// KL-06 — indexing as a job (I040, I103, I104, I108, I021).
//
// Requests (create, edit, Re-index, the document page, Re-extract with
// OCR) only write the outbox row and the source's index_status in their
// own transaction (knowledge-index-queue.ts) and enqueue knowledge.index.
// This module runs and sweeps those rows; no extraction, OCR or embedding
// runs inside an operator's request any more (I108).
//
// knowledge.index {jobId}
//   1. CLAIM: under the source row lock, the queued row becomes 'running'
//      (attempts + 1) and the source 'indexing' — unless another run holds
//      the source (the row is deferred a minute; one run per source,
//      enforced by a partial unique index too). A run that will have to
//      EXTRACT its document (Re-extract with OCR, or no valid cache) also
//      takes the document row lock and is deferred while another source of
//      the same document is being indexed: extraction (and a paid OCR) is
//      serialized per document, and the deferred run then reuses the cache.
//   2. TEXT: text / url sources read their row; a document source reads
//      the extraction cache (document-extraction.ts) — OCR is paid once
//      per document SHA, never once per product or per retry.
//   3. EMBED ONCE PER SOURCE (I040): when the sha256 of that text and the
//      embedding model equal the source's stamp and its chunks exist,
//      nothing is re-embedded; otherwise the chunks are rebuilt and
//      stamped in one transaction (rag.replaceSourceChunks).
//   4. ATTACH per product, for 'products' sources. pgvector declares
//      indexesPerSource, so this is bookkeeping (binding + derived
//      counters); per-copy providers (openai, mock) upload as before.
//   5. FINISH: 'succeeded' and the source 'indexed' — or, when a newer
//      request arrived meanwhile (an edit), the source keeps 'stale' /
//      'queued' for the queued run. A failure retries with backoff (1, 2,
//      4 min; MAX_INDEX_ATTEMPTS runs in all) unless it is deterministic
//      (unsupported file, no text, no OCR key, no scope), then 'failed',
//      the source 'failed' and ONE knowledge.index_failed notification per
//      source (deduped while unread; resolved by the next success).
//
// knowledge.index.sweep (repeatable, every 2 minutes, active workspaces)
//   - fails runs still 'running' after 15 minutes (a killed or hung
//     worker), with a message and the notification;
//   - re-enqueues queued rows whose backoff has passed, or whose job was
//     lost (no backoff, older than 2 minutes).
// It only enqueues, so it works the same on the memory and BullMQ queues.

import { and, asc, eq, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  documents,
  knowledgeSources,
  type Document,
  type KnowledgeIndexStatus,
  type KnowledgeSource,
} from '@/lib/db/schema/documents';
import { indexingJobs, type IndexingJob } from '@/lib/db/schema/rag';
import { workspaces } from '@/lib/db/schema/workspaces';
import { getEmbeddingProviderForCtx, type IEmbeddingProvider } from '@/lib/embeddings';
import type { IJobQueue } from '@/lib/jobs';
import { getStorage, type IStorage } from '@/lib/storage';
import { recordAuditEvent } from './audit';
import {
  canAdminWorkspace,
  canWrite,
  makeWorkspaceContext,
  type WorkspaceContext,
} from './context';
import {
  DocumentExtractionError,
  contentHash,
  extractDocumentText,
  isPdfDocument,
} from './document-extraction';
import {
  KNOWLEDGE_INDEX_JOB,
  KnowledgeIndexQueueError,
  enqueueKnowledgeIndexJobs,
  otherQueuedJob,
  queueKnowledgeIndexTx,
  type IndexReason,
  type KnowledgeIndexPayload,
} from './knowledge-index-queue';
import { WORKSPACE_KNOWLEDGE_SCOPE, loadSourceProductIds } from './knowledge-scope';
import {
  KnowledgeSourceServiceError,
  createKnowledgeSource,
  knowledgeSourceErrorMessage,
  listDocumentSources,
  needsScopeError,
} from './knowledge-sources';
import { notify, resolveNotifications } from './notifications';
import { chunkText, countSourceChunks, replaceSourceChunks, type IndexResult } from './rag';

export const KNOWLEDGE_INDEX_SWEEP_JOB = 'knowledge.index.sweep';
export { KNOWLEDGE_INDEX_SWEEP_TICK_MS } from '@/lib/jobs/tick-catalog';
/** The first run plus up to three retries. */
export const MAX_INDEX_ATTEMPTS = 4;
/** A run still 'running' after this belongs to a killed or hung worker. */
export const INDEX_RUN_TIMEOUT_MS = 15 * 60 * 1000;
/** A queued row nobody claimed in this long lost its job. */
export const LOST_INDEX_JOB_AFTER_MS = 2 * 60 * 1000;
/** A row that found another run holding its source waits this long. */
export const BUSY_DEFER_MS = 60 * 1000;
const SWEEP_BATCH = 100;

export const INDEX_TIMEOUT_MESSAGE =
  'Indexing stopped: the run did not finish within 15 minutes (the worker was restarted or hung). Click Re-index to try again.';

/** Backoff after the n-th failed run: 1, 2, 4 minutes. */
export function indexRetryDelayMs(attempts: number): number {
  return 2 ** Math.max(0, attempts - 1) * 60 * 1000;
}

export type KnowledgeIndexErrorCode =
  | 'permission_denied'
  | 'not_found'
  | 'invalid_input'
  | 'document_unavailable'
  | 'no_text'
  | 'attach_failed'
  | 'ocr_unavailable'
  | 'busy';

export class KnowledgeIndexError extends Error {
  public readonly code: KnowledgeIndexErrorCode;
  /** Deterministic: retrying the same input cannot succeed. */
  public readonly permanent: boolean;
  constructor(message: string, code: KnowledgeIndexErrorCode, permanent: boolean) {
    super(message);
    this.name = 'KnowledgeIndexError';
    this.code = code;
    this.permanent = permanent;
  }
}

/** Fail at once (no backoff) for errors the same input will hit again. */
export function isPermanentIndexError(err: unknown): boolean {
  if (err instanceof DocumentExtractionError) return true;
  if (err instanceof KnowledgeIndexError) return err.permanent;
  if (err instanceof KnowledgeSourceServiceError) {
    return ['needs_scope', 'invalid_input', 'not_found', 'permission_denied'].includes(err.code);
  }
  if (err instanceof Error && err.name === 'OcrError') {
    return (err as Error & { code?: string }).code === 'too_large';
  }
  return false;
}

function errorMessage(err: unknown): string {
  const m =
    knowledgeSourceErrorMessage(err) ?? (err instanceof Error ? err.message : String(err));
  return (m || 'indexing failed').slice(0, 2000);
}

// ---- notifications ---------------------------------------------------------------

export function knowledgeIndexFailedKey(sourceId: bigint): string {
  return `knowledge.index_failed:${sourceId}`;
}

/** One unread notification per source (I021); best effort, never throws. */
export async function notifyKnowledgeIndexFailed(
  workspaceId: bigint,
  source: Pick<KnowledgeSource, 'id' | 'title' | 'indexedAt'>,
  message: string,
): Promise<boolean> {
  const after = source.indexedAt
    ? 'Drafts keep using the version indexed before.'
    : 'Drafts cannot use it until it is indexed.';
  const row = await notify(workspaceId, {
    kind: 'knowledge.index_failed',
    title: `Indexing failed: ${source.title}`,
    body: `${message.slice(0, 600)} ${after}`,
    href: `/knowledge/${source.id}`,
    dedupeKey: knowledgeIndexFailedKey(source.id),
  });
  return row !== null;
}

// ---- reads -----------------------------------------------------------------------

/** Source ids (as strings) with a queued or running run — the pages poll
 *  while one of theirs is listed. */
export async function sourcesWithActiveIndexRuns(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ id: indexingJobs.knowledgeSourceId })
    .from(indexingJobs)
    .where(
      and(
        eq(indexingJobs.workspaceId, ctx.workspaceId),
        isNotNull(indexingJobs.knowledgeSourceId),
        or(eq(indexingJobs.status, 'queued'), eq(indexingJobs.status, 'running')),
      ),
    );
  return new Set(rows.map((r) => String(r.id)));
}

// ---- requests --------------------------------------------------------------------

/**
 * Queue a (re)index of one source and enqueue its job. Returns at once —
 * the knowledge.index job does the work. Coalesces with a queued request.
 */
export async function requestKnowledgeIndex(
  ctx: WorkspaceContext,
  knowledgeSourceId: bigint,
  options: { reason?: IndexReason; forceOcr?: boolean } = {},
): Promise<IndexingJob> {
  if (!canWrite(ctx)) {
    throw new KnowledgeIndexError('Permission denied: knowledge.index', 'permission_denied', true);
  }
  const reason = options.reason ?? 'reindex';
  const job = await queueOrNotFound(ctx, knowledgeSourceId, { reason, forceOcr: options.forceOcr });
  await enqueueKnowledgeIndexJobs(ctx, [job.id]);
  await recordAuditEvent(ctx, {
    kind: 'knowledge_source.index_requested',
    entityType: 'knowledge_source',
    entityId: knowledgeSourceId,
    payload: { jobId: job.id.toString(), reason, forceOcr: job.forceOcr },
  });
  return job;
}

async function queueOrNotFound(
  ctx: WorkspaceContext,
  knowledgeSourceId: bigint,
  options: { reason: IndexReason; forceOcr?: boolean },
): Promise<IndexingJob> {
  try {
    return await db.transaction((tx) => queueKnowledgeIndexTx(tx, ctx, knowledgeSourceId, options));
  } catch (err) {
    if (err instanceof KnowledgeIndexQueueError) {
      throw new KnowledgeIndexError('knowledge_source not found', 'not_found', true);
    }
    throw err;
  }
}

async function loadReadyDocument(ctx: WorkspaceContext, documentId: bigint): Promise<Document> {
  const [doc] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.workspaceId, ctx.workspaceId), eq(documents.id, documentId)))
    .limit(1);
  if (!doc) throw new KnowledgeIndexError('document not found', 'not_found', true);
  if (doc.status !== 'ready') {
    throw new KnowledgeIndexError(`cannot index document in status ${doc.status}`, 'invalid_input', true);
  }
  return doc;
}

/**
 * The document page's button: queue a run for each source wrapping the
 * document. A document with no source gets its one workspace-wide source
 * first (KL-05), then a run — also for a type auto-indexing skips, since
 * the operator asked for an attempt.
 */
export async function requestDocumentIndex(
  ctx: WorkspaceContext,
  documentId: bigint,
): Promise<{ jobs: IndexingJob[]; createdSourceId: bigint | null }> {
  if (!canWrite(ctx)) {
    throw new KnowledgeIndexError('Permission denied: knowledge.index', 'permission_denied', true);
  }
  const doc = await loadReadyDocument(ctx, documentId);
  let sourceIds = (await listDocumentSources(ctx, documentId)).map((r) => r.source.id);
  let createdSourceId: bigint | null = null;
  if (sourceIds.length === 0) {
    const created = await createKnowledgeSource(ctx, {
      kind: 'document',
      title: doc.name,
      documentId,
      tags: doc.tags,
      scope: WORKSPACE_KNOWLEDGE_SCOPE,
    });
    createdSourceId = created.id;
    sourceIds = [created.id];
  }
  const jobs = await db.transaction(async (tx) => {
    const out: IndexingJob[] = [];
    for (const id of sourceIds) {
      out.push(await queueKnowledgeIndexTx(tx, ctx, id, { reason: 'document' }));
    }
    return out;
  });
  await enqueueKnowledgeIndexJobs(
    ctx,
    jobs.map((j) => j.id),
  );
  await recordAuditEvent(ctx, {
    kind: 'rag.index_document_requested',
    entityType: 'document',
    entityId: documentId,
    payload: {
      jobIds: jobs.map((j) => j.id.toString()),
      knowledgeSourceIds: sourceIds.map((id) => id.toString()),
      createdSourceId: createdSourceId?.toString() ?? null,
    },
  });
  return { jobs, createdSourceId };
}

// ---- OCR re-extract (admin) ------------------------------------------------------

export interface OcrEstimate {
  available: boolean;
  /** Why it is not available (not a PDF, no OCR key). */
  reason: string | null;
  /** From the last extraction; null until the PDF was read once. */
  pages: number | null;
  costCents: number | null;
  /** 'workspace' = the workspace's own Mistral key (no tokens). */
  keySource: 'workspace' | 'platform' | null;
}

/** What "Re-extract with OCR" would cost for this document. */
export async function estimateDocumentOcr(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  document: Pick<Document, 'mimeType' | 'filename' | 'pageCount'>,
): Promise<OcrEstimate> {
  if (!isPdfDocument(document)) {
    return {
      available: false,
      reason: 'Only PDF files can be OCR’d.',
      pages: null,
      costCents: null,
      keySource: null,
    };
  }
  const { getOcrProviderForCtx, estimateOcrCostCents } = await import('@/lib/ocr');
  const ocr = await getOcrProviderForCtx(ctx);
  if (!ocr) {
    return {
      available: false,
      reason:
        'No OCR key is configured: add a Mistral API key (Admin → Providers, or the workspace’s own key under Settings → Integrations).',
      pages: document.pageCount,
      costCents: null,
      keySource: null,
    };
  }
  const pages = document.pageCount;
  return {
    available: true,
    reason: null,
    pages,
    costCents: pages !== null && pages > 0 ? estimateOcrCostCents(pages) : null,
    keySource: ocr.keySource,
  };
}

function formatCents(cents: number): string {
  return cents < 100 ? `${cents}¢` : `$${(cents / 100).toFixed(2)}`;
}

/** One sentence for the button's confirm and the page: what OCR costs. */
export function describeOcrCost(estimate: OcrEstimate): string {
  const billing =
    estimate.keySource === 'workspace'
      ? 'billed to your own Mistral key, no tokens'
      : 'charged to your token balance';
  if (estimate.pages === null || estimate.costCents === null) {
    return `Mistral OCR costs about 0.1¢ per page (${billing}); this file’s page count is not known yet.`;
  }
  return `About ${estimate.pages} page${estimate.pages === 1 ? '' : 's'}, estimated ${formatCents(estimate.costCents)} (${billing}).`;
}

/**
 * Admin only: OCR the PDF again (even with a cached text or a text
 * layer) and re-index the document's sources. One paid OCR run however
 * many sources wrap the document, even on a concurrent queue: the claim
 * serializes extraction per document (documentExtractionBusy), the first
 * run caches the OCR text and the others reuse it.
 */
export async function requestDocumentOcrReextract(
  ctx: WorkspaceContext,
  documentId: bigint,
): Promise<{ jobs: IndexingJob[]; estimate: OcrEstimate }> {
  if (!canAdminWorkspace(ctx)) {
    throw new KnowledgeIndexError(
      'Permission denied: only workspace owners and admins can re-extract with OCR',
      'permission_denied',
      true,
    );
  }
  const doc = await loadReadyDocument(ctx, documentId);
  const estimate = await estimateDocumentOcr(ctx, doc);
  if (!estimate.available) {
    throw new KnowledgeIndexError(estimate.reason ?? 'OCR is not available', 'ocr_unavailable', true);
  }
  const sourceIds = (await listDocumentSources(ctx, documentId)).map((r) => r.source.id);
  if (sourceIds.length === 0) {
    throw new KnowledgeIndexError(
      'This document is not in the knowledge base yet. Index it first.',
      'invalid_input',
      true,
    );
  }
  const jobs = await db.transaction(async (tx) => {
    const out: IndexingJob[] = [];
    for (const id of sourceIds) {
      out.push(
        await queueKnowledgeIndexTx(tx, ctx, id, { reason: 'reextract_ocr', forceOcr: true }),
      );
    }
    return out;
  });
  await recordAuditEvent(ctx, {
    kind: 'document.reextract_ocr',
    entityType: 'document',
    entityId: documentId,
    payload: {
      pages: estimate.pages,
      costEstimateCents: estimate.costCents,
      keySource: estimate.keySource,
      jobIds: jobs.map((j) => j.id.toString()),
    },
  });
  await enqueueKnowledgeIndexJobs(
    ctx,
    jobs.map((j) => j.id),
  );
  return { jobs, estimate };
}

// ---- the run ---------------------------------------------------------------------

export interface IndexRunDeps {
  storage?: IStorage;
  embedder?: IEmbeddingProvider;
  /** The clock (tests move it). */
  now?: () => Date;
}

export type IndexRunOutcome =
  | { kind: 'succeeded'; job: IndexingJob; chunkCount: number; reembedded: boolean }
  | { kind: 'retrying'; job: IndexingJob; error: unknown; message: string }
  | { kind: 'failed'; job: IndexingJob; error: unknown; message: string }
  /** closed: the work finished after the sweeper had timed the run out —
   *  its row stays failed and the source is not touched. */
  | { kind: 'skipped'; reason: 'not_found' | 'not_queued' | 'not_due' | 'busy' | 'closed' };

/** A JSON-safe summary (BullMQ stores the handler's return value). */
export function summarizeIndexOutcome(outcome: IndexRunOutcome): Record<string, unknown> {
  switch (outcome.kind) {
    case 'succeeded':
      return {
        kind: outcome.kind,
        jobId: outcome.job.id.toString(),
        chunkCount: outcome.chunkCount,
        reembedded: outcome.reembedded,
      };
    case 'retrying':
    case 'failed':
      return { kind: outcome.kind, jobId: outcome.job.id.toString(), message: outcome.message };
    default:
      return { kind: outcome.kind, reason: outcome.reason };
  }
}

/**
 * The knowledge.index job: claim the row, index, finish. Never throws for
 * an indexing failure — that is recorded on the row (retry or failed);
 * the queue's own retries are not used.
 */
export async function runKnowledgeIndexJob(
  ctx: WorkspaceContext,
  jobId: bigint,
  deps: IndexRunDeps = {},
): Promise<IndexRunOutcome> {
  const now = deps.now ?? (() => new Date());
  const claim = await claimIndexJob(ctx, jobId, now());
  if (claim.kind === 'skipped') return claim;
  const { job, source } = claim;
  try {
    const work = await performIndex(ctx, job, source, deps);
    const finished = await finishSucceeded(ctx, job, source, work, now());
    // The sweeper closed this run while it worked (it hung past 15 min).
    if (!finished) return { kind: 'skipped', reason: 'closed' };
    return {
      kind: 'succeeded',
      job: finished,
      chunkCount: work.chunkCount,
      reembedded: work.reembedded,
    };
  } catch (err) {
    return finishFailed(ctx, job, source, err, now());
  }
}

/**
 * Index one source now, in this process (scripts, tests, the inline
 * rag.indexKnowledgeSource): queue its run — reusing a queued one — and
 * run it. Throws what made the run fail.
 */
export async function indexKnowledgeSourceNow(
  ctx: WorkspaceContext,
  knowledgeSourceId: bigint,
  deps: IndexRunDeps = {},
): Promise<IndexResult> {
  if (!canWrite(ctx)) {
    throw new KnowledgeIndexError('Permission denied: knowledge.index', 'permission_denied', true);
  }
  const job = await queueOrNotFound(ctx, knowledgeSourceId, { reason: 'reindex' });
  const outcome = await runKnowledgeIndexJob(ctx, job.id, deps);
  if (outcome.kind === 'succeeded') return { job: outcome.job, chunkCount: outcome.chunkCount };
  if (outcome.kind === 'skipped') {
    throw new KnowledgeIndexError(
      outcome.reason === 'busy'
        ? 'This source is being indexed right now; try again in a minute.'
        : `indexing run ${outcome.reason}`,
      'busy',
      false,
    );
  }
  throw outcome.error;
}

type Claim =
  | { kind: 'claimed'; job: IndexingJob; source: KnowledgeSource }
  | { kind: 'skipped'; reason: 'not_found' | 'not_queued' | 'not_due' | 'busy' };

/**
 * Inside the claim transaction (the source row already locked): will this
 * run have to extract its document — Re-extract with OCR, or no valid
 * extraction cache — while another source of the same document is being
 * indexed? Then it must wait: two sources of one document (legacy data, or
 * Re-extract with OCR queueing every source) would otherwise extract — and
 * pay Mistral OCR — in parallel on a concurrent queue. The document row
 * lock serializes concurrent claims for the same document (lock order:
 * source, then document); once the first run has cached the text, the
 * deferred one reuses it (forceOcr is satisfied by an OCR extraction newer
 * than its row).
 */
async function documentExtractionBusy(
  tx: Tx,
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  source: KnowledgeSource,
  job: IndexingJob,
): Promise<boolean> {
  if (source.kind !== 'document' || source.documentId === null) return false;
  const [doc] = await tx
    .select({ sha256: documents.sha256, extractedSha256: documents.extractedSha256 })
    .from(documents)
    .where(and(eq(documents.workspaceId, ctx.workspaceId), eq(documents.id, source.documentId)))
    .for('update')
    .limit(1);
  if (!doc) return false;
  // No cache, or a cache of other bytes: this run extracts.
  if (!job.forceOcr && doc.extractedSha256 === doc.sha256) return false;
  const [sibling] = await tx
    .select({ id: indexingJobs.id })
    .from(indexingJobs)
    .innerJoin(
      knowledgeSources,
      and(
        eq(knowledgeSources.id, indexingJobs.knowledgeSourceId),
        eq(knowledgeSources.workspaceId, indexingJobs.workspaceId),
      ),
    )
    .where(
      and(
        eq(indexingJobs.workspaceId, ctx.workspaceId),
        eq(indexingJobs.status, 'running'),
        eq(knowledgeSources.documentId, source.documentId),
        ne(indexingJobs.id, job.id),
      ),
    )
    .limit(1);
  return sibling !== undefined;
}

async function claimIndexJob(ctx: WorkspaceContext, jobId: bigint, now: Date): Promise<Claim> {
  return db.transaction(async (tx): Promise<Claim> => {
    const [row] = await tx
      .select()
      .from(indexingJobs)
      .where(and(eq(indexingJobs.workspaceId, ctx.workspaceId), eq(indexingJobs.id, jobId)))
      .limit(1);
    if (!row || row.knowledgeSourceId === null) return { kind: 'skipped', reason: 'not_found' };
    // Lock the source first: claims, requests and finishes of one source
    // serialize on its row.
    const [source] = await tx
      .select()
      .from(knowledgeSources)
      .where(
        and(
          eq(knowledgeSources.workspaceId, ctx.workspaceId),
          eq(knowledgeSources.id, row.knowledgeSourceId),
        ),
      )
      .for('update')
      .limit(1);
    if (!source) return { kind: 'skipped', reason: 'not_found' };
    const [job] = await tx
      .select()
      .from(indexingJobs)
      .where(and(eq(indexingJobs.workspaceId, ctx.workspaceId), eq(indexingJobs.id, jobId)))
      .limit(1);
    if (!job || job.status !== 'queued') return { kind: 'skipped', reason: 'not_queued' };
    if (job.nextAttemptAt !== null && job.nextAttemptAt.getTime() > now.getTime()) {
      return { kind: 'skipped', reason: 'not_due' };
    }
    const [running] = await tx
      .select({ id: indexingJobs.id })
      .from(indexingJobs)
      .where(
        and(
          eq(indexingJobs.workspaceId, ctx.workspaceId),
          eq(indexingJobs.knowledgeSourceId, source.id),
          eq(indexingJobs.status, 'running'),
        ),
      )
      .limit(1);
    if (running || (await documentExtractionBusy(tx, ctx, source, job))) {
      await tx
        .update(indexingJobs)
        .set({ nextAttemptAt: new Date(now.getTime() + BUSY_DEFER_MS) })
        .where(and(eq(indexingJobs.id, job.id), eq(indexingJobs.status, 'queued')));
      return { kind: 'skipped', reason: 'busy' };
    }
    const [claimed] = await tx
      .update(indexingJobs)
      .set({
        status: 'running',
        startedAt: now,
        finishedAt: null,
        attempts: sql`${indexingJobs.attempts} + 1`,
      })
      .where(and(eq(indexingJobs.id, job.id), eq(indexingJobs.status, 'queued')))
      .returning();
    if (!claimed) return { kind: 'skipped', reason: 'not_queued' };
    await tx
      .update(knowledgeSources)
      .set({ indexStatus: 'indexing' })
      .where(
        and(eq(knowledgeSources.workspaceId, ctx.workspaceId), eq(knowledgeSources.id, source.id)),
      );
    return { kind: 'claimed', job: claimed, source };
  });
}

interface ExternalOutcome {
  providerId: string;
  fileId: string | null;
  /** Some products failed to attach (the others succeeded). */
  error: string | null;
}

interface IndexWork {
  chunkCount: number;
  reembedded: boolean;
  model: string;
  hash: string;
  external: ExternalOutcome;
}

async function sourceText(
  ctx: WorkspaceContext,
  job: IndexingJob,
  source: KnowledgeSource,
  deps: IndexRunDeps,
): Promise<{ text: string; document: Document | null }> {
  if (source.kind === 'text') return { text: source.textExcerpt ?? '', document: null };
  if (source.kind === 'url') {
    // The URL itself is not fetched yet (KL-08 adds the guarded fetcher).
    return { text: `${source.title}\n${source.summary ?? ''}\n${source.url ?? ''}`, document: null };
  }
  if (!source.documentId) {
    throw new KnowledgeIndexError('this source has no document', 'document_unavailable', true);
  }
  const [doc] = await db
    .select()
    .from(documents)
    .where(
      and(eq(documents.workspaceId, ctx.workspaceId), eq(documents.id, source.documentId)),
    )
    .limit(1);
  if (!doc) throw new KnowledgeIndexError('its document no longer exists', 'document_unavailable', true);
  if (doc.status === 'uploading' || doc.status === 'failed') {
    throw new KnowledgeIndexError(`its document is ${doc.status}`, 'document_unavailable', true);
  }
  const extraction = await extractDocumentText(ctx, doc, {
    storage: deps.storage,
    forceOcr: job.forceOcr,
    forceOcrSince: job.createdAt,
  });
  return { text: extraction.text, document: doc };
}

async function performIndex(
  ctx: WorkspaceContext,
  job: IndexingJob,
  source: KnowledgeSource,
  deps: IndexRunDeps,
): Promise<IndexWork> {
  let productIds: bigint[] = [];
  if (source.scopeKind === 'products') {
    productIds =
      (await loadSourceProductIds(ctx.workspaceId, [source.id])).get(source.id.toString()) ?? [];
    if (productIds.length === 0) throw needsScopeError();
  }

  const { text, document } = await sourceText(ctx, job, source, deps);
  if (!text.trim()) {
    throw new KnowledgeIndexError(
      `knowledge_source ${source.id} produced no extractable text`,
      'no_text',
      true,
    );
  }
  const hash = contentHash(text);
  const embedder = deps.embedder ?? (await getEmbeddingProviderForCtx(ctx));
  const model = embedder.model;
  const existing = await countSourceChunks(ctx, source.id);
  const unchanged =
    existing > 0 && source.indexedContentHash === hash && source.indexedEmbeddingModel === model;
  const chunkCount = unchanged
    ? existing
    : await replaceSourceChunks(ctx, embedder, chunkText(text), source.id, {
        contentHash: hash,
        embeddingModel: model,
      });

  const external =
    source.scopeKind === 'products'
      ? await attachToProducts(ctx, source, productIds, document, deps)
      : // A workspace-wide source is tied to no product store: its local
        // chunks are its index (KL-05).
        { providerId: 'pgvector', fileId: null, error: null };
  return { chunkCount, reembedded: !unchanged, model, hash, external };
}

async function attachToProducts(
  ctx: WorkspaceContext,
  source: KnowledgeSource,
  productIds: readonly bigint[],
  document: Document | null,
  deps: IndexRunDeps,
): Promise<ExternalOutcome> {
  const { getVectorStorageProviderForCtx } = await import('@/lib/vector-storage');
  const provider = await getVectorStorageProviderForCtx(ctx);
  const perCopy = provider.indexesPerSource !== true;

  // A per-copy provider re-attaching under the same provider replaces its
  // previous copies first. Never for indexesPerSource: detach would drop
  // the chunks this run just built.
  if (perCopy && source.externalProviderId === provider.id && source.externalStatus === 'indexed') {
    try {
      await provider.detachKnowledgeSource(ctx, source.id);
    } catch (err) {
      console.error('[knowledge-indexing] pre-attach detach failed:', err);
    }
  }

  // Bytes only for providers that upload a copy; read once for all products.
  let fileBytes: Buffer | undefined;
  let filename: string | undefined;
  let mimeType: string | undefined;
  let text: string | undefined;
  let url: string | undefined;
  if (perCopy) {
    if (source.kind === 'document' && document) {
      const storage = deps.storage ?? getStorage();
      const chunks: Buffer[] = [];
      for await (const chunk of (await storage.get(document.storageKey)) as AsyncIterable<
        Buffer | string
      >) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      fileBytes = Buffer.concat(chunks);
      filename = document.filename;
      mimeType = document.mimeType;
    } else if (source.kind === 'text') {
      text = source.textExcerpt ?? '';
    } else if (source.kind === 'url') {
      url = source.url ?? '';
    }
  }

  const errors: string[] = [];
  let firstFileId: string | null = null;
  for (const productId of productIds) {
    try {
      const r = await provider.attachKnowledgeSource(ctx, productId, {
        knowledgeSource: source,
        fileBytes,
        filename,
        mimeType,
        text,
        url,
      });
      if (firstFileId === null) firstFileId = r.externalFileId;
    } catch (err) {
      errors.push(`product ${productId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (errors.length === productIds.length) {
    throw new KnowledgeIndexError(
      `attach failed for all ${productIds.length} product(s): ${errors.join('; ')}`,
      'attach_failed',
      false,
    );
  }
  return {
    providerId: provider.id,
    fileId: firstFileId,
    error: errors.length > 0 ? errors.join('; ') : null,
  };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockSourceStatus(
  tx: Tx,
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  sourceId: bigint,
): Promise<KnowledgeIndexStatus | null> {
  const [row] = await tx
    .select({ indexStatus: knowledgeSources.indexStatus })
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.workspaceId, ctx.workspaceId), eq(knowledgeSources.id, sourceId)))
    .for('update')
    .limit(1);
  return row?.indexStatus ?? null;
}

/** While a newer request waits, the source shows that request's state. */
function statusWhilePending(current: KnowledgeIndexStatus | null): KnowledgeIndexStatus {
  return current === 'stale' ? 'stale' : 'queued';
}

/**
 * Close a run that did its work. Only a run still 'running' may: when the
 * sweeper already timed it out (a hung run that finished after 15
 * minutes), its row stays 'failed' and the source is left to whichever run
 * holds it now — never flipped to 'indexed' under a newer run (the partial
 * unique index allows one 'running' row per source, so with ours still
 * running no other can be). Returns null in that case.
 */
async function finishSucceeded(
  ctx: WorkspaceContext,
  job: IndexingJob,
  source: KnowledgeSource,
  work: IndexWork,
  now: Date,
): Promise<IndexingJob | null> {
  const closed = await db.transaction(async (tx) => {
    const current = await lockSourceStatus(tx, ctx, source.id);
    const pendingJob = await otherQueuedJob(tx, ctx, source.id, job.id);
    const [row] = await tx
      .update(indexingJobs)
      .set({
        status: 'succeeded',
        chunkCount: work.chunkCount,
        embeddingModel: work.model,
        note: work.reembedded ? 'embedded' : 'unchanged',
        error: null,
        nextAttemptAt: null,
        finishedAt: now,
      })
      .where(
        and(
          eq(indexingJobs.workspaceId, ctx.workspaceId),
          eq(indexingJobs.id, job.id),
          eq(indexingJobs.status, 'running'),
        ),
      )
      .returning();
    if (!row) return null;
    await tx
      .update(knowledgeSources)
      .set({
        indexStatus: pendingJob ? statusWhilePending(current) : 'indexed',
        indexedAt: now,
        ...(pendingJob ? {} : { lastIndexError: null }),
        externalProviderId: work.external.providerId,
        externalFileId: work.external.fileId,
        externalStatus: 'indexed',
        externalError: work.external.error,
        externalIndexedAt: now,
      })
      .where(
        and(eq(knowledgeSources.workspaceId, ctx.workspaceId), eq(knowledgeSources.id, source.id)),
      );
    return { finished: row, pending: pendingJob !== null };
  });
  if (!closed) {
    console.error(
      `[knowledge-indexing] workspace=${ctx.workspaceId} source=${source.id} job=${job.id} finished after the sweeper closed it; source status left alone`,
    );
    await recordAuditEvent(ctx, {
      kind: 'rag.index_knowledge_source_late',
      entityType: 'knowledge_source',
      entityId: source.id,
      payload: { jobId: job.id.toString(), chunkCount: work.chunkCount, attempts: job.attempts },
    });
    return null;
  }
  const { finished, pending } = closed;
  if (!pending) await resolveNotifications(ctx.workspaceId, knowledgeIndexFailedKey(source.id));
  await recordAuditEvent(ctx, {
    kind: 'rag.index_knowledge_source',
    entityType: 'knowledge_source',
    entityId: source.id,
    payload: {
      jobId: job.id.toString(),
      chunkCount: work.chunkCount,
      model: work.model,
      kind: source.kind,
      reembedded: work.reembedded,
      providerId: work.external.providerId,
      attempts: job.attempts,
    },
  });
  return finished;
}

async function finishFailed(
  ctx: WorkspaceContext,
  job: IndexingJob,
  source: KnowledgeSource,
  err: unknown,
  now: Date,
): Promise<IndexRunOutcome> {
  const message = errorMessage(err);
  const permanent = isPermanentIndexError(err);
  const result = await db.transaction(
    async (tx): Promise<{ kind: 'retrying' | 'failed'; row: IndexingJob | null; notifyNow: boolean }> => {
      const current = await lockSourceStatus(tx, ctx, source.id);
      const stillOurs = and(
        eq(indexingJobs.workspaceId, ctx.workspaceId),
        eq(indexingJobs.id, job.id),
        eq(indexingJobs.status, 'running'),
      );
      const pendingJob = await otherQueuedJob(tx, ctx, source.id, job.id);
      const setSource = (indexStatus: KnowledgeIndexStatus) =>
        tx
          .update(knowledgeSources)
          .set({ indexStatus, lastIndexError: message })
          .where(
            and(
              eq(knowledgeSources.workspaceId, ctx.workspaceId),
              eq(knowledgeSources.id, source.id),
            ),
          );

      if (pendingJob) {
        // A newer request is queued: it supersedes this run (and inherits
        // an OCR request it would otherwise lose).
        const [row] = await tx
          .update(indexingJobs)
          .set({ status: 'failed', error: message, note: 'superseded', finishedAt: now })
          .where(stillOurs)
          .returning();
        if (!row) return { kind: 'failed', row: null, notifyNow: false };
        if (job.forceOcr && !pendingJob.forceOcr) {
          await tx
            .update(indexingJobs)
            .set({ forceOcr: true })
            .where(eq(indexingJobs.id, pendingJob.id));
        }
        await setSource(statusWhilePending(current));
        return { kind: 'failed', row, notifyNow: false };
      }
      if (!permanent && job.attempts < MAX_INDEX_ATTEMPTS) {
        const [row] = await tx
          .update(indexingJobs)
          .set({
            status: 'queued',
            error: message,
            nextAttemptAt: new Date(now.getTime() + indexRetryDelayMs(job.attempts)),
            finishedAt: null,
          })
          .where(stillOurs)
          .returning();
        if (!row) return { kind: 'failed', row: null, notifyNow: false };
        await setSource('queued');
        return { kind: 'retrying', row, notifyNow: false };
      }
      const [row] = await tx
        .update(indexingJobs)
        .set({ status: 'failed', error: message, finishedAt: now })
        .where(stillOurs)
        .returning();
      if (!row) return { kind: 'failed', row: null, notifyNow: false };
      await setSource('failed');
      return { kind: 'failed', row, notifyNow: true };
    },
  );

  console.error(
    `[knowledge-indexing] workspace=${ctx.workspaceId} source=${source.id} job=${job.id} attempt ${job.attempts} ${result.kind}: ${message}`,
  );
  if (result.notifyNow) await notifyKnowledgeIndexFailed(ctx.workspaceId, source, message);
  await recordAuditEvent(ctx, {
    kind: 'rag.index_knowledge_source_failed',
    entityType: 'knowledge_source',
    entityId: source.id,
    payload: {
      jobId: job.id.toString(),
      attempts: job.attempts,
      outcome: result.kind,
      permanent,
      error: message.slice(0, 500),
    },
  });
  // The row moved on (the sweeper timed it out): report what it is now.
  const row =
    result.row ??
    (
      await db
        .select()
        .from(indexingJobs)
        .where(and(eq(indexingJobs.workspaceId, ctx.workspaceId), eq(indexingJobs.id, job.id)))
        .limit(1)
    )[0] ??
    job;
  return { kind: result.kind, job: row, error: err, message };
}

// ---- the sweeper -----------------------------------------------------------------

export interface KnowledgeIndexSweepResult {
  timedOut: number;
  notified: number;
  enqueued: number;
  workspacesFailed: number;
}

/**
 * One knowledge.index.sweep pass over every active workspace (see the
 * module header). Exported for tests; `now` lets them move the clock.
 */
export async function runKnowledgeIndexSweep(
  now: Date = new Date(),
  queue?: IJobQueue,
): Promise<KnowledgeIndexSweepResult> {
  const result: KnowledgeIndexSweepResult = {
    timedOut: 0,
    notified: 0,
    enqueued: 0,
    workspacesFailed: 0,
  };
  const wss = await db
    .select({ id: workspaces.id, ownerUserId: workspaces.ownerUserId })
    .from(workspaces)
    .where(eq(workspaces.status, 'active'));
  const q = queue ?? (await import('@/lib/jobs')).getJobQueue();
  for (const ws of wss) {
    try {
      const ctx = makeWorkspaceContext({ workspaceId: ws.id, userId: ws.ownerUserId, role: 'owner' });
      await sweepWorkspace(ctx, now, result, q);
    } catch (err) {
      result.workspacesFailed += 1;
      console.error(
        `[knowledge.index.sweep] workspace=${ws.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return result;
}

async function sweepWorkspace(
  ctx: WorkspaceContext,
  now: Date,
  result: KnowledgeIndexSweepResult,
  queue: IJobQueue,
): Promise<void> {
  // 1. Runs older than 15 minutes: failed, with a message and a notice.
  const cutoff = new Date(now.getTime() - INDEX_RUN_TIMEOUT_MS);
  const stuck = await db
    .select()
    .from(indexingJobs)
    .where(
      and(
        eq(indexingJobs.workspaceId, ctx.workspaceId),
        eq(indexingJobs.status, 'running'),
        isNotNull(indexingJobs.knowledgeSourceId),
        lt(indexingJobs.startedAt, cutoff),
      ),
    )
    .orderBy(asc(indexingJobs.id))
    .limit(SWEEP_BATCH);
  for (const job of stuck) {
    const sourceId = job.knowledgeSourceId!;
    const out = await db.transaction(async (tx) => {
      const current = await lockSourceStatus(tx, ctx, sourceId);
      const [row] = await tx
        .update(indexingJobs)
        .set({
          status: 'failed',
          error: INDEX_TIMEOUT_MESSAGE,
          note: 'timed_out',
          finishedAt: now,
        })
        .where(
          and(
            eq(indexingJobs.id, job.id),
            eq(indexingJobs.status, 'running'),
            lt(indexingJobs.startedAt, cutoff),
          ),
        )
        .returning();
      if (!row || current === null) return null;
      const pendingJob = await otherQueuedJob(tx, ctx, sourceId, job.id);
      const [source] = await tx
        .update(knowledgeSources)
        .set({
          indexStatus: pendingJob ? statusWhilePending(current) : 'failed',
          lastIndexError: INDEX_TIMEOUT_MESSAGE,
        })
        .where(
          and(eq(knowledgeSources.workspaceId, ctx.workspaceId), eq(knowledgeSources.id, sourceId)),
        )
        .returning();
      return source ? { source, notifyNow: pendingJob === null } : null;
    });
    if (!out) continue;
    result.timedOut += 1;
    console.error(
      `[knowledge.index.sweep] workspace=${ctx.workspaceId} source=${sourceId} job=${job.id} timed out`,
    );
    if (out.notifyNow && (await notifyKnowledgeIndexFailed(ctx.workspaceId, out.source, INDEX_TIMEOUT_MESSAGE))) {
      result.notified += 1;
    }
    await recordAuditEvent(ctx, {
      kind: 'rag.index_knowledge_source_failed',
      entityType: 'knowledge_source',
      entityId: sourceId,
      payload: { jobId: job.id.toString(), attempts: job.attempts, outcome: 'timed_out' },
    });
  }

  // 2. Due queued rows: a passed backoff (or busy deferral), or a lost job.
  const lostBefore = new Date(now.getTime() - LOST_INDEX_JOB_AFTER_MS);
  const due = await db
    .select({ id: indexingJobs.id })
    .from(indexingJobs)
    .where(
      and(
        eq(indexingJobs.workspaceId, ctx.workspaceId),
        eq(indexingJobs.status, 'queued'),
        isNotNull(indexingJobs.knowledgeSourceId),
        or(
          lte(indexingJobs.nextAttemptAt, now),
          and(isNull(indexingJobs.nextAttemptAt), lt(indexingJobs.createdAt, lostBefore)),
        ),
      ),
    )
    .orderBy(asc(indexingJobs.id))
    .limit(SWEEP_BATCH);
  for (const d of due) {
    const payload: KnowledgeIndexPayload = {
      workspaceId: ctx.workspaceId.toString(),
      jobId: d.id.toString(),
      userId: ctx.userId,
      role: ctx.role,
    };
    await queue.enqueue(KNOWLEDGE_INDEX_JOB, payload, { tag: `knowledge-index:${d.id}` });
    result.enqueued += 1;
  }
}
