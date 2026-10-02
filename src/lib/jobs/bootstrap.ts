// Job-handler bootstrap. Imported once on app startup to register
// handlers with whichever IJobQueue implementation is active.
//
// Importing this file is idempotent — multiple imports register the same
// handler, and Map.set replaces the existing function (handlers are
// stateless; replacement is fine).

import { runConnectorRun } from '@/lib/connectors/runner';
import { db } from '@/lib/db/client';
import { connectorRuns } from '@/lib/db/schema/connectors';
import { eq } from 'drizzle-orm';
import { getJobQueue, NonRetryableJobError, type JobHandler } from './index';
import { instrumented } from './instrumented';
import {
  type WorkspaceContext,
  type WorkspaceRole,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  LEARNING_PROCESS_JOB,
  LearningProcessPayloadSchema,
} from '@/lib/services/learning-decisions';
import { processDecision } from '@/lib/services/learning-processor';
import {
  KNOWLEDGE_INDEX_JOB,
  KnowledgeIndexPayloadSchema,
} from '@/lib/services/knowledge-index-queue';
import { runKnowledgeIndexJob, summarizeIndexOutcome } from '@/lib/services/knowledge-indexing';
import { RECLASSIFY_JOB, runReclassificationJob } from '@/lib/services/qualification-runs';

export interface ConnectorRunJobPayload {
  runId: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  [key: string]: unknown;
}

/** Re-creates a WorkspaceContext from the payload values stored at enqueue time. */
function rehydrateCtx(payload: ConnectorRunJobPayload): WorkspaceContext {
  return makeWorkspaceContext({
    workspaceId: BigInt(payload.workspaceId),
    userId: payload.userId,
    role: payload.role,
  });
}

/**
 * connector.run. PC-36: BullMQ tries it up to 3 times with backoff
 * (lanes.ts CONNECTOR_RUN_RETRY), which only helps a run that has not
 * started: runConnectorRun executes a run only while its row is still
 * 'pending' (conditional claim) and otherwise returns 'skipped'. A retry
 * of a run that an earlier attempt claimed, that was cancelled, or that
 * the stuck-work reaper failed meanwhile therefore changes nothing — it
 * never races the reaper. A missing row or a payload naming another
 * workspace is not retried.
 */
export const handleConnectorRun: JobHandler<ConnectorRunJobPayload> = async (payload) => {
  const ctx = rehydrateCtx(payload);
  const runId = BigInt(payload.runId);

  // Defensive: confirm the run row still exists and belongs to the workspace
  // we expect (cancelled deletions or wrong-workspace replays should fail clean).
  const rows = await db.select().from(connectorRuns).where(eq(connectorRuns.id, runId));
  const run = rows[0];
  if (!run) throw new NonRetryableJobError(`connector_runs ${runId} missing at run time`);
  if (run.workspaceId !== ctx.workspaceId) {
    throw new NonRetryableJobError(`connector_runs ${runId} workspaceId mismatch`);
  }

  return runConnectorRun(ctx, runId);
};

/**
 * KL-02/KL-03: work one decision's learning outbox (learning-processor.ts).
 * The payload is untrusted queue data — validated before use; the
 * decision's events already sit in the database as 'pending', so a
 * malformed or lost job only delays them until learning.sweep re-drives
 * them. processDecision never throws: failures are recorded on the events
 * (backoff, then 'failed'), not left to the queue's own retries.
 */
const handleLearningProcess: JobHandler = async (payload) => {
  const p = LearningProcessPayloadSchema.parse(payload);
  const ctx = makeWorkspaceContext({
    workspaceId: BigInt(p.workspaceId),
    userId: p.userId,
    role: p.role,
  });
  return processDecision(ctx, p.decisionId);
};

/**
 * KL-06: one knowledge.index run (knowledge-indexing.ts). The payload is
 * untrusted queue data — validated before use; the run's row already sits
 * in indexing_jobs as 'queued', so a malformed or lost job only delays it
 * until knowledge.index.sweep re-enqueues it. Failures are recorded on the
 * row (backoff retry, then 'failed' + a notification), never thrown to the
 * queue; the return value is JSON-safe for BullMQ.
 */
const handleKnowledgeIndex: JobHandler = async (payload) => {
  const p = KnowledgeIndexPayloadSchema.parse(payload);
  const ctx = makeWorkspaceContext({
    workspaceId: BigInt(p.workspaceId),
    userId: p.userId,
    role: p.role,
  });
  return summarizeIndexOutcome(await runKnowledgeIndexJob(ctx, BigInt(p.jobId)));
};

let registered = false;

export function registerJobHandlers(): void {
  if (registered) return;
  const q = getJobQueue();
  // PC-07: on-demand jobs — heartbeat (last run, failures) but no
  // schedule, so they never count as stale; a thrown run raises a
  // 'job.failed' platform incident that the next good run resolves.
  q.on<ConnectorRunJobPayload>(
    'connector.run',
    instrumented<ConnectorRunJobPayload>(
      'connector.run',
      (payload, ctx) => handleConnectorRun(payload, { jobId: ctx.jobId }),
      { kind: 'job', label: 'Discovery run' },
    ),
  );
  // KL-02/KL-03 and KL-06: both record their own failures on their rows
  // (backoff, then 'failed' + a notification); the heartbeat shows they run.
  q.on(
    LEARNING_PROCESS_JOB,
    instrumented(
      LEARNING_PROCESS_JOB,
      (payload, ctx) => handleLearningProcess(payload, { jobId: ctx.jobId }),
      { kind: 'job', label: 'Learning' },
    ),
  );
  q.on(
    KNOWLEDGE_INDEX_JOB,
    instrumented(
      KNOWLEDGE_INDEX_JOB,
      (payload, ctx) => handleKnowledgeIndex(payload, { jobId: ctx.jobId }),
      { kind: 'job', label: 'Knowledge indexing' },
    ),
  );
  // PC-38 (I028): a "Re-classify all" run. It records its own progress and
  // outcome on its qualification_runs row; a throw (a database error) also
  // marks the run failed before it reaches the heartbeat.
  q.on(
    RECLASSIFY_JOB,
    instrumented(RECLASSIFY_JOB, (payload) => runReclassificationJob(payload), {
      kind: 'job',
      label: 'Re-classify all',
    }),
  );
  registered = true;
}

/** For tests — clear the flag so registration can re-run after queue reset. */
export function _resetHandlersForTests(): void {
  registered = false;
}
