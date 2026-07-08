// "Ask the platform" — the in-app AI guide. Combines the static
// handbook (how the product works) with a LIVE workspace snapshot
// (what's actually configured/broken in THIS tenant) so answers are
// diagnoses, not documentation links.

import { and, count, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { connectorRecipes, connectors } from '@/lib/db/schema/connectors';
import { mailboxes } from '@/lib/db/schema/mailing';
import { productProfiles } from '@/lib/db/schema/products';
import { reviewItems } from '@/lib/db/schema/review';
import { outreachDrafts } from '@/lib/db/schema/outreach';
import { getAIProviderForCtx } from '@/lib/ai';
import { PLATFORM_HANDBOOK } from '@/lib/assistant/handbook';
import type { WorkspaceContext } from './context';
import { getTokenWallet } from './token-ledger';

export class AssistantError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'AssistantError';
    this.code = code;
  }
}

export interface AssistantTurn {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_QUESTION_LEN = 2000;
const MAX_HISTORY_TURNS = 8;

/** Live tenant snapshot the guide diagnoses from. Cheap counts only. */
async function workspaceSnapshot(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<string> {
  const wsId = ctx.workspaceId;
  const [wallet, products, activeConnectors, recipes, reviewPending, draftsPending, activeMailboxes] =
    await Promise.all([
      getTokenWallet(ctx),
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
        .select({ c: count() })
        .from(mailboxes)
        .where(and(eq(mailboxes.workspaceId, wsId), eq(mailboxes.status, 'active'))),
    ]);

  const recipeRow = recipes[0] ?? { total: 0, withCountry: 0 };
  return [
    `Token balance: ${wallet.balance.toLocaleString()}${wallet.billingExempt ? ' (billing exempt)' : ''}${!wallet.billingExempt && wallet.balance <= 0n ? ' — EMPTY: metered work is paused' : ''}`,
    `Active products: ${Number(products[0]?.c ?? 0)}`,
    `Active connectors: ${Number(activeConnectors[0]?.c ?? 0)}`,
    `Recipes: ${Number(recipeRow.total)} (${Number(recipeRow.withCountry)} with a target country set)`,
    `Review queue (new + needs_review): ${Number(reviewPending[0]?.c ?? 0)}`,
    `Unapproved drafts: ${Number(draftsPending[0]?.c ?? 0)}`,
    `Active mailboxes: ${Number(activeMailboxes[0]?.c ?? 0)}`,
  ].join('\n');
}

/**
 * Answer a "how do I / why is" question about the platform, grounded in
 * the handbook + this workspace's live state. Metered like every other
 * AI call (kind ai.assistant via the provider factory).
 */
export async function askAssistant(
  ctx: WorkspaceContext,
  question: string,
  history: ReadonlyArray<AssistantTurn> = [],
): Promise<{ answer: string }> {
  const trimmed = question.trim();
  if (!trimmed) throw new AssistantError('question is required', 'invalid_input');
  if (trimmed.length > MAX_QUESTION_LEN) {
    throw new AssistantError('question too long', 'invalid_input');
  }

  const snapshot = await workspaceSnapshot(ctx);
  const recent = history.slice(-MAX_HISTORY_TURNS);
  const historyBlock =
    recent.length > 0
      ? `Conversation so far:\n${recent
          .map((t) => `${t.role === 'user' ? 'User' : 'Guide'}: ${t.content.slice(0, 500)}`)
          .join('\n')}\n\n`
      : '';

  const system = [
    'You are the built-in guide of the Lead Discovery Platform. Answer the',
    "operator's questions about how to use the product, and diagnose",
    'problems using the live workspace snapshot provided.',
    'Rules:',
    '- Be concise and concrete. Prefer numbered steps.',
    '- Reference in-app paths in [square brackets], e.g. [/settings/billing],',
    '  exactly as they appear in the handbook — the UI turns them into links.',
    '- When the snapshot explains the problem (empty wallet, no mailbox, no',
    '  target country on recipes), SAY SO first — that is the actual answer.',
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
  const result = await ai.generateText(
    { system, prompt },
    { temperature: 0.3, maxTokens: 900, mockSeed: `assistant:${trimmed.slice(0, 60)}` },
  );

  return { answer: result.text.trim() };
}
