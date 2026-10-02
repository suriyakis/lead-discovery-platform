// The reinforcement ledger (KL-03, §6 of the KL plan).
//
// Every confidence change a decision causes on a rule is a
// lesson_reinforcements row written in the SAME transaction as the
// confidence update:
//
//   - cited:        an operator verdict on a record whose AI verdict cited
//                   the rule. sign = verdict (Fit +1, Not a fit -1) x
//                   citation effect (toward_fit +1, against_fit -1); +2
//                   when they agree, -3 when they oppose, x the event
//                   weight (rounded half away from zero). Only operator
//                   events, only AI-method verdicts at or above the
//                   threshold (the processor filters).
//   - dedup_match:  the decision's extracted rule repeated this one: +5.
//   - compensation: the event behind a row was voided (a changed mind, an
//                   undo, an operator overturning autopilot): the row's
//                   delta_applied is reversed exactly, and a rule whose
//                   evidence is now only voided events is retired
//                   ('source_decision_voided').
//
// Forward steps stay inside 5..95 and never move a rule against their own
// direction (a hand-set 97 is not pulled down to 95 by an agreement); the
// row records what was really applied, so compensation is exact.
//
// Lock order (deadlock-free with recordDecision and the lesson editors):
// decision events first (ascending id), then rules (ascending id).

import { and, asc, eq, inArray, isNotNull, isNull, ne, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  learningEvents,
  learningLessons,
  lessonReinforcements,
  type LessonLifecycle,
  type LessonReinforcement,
  type OperatorVerdict,
} from '@/lib/db/schema/learning';
import { recordAuditEvent } from './audit';
import type { WorkspaceContext } from './context';
import { retireLessons, type LearningTx } from './learning';

export const REINFORCE_AGREE_STEP = 2;
export const REINFORCE_OPPOSE_STEP = 3;
export const DEDUP_MATCH_STEP = 5;
export const REINFORCE_FLOOR = 5;
export const REINFORCE_CEILING = 95;

export type CitationEffect = 'toward_fit' | 'against_fit';

/** Half away from zero, so a half-weight -3 is -2, not -1. */
function roundAway(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/**
 * The step a verdict gives a cited rule: +2 when the citation pointed the
 * way the operator decided, -3 when it pointed the other way, times the
 * event weight (1, or 0.5 for an untouched default, archive and ignore).
 */
export function verdictReinforcementDelta(
  verdict: OperatorVerdict,
  effect: CitationEffect,
  weight: number,
): number {
  const sign = (verdict === 'fit' ? 1 : -1) * (effect === 'toward_fit' ? 1 : -1);
  const step = sign > 0 ? REINFORCE_AGREE_STEP : -REINFORCE_OPPOSE_STEP;
  const delta = roundAway(step * weight);
  return delta === 0 ? Math.sign(step) : delta;
}

/** Confidence after a forward step: bounded to 5..95 and never moved
 *  against the step's direction. */
export function boundedConfidence(before: number, delta: number): number {
  if (delta > 0) return Math.max(before, Math.min(before + delta, REINFORCE_CEILING));
  if (delta < 0) return Math.min(before, Math.max(before + delta, REINFORCE_FLOOR));
  return before;
}

export interface LockedLesson {
  id: bigint;
  confidence: number;
  polarity: number;
  lifecycle: LessonLifecycle;
  evidenceEventIds: bigint[];
}

/** Lock rules (FOR UPDATE, ascending id) and return their current state. */
export async function lockLessons(
  tx: LearningTx,
  workspaceId: bigint,
  ids: readonly bigint[],
): Promise<Map<string, LockedLesson>> {
  const out = new Map<string, LockedLesson>();
  const unique = Array.from(new Set(ids.map((i) => i.toString()))).map((s) => BigInt(s));
  if (unique.length === 0) return out;
  const rows = await tx
    .select({
      id: learningLessons.id,
      confidence: learningLessons.confidence,
      polarity: learningLessons.polarity,
      lifecycle: learningLessons.lifecycle,
      evidenceEventIds: learningLessons.evidenceEventIds,
    })
    .from(learningLessons)
    .where(and(eq(learningLessons.workspaceId, workspaceId), inArray(learningLessons.id, unique)))
    .orderBy(asc(learningLessons.id))
    .for('update');
  for (const r of rows) out.set(r.id.toString(), { ...r });
  return out;
}

export interface ForwardEntry {
  lessonId: bigint;
  eventId: bigint;
  kind: 'cited' | 'dedup_match';
  delta: number;
  reason: string;
}

async function setConfidence(
  tx: LearningTx,
  workspaceId: bigint,
  lessonId: bigint,
  confidence: number,
  now: Date,
): Promise<void> {
  await tx
    .update(learningLessons)
    .set({ confidence, reinforcedAt: now })
    .where(and(eq(learningLessons.workspaceId, workspaceId), eq(learningLessons.id, lessonId)));
}

/**
 * Write forward ledger rows and apply them. The rules must already be
 * locked (lockLessons); `locked` is updated as confidences move. A row for
 * an (event, rule) pair that already exists is skipped — a re-run never
 * moves a rule twice for one decision. Retired rules are left alone.
 */
export async function applyForwardEntries(
  tx: LearningTx,
  workspaceId: bigint,
  locked: Map<string, LockedLesson>,
  entries: readonly ForwardEntry[],
  now: Date,
): Promise<LessonReinforcement[]> {
  const written: LessonReinforcement[] = [];
  for (const e of entries) {
    const lesson = locked.get(e.lessonId.toString());
    if (!lesson || lesson.lifecycle === 'retired') continue;
    const before = lesson.confidence;
    const after = boundedConfidence(before, e.delta);
    const [row] = await tx
      .insert(lessonReinforcements)
      .values({
        workspaceId,
        lessonId: e.lessonId,
        eventId: e.eventId,
        kind: e.kind,
        deltaRequested: e.delta,
        deltaApplied: after - before,
        confidenceBefore: before,
        confidenceAfter: after,
        reason: e.reason,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) continue;
    written.push(row);
    if (after !== before) await setConfidence(tx, workspaceId, e.lessonId, after, now);
    lesson.confidence = after;
  }
  return written;
}

export interface CompensationResult {
  compensated: LessonReinforcement[];
  /** Rules retired because every event they were learned from is voided. */
  retired: bigint[];
  /** Every rule locked by the call (the compensated ones, the retirement
   *  candidates and `alsoLock`), with their state after it. */
  locked: Map<string, LockedLesson>;
}

const compensation = alias(lessonReinforcements, 'compensation');

/**
 * Undo what voided events did to rules (§6 "Decisions can be taken back"):
 * every forward ledger row of theirs not yet compensated is reversed by
 * its exact delta_applied, and every rule whose evidence events are now all
 * voided is retired with 'source_decision_voided'. Idempotent (each forward
 * row is compensated at most once; a retired rule stays retired). Runs in
 * the caller's transaction; locks the voided events, then — in ONE
 * ascending pass — the rules it touches plus `alsoLock` (the rules the
 * caller is about to move), so callers never take rule locks out of order.
 * Ids of events that are not voided are ignored.
 */
export async function compensateVoidedEvents(
  tx: LearningTx,
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
  eventIds: readonly bigint[],
  now: Date,
  alsoLock: readonly bigint[] = [],
): Promise<CompensationResult> {
  const ids = Array.from(new Set(eventIds.map((i) => i.toString()))).map((s) => BigInt(s));
  const voided =
    ids.length === 0
      ? []
      : await tx
          .select({ id: learningEvents.id, voidReason: learningEvents.voidReason })
          .from(learningEvents)
          .where(
            and(
              eq(learningEvents.workspaceId, ctx.workspaceId),
              inArray(learningEvents.id, ids),
              isNotNull(learningEvents.voidedAt),
            ),
          )
          .orderBy(asc(learningEvents.id))
          .for('update');
  if (voided.length === 0) {
    return {
      compensated: [],
      retired: [],
      locked: await lockLessons(tx, ctx.workspaceId, alsoLock),
    };
  }
  const voidedIds = voided.map((v) => v.id);
  const reasonOf = new Map(voided.map((v) => [v.id.toString(), v.voidReason ?? 'changed_mind']));

  const forward = await tx
    .select()
    .from(lessonReinforcements)
    .where(
      and(
        eq(lessonReinforcements.workspaceId, ctx.workspaceId),
        inArray(lessonReinforcements.eventId, voidedIds),
        isNull(lessonReinforcements.compensatesId),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(compensation)
            .where(eq(compensation.compensatesId, lessonReinforcements.id)),
        ),
      ),
    )
    .orderBy(asc(lessonReinforcements.id));

  // Rules learned from these events (evidence) that are still in service.
  const evidenceArray = sql`ARRAY[${sql.join(
    voidedIds.map((id) => sql`${id.toString()}`),
    sql`, `,
  )}]::bigint[]`;
  const learnedFrom = await tx
    .select({ id: learningLessons.id })
    .from(learningLessons)
    .where(
      and(
        eq(learningLessons.workspaceId, ctx.workspaceId),
        ne(learningLessons.lifecycle, 'retired'),
        sql`${learningLessons.evidenceEventIds} && ${evidenceArray}`,
      ),
    );

  const locked = await lockLessons(tx, ctx.workspaceId, [
    ...forward.map((f) => f.lessonId),
    ...learnedFrom.map((l) => l.id),
    ...alsoLock,
  ]);
  const result: CompensationResult = { compensated: [], retired: [], locked };

  for (const f of forward) {
    const lesson = locked.get(f.lessonId.toString());
    if (!lesson) continue;
    const before = lesson.confidence;
    const after = Math.max(0, Math.min(100, before - f.deltaApplied));
    const [row] = await tx
      .insert(lessonReinforcements)
      .values({
        workspaceId: ctx.workspaceId,
        lessonId: f.lessonId,
        eventId: f.eventId,
        kind: 'compensation',
        deltaRequested: -f.deltaApplied,
        deltaApplied: after - before,
        confidenceBefore: before,
        confidenceAfter: after,
        compensatesId: f.id,
        reason: `void:${reasonOf.get(f.eventId.toString()) ?? 'changed_mind'}`,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) continue;
    result.compensated.push(row);
    if (after !== before) await setConfidence(tx, ctx.workspaceId, f.lessonId, after, now);
    lesson.confidence = after;
  }

  // Retire the rules whose every evidence event is voided. A rule with no
  // evidence (hand-made) is never touched.
  for (const l of learnedFrom) {
    const lesson = locked.get(l.id.toString());
    if (!lesson || lesson.lifecycle === 'retired' || lesson.evidenceEventIds.length === 0) continue;
    const live = await tx
      .select({ id: learningEvents.id })
      .from(learningEvents)
      .where(
        and(
          eq(learningEvents.workspaceId, ctx.workspaceId),
          inArray(learningEvents.id, lesson.evidenceEventIds),
          isNull(learningEvents.voidedAt),
        ),
      )
      .limit(1);
    if (live.length > 0) continue;
    const retired = await retireLessons(tx, ctx.workspaceId, [l.id], {
      reason: 'source_decision_voided',
      note: 'The decision this rule was learned from was changed or undone.',
    });
    if (retired.length === 0) continue;
    lesson.lifecycle = 'retired';
    result.retired.push(l.id);
    await recordAuditEvent(
      ctx,
      {
        kind: 'learning.lesson.retire',
        entityType: 'learning_lesson',
        entityId: l.id,
        payload: {
          reason: 'source_decision_voided',
          evidenceEventIds: lesson.evidenceEventIds.map((id) => id.toString()),
        },
      },
      tx,
    );
  }
  return result;
}

/** The ledger rows of a decision's events (receipts, KL-21's history). */
export async function listReinforcementsForEvents(
  exec: Pick<LearningTx, 'select'>,
  workspaceId: bigint,
  eventIds: readonly bigint[],
): Promise<LessonReinforcement[]> {
  if (eventIds.length === 0) return [];
  return exec
    .select()
    .from(lessonReinforcements)
    .where(
      and(
        eq(lessonReinforcements.workspaceId, workspaceId),
        inArray(lessonReinforcements.eventId, [...eventIds]),
      ),
    )
    .orderBy(asc(lessonReinforcements.id));
}
