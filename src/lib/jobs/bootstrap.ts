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
import { getJobQueue, type JobHandler } from './index';
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

const handleConnectorRun: JobHandler<ConnectorRunJobPayload> = async (payload) => {
  const ctx = rehydrateCtx(payload);
  const runId = BigInt(payload.runId);

  // Defensive: confirm the run row still exists and belongs to the workspace
  // we expect (cancelled deletions or wrong-workspace replays should fail clean).
  const rows = await db.select().from(connectorRuns).where(eq(connectorRuns.id, runId));
  const run = rows[0];
  if (!run) throw new Error(`connector_runs ${runId} missing at run time`);
  if (run.workspaceId !== ctx.workspaceId) {
    throw new Error(`connector_runs ${runId} workspaceId mismatch`);
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
  q.on<ConnectorRunJobPayload>('connector.run', handleConnectorRun);
  q.on(LEARNING_PROCESS_JOB, handleLearningProcess);
  q.on(KNOWLEDGE_INDEX_JOB, handleKnowledgeIndex);
  registered = true;
}

/** For tests — clear the flag so registration can re-run after queue reset. */
export function _resetHandlersForTests(): void {
  registered = false;
}
