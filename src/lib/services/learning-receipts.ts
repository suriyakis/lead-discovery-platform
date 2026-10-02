// Decision receipts (KL-03): what the platform actually learned from one
// decision — read by GET /api/learning/receipts/[decisionId] and, with
// KL-20, by the <LearningReceipt> under the review decision panel.
//
// A receipt only tells the truth recorded by the processor: the events'
// processing status and note, the rule each event produced or
// strengthened, and the reinforcement ledger (which rules moved, by how
// much, and what a later change of mind undid). Workspace-scoped: another
// workspace's decision does not exist here.

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  learningDecisions,
  learningEvents,
  learningLessons,
  lessonReinforcements,
  type DecisionOrigin,
  type LearningProcessingStatus,
  type LessonReinforcementKind,
  type OperatorVerdict,
} from '@/lib/db/schema/learning';
import type { WorkspaceContext } from './context';
import { lessonCategoryLabel, type LessonPolarity } from './learning-categories';
import { DecisionContextSchema } from './learning-decisions';
import { decisionSourceLabel } from './learning-extraction';

export type ReceiptState =
  | 'learning'
  | 'learned'
  | 'strengthened'
  | 'not_recreated'
  | 'too_uncertain'
  | 'waiting_for_tokens'
  | 'waiting_for_ai'
  | 'failed'
  | 'changed_later'
  | 'recorded_only'
  | 'nothing_new';

export const RECEIPT_HEADLINES: Record<ReceiptState, string> = {
  learning: 'Learning from this decision…',
  learned: 'Learned a new rule',
  strengthened: 'Matched an existing rule — strengthened it',
  not_recreated: 'This matches a rule you rejected — it was not recreated',
  too_uncertain: 'Nothing learned: the suggested rule was too uncertain',
  waiting_for_tokens: 'Waiting for tokens — learning resumes after a top-up',
  waiting_for_ai: 'Waiting for an AI provider — learning resumes once one is set up',
  failed: 'Learning failed after 5 tries. Your decision is saved.',
  changed_later: 'This decision was changed later, so it no longer teaches',
  recorded_only: 'Recorded for the audit trail — automatic decisions never teach',
  nothing_new: 'Nothing new to learn from this decision',
};

export interface DecisionReceiptEvent {
  id: string;
  subject: { type: string | null; id: string | null };
  productId: string | null;
  productName: string | null;
  verdict: OperatorVerdict | null;
  weight: number;
  status: LearningProcessingStatus;
  note: string | null;
  voided: { at: string; reason: string | null } | null;
  lessonId: string | null;
}

export interface DecisionReceiptRule {
  lessonId: string;
  rule: string;
  category: string;
  categoryLabel: string;
  polarity: number;
  confidence: number;
  lifecycle: string;
  outcome: 'created' | 'strengthened';
  /** "from your approval" / "from your rejection" for a rule learned from
   *  a disagreement without a note or chip. */
  label: string | null;
}

export interface DecisionReceiptChange {
  lessonId: string;
  rule: string;
  kind: LessonReinforcementKind;
  deltaApplied: number;
  confidenceAfter: number;
  reason: string;
  /** A later change of mind reversed this change. */
  undone: boolean;
}

export interface DecisionReceipt {
  decisionId: string;
  kind: string;
  origin: DecisionOrigin;
  createdAt: string;
  subject: { type: string; id: string | null };
  state: ReceiptState;
  headline: string;
  details: string[];
  events: DecisionReceiptEvent[];
  rules: DecisionReceiptRule[];
  /** Ledger rows this decision's events wrote (cited / dedup_match). */
  changes: DecisionReceiptChange[];
  /** What this decision undid of the decisions it superseded. */
  undid: {
    compensations: DecisionReceiptChange[];
    retiredRules: Array<{ lessonId: string; rule: string }>;
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The receipt of one decision in the caller's workspace, or null when the
 * id is malformed or the decision is not this workspace's (the route turns
 * that into 404 — another tenant's decision is indistinguishable from a
 * missing one).
 */
export async function getDecisionReceipt(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  decisionId: string,
): Promise<DecisionReceipt | null> {
  if (!UUID_RE.test(decisionId)) return null;
  const [decision] = await db
    .select()
    .from(learningDecisions)
    .where(
      and(eq(learningDecisions.workspaceId, ctx.workspaceId), eq(learningDecisions.id, decisionId)),
    );
  if (!decision) return null;

  const events = await db
    .select()
    .from(learningEvents)
    .where(
      and(
        eq(learningEvents.workspaceId, ctx.workspaceId),
        eq(learningEvents.decisionId, decisionId),
      ),
    )
    .orderBy(asc(learningEvents.id));
  const eventIds = events.map((e) => e.id);

  const own = eventIds.length
    ? await db
        .select()
        .from(lessonReinforcements)
        .where(
          and(
            eq(lessonReinforcements.workspaceId, ctx.workspaceId),
            inArray(lessonReinforcements.eventId, eventIds),
          ),
        )
        .orderBy(asc(lessonReinforcements.id))
    : [];
  const voidedByThese = eventIds.length
    ? await db
        .select({ id: learningEvents.id })
        .from(learningEvents)
        .where(
          and(
            eq(learningEvents.workspaceId, ctx.workspaceId),
            inArray(learningEvents.voidedByEventId, eventIds),
          ),
        )
    : [];
  const voidedIds = voidedByThese.map((v) => v.id);
  const undoneRows = voidedIds.length
    ? await db
        .select()
        .from(lessonReinforcements)
        .where(
          and(
            eq(lessonReinforcements.workspaceId, ctx.workspaceId),
            inArray(lessonReinforcements.eventId, voidedIds),
            eq(lessonReinforcements.kind, 'compensation'),
          ),
        )
        .orderBy(asc(lessonReinforcements.id))
    : [];
  const retiredRows = voidedIds.length
    ? await db
        .select({ id: learningLessons.id, rule: learningLessons.rule })
        .from(learningLessons)
        .where(
          and(
            eq(learningLessons.workspaceId, ctx.workspaceId),
            eq(learningLessons.retiredReason, 'source_decision_voided'),
            sql`${learningLessons.evidenceEventIds} && ARRAY[${sql.join(
              voidedIds.map((id) => sql`${id.toString()}`),
              sql`, `,
            )}]::bigint[]`,
          ),
        )
    : [];

  const lessonIds = Array.from(
    new Set(
      [
        ...events.map((e) => e.extractedLessonId),
        ...own.map((r) => r.lessonId),
        ...undoneRows.map((r) => r.lessonId),
      ]
        .filter((id): id is bigint => id !== null)
        .map((id) => id.toString()),
    ),
  ).map((s) => BigInt(s));
  const lessons = lessonIds.length
    ? await db
        .select()
        .from(learningLessons)
        .where(
          and(
            eq(learningLessons.workspaceId, ctx.workspaceId),
            inArray(learningLessons.id, lessonIds),
          ),
        )
    : [];
  const lessonById = new Map(lessons.map((l) => [l.id.toString(), l]));

  const compensatedIds = new Set(
    own.filter((r) => r.kind === 'compensation').map((r) => r.compensatesId?.toString()),
  );
  const change = (r: (typeof own)[number]): DecisionReceiptChange => ({
    lessonId: r.lessonId.toString(),
    rule: lessonById.get(r.lessonId.toString())?.rule ?? '',
    kind: r.kind,
    deltaApplied: r.deltaApplied,
    confidenceAfter: r.confidenceAfter,
    reason: r.reason,
    undone: compensatedIds.has(r.id.toString()),
  });
  const changes = own.filter((r) => r.kind !== 'compensation').map(change);

  const receiptEvents: DecisionReceiptEvent[] = events.map((e) => {
    const ctxParsed = DecisionContextSchema.safeParse(e.context);
    const product =
      ctxParsed.success && e.productProfileId !== null
        ? ctxParsed.data.products.find((p) => p.id === e.productProfileId!.toString())
        : undefined;
    return {
      id: e.id.toString(),
      subject: { type: e.entityType, id: e.entityId },
      productId: e.productProfileId?.toString() ?? null,
      productName: product?.name ?? null,
      verdict: e.verdict,
      weight: Number(e.weight),
      status: e.processingStatus,
      note: e.processingNote,
      voided: e.voidedAt ? { at: e.voidedAt.toISOString(), reason: e.voidReason } : null,
      lessonId: e.extractedLessonId?.toString() ?? null,
    };
  });

  const rules: DecisionReceiptRule[] = [];
  const seenRules = new Set<string>();
  for (const e of events) {
    if (!e.extractedLessonId || e.processingStatus !== 'done') continue;
    const key = e.extractedLessonId.toString();
    if (seenRules.has(key)) continue;
    const lesson = lessonById.get(key);
    if (!lesson) continue;
    seenRules.add(key);
    const strengthened = e.processingNote === 'rule_strengthened';
    rules.push({
      lessonId: key,
      rule: lesson.rule,
      category: lesson.category,
      categoryLabel: lessonCategoryLabel(lesson.category),
      polarity: lesson.polarity,
      confidence: lesson.confidence,
      lifecycle: lesson.lifecycle,
      outcome: strengthened ? 'strengthened' : 'created',
      label:
        e.processingNote === 'rule_created_from_verdict'
          ? decisionSourceLabel(lesson.polarity as LessonPolarity)
          : null,
    });
  }

  const has = (pred: (e: (typeof events)[number]) => boolean) => events.some(pred);
  let state: ReceiptState;
  if (events.length === 0) state = decision.origin === 'operator' ? 'nothing_new' : 'recorded_only';
  else if (events.every((e) => e.voidedAt !== null)) state = 'changed_later';
  else if (has((e) => e.processingStatus === 'pending' || e.processingStatus === 'processing')) {
    state = 'learning';
  } else if (has((e) => e.processingStatus === 'failed')) state = 'failed';
  else if (has((e) => e.processingStatus === 'skipped_no_tokens')) {
    state = has((e) => e.processingNote === 'no_ai_provider')
      ? 'waiting_for_ai'
      : 'waiting_for_tokens';
  } else if (rules.some((r) => r.outcome === 'created')) state = 'learned';
  else if (rules.some((r) => r.outcome === 'strengthened')) state = 'strengthened';
  else if (has((e) => e.processingNote === 'matches_rejected_rule')) state = 'not_recreated';
  else if (has((e) => e.processingStatus === 'below_floor')) state = 'too_uncertain';
  else if (events.every((e) => e.origin !== 'operator')) state = 'recorded_only';
  else state = 'nothing_new';

  let headline = RECEIPT_HEADLINES[state];
  const created = rules.find((r) => r.outcome === 'created' && r.label);
  if (state === 'learned' && created?.label) headline = `${headline} ${created.label}`;

  const details: string[] = [];
  const cited = changes.filter((c) => c.kind === 'cited' && !c.undone);
  const up = cited.filter((c) => c.deltaApplied > 0).length;
  const down = cited.filter((c) => c.deltaApplied < 0).length;
  if (up > 0) details.push(`Strengthened ${plural(up, 'rule', 'rules')} the AI relied on.`);
  if (down > 0)
    details.push(`Weakened ${plural(down, 'rule', 'rules')} that pointed the other way.`);
  const compensations = undoneRows.map(change);
  if (compensations.length > 0 || retiredRows.length > 0) {
    const parts: string[] = [];
    if (compensations.length > 0) {
      parts.push(
        `${plural(new Set(compensations.map((c) => c.lessonId)).size, 'rule', 'rules')} restored`,
      );
    }
    if (retiredRows.length > 0)
      parts.push(`${plural(retiredRows.length, 'rule', 'rules')} retired`);
    details.push(`Undid your earlier decision: ${parts.join(', ')}.`);
  }

  return {
    decisionId: decision.id,
    kind: decision.kind,
    origin: decision.origin,
    createdAt: decision.createdAt.toISOString(),
    subject: { type: decision.subjectType, id: decision.subjectId },
    state,
    headline,
    details,
    events: receiptEvents,
    rules,
    changes,
    undid: {
      compensations,
      retiredRules: retiredRows.map((r) => ({ lessonId: r.id.toString(), rule: r.rule })),
    },
  };
}
