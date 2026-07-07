// Prepaid token system tests: ledger arithmetic + idempotency, the
// recordUsage debit hook, Stripe payment-mode crediting, gates, and
// workspace isolation.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock';
import type Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { workspaces } from '@/lib/db/schema/workspaces';
import { tokenTransactions } from '@/lib/db/schema/tokens';
import { _setAIProviderForTests } from '@/lib/ai';
import { costCentsToTokens } from '@/lib/billing/tokens';
import { applyStripeEvent } from '@/lib/services/billing';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { createConnector, startRun } from '@/lib/services/connector-run';
import {
  TokenError,
  adjustTokens,
  assertTokens,
  creditTokens,
  debitTokens,
  getTokenWallet,
  hasTokens,
  listTokenTransactions,
} from '@/lib/services/token-ledger';
import { recordUsage } from '@/lib/services/usage';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  ownerB: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'tokensA@test.local' });
  const ownerB = await seedUser({ email: 'tokensB@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  return { workspaceA, workspaceB, ownerA, ownerB };
}

function ctx(
  workspaceId: bigint,
  userId: string,
  role: WorkspaceContext['role'] = 'owner',
): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

async function setBalance(workspaceId: bigint, balance: bigint): Promise<void> {
  await db
    .update(workspaces)
    .set({ tokenBalance: balance })
    .where(eq(workspaces.id, workspaceId));
}

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  _setAIProviderForTests(null);
  delete process.env.TOKEN_MARKUP;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- pure pricing math --------------------------------------------------

describe('costCentsToTokens', () => {
  it('applies the markup and rounds up', () => {
    expect(costCentsToTokens(10)).toBe(30); // default markup 3
    expect(costCentsToTokens(1)).toBe(3);
  });

  it('charges at least 1 token for any non-zero cost', () => {
    process.env.TOKEN_MARKUP = '0.1';
    expect(costCentsToTokens(1)).toBe(1);
  });

  it('charges nothing for zero/unknown cost', () => {
    expect(costCentsToTokens(0)).toBe(0);
    expect(costCentsToTokens(null)).toBe(0);
    expect(costCentsToTokens(undefined)).toBe(0);
  });
});

// ---- ledger -------------------------------------------------------------

describe('token ledger', () => {
  it('new workspaces start with the 500-token welcome allowance', async () => {
    const s = await setup();
    const wallet = await getTokenWallet(ctx(s.workspaceA, s.ownerA));
    expect(wallet.balance).toBe(500n);
    expect(wallet.billingExempt).toBe(false);
  });

  it('credit + debit update balance and write ledger rows with balanceAfter', async () => {
    const s = await setup();
    await creditTokens(s.workspaceA, {
      tokens: 1000,
      kind: 'purchase',
      reason: 'pack_s',
    });
    await debitTokens(s.workspaceA, { tokens: 200, reason: 'ai.qualification' });

    const wallet = await getTokenWallet(ctx(s.workspaceA, s.ownerA));
    expect(wallet.balance).toBe(1300n); // 500 welcome + 1000 - 200

    const txs = await listTokenTransactions(ctx(s.workspaceA, s.ownerA));
    expect(txs).toHaveLength(2);
    const [debit, credit] = txs; // newest first
    expect(credit!.delta).toBe(1000n);
    expect(credit!.balanceAfter).toBe(1500n);
    expect(debit!.delta).toBe(-200n);
    expect(debit!.balanceAfter).toBe(1300n);
  });

  it('purchase credit is idempotent by externalRef (webhook replay)', async () => {
    const s = await setup();
    const first = await creditTokens(s.workspaceA, {
      tokens: 1000,
      kind: 'purchase',
      reason: 'pack_s',
      externalRef: 'cs_test_replay',
    });
    const second = await creditTokens(s.workspaceA, {
      tokens: 1000,
      kind: 'purchase',
      reason: 'pack_s',
      externalRef: 'cs_test_replay',
    });
    expect(first.alreadyApplied).toBe(false);
    expect(second.alreadyApplied).toBe(true);
    expect(second.transaction.id).toBe(first.transaction.id);
    const wallet = await getTokenWallet(ctx(s.workspaceA, s.ownerA));
    expect(wallet.balance).toBe(1500n); // credited exactly once
  });

  it('adjustTokens is super-admin only', async () => {
    const s = await setup();
    await expect(
      adjustTokens(ctx(s.workspaceA, s.ownerA, 'admin'), s.workspaceA, 100, 'promo'),
    ).rejects.toMatchObject({ code: 'permission_denied' });

    const superCtx = makeWorkspaceContext({
      workspaceId: s.workspaceA,
      userId: s.ownerA,
      role: 'super_admin',
    });
    await adjustTokens(superCtx, s.workspaceA, -100, 'correction');
    const wallet = await getTokenWallet(ctx(s.workspaceA, s.ownerA));
    expect(wallet.balance).toBe(400n);
  });

  it('ledger is workspace-isolated', async () => {
    const s = await setup();
    await creditTokens(s.workspaceA, { tokens: 50, kind: 'purchase', reason: 'x' });
    const inB = await listTokenTransactions(ctx(s.workspaceB, s.ownerB));
    expect(inB).toHaveLength(0);
  });
});

// ---- gates ----------------------------------------------------------------

describe('token gates', () => {
  it('assertTokens passes with balance, throws when empty', async () => {
    const s = await setup();
    await expect(assertTokens(ctx(s.workspaceA, s.ownerA))).resolves.toBeUndefined();
    await setBalance(s.workspaceA, 0n);
    await expect(assertTokens(ctx(s.workspaceA, s.ownerA))).rejects.toMatchObject({
      code: 'insufficient_tokens',
    });
  });

  it('billing-exempt workspaces always pass', async () => {
    const s = await setup();
    await setBalance(s.workspaceA, 0n);
    await db
      .update(workspaces)
      .set({ billingExempt: true })
      .where(eq(workspaces.id, s.workspaceA));
    await expect(assertTokens(ctx(s.workspaceA, s.ownerA))).resolves.toBeUndefined();
    expect(await hasTokens(ctx(s.workspaceA, s.ownerA))).toBe(true);
  });

  it('startRun refuses on an empty wallet', async () => {
    const s = await setup();
    const c = await createConnector(ctx(s.workspaceA, s.ownerA), {
      templateType: 'mock',
      name: 'Mock',
      config: {},
    });
    await setBalance(s.workspaceA, 0n);
    await expect(
      startRun(ctx(s.workspaceA, s.ownerA), { connectorId: c.id }),
    ).rejects.toMatchObject({ code: 'insufficient_tokens' });
  });
});

// ---- recordUsage debit hook ------------------------------------------------

describe('recordUsage token debits', () => {
  it('debits ceil(cost × markup) for platform-key usage', async () => {
    const s = await setup();
    await recordUsage(ctx(s.workspaceA, s.ownerA), {
      kind: 'ai.qualification',
      provider: 'anthropic',
      units: 1200,
      costEstimateCents: 10,
      payload: { keySource: 'platform' },
    });
    const wallet = await getTokenWallet(ctx(s.workspaceA, s.ownerA));
    expect(wallet.balance).toBe(500n - 30n);
    const txs = await listTokenTransactions(ctx(s.workspaceA, s.ownerA));
    expect(txs[0]!.reason).toBe('ai.qualification');
  });

  it('skips mock providers, BYOK usage and billing-exempt workspaces', async () => {
    const s = await setup();
    await recordUsage(ctx(s.workspaceA, s.ownerA), {
      kind: 'search.query',
      provider: 'mock',
      units: 1,
      costEstimateCents: 10,
    });
    await recordUsage(ctx(s.workspaceA, s.ownerA), {
      kind: 'search.query',
      provider: 'serpapi',
      units: 1,
      costEstimateCents: 10,
      payload: { keySource: 'workspace' },
    });
    await db
      .update(workspaces)
      .set({ billingExempt: true })
      .where(eq(workspaces.id, s.workspaceA));
    await recordUsage(ctx(s.workspaceA, s.ownerA), {
      kind: 'ai.generate',
      provider: 'anthropic',
      units: 100,
      costEstimateCents: 50,
      payload: { keySource: 'platform' },
    });

    const wallet = await getTokenWallet(ctx(s.workspaceA, s.ownerA));
    expect(wallet.balance).toBe(500n); // untouched by all three
  });
});

// ---- Stripe payment-mode webhook -------------------------------------------

describe('applyStripeEvent — token purchase', () => {
  function paymentEvent(workspaceId: bigint, sessionId: string): Stripe.Event {
    return {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: sessionId,
          mode: 'payment',
          metadata: {
            workspace_id: workspaceId.toString(),
            token_pack_id: 'pack_s',
            tokens: '1000',
          },
          amount_total: 1000,
          currency: 'eur',
        },
      },
    } as unknown as Stripe.Event;
  }

  it('credits the wallet and never touches subscription state', async () => {
    const s = await setup();
    const before = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, s.workspaceA));

    const result = await applyStripeEvent(paymentEvent(s.workspaceA, 'cs_pay_1'));
    expect(result.action).toBe('updated');

    const [after] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, s.workspaceA));
    expect(after!.tokenBalance).toBe(1500n);
    expect(after!.plan).toBe(before[0]!.plan);
    expect(after!.subscriptionStatus).toBe(before[0]!.subscriptionStatus);
  });

  it('webhook replay credits exactly once', async () => {
    const s = await setup();
    await applyStripeEvent(paymentEvent(s.workspaceA, 'cs_pay_2'));
    const replay = await applyStripeEvent(paymentEvent(s.workspaceA, 'cs_pay_2'));
    expect(replay.detail).toContain('replay');
    const wallet = await getTokenWallet(ctx(s.workspaceA, s.ownerA));
    expect(wallet.balance).toBe(1500n);
  });

  it('payment session without token metadata is ignored gracefully', async () => {
    const s = await setup();
    const evt = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_pay_3',
          mode: 'payment',
          metadata: { workspace_id: s.workspaceA.toString() },
        },
      },
    } as unknown as Stripe.Event;
    const result = await applyStripeEvent(evt);
    expect(result.action).toBe('ignored');
    const wallet = await getTokenWallet(ctx(s.workspaceA, s.ownerA));
    expect(wallet.balance).toBe(500n);
  });
});

void tokenTransactions;
