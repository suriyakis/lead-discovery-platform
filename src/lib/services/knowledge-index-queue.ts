// KL-06 — the knowledge.index outbox, writer side.
//
// A request to (re)index a knowledge source writes an indexing_jobs row
// 'queued' and the source's index_status INSIDE the requesting
// transaction (create, edit, Re-index, Re-extract with OCR), then, after
// the commit, asks the queue to run knowledge.index for it. The row is the
// durable truth: a lost enqueue only delays the run until
// knowledge.index.sweep re-enqueues it (knowledge-indexing.ts runs and
// sweeps). Nothing slow runs in the operator's request (I108).
//
// Requests coalesce: a source has at most one 'queued' row (partial unique
// index), so ten edits in a row make one run, and a Re-extract-with-OCR
// request upgrades the queued row instead of adding a second paid run.
//
// This module is a leaf (db + schema + jobs only) so knowledge-sources.ts
// can call it inside its own transactions without an import cycle.

import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import { knowledgeSources, type KnowledgeIndexStatus } from '@/lib/db/schema/documents';
import { indexingJobs, type IndexingJob } from '@/lib/db/schema/rag';
import type { WorkspaceContext } from './context';

export const KNOWLEDGE_INDEX_JOB = 'knowledge.index';

export const KnowledgeIndexPayloadSchema = z.object({
  workspaceId: z.string().regex(/^\d+$/),
  jobId: z.string().regex(/^\d+$/),
  userId: z.string().min(1),
  role: z.enum(['owner', 'admin', 'manager', 'member', 'viewer', 'super_admin']),
});
export type KnowledgeIndexPayload = z.infer<typeof KnowledgeIndexPayloadSchema>;

export const INDEX_REASONS = ['create', 'edit', 'reindex', 'document', 'reextract_ocr'] as const;
export type IndexReason = (typeof INDEX_REASONS)[number];

export interface QueueIndexOptions {
  reason: IndexReason;
  /** OCR the document even if cached text or a text layer exists. */
  forceOcr?: boolean;
  /** The source's content, URL, summary or products changed: show it as
   *  'stale' (its chunks serve the previous version) until a run ends. */
  markStale?: boolean;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class KnowledgeIndexQueueError extends Error {
  public readonly code: 'not_found';
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeIndexQueueError';
    this.code = 'not_found';
  }
}

/**
 * Queue one run for a source inside the caller's transaction: lock the
 * source row, reuse its queued row (made due now, attempts reset, OCR
 * forcing OR-ed in) or insert one, and record index_status. A source a
 * run currently holds keeps 'indexing' unless the change makes it stale:
 * the run, when it ends, sees the queued row and does not claim
 * 'indexed' for content it never read.
 */
export async function queueKnowledgeIndexTx(
  tx: Tx,
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
  knowledgeSourceId: bigint,
  options: QueueIndexOptions,
): Promise<IndexingJob> {
  const [source] = await tx
    .select({ id: knowledgeSources.id, indexStatus: knowledgeSources.indexStatus })
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.workspaceId, ctx.workspaceId),
        eq(knowledgeSources.id, knowledgeSourceId),
      ),
    )
    .for('update')
    .limit(1);
  if (!source) throw new KnowledgeIndexQueueError('knowledge_source not found');

  const forceOcr = options.forceOcr === true;
  const [queued] = await tx
    .select()
    .from(indexingJobs)
    .where(
      and(
        eq(indexingJobs.workspaceId, ctx.workspaceId),
        eq(indexingJobs.knowledgeSourceId, knowledgeSourceId),
        eq(indexingJobs.status, 'queued'),
      ),
    )
    .limit(1);

  let job: IndexingJob | undefined;
  if (queued) {
    [job] = await tx
      .update(indexingJobs)
      .set({
        attempts: 0,
        nextAttemptAt: null,
        forceOcr: queued.forceOcr || forceOcr,
        reason: forceOcr ? 'reextract_ocr' : options.reason,
        triggeredBy: ctx.userId,
      })
      .where(and(eq(indexingJobs.workspaceId, ctx.workspaceId), eq(indexingJobs.id, queued.id)))
      .returning();
  } else {
    [job] = await tx
      .insert(indexingJobs)
      .values({
        workspaceId: ctx.workspaceId,
        knowledgeSourceId,
        status: 'queued',
        forceOcr,
        reason: options.reason,
        triggeredBy: ctx.userId,
      })
      .returning();
  }
  if (!job) throw new Error('indexing_jobs queue write returned no row');

  await tx
    .update(knowledgeSources)
    .set({ indexStatus: statusAfterRequest(source.indexStatus, options.markStale === true) })
    .where(
      and(
        eq(knowledgeSources.workspaceId, ctx.workspaceId),
        eq(knowledgeSources.id, knowledgeSourceId),
      ),
    );
  return job;
}

/**
 * The status a request leaves: a content change makes the source 'stale'
 * (its chunks serve the previous version until the queued run ends); a
 * plain request does not make a stale source current, nor take 'indexing'
 * from the run holding it; otherwise 'queued'.
 */
export function statusAfterRequest(
  current: KnowledgeIndexStatus,
  markStale: boolean,
): KnowledgeIndexStatus {
  if (markStale) return 'stale';
  if (current === 'indexing' || current === 'stale') return current;
  return 'queued';
}

/** Another queued row for the source than `jobId` (a request that arrived
 *  while a run held it). */
export async function otherQueuedJob(
  tx: Tx,
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  knowledgeSourceId: bigint,
  jobId: bigint,
): Promise<IndexingJob | null> {
  const [row] = await tx
    .select()
    .from(indexingJobs)
    .where(
      and(
        eq(indexingJobs.workspaceId, ctx.workspaceId),
        eq(indexingJobs.knowledgeSourceId, knowledgeSourceId),
        eq(indexingJobs.status, 'queued'),
        ne(indexingJobs.id, jobId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * After the requesting transaction committed: ask the queue to run the
 * rows. Best effort and never throws — the rows are durable, so a lost
 * enqueue only delays the run until knowledge.index.sweep (2 minutes).
 */
export async function enqueueKnowledgeIndexJobs(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId' | 'role'>,
  jobIds: ReadonlyArray<bigint>,
): Promise<void> {
  if (jobIds.length === 0) return;
  try {
    const { getJobQueue } = await import('@/lib/jobs');
    const queue = getJobQueue();
    for (const jobId of new Set(jobIds.map((id) => id.toString()))) {
      const payload: KnowledgeIndexPayload = {
        workspaceId: ctx.workspaceId.toString(),
        jobId,
        userId: ctx.userId,
        role: ctx.role,
      };
      // PC-36: deduplicated while the row's job still waits or runs.
      const key = `knowledge-index:${jobId}`;
      await queue.enqueue(KNOWLEDGE_INDEX_JOB, payload, { tag: key, dedupeKey: key });
    }
  } catch (err) {
    console.error(
      `[knowledge-index-queue] enqueue ${KNOWLEDGE_INDEX_JOB} failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}
