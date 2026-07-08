// Connector runner — executes a registered connector against a recipe and
// persists the resulting events.
//
// Lifecycle:
//   1. Caller has already inserted a connector_runs row with status=pending.
//   2. runConnectorRun() flips it to running, iterates the async iterable
//      from the connector, and writes:
//        - 'log'      → connector_run_logs row
//        - 'record'   → source_records row (skipped on dedupe conflict)
//        - 'progress' → connector_runs.progress + record_count update
//        - 'error'    → connector_run_logs + (if fatal) end run as failed
//   3. On clean iteration end, status -> succeeded.
//   4. On thrown error from the connector, status -> failed.
//   5. On AbortSignal abort, status -> cancelled.

import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  connectorRuns,
  connectorRunLogs,
  connectors,
  sourceRecords,
  type NewConnectorRunLog,
  type NewSourceRecord,
} from '@/lib/db/schema/connectors';
import type { WorkspaceContext } from '@/lib/services/context';
import { classifySourceRecord } from '@/lib/services/qualification';
import { seedReviewItem } from '@/lib/services/review';
import { getConnector } from './registry';

// Side-effect imports: each connector implementation calls
// `registerConnector(new ...)` at module load. Without these imports
// the registry is empty at runtime and `getConnector(templateType)`
// throws — silently inside the in-memory job microtask, leaving the
// connector_runs row stuck on 'pending' with no log line. Importing
// here makes the connectors load whenever the runner does.
import './mock';
import './internet-search';

export interface RunResult {
  status: 'succeeded' | 'failed' | 'cancelled';
  recordCount: number;
  error?: { message: string; payload?: unknown };
}

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

  const connectorRows = await db
    .select()
    .from(connectors)
    .where(eq(connectors.id, run.connectorId));
  const connector = connectorRows[0];
  if (!connector) throw new Error(`connectors row ${run.connectorId} not found`);

  // Resolve the connector impl. A miss here used to throw before the
  // status flip and leave the row stuck on 'pending' with no log line.
  // Surface it as a proper failure so the operator sees it.
  let impl;
  try {
    impl = getConnector(connector.templateType);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(connectorRuns)
      .set({
        status: 'failed',
        startedAt: new Date(),
        completedAt: new Date(),
        errorPayload: { message },
        updatedAt: new Date(),
      })
      .where(eq(connectorRuns.id, runId));
    await insertLog(runId, 'error', message);
    return { status: 'failed', recordCount: 0, error: { message } };
  }

  // Mark running.
  await db
    .update(connectorRuns)
    .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
    .where(eq(connectorRuns.id, runId));

  let recordCount = 0;
  let progress = 0;
  let fatalError: { message: string; payload?: unknown } | null = null;
  let aborted = false;

  try {
    const events = impl.run(ctx, {
      runId,
      connectorId: run.connectorId,
      recipeId: run.recipeId,
      recipe: (run.recipeSnapshot as Record<string, unknown> | null) ?? null,
      config: (connector.config as Record<string, unknown>) ?? {},
      productProfileIds: run.productProfileIds,
      signal: options.signal,
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
          await db
            .update(connectorRuns)
            .set({ progress, recordCount, updatedAt: new Date() })
            .where(eq(connectorRuns.id, runId));
          break;
        }

        case 'error': {
          await insertLog(runId, 'error', event.error.message, event.error.payload);
          if (event.fatal) fatalError = event.error;
          break;
        }
      }
    }
  } catch (err) {
    fatalError = {
      message: err instanceof Error ? err.message : String(err),
    };
    await insertLog(runId, 'error', fatalError.message);
  }

  const finalStatus: 'succeeded' | 'failed' | 'cancelled' = aborted
    ? 'cancelled'
    : fatalError
      ? 'failed'
      : 'succeeded';

  await db
    .update(connectorRuns)
    .set({
      status: finalStatus,
      progress,
      recordCount,
      completedAt: new Date(),
      errorPayload: fatalError ?? null,
      updatedAt: new Date(),
    })
    .where(eq(connectorRuns.id, runId));

  const result: RunResult = { status: finalStatus, recordCount };
  if (fatalError) result.error = fatalError;

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
  }

  // P62-07: when a crawl succeeded with new records, kick the
  // autopilot pipeline immediately so harvested records flow through
  // approve+draft+enqueue within seconds instead of waiting for the
  // next autopilot.tick. Fire-and-forget — autopilot has its own
  // permission gates + emergency-pause check, and any failure here
  // must NOT propagate back into the connector run status. Inline
  // import to avoid a top-level cycle between runner and autopilot.
  // Fire-and-forget (see above). Skipped under Vitest: a background runOnce
  // that outlives the run leaks across the next test's truncate and
  // intermittently deadlocks it. runOnce is covered directly in
  // autopilot.test.ts; prod behaviour is unchanged.
  if (finalStatus === 'succeeded' && recordCount > 0 && !process.env.VITEST) {
    void (async () => {
      try {
        const { runOnce } = await import('@/lib/services/autopilot');
        await runOnce(ctx);
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
