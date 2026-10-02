// The decision record (KL-02).
//
// Every decision an operator, autopilot or the system takes on a subject
// (today: a review item; later: the Lead, flow:F-17) is written through
// recordDecision() INSIDE the transaction of the state change it records:
//
//   - one learning_decisions row, idempotent on decision_key (a form nonce,
//     or autopilot:<run>:<item>) — a repeat records nothing (no events, no
//     audit) and the caller treats it as a replay;
//   - one learning_events row per product verdict (or one unscoped event
//     when the record is relevant to no product and nobody chose one),
//     carrying origin, verdict, polarity, weight, the reason and a snapshot
//     of the record (`context`, I036);
//   - supersession: a newer verdict on the same (subject, product) voids the
//     older event (voided_at / voided_by_event_id / void_reason); an
//     operator verdict that voids an autopilot event is an override
//     (overrides_autopilot, void_reason 'autopilot_override').
//
// Operator events are written 'pending' — the outbox. After the commit the
// caller enqueues learning.process {decisionId}; processDecision() claims
// the pending events by a conditional UPDATE and learns from them: ONE rule
// extraction per decision whatever the number of products (I032), and the
// verdict reinforcement of the rules the AI used. Autopilot and system
// events are written 'skipped': machines never teach (I034).
//
// KL-03 hardens the processor (sweeper, backoff, ledger, compensation of
// voided events, validated extraction); the contract above stays.

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import { productProfiles } from '@/lib/db/schema/products';
import {
  DECISION_ORIGINS,
  OPERATOR_VERDICTS,
  learningDecisions,
  learningEvents,
  type DecisionOrigin,
  type LearningEvent,
  type LearningProcessingStatus,
  type NewLearningEvent,
  type OperatorVerdict,
} from '@/lib/db/schema/learning';
import type { WorkspaceContext } from './context';
import {
  prepareLessonFromText,
  reinforceLessonsForVerdict,
  scheduleLessonEmbedding,
  writePreparedLesson,
  type LearningTx,
  type LessonScopeInput,
} from './learning';

export type { DecisionOrigin, OperatorVerdict } from '@/lib/db/schema/learning';

// ---- errors ----------------------------------------------------------------

export class DecisionServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'DecisionServiceError';
    this.code = code;
  }
}

/** Thrown inside the transaction when the decision key was already used:
 *  the caller's whole transaction rolls back and it reports a replay. */
export class DecisionReplayedError extends Error {
  public readonly decisionKey: string;
  constructor(decisionKey: string) {
    super(`decision ${decisionKey} was already recorded`);
    this.name = 'DecisionReplayedError';
    this.decisionKey = decisionKey;
  }
}

const invalid = (msg: string) => new DecisionServiceError(msg, 'invalid_input');

// ---- kinds and keys ----------------------------------------------------------

export const DECISION_KINDS = [
  'review.approve',
  'review.reject',
  'review.ignore',
  'review.archive',
  'review.comment',
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** Kinds that carry verdicts and therefore supersede each other on the same
 *  (subject, product). Comments are instructions: they never void a
 *  verdict and are never voided by one. */
export const VERDICT_DECISION_KINDS: readonly DecisionKind[] = [
  'review.approve',
  'review.reject',
  'review.ignore',
  'review.archive',
];

const DECISION_KEY_RE = /^[A-Za-z0-9:._-]{8,128}$/;

/** A fresh idempotency key (forms render one per decision control). */
export function newDecisionKey(): string {
  return randomUUID();
}

/** The submitted key when it is well-formed, otherwise null. Untrusted
 *  form input — never echoed, only matched. */
export function parseDecisionKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  return DECISION_KEY_RE.test(key) ? key : null;
}

// ---- the context snapshot -------------------------------------------------------

/** What the AI said about one product when the decision was taken. */
const ProductAiSchema = z.object({
  relevant: z.boolean(),
  method: z.string(),
  score: z.number(),
  threshold: z.number(),
  /** 'relevant' at a score under the product threshold (I075). */
  belowThreshold: z.boolean(),
  reason: z.string().nullable(),
  /** Rules the verdict reports it used (evidence.matchedLessonIds). */
  matchedLessonIds: z.array(z.string()),
  /** KL-04's cited rules, when the verdict carries them. */
  citedLessonIds: z.array(z.string()),
});

const ProductSnapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  ai: ProductAiSchema.nullable(),
  /** The operator verdict on the product before this decision. */
  priorVerdict: z.enum(OPERATOR_VERDICTS).nullable(),
});

const RecordSnapshotSchema = z.object({
  title: z.string().nullable(),
  /** Normalized company domain — never a Vertex redirect host. */
  domain: z.string().nullable(),
  sourceSystem: z.string().nullable(),
  connectorId: z.string().nullable(),
  recipeId: z.string().nullable(),
  targetCountry: z.string().nullable(),
  detectedCountry: z.string().nullable(),
  geoStatus: z.string().nullable(),
  /** How much the verdict could see: a domain name only, a search
   *  snippet, or page body text. */
  evidenceQuality: z.enum(['domain_only', 'snippet', 'body']),
});

/** learning_events.context (v1). Written by the subject's service (e.g.
 *  review-decisions.ts), read by the processor and, later, the distiller. */
export const DecisionContextSchema = z
  .object({
    v: z.literal(1),
    subject: z.object({ type: z.string(), id: z.string() }),
    /** fit_confirmed | false_negative | false_positive | not_fit_confirmed |
     *  dismissed | unscoped | autopilot | instruction */
    outcome: z.string(),
    record: RecordSnapshotSchema.nullable(),
    products: z.array(ProductSnapshotSchema),
    commentId: z.string().optional(),
  })
  .passthrough();
export type DecisionContext = z.infer<typeof DecisionContextSchema>;
export type DecisionProductSnapshot = z.infer<typeof ProductSnapshotSchema>;
export type DecisionRecordSnapshot = z.infer<typeof RecordSnapshotSchema>;

// ---- record ------------------------------------------------------------------

export interface DecisionEventInput {
  subject: { type: string; id: string };
  /** NULL = unscoped (no relevant product and no explicit choice) or a
   *  workspace-wide comment. */
  productProfileId: bigint | null;
  /** Requires a product. NULL for unscoped events and comments. */
  verdict: OperatorVerdict | null;
  polarity: -1 | 0 | 1;
  /** 1 or 0.5 (see §5 of the KL plan). */
  weight: number;
  explicit: boolean;
  actionType: string;
  confidence: number;
  context: DecisionContext;
}

export interface RecordDecisionInput {
  kind: DecisionKind;
  origin: DecisionOrigin;
  decisionKey: string;
  /** subject.id NULL for a bulk decision (its events name the subjects). */
  subject: { type: string; id: string | null };
  events: readonly DecisionEventInput[];
  reasonText?: string | null;
  reasonCodes?: readonly string[];
}

export interface RecordedDecision {
  decisionId: string;
  events: LearningEvent[];
  voidedEventIds: bigint[];
  /** At least one event waits for learning.process. */
  pending: boolean;
}

const RecordInputSchema = z.object({
  kind: z.enum(DECISION_KINDS),
  origin: z.enum(DECISION_ORIGINS),
  decisionKey: z.string().regex(DECISION_KEY_RE),
  subjectType: z.string().min(1).max(64),
  reasonText: z.string().max(5000).nullable(),
  reasonCodes: z.array(z.string().regex(/^[a-z0-9_]{1,64}$/)).max(20),
});

/** Has this key already been used in the workspace? */
export async function findDecisionByKey(
  exec: LearningTx | typeof db,
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  decisionKey: string,
): Promise<{ id: string; kind: string; origin: DecisionOrigin } | null> {
  const rows = await exec
    .select({
      id: learningDecisions.id,
      kind: learningDecisions.kind,
      origin: learningDecisions.origin,
    })
    .from(learningDecisions)
    .where(
      and(
        eq(learningDecisions.workspaceId, ctx.workspaceId),
        eq(learningDecisions.decisionKey, decisionKey),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function weightText(weight: number): string {
  if (!Number.isFinite(weight) || weight <= 0 || weight > 1) {
    throw invalid(`decision weight must be in (0, 1], got ${weight}`);
  }
  return weight.toFixed(2);
}

function sameProduct(productProfileId: bigint | null): SQL {
  return productProfileId === null
    ? isNull(learningEvents.productProfileId)
    : eq(learningEvents.productProfileId, productProfileId);
}

/**
 * Record a decision inside the caller's transaction (see the header). Must
 * run in the SAME transaction as the state change: if anything after it
 * fails, the events roll back with the change. Throws DecisionReplayedError
 * when the key was already used (the caller rolls back and reports a
 * replay) and DecisionServiceError('invalid_input') for a malformed input.
 */
export async function recordDecision(
  tx: LearningTx,
  ctx: WorkspaceContext,
  input: RecordDecisionInput,
): Promise<RecordedDecision> {
  const parsed = RecordInputSchema.safeParse({
    kind: input.kind,
    origin: input.origin,
    decisionKey: input.decisionKey,
    subjectType: input.subject.type,
    reasonText: input.reasonText ?? null,
    reasonCodes: [...(input.reasonCodes ?? [])],
  });
  if (!parsed.success) throw invalid(`invalid decision: ${parsed.error.issues[0]?.message}`);
  const seen = new Set<string>();
  for (const e of input.events) {
    const key = `${e.subject.type}:${e.subject.id}:${e.productProfileId ?? '-'}`;
    if (seen.has(key)) throw invalid(`duplicate decision event for ${key}`);
    seen.add(key);
    if (e.verdict !== null && e.productProfileId === null) {
      throw invalid('a verdict needs a product');
    }
    weightText(e.weight);
  }

  const [header] = await tx
    .insert(learningDecisions)
    .values({
      workspaceId: ctx.workspaceId,
      decisionKey: input.decisionKey,
      kind: input.kind,
      origin: input.origin,
      subjectType: input.subject.type,
      subjectId: input.subject.id,
      userId: input.origin === 'operator' ? ctx.userId : null,
    })
    .onConflictDoNothing({ target: [learningDecisions.workspaceId, learningDecisions.decisionKey] })
    .returning({ id: learningDecisions.id });
  if (!header) throw new DecisionReplayedError(input.decisionKey);
  const decisionId = header.id;

  const supersedes = VERDICT_DECISION_KINDS.includes(input.kind);
  const status: LearningProcessingStatus = input.origin === 'operator' ? 'pending' : 'skipped';
  const events: LearningEvent[] = [];
  const voidedEventIds: bigint[] = [];

  for (const e of input.events) {
    // Earlier live verdict events on the same (subject, product). Machines
    // never void a person's verdict.
    const priors = supersedes
      ? await tx
          .select({ id: learningEvents.id, origin: learningEvents.origin })
          .from(learningEvents)
          .where(
            and(
              eq(learningEvents.workspaceId, ctx.workspaceId),
              eq(learningEvents.entityType, e.subject.type),
              eq(learningEvents.entityId, e.subject.id),
              sameProduct(e.productProfileId),
              isNull(learningEvents.voidedAt),
              ne(learningEvents.decisionId, decisionId),
              inArray(
                learningEvents.decisionId,
                tx
                  .select({ id: learningDecisions.id })
                  .from(learningDecisions)
                  .where(
                    and(
                      eq(learningDecisions.workspaceId, ctx.workspaceId),
                      inArray(learningDecisions.kind, [...VERDICT_DECISION_KINDS]),
                    ),
                  ),
              ),
              ...(input.origin === 'operator' ? [] : [ne(learningEvents.origin, 'operator')]),
            ),
          )
          .for('update')
      : [];
    const overridesAutopilot =
      input.origin === 'operator' && priors.some((p) => p.origin === 'autopilot');

    const row: NewLearningEvent = {
      workspaceId: ctx.workspaceId,
      userId: input.origin === 'operator' ? ctx.userId : null,
      entityType: e.subject.type,
      entityId: e.subject.id,
      productProfileId: e.productProfileId,
      actionType: e.actionType,
      originalComment: input.reasonText ?? null,
      confidence: Math.max(0, Math.min(100, Math.round(e.confidence))),
      decisionId,
      origin: input.origin,
      verdict: e.verdict,
      polarity: e.polarity,
      weight: weightText(e.weight),
      explicit: e.explicit,
      reasonCodes: [...(input.reasonCodes ?? [])],
      context: e.context,
      processingStatus: status,
      processedAt: status === 'skipped' ? new Date() : null,
      overridesAutopilot,
    };
    const [inserted] = await tx.insert(learningEvents).values(row).returning();
    if (!inserted)
      throw new DecisionServiceError(
        'learning_events insert returned no row',
        'invariant_violation',
      );
    events.push(inserted);

    if (priors.length > 0) {
      const now = new Date();
      const autopilotIds = priors.filter((p) => p.origin === 'autopilot').map((p) => p.id);
      const otherIds = priors.filter((p) => p.origin !== 'autopilot').map((p) => p.id);
      for (const [ids, reason] of [
        [input.origin === 'operator' ? autopilotIds : [], 'autopilot_override'],
        [input.origin === 'operator' ? otherIds : [...autopilotIds, ...otherIds], 'changed_mind'],
      ] as const) {
        if (ids.length === 0) continue;
        await tx
          .update(learningEvents)
          .set({ voidedAt: now, voidedByEventId: inserted.id, voidReason: reason })
          .where(
            and(
              eq(learningEvents.workspaceId, ctx.workspaceId),
              inArray(learningEvents.id, [...ids]),
            ),
          );
        voidedEventIds.push(...ids);
      }
    }
  }

  return {
    decisionId,
    events,
    voidedEventIds,
    pending: events.some((e) => e.processingStatus === 'pending'),
  };
}

// ---- after commit: the job --------------------------------------------------------

export const LEARNING_PROCESS_JOB = 'learning.process';

export const LearningProcessPayloadSchema = z.object({
  workspaceId: z.string().regex(/^\d+$/),
  decisionId: z.string().uuid(),
  userId: z.string().min(1),
  role: z.enum(['owner', 'admin', 'manager', 'member', 'viewer', 'super_admin']),
});
export type LearningProcessPayload = z.infer<typeof LearningProcessPayloadSchema>;

/**
 * After the decision's transaction committed: ask learning.process to work
 * the outbox. Best effort — the events are already durable as 'pending',
 * so a lost enqueue only delays learning until the KL-03 sweeper re-drives
 * them. Never throws.
 */
export async function enqueueDecisionProcessing(
  ctx: WorkspaceContext,
  decisionId: string,
): Promise<void> {
  try {
    const { getJobQueue } = await import('@/lib/jobs');
    const payload: LearningProcessPayload = {
      workspaceId: ctx.workspaceId.toString(),
      decisionId,
      userId: ctx.userId,
      role: ctx.role,
    };
    await getJobQueue().enqueue(LEARNING_PROCESS_JOB, payload, { tag: `learning:${decisionId}` });
  } catch (err) {
    console.error(
      `[learning-decisions] enqueue ${LEARNING_PROCESS_JOB} failed for ${decisionId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ---- the processor ----------------------------------------------------------------

/** "@user@example.com" mentions carry no rule — strip them before learning. */
export function stripMentions(text: string): string {
  return text
    .replace(/@[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Shortest note worth an extraction call (matches extractLesson's floor). */
export const MIN_TEACHABLE_TEXT = 8;

const MAX_ATTEMPTS = 5;

export interface ProcessDecisionResult {
  claimed: number;
  lessonId: bigint | null;
  dedupReinforced: boolean;
  reinforcedRules: number;
  statuses: Partial<Record<LearningProcessingStatus, number>>;
  error: string | null;
}

function productSnapshot(event: LearningEvent): DecisionProductSnapshot | null {
  if (event.productProfileId === null) return null;
  const parsed = DecisionContextSchema.safeParse(event.context);
  if (!parsed.success) return null;
  return parsed.data.products.find((p) => p.id === event.productProfileId!.toString()) ?? null;
}

function ruleIds(ids: readonly string[]): bigint[] {
  return Array.from(new Set(ids.filter((v) => /^\d{1,19}$/.test(v)))).map((v) => BigInt(v));
}

/**
 * Work one decision's outbox rows (the learning.process job). Claims the
 * decision's 'pending' events by a conditional UPDATE, so two workers can
 * never process the same event; voided events are closed as 'skipped' and
 * never mined. Then:
 *   1. extraction — the decision's reason (mentions stripped) is extracted
 *      ONCE; the rule is scoped to every product whose verdict points the
 *      rule's way (or workspace-wide for an unscoped event), deduped
 *      against existing rules, and linked to those events ('done'); the
 *      rest are 'no_rule';
 *   2. reinforcement — for each operator product verdict on an AI-method
 *      row, the rules that verdict used move with the verdict's polarity
 *      (rules-fallback rows never reinforce, §5).
 * A failure puts the claimed rows back to 'pending' (or 'failed' after
 * MAX_ATTEMPTS) with last_error; nothing is half-written because the rule
 * and the status update commit together. Never throws.
 */
export async function processDecision(
  ctx: WorkspaceContext,
  decisionId: string,
): Promise<ProcessDecisionResult> {
  const result: ProcessDecisionResult = {
    claimed: 0,
    lessonId: null,
    dedupReinforced: false,
    reinforcedRules: 0,
    statuses: {},
    error: null,
  };
  const claimed = await db
    .update(learningEvents)
    .set({
      processingStatus: 'processing',
      attempts: sql`${learningEvents.attempts} + 1`,
      nextAttemptAt: null,
    })
    .where(
      and(
        eq(learningEvents.workspaceId, ctx.workspaceId),
        eq(learningEvents.decisionId, decisionId),
        eq(learningEvents.processingStatus, 'pending'),
      ),
    )
    .returning();
  result.claimed = claimed.length;
  if (claimed.length === 0) return result;

  const count = (status: LearningProcessingStatus, n: number) => {
    if (n > 0) result.statuses[status] = (result.statuses[status] ?? 0) + n;
  };

  try {
    const voided = claimed.filter((e) => e.voidedAt !== null);
    const live = claimed.filter((e) => e.voidedAt === null && e.origin === 'operator');
    const machine = claimed.filter((e) => e.voidedAt === null && e.origin !== 'operator');

    // ---- 1. extraction (outside the tx: AI + embedding calls) ----
    // ONE extraction for the whole decision (I032). The rule's polarity
    // picks the events it speaks for — on a mixed decision a PREFER rule
    // belongs to the Fit products — and those events' products are its
    // scope (any unscoped event makes it workspace-wide).
    const reason = live.find((e) => e.originalComment)?.originalComment ?? null;
    const text = reason ? stripMentions(reason) : '';
    let targets: LearningEvent[] = [];
    let prepared: Awaited<ReturnType<typeof prepareLessonFromText>> = null;
    if (live.length > 0 && text.length >= MIN_TEACHABLE_TEXT) {
      prepared = await prepareLessonFromText(ctx, text, async (draft) => {
        const same =
          draft.polarity === 0 ? live : live.filter((e) => e.polarity === draft.polarity);
        targets = same.length > 0 ? same : live;
        if (targets.some((e) => e.productProfileId === null)) return { kind: 'workspace' };
        const wanted = Array.from(new Set(targets.map((e) => e.productProfileId!.toString()))).map(
          (s) => BigInt(s),
        );
        // A product deleted since the decision cannot carry a scope row.
        const existing = await db
          .select({ id: productProfiles.id })
          .from(productProfiles)
          .where(
            and(
              eq(productProfiles.workspaceId, ctx.workspaceId),
              inArray(productProfiles.id, wanted),
            ),
          );
        const scope: LessonScopeInput | null =
          existing.length > 0
            ? { kind: 'products', productProfileIds: existing.map((p) => p.id) }
            : null;
        return scope;
      });
      if (!prepared) targets = [];
    }

    // ---- write the rule + close the claimed rows, atomically ----
    const now = new Date();
    const targetIds = new Set(targets.map((t) => t.id.toString()));
    const written = await db.transaction(async (tx) => {
      const out = prepared
        ? await writePreparedLesson(
            tx,
            ctx,
            prepared,
            targets.map((t) => t.id),
          )
        : { lesson: null, dedupReinforced: false };
      const close = async (ids: bigint[], status: LearningProcessingStatus) => {
        if (ids.length === 0) return;
        await tx
          .update(learningEvents)
          .set({ processingStatus: status, processedAt: now, lastError: null })
          .where(
            and(eq(learningEvents.workspaceId, ctx.workspaceId), inArray(learningEvents.id, ids)),
          );
        count(status, ids.length);
      };
      const linked = out.lesson !== null;
      await close(
        live.filter((e) => linked && targetIds.has(e.id.toString())).map((e) => e.id),
        'done',
      );
      await close(
        live.filter((e) => !(linked && targetIds.has(e.id.toString()))).map((e) => e.id),
        'no_rule',
      );
      await close(
        [...voided, ...machine].map((e) => e.id),
        'skipped',
      );
      return out;
    });
    result.lessonId = written.lesson?.id ?? null;
    result.dedupReinforced = written.dedupReinforced;
    if (written.lesson && !written.dedupReinforced) scheduleLessonEmbedding(ctx, written.lesson.id);

    // ---- 2. reinforcement (after commit; never throws) ----
    for (const verdict of OPERATOR_VERDICTS) {
      const ids = new Set<string>();
      for (const e of live) {
        if (e.verdict !== verdict) continue;
        const snap = productSnapshot(e);
        if (!snap?.ai || snap.ai.method !== 'ai') continue;
        const used =
          snap.ai.citedLessonIds.length > 0 ? snap.ai.citedLessonIds : snap.ai.matchedLessonIds;
        for (const id of ruleIds(used)) ids.add(id.toString());
      }
      if (ids.size === 0) continue;
      const r = await reinforceLessonsForVerdict(
        ctx,
        [...ids].map((s) => BigInt(s)),
        verdict,
        `decision:${decisionId}`,
      );
      result.reinforcedRules += r.strengthened.length + r.weakened.length;
    }
    return result;
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    console.error(`[learning-decisions] processing ${decisionId} failed:`, message);
    result.error = message;
    // Give the rows back. Exponential backoff for the KL-03 sweeper; after
    // MAX_ATTEMPTS the event is 'failed'.
    for (const e of claimed) {
      const attempts = e.attempts;
      const giveUp = attempts >= MAX_ATTEMPTS;
      await db
        .update(learningEvents)
        .set({
          processingStatus: giveUp ? 'failed' : 'pending',
          lastError: message,
          nextAttemptAt: giveUp ? null : new Date(Date.now() + 2 ** attempts * 60_000),
        })
        .where(and(eq(learningEvents.workspaceId, ctx.workspaceId), eq(learningEvents.id, e.id)))
        .catch(() => {});
      count(giveUp ? 'failed' : 'pending', 1);
    }
    return result;
  }
}
