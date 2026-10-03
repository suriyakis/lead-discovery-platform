// Connector runner — executes a registered connector against a recipe and
// persists the resulting events.
//
// Lifecycle:
//   1. Caller has already inserted a connector_runs row with status=pending.
//   2. runConnectorRun() claims it (pending → running, conditional: a run
//      that was cancelled, reaped or is already running elsewhere is left
//      alone), iterates the async iterable from the connector, and writes:
//        - 'log'      → connector_run_logs row
//        - 'record'   → source_records row (skipped on dedupe conflict)
//        - 'progress' → connector_runs.progress + record_count update
//        - 'error'    → connector_run_logs + (if fatal) end run as failed
//   3. On clean iteration end, status -> succeeded; PC-10 (I074): when
//      some steps reported a non-fatal error (e.g. a search query failed)
//      the run ends 'partial' instead.
//   4. On thrown error from the connector, status -> failed.
//   5. On AbortSignal abort, or a cancel request, status -> cancelled.
//
// PC-10: the runner keeps a heartbeat (last_progress_at) on every progress
// event and at least every PROGRESS_TOUCH_MS while events flow, and reads
// cancel_requested_at on the same write. Cancel therefore works across
// processes: the action sets the column, whichever worker runs the
// connector sees it at its next step (one search query at most) and stops.
// The same write tells the runner when the stuck-work reaper has failed
// the run meanwhile; it then stops without overwriting that outcome.

import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  connectorRuns,
  connectorRunLogs,
  connectors,
  sourceRecords,
  type ConnectorRun,
  type ConnectorRunStatus,
  type NewConnectorRunLog,
  type NewSourceRecord,
} from '@/lib/db/schema/connectors';
import type { WorkspaceContext } from '@/lib/services/context';
import { classifySourceRecord } from '@/lib/services/qualification';
import { seedReviewItem } from '@/lib/services/review';
import { reportRunFailed, resolveRunIncidents, resolveRunStuck } from '@/lib/ops/work-incidents';
import {
  acquireWorkLease,
  describeLeaseHolder,
  type LeaseHolder,
  type WorkLease,
} from '@/lib/services/work-leases';
import { getConnector } from './registry';

// Side-effect imports: each connector implementation calls
// `registerConnector(new ...)` at module load. Without these imports
// the registry is empty at runtime and `getConnector(templateType)`
// throws — silently inside the in-memory job microtask, leaving the
// connector_runs row stuck on 'pending' with no log line. Importing
// here makes the connectors load whenever the runner does.
import './mock';
import './internet-search';

/** How a run ended. */
export type RunOutcome = 'succeeded' | 'partial' | 'failed' | 'cancelled';

/** Statuses a run never leaves. */
export const TERMINAL_RUN_STATUSES: readonly ConnectorRunStatus[] = [
  'succeeded',
  'partial',
  'failed',
  'cancelled',
];

export function isTerminalRunStatus(status: ConnectorRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export interface RunResult {
  /** 'skipped': this call did not execute the run — it was no longer
   *  pending when it arrived (cancelled first, already running in another
   *  process, a duplicate delivery), or the reaper ended it meanwhile. */
  status: RunOutcome | 'skipped';
  recordCount: number;
  error?: { message: string; payload?: unknown };
  /** 'skipped' only: the run's status as this call found it. */
  currentStatus?: ConnectorRunStatus;
}

/** The heartbeat is written at least this often while events flow. */
export const PROGRESS_TOUCH_MS = 5_000;

/** PC-12: why a run stopped when another run of its recipe took the
 *  recipe lease over (it made no progress for the lease's whole TTL). */
export const RUN_TAKEN_OVER_MESSAGE =
  'Stopped: this run made no progress for 15 minutes and another run of the recipe took over. Records found before that are kept.';

/**
 * Execute a pending run. PC-12 (I068): a recipe's run executes under the
 * recipe's 'connector.recipe' work lease, renewed at the run's progress
 * checkpoints (its TTL is the reaper's 15-minute no-progress window), so
 * two runs of one recipe never execute side by side — not even when the
 * reaper gave up on a run whose worker is in fact still going. startRun
 * already refuses a second run while one is pending or running; a run
 * that finds the lease held anyway ends 'cancelled' with why, before it
 * starts (a queue retry could not wait out the lease).
 */
export async function runConnectorRun(
  ctx: WorkspaceContext,
  runId: bigint,
  options: { signal?: AbortSignal } = {},
): Promise<RunResult> {
  // Load the run + the parent connector.
  const runRows = await db
    .select()
    .from(connectorRuns)
    .where(eq(connectorRuns.id, runId));
  const run = runRows[0];
  if (!run) throw new Error(`connector_runs row ${runId} not found`);
  if (run.workspaceId !== ctx.workspaceId) {
    throw new Error(`connector_runs row ${runId} is not in this workspace`);
  }
  if (run.status !== 'pending') {
    return notStarted(runId, run.status, run.recordCount);
  }
  if (run.recipeId === null) return executeRun(ctx, run, options, null);

  const got = await acquireWorkLease(ctx, {
    kind: 'connector.recipe',
    resource: run.recipeId,
    purpose: `run ${runId}`,
  });
  if (!got.acquired) return refuseOverlappingRun(run, got.held);
  try {
    return await executeRun(ctx, run, options, got.lease);
  } finally {
    try {
      await got.lease.release();
    } catch (err) {
      console.error(
        `[runner] run ${runId}: recipe lease not released (it expires on its own):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/** PC-12: another run of the recipe still holds its lease — end this one
 *  before it starts, saying why (only while it is still pending). */
async function refuseOverlappingRun(run: ConnectorRun, held: LeaseHolder): Promise<RunResult> {
  const message =
    `Not started: another run of this recipe was still executing ${describeLeaseHolder(held)}. ` +
    'A recipe runs once at a time; start it again when that run has ended.';
  const now = new Date();
  const [cancelled] = await db
    .update(connectorRuns)
    .set({
      status: 'cancelled',
      startedAt: now,
      completedAt: now,
      errorPayload: { message, reason: 'recipe_busy' },
      updatedAt: now,
    })
    .where(and(eq(connectorRuns.id, run.id), eq(connectorRuns.status, 'pending')))
    .returning({ id: connectorRuns.id });
  if (!cancelled) return notStarted(run.id, null, run.recordCount);
  await insertLog(run.id, 'warn', message, { reason: 'recipe_busy' });
  return { status: 'cancelled', recordCount: 0, error: { message } };
}

async function executeRun(
  ctx: WorkspaceContext,
  run: ConnectorRun,
  options: { signal?: AbortSignal },
  lease: WorkLease | null,
): Promise<RunResult> {
  const runId = run.id;
  const connectorRows = await db
    .select()
    .from(connectors)
    .where(eq(connectors.id, run.connectorId));
  const connector = connectorRows[0];
  if (!connector) throw new Error(`connectors row ${run.connectorId} not found`);
  const runRef = {
    workspaceId: ctx.workspaceId,
    runId,
    connectorId: run.connectorId,
    recipeId: run.recipeId,
  };

  // Resolve the connector impl. A miss here used to throw before the
  // status flip and leave the row stuck on 'pending' with no log line.
  // Surface it as a proper failure so the operator sees it.
  let impl;
  try {
    impl = getConnector(connector.templateType);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const [failed] = await db
      .update(connectorRuns)
      .set({
        status: 'failed',
        startedAt: new Date(),
        completedAt: new Date(),
        errorPayload: { message },
        updatedAt: new Date(),
      })
      .where(and(eq(connectorRuns.id, runId), eq(connectorRuns.status, 'pending')))
      .returning({ id: connectorRuns.id });
    if (!failed) return notStarted(runId, null, run.recordCount);
    await insertLog(runId, 'error', message);
    await reportRunFailed(runRef, message);
    return { status: 'failed', recordCount: 0, error: { message } };
  }

  // Claim: pending → running. Conditional, so a run cancelled while it
  // waited (or picked up twice) is not executed.
  const startedAt = new Date();
  const [claimed] = await db
    .update(connectorRuns)
    .set({ status: 'running', startedAt, lastProgressAt: startedAt, updatedAt: startedAt })
    .where(and(eq(connectorRuns.id, runId), eq(connectorRuns.status, 'pending')))
    .returning({ id: connectorRuns.id });
  if (!claimed) return notStarted(runId, null, run.recordCount);

  let recordCount = 0;
  let progress = 0;
  let fatalError: { message: string; payload?: unknown } | null = null;
  let aborted = false;
  let cancelRequested = false;
  /** The run left 'running' under us (the reaper failed it). */
  let lost = false;
  /** PC-12: another run of the recipe took the recipe lease over. */
  let takenOver = false;
  let nonFatalErrors = 0;
  let firstNonFatal: string | null = null;

  // The connector's signal: the caller's, plus our own cancel request.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', forwardAbort, { once: true });

  let lastTouch = Date.now();
  /** Heartbeat + cancel poll in one write; extra columns ride along.
   *  PC-12: the recipe lease is renewed on the same beat (when due). */
  const checkpoint = async (extra: { progress?: number; recordCount?: number } = {}) => {
    lastTouch = Date.now();
    const now = new Date();
    const [row] = await db
      .update(connectorRuns)
      .set({ ...extra, lastProgressAt: now, updatedAt: now })
      .where(and(eq(connectorRuns.id, runId), eq(connectorRuns.status, 'running')))
      .returning({ cancelRequestedAt: connectorRuns.cancelRequestedAt });
    if (!row) {
      lost = true;
      controller.abort();
    } else if (row.cancelRequestedAt) {
      cancelRequested = true;
      controller.abort();
    } else if (lease && !(await lease.checkpoint())) {
      // The lease expired (no progress for its whole TTL) and another run
      // of the recipe took it: stop here, failed, and leave the recipe to
      // that run.
      takenOver = true;
      controller.abort();
    }
  };

  try {
    const events = impl.run(ctx, {
      runId,
      connectorId: run.connectorId,
      recipeId: run.recipeId,
      recipe: (run.recipeSnapshot as Record<string, unknown> | null) ?? null,
      config: (connector.config as Record<string, unknown>) ?? {},
      productProfileIds: run.productProfileIds,
      signal: controller.signal,
    });

    for await (const event of events) {
      if (options.signal?.aborted) {
        aborted = true;
        break;
      }
      if (fatalError) break;

      switch (event.kind) {
        case 'log': {
          await insertLog(runId, event.level, event.message, event.payload);
          break;
        }

        case 'record': {
          const inserted = await insertRecord(ctx, run, event.record);
          if (inserted) recordCount += 1;
          break;
        }

        case 'progress': {
          progress = event.current;
          await checkpoint({ progress, recordCount });
          break;
        }

        case 'error': {
          await insertLog(runId, 'error', event.error.message, event.error.payload);
          if (event.fatal) {
            fatalError = event.error;
          } else {
            nonFatalErrors += 1;
            firstNonFatal ??= event.error.message;
          }
          break;
        }
      }
      if (event.kind !== 'progress' && Date.now() - lastTouch >= PROGRESS_TOUCH_MS) {
        await checkpoint();
      }
      if (cancelRequested || lost || takenOver) break;
    }
  } catch (err) {
    fatalError = {
      message: err instanceof Error ? err.message : String(err),
    };
    await insertLog(runId, 'error', fatalError.message);
  } finally {
    options.signal?.removeEventListener('abort', forwardAbort);
  }

  if (lost) {
    return finishedElsewhere(runId, recordCount);
  }
  if (takenOver) {
    fatalError = { message: RUN_TAKEN_OVER_MESSAGE };
    await insertLog(runId, 'error', RUN_TAKEN_OVER_MESSAGE);
  }

  const finalStatus: RunOutcome =
    aborted || cancelRequested
      ? 'cancelled'
      : fatalError
        ? 'failed'
        : nonFatalErrors > 0
          ? 'partial'
          : 'succeeded';
  const partialError =
    finalStatus === 'partial'
      ? {
          message:
            `${nonFatalErrors} step${nonFatalErrors === 1 ? '' : 's'} failed and ` +
            `the run went on without ${nonFatalErrors === 1 ? 'it' : 'them'}; first: ${firstNonFatal ?? 'unknown error'}`,
          payload: { partial: true, failedSteps: nonFatalErrors },
        }
      : null;
  if (cancelRequested) {
    await insertLog(runId, 'warn', 'Cancelled on request; records found before that are kept.');
  }

  const [finished] = await db
    .update(connectorRuns)
    .set({
      status: finalStatus,
      progress,
      recordCount,
      completedAt: new Date(),
      lastProgressAt: new Date(),
      errorPayload: fatalError ?? partialError,
      updatedAt: new Date(),
    })
    .where(and(eq(connectorRuns.id, runId), eq(connectorRuns.status, 'running')))
    .returning({ id: connectorRuns.id });
  if (!finished) {
    return finishedElsewhere(runId, recordCount);
  }

  const result: RunResult = { status: finalStatus, recordCount };
  if (fatalError) result.error = fatalError;
  else if (partialError) result.error = partialError;

  if (finalStatus === 'failed') {
    // Surface the failure in the notification feed — a dead discovery
    // run otherwise only shows up if someone opens the runs page.
    const { notify } = await import('@/lib/services/notifications');
    await notify(ctx.workspaceId, {
      kind: 'run.failed',
      title: 'Discovery run failed',
      body: fatalError?.message?.slice(0, 300) ?? null,
      href: `/connectors/${run.connectorId}/runs/${runId}`,
      dedupeKey: `run.failed:${run.connectorId}`,
    });
    await reportRunFailed(runRef, fatalError?.message ?? 'the run failed');
    // PC-10: this run ended by itself, so the recipe is not stuck any more
    // (its failure is the run.failed just raised).
    await resolveRunStuck(ctx.workspaceId, run);
  } else if (finalStatus === 'succeeded' || finalStatus === 'partial') {
    // The recipe works again (at least partly): close its incidents.
    await resolveRunIncidents(ctx.workspaceId, run);
  } else {
    // Cancelled on request: it ended by itself, so not stuck any more.
    await resolveRunStuck(ctx.workspaceId, run);
  }

  // P62-07: when a crawl succeeded with new records, kick the
  // autopilot pipeline immediately so harvested records flow through
  // approve+draft+enqueue within seconds instead of waiting for the
  // next autopilot.tick. Fire-and-forget — autopilot has its own
  // permission gates + emergency-pause check, and any failure here
  // must NOT propagate back into the connector run status. Inline
  // import to avoid a top-level cycle between runner and autopilot.
  // PC-12 (I064): runOnce holds the workspace's autopilot lease, so this
  // hook never overlaps the tick or Run now; when a run is already in
  // progress it returns at once (leaseHeld) and that run, or the next
  // tick, picks the new records up.
  // Fire-and-forget (see above). Skipped under Vitest: a background runOnce
  // that outlives the run leaks across the next test's truncate and
  // intermittently deadlocks it. runOnce is covered directly in
  // autopilot.test.ts; prod behaviour is unchanged.
  if (
    (finalStatus === 'succeeded' || finalStatus === 'partial') &&
    recordCount > 0 &&
    !process.env.VITEST
  ) {
    void (async () => {
      try {
        const { runOnce } = await import('@/lib/services/autopilot');
        await runOnce(ctx, { purpose: 'post-crawl' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[runner] autopilot.runOnce after-crawl hook failed:', message);
        // Persist the failure to the run's log so the operator can see WHY
        // harvested records didn't flow to approve/draft/enqueue — a
        // console-only error made this hook fail silently in production.
        try {
          await insertLog(runId, 'warn', `post-crawl autopilot failed: ${message}`, {
            hook: 'autopilot.runOnce',
          });
        } catch {
          // best-effort — nothing left to log to.
        }
      }
    })();
  }
  return result;
}

/** This call did not execute the run: it was not (or no longer) pending. */
async function notStarted(
  runId: bigint,
  knownStatus: ConnectorRunStatus | null,
  recordCount: number,
): Promise<RunResult> {
  let currentStatus = knownStatus;
  if (currentStatus === null) {
    const [row] = await db
      .select({ status: connectorRuns.status })
      .from(connectorRuns)
      .where(eq(connectorRuns.id, runId));
    currentStatus = row?.status ?? 'cancelled';
  }
  console.warn(`[runner] run ${runId} not started: it is ${currentStatus}`);
  return { status: 'skipped', recordCount, currentStatus };
}

/** The run left 'running' while this call executed it (the stuck-work
 *  reaper ended it): keep that outcome, note what this call did. */
async function finishedElsewhere(runId: bigint, recordCount: number): Promise<RunResult> {
  const [row] = await db
    .select({ status: connectorRuns.status })
    .from(connectorRuns)
    .where(eq(connectorRuns.id, runId));
  const currentStatus = row?.status ?? 'failed';
  try {
    await insertLog(
      runId,
      'warn',
      `The run was already marked ${currentStatus} when this worker reached it; ` +
        `it stopped there (${recordCount} new record${recordCount === 1 ? '' : 's'} kept).`,
    );
  } catch {
    // best-effort
  }
  return { status: 'skipped', recordCount, currentStatus };
}

async function insertLog(
  runId: bigint,
  level: string,
  message: string,
  payload?: unknown,
): Promise<void> {
  const row: NewConnectorRunLog = {
    runId,
    level,
    message,
    payload: ((payload as Record<string, unknown> | undefined) ?? {}) as never,
  };
  await db.insert(connectorRunLogs).values(row);
}

async function insertRecord(
  ctx: WorkspaceContext,
  run: { id: bigint; connectorId: bigint; recipeId: bigint | null },
  record: import('./types').NormalizedRecord,
): Promise<boolean> {
  const row: NewSourceRecord = {
    workspaceId: ctx.workspaceId,
    sourceSystem: 'mock', // overwritten below if connector specifies via record.normalized
    sourceId: record.sourceId,
    sourceUrl: record.sourceUrl ?? null,
    connectorId: run.connectorId,
    recipeId: run.recipeId,
    runId: run.id,
    rawData: (record.raw as Record<string, unknown>) ?? {},
    normalizedData: record.normalized,
    evidenceUrls: (record.evidence ?? []).map((e) => e.url),
    confidence: clampConfidence(record.confidence ?? 50),
  };

  // Source system for the dedupe key is "<connector_template>:<connector_id>"
  // — distinct connectors can produce the same provider-id without colliding.
  // Read from the connector record on caller side; we already have connectorId
  // in `run`, so encode it.
  row.sourceSystem = `connector:${run.connectorId.toString()}`;

  let inserted: { id: bigint } | undefined;
  try {
    const result = await db.insert(sourceRecords).values(row).returning({ id: sourceRecords.id });
    inserted = result[0];
  } catch (err) {
    if (err instanceof Error && /duplicate key/.test(err.message)) {
      // Dedupe — same workspace+system+id already exists. Not an error.
      return false;
    }
    throw err;
  }

  if (!inserted) return false;

  // Auto-create the review_items row so the user can act on this lead.
  // Best-effort — failure here logs but doesn't fail the whole run.
  try {
    await seedReviewItem(ctx.workspaceId, inserted.id);
  } catch (err) {
    console.error('[runner] seedReviewItem failed:', err);
  }

  // Classify against every active product profile in the workspace.
  // Best-effort — failure here logs but does not fail the run.
  try {
    await classifySourceRecord(ctx, inserted.id);
  } catch (err) {
    console.error('[runner] classifySourceRecord failed:', err);
  }

  return true;
}

function clampConfidence(input: number): number {
  if (!Number.isFinite(input)) return 50;
  return Math.max(0, Math.min(100, Math.round(input)));
}
