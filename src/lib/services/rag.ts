// RAG indexing + retrieval service.
//
// Index path (KL-06: indexing is a job — knowledge-indexing.ts):
//   indexDocument(ctx, documentId)         — index this document's sources NOW, in-process
//   indexKnowledgeSource(ctx, ksId)        — index one source NOW, in-process
//   replaceSourceChunks(...)               — the chunk swap the knowledge.index job uses
//   embedLesson(ctx, lessonId)             — embed a single learning_lesson
//   embedAllLessons(ctx)                   — bulk-embed every active, in-scope lesson
//
// Pages never index inside the request any more: they queue a run
// (requestKnowledgeIndex / requestDocumentIndex) and the knowledge.index
// job does the work. indexDocument / indexKnowledgeSource run that same
// job inline (same outbox row, same extraction cache, same no-re-embed
// rule) for scripts and tests that need the result at once.
//
// Retrieval path:
//   retrieve(ctx, query, opts)             — top-k cosine-nearest chunks
//   retrieveLessons(ctx, query, opts)      — top-k cosine-nearest lessons
//
// KL-05: every chunk is owned by exactly one knowledge source, and only
// knowledge-scope.ts decides whether a source's chunks may reach a prompt
// (scope, archived document). There are no "document-level" chunks any
// more: a NULL source used to mean workspace-wide, which is how a
// product-scoped document leaked into every product (I039).

import { and, desc, eq, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  documents,
  knowledgeSources,
  type DocumentMeta,
  type KnowledgeSource,
} from '@/lib/db/schema/documents';
import {
  documentChunks,
  indexingJobs,
  type DocumentChunk,
  type IndexingJob,
  type NewDocumentChunk,
} from '@/lib/db/schema/rag';
import { learningLessons, type LearningLesson } from '@/lib/db/schema/learning';
import { recordAuditEvent } from './audit';
import { canWrite, type WorkspaceContext } from './context';
import { DocumentExtractionError } from './document-extraction';
import { documentMetaColumns } from './documents';
import { knowledgeSourceRetrievable, WORKSPACE_KNOWLEDGE_SCOPE } from './knowledge-scope';
// knowledge-sources.ts reaches rag.ts only through dynamic imports, and
// knowledge-indexing.ts (which imports rag.ts) is reached from here only
// through a dynamic import, so these static imports have no cycle.
import { createKnowledgeSource, listDocumentSources } from './knowledge-sources';
import { categoriesForTaskType, type LessonTaskType } from './learning-categories';
// Static import is safe: learning.ts reaches rag.ts only through a
// dynamic import (scheduleLessonEmbedding), so there is no load cycle.
import { lessonInScope } from './learning';
import type { IStorage } from '@/lib/storage';
import {
  EMBEDDING_DIM,
  getEmbeddingProviderForCtx,
  type IEmbeddingProvider,
} from '@/lib/embeddings';

export { isIndexableDocument } from './document-extraction';

export class RagServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'RagServiceError';
    this.code = code;
  }
}

const permissionDenied = (op: string) =>
  new RagServiceError(`Permission denied: ${op}`, 'permission_denied');
const notFound = (kind: string) =>
  new RagServiceError(`${kind} not found`, 'not_found');
const invariant = (msg: string) =>
  new RagServiceError(msg, 'invariant_violation');
const invalid = (msg: string) =>
  new RagServiceError(msg, 'invalid_input');

// ---- chunking ------------------------------------------------------

/** Approximately 500-token chunks (2000 chars) with 200-char overlap. */
const CHUNK_CHAR_TARGET = 2000;
const CHUNK_CHAR_OVERLAP = 200;
const MAX_CHUNKS_PER_SOURCE = 1000;

export interface Chunk {
  index: number;
  startChar: number;
  endChar: number;
  content: string;
  tokenCount: number;
}

export function chunkText(input: string): Chunk[] {
  const text = input.replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  const chunks: Chunk[] = [];
  let start = 0;
  let chunkIndex = 0;
  while (start < text.length && chunkIndex < MAX_CHUNKS_PER_SOURCE) {
    const target = Math.min(start + CHUNK_CHAR_TARGET, text.length);
    let end = target;
    if (end < text.length) {
      // Try to break on a sentence/paragraph boundary in the last ~200 chars.
      const window = text.slice(end - 200, end);
      const lastBreak = Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('. '),
        window.lastIndexOf('? '),
        window.lastIndexOf('! '),
      );
      if (lastBreak > 50) {
        end = end - 200 + lastBreak + 1;
      }
    }
    const content = text.slice(start, end).trim();
    if (content) {
      chunks.push({
        index: chunkIndex++,
        startChar: start,
        endChar: end,
        content,
        tokenCount: Math.ceil(content.length / 4),
      });
    }
    if (end >= text.length) break;
    start = Math.max(end - CHUNK_CHAR_OVERLAP, start + 1);
  }
  return chunks;
}

// ---- index (in-process) --------------------------------------------

export interface IndexDeps {
  storage?: IStorage;
  embedder?: IEmbeddingProvider;
}

export interface IndexResult {
  job: IndexingJob;
  chunkCount: number;
}

export interface IndexDocumentResult extends IndexResult {
  /** One entry per source of the document, in order. `job` above is the
   *  last one's (kept for callers that index a single-source document). */
  sources: Array<{ knowledgeSourceId: bigint; job: IndexingJob; chunkCount: number }>;
  /** Set when the document had no source and indexing created a
   *  workspace-wide one for it. */
  createdSourceId: bigint | null;
}

/** Extraction failures surface as this module's invalid_input, as before. */
function asRagError(err: unknown): unknown {
  return err instanceof DocumentExtractionError ? invalid(err.message) : err;
}

/**
 * KL-05: "index this document's sources". The document's chunks are its
 * knowledge sources' chunks, so re-indexing refreshes exactly those (in
 * place, scope unchanged) and never writes a second, unscoped set (I039).
 * A document with no source yet gets one workspace-wide source (available
 * to every product), created explicitly and audited; to scope it to
 * products, tick them on that source.
 *
 * KL-06: runs the knowledge.index job inline for each source (pages queue
 * it instead — requestDocumentIndex).
 */
export async function indexDocument(
  ctx: WorkspaceContext,
  documentId: bigint,
  deps: IndexDeps = {},
): Promise<IndexDocumentResult> {
  if (!canWrite(ctx)) throw permissionDenied('rag.index_document');
  const docRows = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.workspaceId, ctx.workspaceId),
        eq(documents.id, documentId),
      ),
    )
    .limit(1);
  if (!docRows[0]) throw notFound('document');
  const doc = docRows[0];
  if (doc.status !== 'ready') {
    throw invalid(`cannot index document in status ${doc.status}`);
  }

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

  const results: IndexDocumentResult['sources'] = [];
  let firstError: unknown = null;
  for (const knowledgeSourceId of sourceIds) {
    try {
      const r = await indexKnowledgeSource(ctx, knowledgeSourceId, deps);
      results.push({ knowledgeSourceId, job: r.job, chunkCount: r.chunkCount });
    } catch (err) {
      firstError ??= err;
    }
  }
  if (firstError !== null) throw firstError;
  const last = results[results.length - 1];
  if (!last) throw invariant('document indexing produced no result');
  const chunkCount = results.reduce((n, r) => n + r.chunkCount, 0);
  await recordAuditEvent(ctx, {
    kind: 'rag.index_document',
    entityType: 'document',
    entityId: documentId,
    payload: {
      chunkCount,
      knowledgeSourceIds: results.map((r) => r.knowledgeSourceId.toString()),
      createdSourceId: createdSourceId?.toString() ?? null,
    },
  });
  return { job: last.job, chunkCount, sources: results, createdSourceId };
}

/**
 * Index one source now, in this process: queue its run (reusing a queued
 * one) and execute the knowledge.index job inline. Throws what made the
 * run fail; the run's row records it either way (and, for a transient
 * error, stays queued for its backoff retry).
 */
export async function indexKnowledgeSource(
  ctx: WorkspaceContext,
  knowledgeSourceId: bigint,
  deps: IndexDeps = {},
): Promise<IndexResult> {
  if (!canWrite(ctx)) throw permissionDenied('rag.index_knowledge_source');
  const ks = await db
    .select({ id: knowledgeSources.id })
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.workspaceId, ctx.workspaceId),
        eq(knowledgeSources.id, knowledgeSourceId),
      ),
    )
    .limit(1);
  if (!ks[0]) throw notFound('knowledge_source');
  const { indexKnowledgeSourceNow } = await import('./knowledge-indexing');
  try {
    return await indexKnowledgeSourceNow(ctx, knowledgeSourceId, deps);
  } catch (err) {
    throw asRagError(err);
  }
}

/**
 * Embed first, then swap the source's chunks in one transaction: the old
 * set stays retrievable until the new one is committed, and the source row
 * lock keeps two concurrent re-indexes from leaving both sets behind. The
 * same transaction stamps the source with the hash of the text and the
 * embedding model the new chunks came from (KL-06: a later run with the
 * same hash and model re-embeds nothing).
 */
export async function replaceSourceChunks(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  embedder: IEmbeddingProvider,
  chunks: ReadonlyArray<Chunk>,
  knowledgeSourceId: bigint,
  stamp: { contentHash: string; embeddingModel: string },
): Promise<number> {
  // Batch the embed call — most providers cap at 128 inputs per call.
  const BATCH = 64;
  const now = new Date();
  const rows: NewDocumentChunk[] = [];
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const result = await embedder.embed({ texts: batch.map((c) => c.content) });
    if (result.embeddings.length !== batch.length) {
      throw invariant('embedder returned wrong batch size');
    }
    batch.forEach((c, idx) => {
      rows.push({
        workspaceId: ctx.workspaceId,
        knowledgeSourceId,
        chunkIndex: c.index,
        startChar: c.startChar,
        endChar: c.endChar,
        content: c.content,
        tokenCount: c.tokenCount,
        embedding: result.embeddings[idx]!,
        embeddingModel: result.model,
        embeddingDim: EMBEDDING_DIM,
        embeddedAt: now,
      });
    });
  }

  await db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(
        and(
          eq(knowledgeSources.workspaceId, ctx.workspaceId),
          eq(knowledgeSources.id, knowledgeSourceId),
        ),
      )
      .for('update')
      .limit(1);
    if (!owner) throw notFound('knowledge_source');
    await tx
      .delete(documentChunks)
      .where(
        and(
          eq(documentChunks.workspaceId, ctx.workspaceId),
          eq(documentChunks.knowledgeSourceId, knowledgeSourceId),
        ),
      );
    for (let i = 0; i < rows.length; i += BATCH) {
      await tx.insert(documentChunks).values(rows.slice(i, i + BATCH));
    }
    await tx
      .update(knowledgeSources)
      .set({
        indexedContentHash: stamp.contentHash,
        indexedEmbeddingModel: stamp.embeddingModel,
      })
      .where(
        and(
          eq(knowledgeSources.workspaceId, ctx.workspaceId),
          eq(knowledgeSources.id, knowledgeSourceId),
        ),
      );
  });
  return rows.length;
}

/** Chunks a source owns right now. */
export async function countSourceChunks(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  knowledgeSourceId: bigint,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(documentChunks)
    .where(
      and(
        eq(documentChunks.workspaceId, ctx.workspaceId),
        eq(documentChunks.knowledgeSourceId, knowledgeSourceId),
      ),
    );
  return Number(row?.n ?? 0);
}

// ---- lesson embedding ----------------------------------------------

export async function embedLesson(
  ctx: WorkspaceContext,
  lessonId: bigint,
  embedder?: IEmbeddingProvider,
): Promise<LearningLesson> {
  if (!canWrite(ctx)) throw permissionDenied('rag.embed_lesson');
  const rows = await db
    .select()
    .from(learningLessons)
    .where(
      and(
        eq(learningLessons.workspaceId, ctx.workspaceId),
        eq(learningLessons.id, lessonId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound('learning_lesson');
  const lesson = rows[0];

  const embedderInst = embedder ?? (await getEmbeddingProviderForCtx(ctx));
  const result = await embedderInst.embed({ texts: [lesson.rule] });
  const [updated] = await db
    .update(learningLessons)
    .set({
      embedding: result.embeddings[0]!,
      embeddingModel: result.model,
      embeddingDim: EMBEDDING_DIM,
      embeddedAt: new Date(),
    })
    .where(eq(learningLessons.id, lessonId))
    .returning();
  if (!updated) throw invariant('lesson embed update returned no row');
  return updated;
}

export async function embedAllLessons(
  ctx: WorkspaceContext,
  embedder?: IEmbeddingProvider,
): Promise<{ embedded: number }> {
  if (!canWrite(ctx)) throw permissionDenied('rag.embed_all_lessons');
  // Only rules some prompt can actually receive: active and in scope.
  const rows = await db
    .select()
    .from(learningLessons)
    .where(
      and(
        eq(learningLessons.workspaceId, ctx.workspaceId),
        eq(learningLessons.lifecycle, 'active'),
        lessonInScope(),
      ),
    );
  const embedderInst = embedder ?? (await getEmbeddingProviderForCtx(ctx));
  let embedded = 0;
  // Single batch per workspace; most workspaces will have well under 64
  // active lessons so this round-trips once.
  const BATCH = 64;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const result = await embedderInst.embed({ texts: batch.map((l) => l.rule) });
    const now = new Date();
    for (let j = 0; j < batch.length; j++) {
      await db
        .update(learningLessons)
        .set({
          embedding: result.embeddings[j]!,
          embeddingModel: result.model,
          embeddingDim: EMBEDDING_DIM,
          embeddedAt: now,
        })
        .where(eq(learningLessons.id, batch[j]!.id));
      embedded++;
    }
  }
  return { embedded };
}

// ---- retrieval -----------------------------------------------------

export interface RetrieveOptions {
  /** Top-k. Defaults to 8. */
  limit?: number;
  /** Workspace-wide sources plus this product's. Omitted: workspace-wide
   *  sources plus every source that still has a product (Suggest reply on
   *  a thread with no lead product). See knowledge-scope.ts. */
  productProfileId?: bigint;
  /** Phase 22: filter chunks to a single knowledge purpose category. */
  purposeCategory?:
    | 'technical'
    | 'marketing'
    | 'case_study'
    | 'internal_note'
    | 'objection_handling'
    | 'general';
  embedder?: IEmbeddingProvider;
}

export interface RetrievedChunk {
  chunk: DocumentChunk;
  similarity: number;
  /** The document the owning source wraps (kind=document), else null —
   *  without its extraction cache (KL-06). */
  document: DocumentMeta | null;
  knowledgeSource: KnowledgeSource;
}

/**
 * Top-k cosine-nearest chunks for `query` in the workspace. Uses pgvector's
 * `<=>` (cosine distance) operator — similarity = 1 - distance.
 *
 * Which chunks may be returned is decided by THE predicate
 * (knowledgeSourceRetrievable): the owning source's scope and whether its
 * document is archived. An identical passage (e.g. one document wrapped
 * by two sources, possible only in data from before KL-05) is returned
 * once.
 */
export async function retrieve(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  query: string,
  options: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  if (!query.trim()) return [];
  const embedder = options.embedder ?? (await getEmbeddingProviderForCtx(ctx));
  const result = await embedder.embed({ texts: [query] });
  const queryVec = result.embeddings[0]!;
  const literal = vectorLiteral(queryVec);
  const limit = Math.min(options.limit ?? 8, 100);

  const conditions: SQL[] = [
    eq(documentChunks.workspaceId, ctx.workspaceId),
    isNotNull(documentChunks.embedding),
    knowledgeSourceRetrievable({
      workspaceId: ctx.workspaceId,
      productProfileId: options.productProfileId,
    }),
  ];
  // Phase 22: optional purpose-category filter (a source-level axis).
  if (options.purposeCategory !== undefined) {
    conditions.push(eq(knowledgeSources.purposeCategory, options.purposeCategory));
  }

  const rows = await db
    .select({
      chunk: documentChunks,
      document: documentMetaColumns,
      knowledgeSource: knowledgeSources,
      similarity: sql<number>`1 - (${documentChunks.embedding} <=> ${sql.raw(`'${literal}'::vector`)})`.as('similarity'),
    })
    .from(documentChunks)
    .innerJoin(
      knowledgeSources,
      and(
        eq(knowledgeSources.id, documentChunks.knowledgeSourceId),
        eq(knowledgeSources.workspaceId, documentChunks.workspaceId),
      ),
    )
    .leftJoin(
      documents,
      and(
        eq(documents.id, knowledgeSources.documentId),
        eq(documents.workspaceId, knowledgeSources.workspaceId),
      ),
    )
    .where(and(...conditions))
    .orderBy(sql`${documentChunks.embedding} <=> ${sql.raw(`'${literal}'::vector`)}`)
    // Headroom for the duplicate-passage filter below.
    .limit(Math.min(limit * 2, 200));

  const seen = new Set<string>();
  const out: RetrievedChunk[] = [];
  for (const r of rows) {
    if (seen.has(r.chunk.content)) continue;
    seen.add(r.chunk.content);
    out.push({
      chunk: r.chunk,
      similarity: Number(r.similarity),
      document: r.document,
      knowledgeSource: r.knowledgeSource,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export interface RetrievedLesson {
  lesson: LearningLesson;
  similarity: number;
}

export interface RetrieveLessonsOptions {
  /** Top-k. Defaults to 8. */
  limit?: number;
  /** Workspace-wide rules plus that product's rules; omitted = every rule
   *  that applies somewhere (lessonInScope()). */
  productProfileId?: bigint;
  /** The consuming task; only its registry categories are searched. */
  taskType?: LessonTaskType;
  embedder?: IEmbeddingProvider;
}

/** Top-k cosine-nearest active, in-scope learning_lessons for `query`. */
export async function retrieveLessons(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  query: string,
  options: RetrieveLessonsOptions = {},
): Promise<RetrievedLesson[]> {
  if (!query.trim()) return [];
  const embedder = options.embedder ?? (await getEmbeddingProviderForCtx(ctx));
  const result = await embedder.embed({ texts: [query] });
  const queryVec = result.embeddings[0]!;
  const literal = vectorLiteral(queryVec);
  const limit = Math.min(options.limit ?? 8, 50);

  const conditions: SQL[] = [
    eq(learningLessons.workspaceId, ctx.workspaceId),
    eq(learningLessons.lifecycle, 'active'),
    isNotNull(learningLessons.embedding),
    lessonInScope(options.productProfileId),
  ];
  if (options.taskType !== undefined) {
    conditions.push(inArray(learningLessons.category, categoriesForTaskType(options.taskType)));
  }

  const rows = await db
    .select({
      lesson: learningLessons,
      similarity: sql<number>`1 - (${learningLessons.embedding} <=> ${sql.raw(`'${literal}'::vector`)})`.as('similarity'),
    })
    .from(learningLessons)
    .where(and(...conditions))
    .orderBy(sql`${learningLessons.embedding} <=> ${sql.raw(`'${literal}'::vector`)}`)
    .limit(limit);

  return rows.map((r) => ({ lesson: r.lesson, similarity: Number(r.similarity) }));
}

function vectorLiteral(v: ReadonlyArray<number>): string {
  return `[${v.join(',')}]`;
}

// ---- read ---------------------------------------------------------

/** Sources wrapping a document, as a subquery for IN (...). */
function sourcesWrappingDocument(workspaceId: bigint, documentId: bigint) {
  return db
    .select({ id: knowledgeSources.id })
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.workspaceId, workspaceId),
        eq(knowledgeSources.documentId, documentId),
      ),
    );
}

/**
 * Indexing runs, newest first. With `documentId`: the runs of the
 * document's knowledge sources (KL-05: the document page lists its sources'
 * jobs — a document is indexed only through them), plus the document-level
 * runs recorded before KL-05.
 */
export async function listIndexingJobs(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: { documentId?: bigint; knowledgeSourceId?: bigint; limit?: number } = {},
): Promise<IndexingJob[]> {
  const conditions: SQL[] = [eq(indexingJobs.workspaceId, ctx.workspaceId)];
  if (filter.documentId !== undefined) {
    conditions.push(
      or(
        eq(indexingJobs.documentId, filter.documentId),
        inArray(
          indexingJobs.knowledgeSourceId,
          sourcesWrappingDocument(ctx.workspaceId, filter.documentId),
        ),
      )!,
    );
  }
  if (filter.knowledgeSourceId !== undefined) {
    conditions.push(eq(indexingJobs.knowledgeSourceId, filter.knowledgeSourceId));
  }
  return db
    .select()
    .from(indexingJobs)
    .where(and(...conditions))
    .orderBy(desc(indexingJobs.createdAt), desc(indexingJobs.id))
    .limit(Math.min(filter.limit ?? 50, 500));
}

/** The chunks of a document = the chunks of the sources wrapping it. */
export async function listChunksForDocument(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  documentId: bigint,
): Promise<DocumentChunk[]> {
  return db
    .select()
    .from(documentChunks)
    .where(
      and(
        eq(documentChunks.workspaceId, ctx.workspaceId),
        inArray(documentChunks.knowledgeSourceId, sourcesWrappingDocument(ctx.workspaceId, documentId)),
      ),
    )
    .orderBy(documentChunks.knowledgeSourceId, documentChunks.chunkIndex);
}
