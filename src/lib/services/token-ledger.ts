// Prepaid token ledger. workspaces.token_balance is the materialized
// wallet; token_transactions is the authoritative append-only history.
// The two are only ever written together, inside one DB transaction.
//
// Credits come from Stripe purchases (webhook, idempotent by checkout-
// session id) and super-admin adjustments. Debits come from metered usage
// (usage.ts). Gates (`assertTokens`) stop NEW billable work when the
// wallet is empty — in-flight work may take the balance slightly
// negative, which is accepted and visible in the ledger.

import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { workspaces } from '@/lib/db/schema/workspaces';
import {
  tokenTransactions,
  type TokenTransaction,
} from '@/lib/db/schema/tokens';
import { recordAuditEvent } from './audit';
import { isSuperAdmin, type WorkspaceContext } from './context';

export class TokenError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'TokenError';
    this.code = code;
  }
}

const invalid = (msg: string) => new TokenError(msg, 'invalid_input');

export interface TokenWallet {
  balance: bigint;
  billingExempt: boolean;
}

export async function getTokenWallet(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<TokenWallet> {
  const rows = await db
    .select({
      balance: workspaces.tokenBalance,
      billingExempt: workspaces.billingExempt,
    })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);
  if (!rows[0]) throw new TokenError('workspace not found', 'not_found');
  return rows[0];
}

interface LedgerWrite {
  tokens: number | bigint;
  kind: 'purchase' | 'usage' | 'adjustment';
  reason: string;
  externalRef?: string | null;
  payload?: Record<string, unknown>;
}

/** Shared atomic write: bump the wallet, append the ledger row carrying
 *  the post-write balance. `delta` sign decides credit vs debit. */
async function applyDelta(
  workspaceId: bigint,
  delta: bigint,
  write: LedgerWrite,
): Promise<TokenTransaction> {
  if (delta === 0n) throw invalid('token delta must be non-zero');
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(workspaces)
      .set({
        tokenBalance: sql`${workspaces.tokenBalance} + ${delta}`,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, workspaceId))
      .returning({ balance: workspaces.tokenBalance });
    if (!updated[0]) throw new TokenError('workspace not found', 'not_found');
    const [row] = await tx
      .insert(tokenTransactions)
      .values({
        workspaceId,
        delta,
        balanceAfter: updated[0].balance,
        kind: write.kind,
        reason: write.reason,
        externalRef: write.externalRef ?? null,
        payload: write.payload ?? {},
      })
      .returning();
    if (!row) throw new TokenError('ledger insert returned no row', 'invariant');
    return row;
  });
}

/**
 * Credit tokens (purchase / adjustment). Idempotent when `externalRef`
 * is provided: a second call with the same ref (Stripe webhook retry)
 * returns the existing transaction without touching the balance.
 * Takes a plain workspaceId — the Stripe webhook has no user session.
 */
export async function creditTokens(
  workspaceId: bigint,
  input: LedgerWrite,
): Promise<{ transaction: TokenTransaction; alreadyApplied: boolean }> {
  const tokens = BigInt(input.tokens);
  if (tokens <= 0n) throw invalid('credit must be positive');

  if (input.externalRef) {
    const existing = await db
      .select()
      .from(tokenTransactions)
      .where(eq(tokenTransactions.externalRef, input.externalRef))
      .limit(1);
    if (existing[0]) return { transaction: existing[0], alreadyApplied: true };
  }

  try {
    const transaction = await applyDelta(workspaceId, tokens, input);
    return { transaction, alreadyApplied: false };
  } catch (err) {
    // Unique-index race on externalRef (two webhook deliveries at once):
    // the loser re-reads the winner's row.
    if (
      input.externalRef &&
      err instanceof Error &&
      /token_tx_external_ref_idx|duplicate key/i.test(err.message)
    ) {
      const existing = await db
        .select()
        .from(tokenTransactions)
        .where(eq(tokenTransactions.externalRef, input.externalRef))
        .limit(1);
      if (existing[0]) return { transaction: existing[0], alreadyApplied: true };
    }
    throw err;
  }
}

/** Balance at/below which the workspace gets a "tokens low" nudge. */
const LOW_TOKEN_THRESHOLD = 100n;

/** Debit tokens for metered usage. No floor check — usage debits record
 *  what actually happened; the gates prevent runaway spending. */
export async function debitTokens(
  workspaceId: bigint,
  input: Omit<LedgerWrite, 'kind'>,
): Promise<TokenTransaction> {
  const tokens = BigInt(input.tokens);
  if (tokens <= 0n) throw invalid('debit must be positive');
  const tx = await applyDelta(workspaceId, -tokens, { ...input, kind: 'usage' });

  // Low-balance nudge: fires once (deduped while unread) as the wallet
  // crosses the threshold, so operators top up BEFORE the gates pause
  // discovery/drafting. Best-effort — never fails the debit.
  if (tx.balanceAfter <= LOW_TOKEN_THRESHOLD) {
    const { notify } = await import('./notifications');
    await notify(workspaceId, {
      kind: 'tokens.low',
      title:
        tx.balanceAfter <= 0n
          ? 'Out of tokens — discovery, drafting and translation are paused'
          : `Tokens running low (${tx.balanceAfter.toLocaleString()} left)`,
      body: 'Buy a token pack to keep the pipeline running.',
      href: '/settings/billing',
      dedupeKey: 'tokens.low',
    });
  }
  return tx;
}

/**
 * Super-admin manual adjustment (promo, refund, correction). Positive or
 * negative. Audit-logged with the acting user.
 */
export async function adjustTokens(
  ctx: WorkspaceContext,
  workspaceId: bigint,
  tokens: number | bigint,
  reason: string,
): Promise<TokenTransaction> {
  if (!isSuperAdmin(ctx)) {
    throw new TokenError('Permission denied: tokens.adjust', 'permission_denied');
  }
  const delta = BigInt(tokens);
  if (delta === 0n) throw invalid('adjustment must be non-zero');
  const transaction = await applyDelta(workspaceId, delta, {
    tokens: delta < 0n ? -delta : delta,
    kind: 'adjustment',
    reason,
    payload: { actorUserId: ctx.userId },
  });
  await recordAuditEvent(
    { ...ctx, workspaceId },
    {
      kind: 'tokens.adjust',
      entityType: 'workspace',
      entityId: workspaceId,
      payload: { delta: delta.toString(), reason },
    },
  );
  return transaction;
}

/**
 * Gate for billable entry points: throws when the wallet is empty.
 * Billing-exempt workspaces always pass. Checks balance > 0 rather than
 * balance ≥ estimate — in-flight work may overshoot slightly, and the
 * next gate check stops further work.
 */
export async function assertTokens(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<void> {
  const wallet = await getTokenWallet(ctx);
  if (wallet.billingExempt) return;
  if (wallet.balance <= 0n) {
    throw new TokenError(
      'No tokens left — buy a token pack in Settings → Billing to continue.',
      'insufficient_tokens',
    );
  }
}

/** Non-throwing variant for background loops (autopilot, crawl ticks). */
export async function hasTokens(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<boolean> {
  const wallet = await getTokenWallet(ctx);
  return wallet.billingExempt || wallet.balance > 0n;
}

export async function listTokenTransactions(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  options: { limit?: number } = {},
): Promise<TokenTransaction[]> {
  const limit = Math.min(options.limit ?? 50, 200);
  return db
    .select()
    .from(tokenTransactions)
    .where(and(eq(tokenTransactions.workspaceId, ctx.workspaceId)))
    .orderBy(desc(tokenTransactions.createdAt), desc(tokenTransactions.id))
    .limit(limit);
}
