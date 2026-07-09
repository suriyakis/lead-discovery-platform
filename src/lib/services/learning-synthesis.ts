// Weekly self-learning synthesis — the pattern miner.
//
// The hooks in learning-loop.ts capture individual signals (one decision,
// one reply, one edit). What no single hook can see is the AGGREGATE:
// "records mentioning 'consultancy' get rejected 9 times out of 10",
// "German leads never reply to the pitch stage". This service hands the
// recent event stream + the existing rule base to the workspace AI and
// asks for up to a handful of NEW generalized rules that the existing
// base doesn't already cover.
//
// Synthesized lessons land with source='synthesis', modest confidence and
// enabled=true — the reinforcement loop then promotes the ones reality
// confirms and compaction retires the ones it doesn't. Operators see the
// provenance badge on /learning and can disable anything on sight.
//
// Runs unattended on the weekly knowledge tick (after compaction, so it
// mines a deduplicated base) and on demand from /learning (admin button).

import { and, desc, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import { learningEvents, learningLessons } from '@/lib/db/schema/learning';
import { productProfiles } from '@/lib/db/schema/products';
import { getAIProviderForCtx } from '@/lib/ai';
import { recordPlatformAuditEvent } from './audit';
import {
  canAdminWorkspace,
  type WorkspaceContext,
} from './context';
import {
  LESSON_CATEGORIES,
  createLesson,
  type LessonCategory,
} from './learning';
import { hasTokens } from './token-ledger';

export class LearningSynthesisError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'LearningSynthesisError';
    this.code = code;
  }
}

/** Look-back window for pattern mining. Two weekly runs of overlap keeps
 *  slow-burn patterns alive without re-mining ancient history. */
const WINDOW_DAYS = 14;
/** Below this many events there is no pattern to find — skip the AI call. */
const MIN_EVENTS = 10;
/** Hard cap of events serialized into the prompt. */
const EVENT_CAP = 300;
/** Existing rules shown to the AI for dedupe. */
const EXISTING_RULE_CAP = 150;
/** Max new lessons a single run may create. */
const MAX_PROPOSALS = 3;
/** Synthesized rules start humble; reinforcement promotes the good ones. */
const SYNTHESIS_CONFIDENCE_CAP = 55;

export interface SynthesisSummary {
  workspaceId: bigint;
  ran: boolean;
  skippedReason: 'insufficient_events' | 'no_tokens' | null;
  eventsExamined: number;
  proposalsReceived: number;
  lessonsCreated: number;
}

const ProposalSchema = z.object({
  proposals: z
    .array(
      z.object({
        category: z.string(),
        rule: z.string(),
        /** Product profile id as a string, or null for workspace-wide. */
        productId: z.string().nullable(),
        confidence: z.number().int().min(0).max(100),
      }),
    )
    .max(10),
});

const SYNTHESIS_SYSTEM_PROMPT = `You are the self-learning engine of a B2B lead-discovery platform. You receive:
1. EVENTS — the workspace's recent feedback stream: review approvals/rejections (with optional operator comments), positive/negative reply outcomes, and draft-edit signals, each optionally scoped to a product.
2. EXISTING RULES — the knowledge base already in force.

Find recurring PATTERNS in the events that the existing rules do NOT already cover, and propose new generalized rules the platform should follow. Examples of patterns worth learning: a company type that keeps getting rejected, a sector that replies well, a repeated operator complaint, a country/role that converts.

Rules must be:
- GENERAL (about kinds of companies/situations, never about one specific company)
- ACTIONABLE one-sentence imperatives
- NOT a duplicate or trivial rephrasing of an existing rule

Allowed categories: ${LESSON_CATEGORIES.join(', ')}.

Strict JSON output:
{"proposals": [{"category": "<allowed category>", "rule": "<one sentence>", "productId": "<product id string from the events, or null for workspace-wide>", "confidence": <int 0-100>}]}

Return at most ${MAX_PROPOSALS} proposals. Quality over quantity — an empty proposals array is the CORRECT answer when the events show no reliable new pattern. Output JSON only.`;

/**
 * Attended entry point (the /learning "Synthesize now" button). Admin-gated.
 */
export async function synthesizeWorkspaceLearning(
  ctx: WorkspaceContext,
): Promise<SynthesisSummary> {
  if (!canAdminWorkspace(ctx)) {
    throw new LearningSynthesisError(
      'Permission denied: learning.synthesize',
      'permission_denied',
    );
  }
  return runSynthesis(ctx);
}

/**
 * Cron entry point — one workspace, trusted caller. Acts as the workspace
 * owner (same convention as the other unattended ticks) so FK-carrying
 * writes (lesson createdBy, audit) reference a real user.
 */
export async function synthesizeWorkspaceLearningUnattended(
  workspaceId: bigint,
): Promise<SynthesisSummary> {
  const { workspaces } = await import('@/lib/db/schema/workspaces');
  const rows = await db
    .select({ ownerUserId: workspaces.ownerUserId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!rows[0]) {
    throw new LearningSynthesisError('workspace not found', 'not_found');
  }
  const ctx: WorkspaceContext = {
    workspaceId,
    userId: rows[0].ownerUserId,
    role: 'owner',
  } as WorkspaceContext;
  return runSynthesis(ctx);
}

async function runSynthesis(ctx: WorkspaceContext): Promise<SynthesisSummary> {
  const base: SynthesisSummary = {
    workspaceId: ctx.workspaceId,
    ran: false,
    skippedReason: null,
    eventsExamined: 0,
    proposalsReceived: 0,
    lessonsCreated: 0,
  };

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const events = await db
    .select({
      actionType: learningEvents.actionType,
      productProfileId: learningEvents.productProfileId,
      originalComment: learningEvents.originalComment,
      confidence: learningEvents.confidence,
    })
    .from(learningEvents)
    .where(
      and(
        eq(learningEvents.workspaceId, ctx.workspaceId),
        gte(learningEvents.createdAt, since),
      ),
    )
    .orderBy(desc(learningEvents.createdAt))
    .limit(EVENT_CAP);

  base.eventsExamined = events.length;
  if (events.length < MIN_EVENTS) {
    return { ...base, skippedReason: 'insufficient_events' };
  }
  if (!(await hasTokens(ctx))) {
    return { ...base, skippedReason: 'no_tokens' };
  }

  const existing = await db
    .select({
      rule: learningLessons.rule,
      category: learningLessons.category,
    })
    .from(learningLessons)
    .where(
      and(
        eq(learningLessons.workspaceId, ctx.workspaceId),
        eq(learningLessons.enabled, true),
      ),
    )
    .orderBy(desc(learningLessons.confidence))
    .limit(EXISTING_RULE_CAP);

  const products = await db
    .select({ id: productProfiles.id, name: productProfiles.name })
    .from(productProfiles)
    .where(eq(productProfiles.workspaceId, ctx.workspaceId));
  const productNames = new Map(products.map((p) => [p.id.toString(), p.name]));
  const validProductIds = new Set(productNames.keys());

  // Compact event serialization: aggregate counts per (action, product),
  // then the individual comments (the richest signal) up to a budget.
  const tally = new Map<string, number>();
  for (const e of events) {
    const key = `${e.actionType} | product=${e.productProfileId ? `${e.productProfileId} (${productNames.get(e.productProfileId.toString()) ?? 'unknown'})` : 'workspace-wide'}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const tallyBlock = Array.from(tally.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n}× ${k}`)
    .join('\n');
  const comments = events
    .filter((e) => e.originalComment && e.originalComment.trim().length > 0)
    .slice(0, 40)
    .map(
      (e) =>
        `- [${e.actionType}${e.productProfileId ? `, product=${e.productProfileId}` : ''}] ${e.originalComment!.slice(0, 200)}`,
    )
    .join('\n');
  const existingBlock =
    existing.length > 0
      ? existing.map((l) => `- [${l.category}] ${l.rule.slice(0, 200)}`).join('\n')
      : '(none yet)';

  const prompt = `EVENTS from the last ${WINDOW_DAYS} days (${events.length} total):

Aggregate counts:
${tallyBlock}

Operator comments:
${comments || '(none)'}

EXISTING RULES (do not duplicate):
${existingBlock}

Products in this workspace: ${products.map((p) => `${p.id}=${p.name}`).join(', ') || '(none)'}`;

  const provider = await getAIProviderForCtx(ctx, 'ai.learning_synthesis');
  const result = await provider.generateJson(
    { system: SYNTHESIS_SYSTEM_PROMPT, prompt },
    ProposalSchema,
    {
      maxTokens: 1024,
      temperature: 0,
      mockSeed: `learning.synthesis:${ctx.workspaceId}`,
    },
  );

  base.ran = true;
  base.proposalsReceived = result.proposals.length;

  const categorySet = new Set<string>(LESSON_CATEGORIES);
  const existingRulesLower = new Set(existing.map((l) => l.rule.trim().toLowerCase()));
  let created = 0;
  for (const p of result.proposals.slice(0, MAX_PROPOSALS)) {
    const rule = p.rule.trim();
    if (!rule || !categorySet.has(p.category)) continue;
    // Belt-and-braces dedupe on top of the prompt instruction.
    if (existingRulesLower.has(rule.toLowerCase())) continue;
    const productId =
      p.productId && validProductIds.has(p.productId) ? BigInt(p.productId) : null;
    try {
      await createLesson(ctx, {
        category: p.category as LessonCategory,
        rule,
        productProfileId: productId,
        confidence: Math.min(p.confidence, SYNTHESIS_CONFIDENCE_CAP),
        source: 'synthesis',
      });
      existingRulesLower.add(rule.toLowerCase());
      created++;
    } catch (err) {
      console.error('[learning-synthesis] lesson insert failed:', err);
    }
  }
  base.lessonsCreated = created;

  await recordPlatformAuditEvent(null, {
    kind: 'learning.synthesis.run',
    entityType: 'workspace',
    entityId: ctx.workspaceId,
    payload: {
      workspaceId: ctx.workspaceId.toString(),
      eventsExamined: base.eventsExamined,
      proposalsReceived: base.proposalsReceived,
      lessonsCreated: created,
    },
  });

  if (created > 0) {
    try {
      const { notify } = await import('./notifications');
      await notify(ctx.workspaceId, {
        kind: 'learning.synthesis',
        title: `The platform learned ${created} new rule${created === 1 ? '' : 's'} from recent activity`,
        body: 'Auto-learned rules start with modest confidence — review or disable them anytime.',
        href: '/learning',
        dedupeKey: 'learning.synthesis',
      });
    } catch (err) {
      console.error('[learning-synthesis] notify failed:', err);
    }
  }

  return base;
}
