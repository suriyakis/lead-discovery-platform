// "Ask the platform" — the in-app AI guide. Combines the static
// handbook (how the product works) with a LIVE workspace snapshot
// (what's actually configured/broken in THIS tenant) so answers are
// diagnoses, not documentation links.
//
// AP-02 robustness + billing rules:
//   - Empty wallet (non-exempt tenant): the model is NOT called; the
//     answer is built deterministically from the health-check rule
//     findings, with a [/settings/billing] link. Free.
//   - A super-admin's question (ctx.role 'super_admin', member or god
//     mode) is metered as platform support (payload.support) and never
//     debited to the tenant — so it also skips the empty-wallet gate.
//   - The model runs with `reasoning: 'low'`, which the adapters map per
//     model (src/lib/ai/model-profiles.ts) so hidden reasoning can't eat
//     the answer.
//   - A blank answer is AssistantError('empty_answer') — retryable, and
//     never billed (the metering decorator tags it unbilled).
//   - A refusal returns the deterministic answer instead.

import { and, count, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { connectorRecipes, connectors } from '@/lib/db/schema/connectors';
import { mailboxes, type MailboxStatus } from '@/lib/db/schema/mailing';
import { productProfiles } from '@/lib/db/schema/products';
import { reviewItems } from '@/lib/db/schema/review';
import { outreachDrafts, outreachQueue } from '@/lib/db/schema/outreach';
import { AIOutputError, getAIProviderForCtx, type AIGenOptions } from '@/lib/ai';
import { HANDBOOK_VERSION, PLATFORM_HANDBOOK } from '@/lib/assistant/handbook';
import { BRAND_NAME } from '@/lib/brand';
import { getAutomationState } from './automation-policy';
import { canAdminWorkspace, isSuperAdmin, type WorkspaceContext } from './context';
import { collectRuleFindings } from './health-check';
import { getTokenWallet, type TokenWallet } from './token-ledger';

export class AssistantError extends Error {
  public readonly code: string;
  /** True when asking again may well succeed (e.g. an empty answer). */
  public readonly retryable: boolean;
  constructor(message: string, code: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'AssistantError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export interface AssistantTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantAnswer {
  answer: string;
  /** 'ai' — the model answered; 'deterministic' — the built-in answer
   *  (empty wallet, or the model declined). */
  source: 'ai' | 'deterministic';
  /** Why the deterministic answer was given. */
  fallbackReason?: 'wallet_empty' | 'refusal';
  /** Codes of the rule findings the deterministic answer lists. */
  findings?: string[];
  /** Model answers: the handbook version the model read (AP-03). */
  handbookVersion?: string;
}

const MAX_QUESTION_LEN = 2000;
const MAX_HISTORY_TURNS = 8;

/** Generation settings for every guide answer. `maxTokens` is the
 *  visible-answer budget; `reasoning` lets each adapter add what its
 *  model needs on top (effort knob + output floor). Temperature is
 *  dropped by the adapters for models that reject it. */
export const ASSISTANT_GENERATION: Readonly<
  Required<Pick<AIGenOptions, 'temperature' | 'maxTokens' | 'reasoning'>>
> = { temperature: 0.3, maxTokens: 900, reasoning: 'low' };

const EMPTY_ANSWER_MESSAGE =
  'The guide came back with an empty answer. Your question is kept — try again.';

/** Live tenant snapshot the guide diagnoses from. Cheap counts only. */
async function workspaceSnapshot(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  wallet: TokenWallet,
): Promise<string> {
  const wsId = ctx.workspaceId;
  const [products, activeConnectors, recipes, reviewPending, draftsPending, mailboxesByStatus] =
    await Promise.all([
      db
        .select({ c: count() })
        .from(productProfiles)
        .where(and(eq(productProfiles.workspaceId, wsId), eq(productProfiles.active, true))),
      db
        .select({ c: count() })
        .from(connectors)
        .where(and(eq(connectors.workspaceId, wsId), eq(connectors.active, true))),
      db
        .select({
          total: count(),
          withCountry: sql<number>`count(*) filter (where selectors->>'country' is not null)::int`,
        })
        .from(connectorRecipes)
        .where(eq(connectorRecipes.workspaceId, wsId)),
      db
        .select({ c: count() })
        .from(reviewItems)
        .where(
          and(
            eq(reviewItems.workspaceId, wsId),
            sql`${reviewItems.state} in ('new', 'needs_review')`,
          ),
        ),
      db
        .select({ c: count() })
        .from(outreachDrafts)
        .where(
          and(
            eq(outreachDrafts.workspaceId, wsId),
            sql`${outreachDrafts.status} in ('draft', 'needs_edit')`,
          ),
        ),
      db
        .select({ status: mailboxes.status, c: count() })
        .from(mailboxes)
        .where(eq(mailboxes.workspaceId, wsId))
        .groupBy(mailboxes.status),
    ]);
  // F-07: the send queue's counts, so "why is nothing sending?" can say how
  // much waits. A queued entry with a note was held by the gate (or waits
  // to retry); the note on /mailbox/queue says which.
  const [queue] = await db
    .select({
      queued: sql<number>`count(*) filter (where ${outreachQueue.status} = 'queued')::int`,
      withNote: sql<number>`count(*) filter (where ${outreachQueue.status} = 'queued' and ${outreachQueue.lastError} is not null)::int`,
      failedRecently: sql<number>`count(*) filter (where ${outreachQueue.status} = 'failed' and ${outreachQueue.updatedAt} >= now() - interval '7 days')::int`,
    })
    .from(outreachQueue)
    .where(eq(outreachQueue.workspaceId, wsId));

  const recipeRow = recipes[0] ?? { total: 0, withCountry: 0 };
  const mailboxCount = (status: MailboxStatus) =>
    Number(mailboxesByStatus.find((r) => r.status === status)?.c ?? 0);
  // No "empty wallet" marker: a non-exempt empty wallet never reaches the
  // model (askAssistant answers deterministically first).
  return [
    `Token balance: ${wallet.balance.toLocaleString()}${wallet.billingExempt ? ' (billing exempt)' : ''}`,
    `Active products: ${Number(products[0]?.c ?? 0)}`,
    `Active connectors: ${Number(activeConnectors[0]?.c ?? 0)}`,
    `Recipes: ${Number(recipeRow.total)} (${Number(recipeRow.withCountry)} with a target country set)`,
    `Review queue (new + needs_review): ${Number(reviewPending[0]?.c ?? 0)}`,
    `Unapproved drafts: ${Number(draftsPending[0]?.c ?? 0)}`,
    // A failing or paused mailbox holds its due sends (and follow-ups) until
    // it works again or is re-enabled — nothing fails (PC-05). Neither is
    // read — the model needs the split to diagnose either.
    `Mailboxes: ${mailboxCount('active')} active, ${mailboxCount('failing')} failing (queued sends held, not read), ${mailboxCount('paused')} paused (not sending, due sends held, not failed, not read)`,
    `Send queue: ${Number(queue?.queued ?? 0)} queued (${Number(queue?.withNote ?? 0)} held or waiting to retry; each entry on [/mailbox/queue] says why), ${Number(queue?.failedRecently ?? 0)} failed in the last 7 days`,
    ...(await automationSnapshot(ctx)),
  ].join('\n');
}

/**
 * PC-05 / PC-06 / flow:F-07: the stops above the mailboxes — the workspace
 * pause, holds, the platform-wide outbound stop, no accountable owner —
 * and the go-live hold, so the model can answer "why is nothing sending?".
 * Best-effort: a failure leaves one "unknown" line, never the answer.
 */
async function automationSnapshot(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<string[]> {
  try {
    const s = await getAutomationState(ctx);
    const lines = [`Automation: ${s.summary}`];
    // The paused summary says what stops, not who paused or why.
    if (s.kind === 'paused' && s.reasons.length > 0) {
      lines.push(`Paused because: ${s.reasons.join('; ')}`);
    }
    lines.push(
      s.live
        ? 'Go-live: live (cold outreach, follow-ups and AI reply emails may send)'
        : 'Go-live: NOT live yet: cold outreach, follow-ups and AI reply emails are held until the platform releases the workspace; manual email sends normally',
    );
    if (s.degradations.length > 0) lines.push(`Degraded: ${s.degradations.join(' ')}`);
    return lines;
  } catch (err) {
    console.error('[assistant] automation state unavailable:', err);
    return ['Automation: unknown (the automation state could not be read)'];
  }
}

/**
 * Answer a "how do I / why is" question about the platform, grounded in
 * the handbook + this workspace's live state. Metered like every other
 * AI call (kind ai.assistant via the provider factory) — except that an
 * empty wallet gets a free deterministic answer instead of the model,
 * and a super-admin's question is tagged as platform support.
 */
export async function askAssistant(
  ctx: WorkspaceContext,
  question: string,
  history: ReadonlyArray<AssistantTurn> = [],
): Promise<AssistantAnswer> {
  const trimmed = question.trim();
  if (!trimmed) throw new AssistantError('question is required', 'invalid_input');
  if (trimmed.length > MAX_QUESTION_LEN) {
    throw new AssistantError('question too long', 'invalid_input');
  }

  // I179: a super-admin (member or god mode) is doing platform support —
  // metered as such, never debited to this tenant. So the wallet gate
  // below does not apply to them: tenants with an empty wallet are the
  // ones most likely to need support.
  const support = isSuperAdmin(ctx);

  // I054: the guide used to 402 here, on exactly the question it exists
  // to answer. Same predicate as every other AI gate (assertTokens), but
  // the operator gets a real, free answer instead of an error.
  const wallet = await getTokenWallet(ctx);
  if (!support && !wallet.billingExempt && wallet.balance <= 0n) {
    return deterministicAnswer(ctx, 'wallet_empty');
  }

  const snapshot = await workspaceSnapshot(ctx, wallet);
  const recent = history.slice(-MAX_HISTORY_TURNS);
  const historyBlock =
    recent.length > 0
      ? `Conversation so far:\n${recent
          .map((t) => `${t.role === 'user' ? 'User' : 'Guide'}: ${t.content.slice(0, 500)}`)
          .join('\n')}\n\n`
      : '';

  const system = [
    `You are the built-in guide of ${BRAND_NAME}. Answer the`,
    "operator's questions about how to use the product, and diagnose",
    'problems using the live workspace snapshot provided.',
    'Rules:',
    '- Be concise and concrete. Prefer numbered steps. Keep answers under',
    '  about 250 words; the panel is small.',
    '- Reference in-app paths in [square brackets], e.g. [/settings/billing],',
    '  exactly as they appear in the handbook — the UI turns them into links.',
    '- When the snapshot explains the problem (automation paused, on hold or',
    '  stopped by the platform, the workspace not live yet, no active',
    '  mailbox, a failing or paused mailbox, no active product, recipes',
    '  without a target country), SAY SO first — that is the actual answer.',
    '- The handbook\'s "Known limitations right now" section lists what does',
    '  not work yet. If the question touches one, say so plainly and give the',
    '  workaround it names; never claim that part works.',
    "- If something isn't covered by the handbook, say you're not sure and",
    '  suggest where to look. Never invent features.',
    '- Answer in the language the question was asked in.',
  ].join('\n');

  const prompt = [
    '### PLATFORM HANDBOOK',
    PLATFORM_HANDBOOK,
    '',
    '### THIS WORKSPACE RIGHT NOW',
    snapshot,
    '',
    historyBlock + `### QUESTION\n${trimmed}`,
  ].join('\n');

  const ai = await getAIProviderForCtx(ctx, 'ai.assistant');
  let text: string;
  try {
    const result = await ai.generateText(
      { system, prompt },
      {
        ...ASSISTANT_GENERATION,
        ...(support ? { support: true } : {}),
        mockSeed: `assistant:${trimmed.slice(0, 60)}`,
      },
    );
    text = result.text.trim();
  } catch (err) {
    if (err instanceof AIOutputError) {
      if (err.kind === 'refusal') return deterministicAnswer(ctx, 'refusal');
      throw new AssistantError(EMPTY_ANSWER_MESSAGE, 'empty_answer', { retryable: true });
    }
    throw err;
  }
  // I135: never hand the panel a blank 200. (The metering decorator has
  // already tagged a blank result unbilled.)
  if (!text) {
    throw new AssistantError(EMPTY_ANSWER_MESSAGE, 'empty_answer', { retryable: true });
  }
  return { answer: text, source: 'ai', handbookVersion: HANDBOOK_VERSION };
}

/**
 * The built-in answer: no model call, no tokens. Built from the same rule
 * findings as the health report, so it names real problems in this
 * workspace with links to fix them. Its fixed lines are English only
 * (unlike model answers, which follow the question's language).
 */
async function deterministicAnswer(
  ctx: WorkspaceContext,
  reason: 'wallet_empty' | 'refusal',
): Promise<AssistantAnswer> {
  const findings = await collectRuleFindings(ctx);
  const lines: string[] = [];
  if (reason === 'wallet_empty') {
    lines.push(
      'Your token wallet is empty, so the AI guide is paused — and so are discovery, drafting and translation. This answer comes from the built-in checklist and used no tokens.',
      '',
      'To get going again:',
      '1. Open [/settings/billing].',
      '2. Buy a one-time token pack, or start a subscription — its monthly allowance refills the wallet. Tokens arrive a moment after payment.',
      '3. Optionally switch on "Auto top-up when tokens run low" there, so the wallet refills itself next time.',
    );
    if (!canAdminWorkspace(ctx)) {
      lines.push('Only workspace owners and admins can buy tokens — ask one of them.');
    }
  } else {
    lines.push("I can't answer that one.");
  }
  // The empty wallet is already the header of a wallet_empty answer, so
  // its finding is not listed again (its code stays in `findings`).
  const walletEmpty = reason === 'wallet_empty';
  const listed = walletEmpty ? findings.filter((f) => f.code !== 'tokens.empty') : findings;
  lines.push(
    '',
    walletEmpty
      ? 'Anything else I can see in this workspace right now:'
      : 'What I can see in this workspace right now:',
  );
  if (listed.length === 0) {
    lines.push(
      walletEmpty
        ? '- Nothing else in the workspace checks looks wrong.'
        : '- Nothing in the workspace checks looks wrong.',
    );
  } else {
    for (const f of listed) {
      lines.push(`- ${f.message}${f.href ? ` [${f.href}]` : ''}`);
    }
  }
  lines.push('', 'For anything else, [/support] reaches the platform team.');
  return {
    answer: lines.join('\n'),
    source: 'deterministic',
    fallbackReason: reason,
    findings: findings.map((f) => f.code),
  };
}
