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
import { getConnector } from './registry';

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

  const impl = getConnector(connector.templateType);

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

  try {
    await db.insert(sourceRecords).values(row);
    return true;
  } catch (err) {
    if (err instanceof Error && /duplicate key/.test(err.message)) {
      // Dedupe — same workspace+system+id already exists. Not an error.
      return false;
    }
    throw err;
  }
}

function clampConfidence(input: number): number {
  if (!Number.isFinite(input)) return 50;
  return Math.max(0, Math.min(100, Math.round(input)));
}
