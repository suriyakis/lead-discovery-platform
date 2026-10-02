// PC-07 (I022): background-job heartbeats.
//
// Writers (system-level, called by the instrumented() wrapper and by the
// tick schedule registration — no user acts in a background job):
//   recordTickRegistration  boot: interval, provider, boot_id, registered_at
//   recordJobStart          every run: last_started_at, status 'running'
//   recordJobFinish         every run: finish, duration, status, counters
// Callers treat every write as best-effort: a heartbeat that cannot be
// written must never fail the job it describes.
//
// Readers: getTickStatuses() joins the tick catalogue with the rows and
// applies the expected-slot rule (src/lib/jobs/tick-schedule.ts).

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { jobHeartbeats, type JobHeartbeat } from '@/lib/db/schema/ops';
import { TICK_CATALOG } from '@/lib/jobs/tick-catalog';
import {
  alignmentFor,
  evaluateTick,
  firstSlotAfterRegistration,
  type TickEvaluation,
} from '@/lib/jobs/tick-schedule';
import { maskPayload, maskSensitive } from '@/lib/ops/mask';

export type JobKind = 'tick' | 'job';
/** 'degraded' = the handler finished but some workspaces failed inside it. */
export type JobRunOutcome = 'ok' | 'degraded' | 'failed';

const MAX_INT32 = 2_147_483_647;

export async function recordTickRegistration(input: {
  name: string;
  intervalMs: number;
  queueProvider: string;
  bootId: string;
  registeredAt: Date;
}): Promise<void> {
  const nextDueAt = new Date(
    firstSlotAfterRegistration(
      input.registeredAt.getTime(),
      input.intervalMs,
      alignmentFor(input.queueProvider),
    ),
  );
  const values = {
    kind: 'tick' as const,
    intervalMs: input.intervalMs,
    queueProvider: input.queueProvider,
    bootId: input.bootId,
    registeredAt: input.registeredAt,
    nextDueAt,
    updatedAt: input.registeredAt,
  };
  await db
    .insert(jobHeartbeats)
    .values({ name: input.name, ...values })
    .onConflictDoUpdate({ target: jobHeartbeats.name, set: values });
}

/** What the finish write needs to know about the schedule. */
export interface JobStartRecord {
  registeredAt: Date | null;
  intervalMs: number | null;
  queueProvider: string | null;
}

export async function recordJobStart(
  name: string,
  input: { kind: JobKind; startedAt: Date },
): Promise<JobStartRecord> {
  const [row] = await db
    .insert(jobHeartbeats)
    .values({
      name,
      kind: input.kind,
      lastStartedAt: input.startedAt,
      lastStatus: 'running',
      updatedAt: input.startedAt,
    })
    .onConflictDoUpdate({
      target: jobHeartbeats.name,
      set: { lastStartedAt: input.startedAt, lastStatus: 'running', updatedAt: input.startedAt },
    })
    .returning({
      registeredAt: jobHeartbeats.registeredAt,
      intervalMs: jobHeartbeats.intervalMs,
      queueProvider: jobHeartbeats.queueProvider,
    });
  return row ?? { registeredAt: null, intervalMs: null, queueProvider: null };
}

export async function recordJobFinish(
  name: string,
  input: {
    kind: JobKind;
    startedAt: Date;
    finishedAt: Date;
    outcome: JobRunOutcome;
    /** The handler's structured summary (ok/degraded runs). Masked. */
    summary?: unknown;
    /** Message of what was thrown (failed runs). Masked. */
    error?: string | null;
    /** Next expected slot; omitted for on-demand jobs. */
    nextDueAt?: Date | null;
  },
): Promise<void> {
  const ok = input.outcome !== 'failed';
  const durationMs = Math.min(
    MAX_INT32,
    Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime()),
  );
  const summary = ok ? (maskPayload(input.summary ?? {}) as Record<string, unknown>) : undefined;
  const error = ok ? null : maskSensitive(input.error ?? 'unknown error');
  const outcomeFields = ok
    ? { lastOkAt: input.finishedAt, lastSummary: summary ?? {} }
    : { lastError: error, lastErrorAt: input.finishedAt };
  const nextDue = input.nextDueAt !== undefined ? { nextDueAt: input.nextDueAt } : {};

  await db
    .insert(jobHeartbeats)
    .values({
      // Only reached when the start write failed: rebuild what we can.
      name,
      kind: input.kind,
      lastStartedAt: input.startedAt,
      lastFinishedAt: input.finishedAt,
      lastStatus: input.outcome,
      lastDurationMs: durationMs,
      runCount: 1,
      consecutiveFailures: ok ? 0 : 1,
      ...outcomeFields,
      ...nextDue,
      updatedAt: input.finishedAt,
    })
    .onConflictDoUpdate({
      target: jobHeartbeats.name,
      set: {
        lastFinishedAt: input.finishedAt,
        lastStatus: input.outcome,
        lastDurationMs: durationMs,
        runCount: sql`${jobHeartbeats.runCount} + 1`,
        consecutiveFailures: ok ? 0 : sql`${jobHeartbeats.consecutiveFailures} + 1`,
        ...outcomeFields,
        ...nextDue,
        updatedAt: input.finishedAt,
      },
    });
}

export async function listJobHeartbeats(): Promise<JobHeartbeat[]> {
  return db.select().from(jobHeartbeats).orderBy(jobHeartbeats.name);
}

export interface TickStatus extends TickEvaluation {
  label: string;
  intervalMs: number | null;
  queueProvider: string | null;
  bootId: string | null;
  registeredAt: Date | null;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastOkAt: Date | null;
  lastStatus: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  runCount: number;
}

/**
 * One status per catalogued tick (rows of retired ticks are ignored; a
 * tick with no row is 'unscheduled'). Pure — pass the rows and the clock.
 */
export function buildTickStatuses(
  rows: readonly JobHeartbeat[],
  now: Date,
  options: { processBootedAt?: Date | null; bootGraceMs?: number } = {},
): TickStatus[] {
  const byName = new Map(rows.map((r) => [r.name, r]));
  return TICK_CATALOG.map((def) => {
    const row = byName.get(def.name);
    const evaluation = evaluateTick(
      {
        name: def.name,
        intervalMs: row?.intervalMs ?? null,
        queueProvider: row?.queueProvider ?? null,
        registeredAt: row?.registeredAt ?? null,
        lastStartedAt: row?.lastStartedAt ?? null,
        consecutiveFailures: row?.consecutiveFailures ?? 0,
      },
      now,
      options,
    );
    return {
      ...evaluation,
      label: def.label,
      intervalMs: row?.intervalMs ?? null,
      queueProvider: row?.queueProvider ?? null,
      bootId: row?.bootId ?? null,
      registeredAt: row?.registeredAt ?? null,
      lastStartedAt: row?.lastStartedAt ?? null,
      lastFinishedAt: row?.lastFinishedAt ?? null,
      lastOkAt: row?.lastOkAt ?? null,
      lastStatus: row?.lastStatus ?? null,
      lastDurationMs: row?.lastDurationMs ?? null,
      lastError: row?.lastError ?? null,
      runCount: row?.runCount ?? 0,
    };
  });
}

export async function getTickStatuses(
  now: Date = new Date(),
  options: { processBootedAt?: Date | null; bootGraceMs?: number } = {},
): Promise<TickStatus[]> {
  return buildTickStatuses(await listJobHeartbeats(), now, options);
}
