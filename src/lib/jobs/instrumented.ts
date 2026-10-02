// PC-07 (I022): instrumented(name, handler) wraps every job handler that is
// registered with the queue (q.on), so the platform can see whether
// background work runs at all.
//
// Per run it:
//   1. writes the start heartbeat (last_started_at, status 'running');
//   2. reads the job's open incidents once and hands the handler a
//      TickIncidents to report per-workspace failures and successes;
//   3. on return: writes the finish heartbeat (duration, 'ok' or
//      'degraded' when a workspace failed, consecutive_failures = 0, the
//      handler's structured summary, the next expected slot) and resolves
//      the job's own platform incident if one was open;
//   4. on throw: writes the 'failed' heartbeat (consecutive_failures + 1,
//      masked error), raises a platform incident ('tick.failed' for ticks,
//      'job.failed' for on-demand jobs) and rethrows, so the queue still
//      records the failure.
// Every heartbeat and incident write is best-effort: a failed write is
// logged and never fails the job.
//
// The returned handler carries a marker (isInstrumentedHandler) so the
// BullMQ worker's own 'failed' listener does not raise a second incident
// for a job this wrapper already reported.

import type { JobHandler, JobId, JobPayload } from './index';
import { expectedSlotAfterStart, alignmentFor } from './tick-schedule';
import {
  recordJobFinish,
  recordJobStart,
  type JobKind,
  type JobStartRecord,
} from '@/lib/services/job-heartbeats';
import {
  listOpenOpsEventFingerprints,
  opsEventFingerprint,
  raiseOpsEvent,
  resolveOpsEvent,
} from '@/lib/services/ops-events';
import { describeError } from '@/lib/ops/mask';
import {
  createTickIncidents,
  loadOpenTickFingerprints,
  type TickIncidents,
} from '@/lib/ops/tick-incidents';

const INSTRUMENTED = Symbol.for('lead-platform.instrumented-job');

export interface InstrumentedJobContext {
  jobId: JobId;
  startedAt: Date;
  /** Report per-workspace failures / successes of this run. */
  incidents: TickIncidents;
}

export type InstrumentedHandler<P extends JobPayload = JobPayload> = (
  payload: P,
  ctx: InstrumentedJobContext,
) => Promise<unknown> | unknown;

export interface InstrumentDeps {
  now: () => Date;
  recordStart: typeof recordJobStart;
  recordFinish: typeof recordJobFinish;
  raise: typeof raiseOpsEvent;
  resolve: typeof resolveOpsEvent;
  listOpen: typeof listOpenOpsEventFingerprints;
  log: (message: string, err?: unknown) => void;
}

const DEFAULT_DEPS: InstrumentDeps = {
  now: () => new Date(),
  recordStart: recordJobStart,
  recordFinish: recordJobFinish,
  raise: raiseOpsEvent,
  resolve: resolveOpsEvent,
  listOpen: listOpenOpsEventFingerprints,
  log: (message, err) => console.error(message, err instanceof Error ? err.message : (err ?? '')),
};

export interface InstrumentOptions {
  /** 'tick' = repeatable (heartbeat staleness applies); 'job' = on demand. */
  kind: JobKind;
  /** Human name for incident titles, e.g. 'Autopilot'. */
  label: string;
  /** Test seam. */
  deps?: Partial<InstrumentDeps>;
}

export type InstrumentedJobHandler<P extends JobPayload = JobPayload> = JobHandler<P> & {
  readonly [INSTRUMENTED]: string;
};

/** The platform incident kind a whole-job failure raises. */
export function jobFailureKind(kind: JobKind): 'tick.failed' | 'job.failed' {
  return kind === 'tick' ? 'tick.failed' : 'job.failed';
}

export function jobFailureFingerprint(name: string, kind: JobKind): string {
  return opsEventFingerprint({ scope: 'platform', kind: jobFailureKind(kind), dedupeKey: name });
}

export function isInstrumentedHandler(handler: unknown): boolean {
  return (
    typeof handler === 'function' &&
    typeof (handler as { [INSTRUMENTED]?: unknown })[INSTRUMENTED] === 'string'
  );
}

function summaryOf(result: unknown, failedSubjects: number): Record<string, unknown> {
  const base =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : result === undefined
        ? {}
        : { result };
  return { ...base, failedSubjects };
}

function nextDueAfter(start: JobStartRecord | null, startedAt: Date): Date | undefined {
  if (!start?.registeredAt || !start.intervalMs) return undefined;
  return new Date(
    expectedSlotAfterStart(
      startedAt.getTime(),
      start.intervalMs,
      alignmentFor(start.queueProvider),
      start.registeredAt.getTime(),
    ),
  );
}

export function instrumented<P extends JobPayload = JobPayload>(
  name: string,
  handler: InstrumentedHandler<P>,
  options: InstrumentOptions,
): InstrumentedJobHandler<P> {
  const { kind, label } = options;

  const run = async (payload: P, ctx: { jobId: JobId }): Promise<unknown> => {
    const d: InstrumentDeps = { ...DEFAULT_DEPS, ...options.deps };
    const failureFingerprint = jobFailureFingerprint(name, kind);
    const startedAt = d.now();

    let start: JobStartRecord | null = null;
    try {
      start = await d.recordStart(name, { kind, startedAt });
    } catch (err) {
      d.log(`[jobs] ${name}: start heartbeat not recorded:`, err);
    }
    const open = await loadOpenTickFingerprints(name, d.listOpen);
    const incidents = createTickIncidents({
      source: name,
      label,
      open,
      reporter: { raise: d.raise, resolve: d.resolve },
    });

    let result: unknown;
    try {
      result = await handler(payload, { jobId: ctx.jobId, startedAt, incidents });
    } catch (err) {
      const finishedAt = d.now();
      try {
        await d.recordFinish(name, {
          kind,
          startedAt,
          finishedAt,
          outcome: 'failed',
          error: describeError(err).message,
        });
      } catch (writeErr) {
        d.log(`[jobs] ${name}: failure heartbeat not recorded:`, writeErr);
      }
      try {
        await d.raise({
          scope: 'platform',
          kind: jobFailureKind(kind),
          severity: 'error',
          source: name,
          dedupeKey: name,
          title: `${label} failed`,
          error: err,
          payload: { job: name, jobId: ctx.jobId },
        });
      } catch (writeErr) {
        d.log(`[jobs] ${name}: failure incident not recorded:`, writeErr);
      }
      throw err;
    }

    const finishedAt = d.now();
    try {
      await d.recordFinish(name, {
        kind,
        startedAt,
        finishedAt,
        outcome: incidents.failedCount > 0 ? 'degraded' : 'ok',
        summary: kind === 'tick' ? summaryOf(result, incidents.failedCount) : {},
        nextDueAt: kind === 'tick' ? nextDueAfter(start, startedAt) : undefined,
      });
    } catch (err) {
      d.log(`[jobs] ${name}: finish heartbeat not recorded:`, err);
    }
    if (open === null || open.has(failureFingerprint)) {
      try {
        await d.resolve(failureFingerprint, { resolution: 'auto' });
      } catch (err) {
        d.log(`[jobs] ${name}: failure incident not resolved:`, err);
      }
    }
    return result;
  };

  return Object.assign(run, { [INSTRUMENTED]: name }) as InstrumentedJobHandler<P>;
}
