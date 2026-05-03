// RAG indexing + retrieval service.
//
// Index path:
//   indexDocument(ctx, documentId)         — chunk + embed a document's bytes
//   indexKnowledgeSource(ctx, ksId)        — chunk + embed a text/url source
//   embedLesson(ctx, lessonId)             — embed a single learning_lesson
//   embedAllLessons(ctx)                   — bulk-embed every enabled lesson
//
// Retrieval path:
//   retrieve(ctx, query, opts)             — top-k cosine-nearest chunks
//   retrieveLessons(ctx, query, opts)      — top-k cosine-nearest lessons

import { and, desc, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import { Readable } from 'node:stream';
import { db } from '@/lib/db/client';
import {
  documents,
  knowledgeSources,
  type Document,
  type KnowledgeSource,
} from '@/lib/db/schema/documents';
import {
  documentChunks,
  indexingJobs,
  type DocumentChunk,
  type IndexingJob,
  type NewDocumentChunk,
  type NewIndexingJob,
} from '@/lib/db/schema/rag';
import { learningLessons, type LearningLesson } from '@/lib/db/schema/learning';
import { recordAuditEvent } from './audit';
import { canWrite, type WorkspaceContext } from './context';
import { getStorage, type IStorage } from '@/lib/storage';
import {
  EMBEDDING_DIM,
  getEmbeddingProvider,
  type IEmbeddingProvider,
} from '@/lib/embeddings';

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

interface Chunk {
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

// ---- text extraction ------------------------------------------------

interface ExtractDeps {
  storage?: IStorage;
}

async function extractDocumentText(
  document: Document,
  deps: ExtractDeps = {},
): Promise<string> {
  const storage = deps.storage ?? getStorage();
  const stream = await storage.get(document.storageKey);
  const buffer = await streamToBuffer(stream);
  const mime = document.mimeType.toLowerCase();

  if (mime.startsWith('text/') || mime === 'application/json') {
    return buffer.toString('utf8');
  }
  if (mime === 'text/html' || mime === 'application/xhtml+xml') {
    return stripHtml(buffer.toString('utf8'));
  }
  // Phase 12 supports plain-text. PDF + DOCX extraction is a Phase 12+
  // upgrade — we keep the schema ready and the caller can inject text via
  // a knowledge_source(kind=text) for now.
  // Heuristic: if the buffer looks like UTF-8 text, treat it as such.
  const sample = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('utf8');
  if (looksLikeText(sample)) return buffer.toString('utf8');
  throw invalid(`unsupported mime type for indexing: ${mime}`);
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function looksLikeText(sample: string): boolean {
  let nonText = 0;
  for (const ch of sample) {
    const code = ch.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 65533) {
      nonText++;
    }
  }
  return nonText / Math.max(1, sample.length) < 0.05;
}

async function streamToBuffer(stream: Readable | NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// ---- index ---------------------------------------------------------

export interface IndexResult {
  job: IndexingJob;
  chunkCount: number;
}

export async function indexDocument(
  ctx: WorkspaceContext,
  documentId: bigint,
  deps: ExtractDeps & { embedder?: IEmbeddingProvider } = {},
): Promise<IndexResult> {
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

  const job = await startJob(ctx, { documentId, knowledgeSourceId: null });
  try {
    const text = await extractDocumentText(doc, deps);
    const chunks = chunkText(text);
    const embedder = deps.embedder ?? getEmbeddingProvider();
    const inserted = await embedAndPersist(ctx, embedder, chunks, {
      documentId,
      knowledgeSourceId: null,
    });
    const finished = await finishJob(ctx, job.id, 'succeeded', inserted, embedder.model);
    await recordAuditEvent(ctx, {
      kind: 'rag.index_document',
      entityType: 'document',
      entityId: documentId,
      payload: { chunkCount: inserted, model: embedder.model },
    });
    return { job: finished, chunkCount: inserted };
  } catch (err) {
    await finishJob(
      ctx,
      job.id,
      'failed',
      0,
      null,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }
}

export async function indexKnowledgeSource(
  ctx: WorkspaceContext,
  knowledgeSourceId: bigint,
  deps: ExtractDeps & { embedder?: IEmbeddingProvider } = {},
): Promise<IndexResult> {
  if (!canWrite(ctx)) throw permissionDenied('rag.index_knowledge_source');
  const ksRows = await db
    .select()
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.workspaceId, ctx.workspaceId),
        eq(knowledgeSources.id, knowledgeSourceId),
      ),
    )
    .limit(1);
  if (!ksRows[0]) throw notFound('knowledge_source');
  const ks = ksRows[0];

  const job = await startJob(ctx, {
    documentId: null,
    knowledgeSourceId,
  });
  try {
    let text = '';
    if (ks.kind === 'text') {
      text = ks.textExcerpt ?? '';
    } else if (ks.kind === 'url') {
      text = `${ks.title}\n${ks.summary ?? ''}\n${ks.url ?? ''}`;
    } else if (ks.kind === 'document' && ks.documentId) {
      // Forward to document indexing; both the document and ks rows can
      // surface in retrieval via the join.
      const docRows = await db
        .select()
        .from(documents)
        .where(eq(documents.id, ks.documentId))
        .limit(1);
      if (docRows[0]) {
        text = await extractDocumentText(docRows[0], deps);
      }
    }
    if (!text.trim()) {
      throw invalid(`knowledge_source ${ks.id} produced no extractable text`);
    }
    const chunks = chunkText(text);
    const embedder = deps.embedder ?? getEmbeddingProvider();
    const inserted = await embedAndPersist(ctx, embedder, chunks, {
      documentId: null,
      knowledgeSourceId,
    });
    const finished = await finishJob(ctx, job.id, 'succeeded', inserted, embedder.model);
    await recordAuditEvent(ctx, {
      kind: 'rag.index_knowledge_source',
      entityType: 'knowledge_source',
      entityId: knowledgeSourceId,
      payload: { chunkCount: inserted, model: embedder.model, kind: ks.kind },
    });
    return { job: finished, chunkCount: inserted };
  } catch (err) {
    await finishJob(
      ctx,
      job.id,
      'failed',
      0,
      null,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }
}

async function embedAndPersist(
  ctx: WorkspaceContext,
  embedder: IEmbeddingProvider,
  chunks: ReadonlyArray<Chunk>,
  scope: { documentId: bigint | null; knowledgeSourceId: bigint | null },
): Promise<number> {
  // Re-index: drop prior chunks for the same scope.
  if (scope.documentId !== null) {
    await db
      .delete(documentChunks)
      .where(
        and(
          eq(documentChunks.workspaceId, ctx.workspaceId),
          eq(documentChunks.documentId, scope.documentId),
        ),
      );
  }
  if (scope.knowledgeSourceId !== null) {
    await db
      .delete(documentChunks)
      .where(
        and(
          eq(documentChunks.workspaceId, ctx.workspaceId),
          eq(documentChunks.knowledgeSourceId, scope.knowledgeSourceId),
        ),
      );
  }
  if (chunks.length === 0) return 0;

  // Batch the embed call — most providers cap at 128 inputs per call.
  const BATCH = 64;
  const now = new Date();
  let total = 0;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const result = await embedder.embed({ texts: batch.map((c) => c.content) });
    if (result.embeddings.length !== batch.length) {
      throw invariant('embedder returned wrong batch size');
    }
    const rows: NewDocumentChunk[] = batch.map((c, idx) => ({
      workspaceId: ctx.workspaceId,
      documentId: scope.documentId,
      knowledgeSourceId: scope.knowledgeSourceId,
      chunkIndex: c.index,
      startChar: c.startChar,
      endChar: c.endChar,
      content: c.content,
      tokenCount: c.tokenCount,
      embedding: result.embeddings[idx]!,
      embeddingModel: result.model,
      embeddingDim: EMBEDDING_DIM,
      embeddedAt: now,
    }));
    await db.insert(documentChunks).values(rows);
    total += rows.length;
  }
  return total;
}

async function startJob(
  ctx: WorkspaceContext,
  scope: { documentId: bigint | null; knowledgeSourceId: bigint | null },
): Promise<IndexingJob> {
  const row: NewIndexingJob = {
    workspaceId: ctx.workspaceId,
    documentId: scope.documentId,
    knowledgeSourceId: scope.knowledgeSourceId,
    status: 'running',
    startedAt: new Date(),
    triggeredBy: ctx.userId,
  };
  const [created] = await db.insert(indexingJobs).values(row).returning();
  if (!created) throw invariant('indexing_job insert returned no row');
  return created;
}

async function finishJob(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
  status: 'succeeded' | 'failed',
  chunkCount: number,
  embeddingModel: string | null,
  error?: string,
): Promise<IndexingJob> {
  const [updated] = await db
    .update(indexingJobs)
    .set({
      status,
      chunkCount,
      embeddingModel,
      error: error ?? null,
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(indexingJobs.workspaceId, ctx.workspaceId),
        eq(indexingJobs.id, id),
      ),
    )
    .returning();
  if (!updated) throw invariant('indexing_job finish returned no row');
  return updated;
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

  const embedderInst = embedder ?? getEmbeddingProvider();
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
  const rows = await db
    .select()
    .from(learningLessons)
    .where(
      and(
        eq(learningLessons.workspaceId, ctx.workspaceId),
        eq(learningLessons.enabled, true),
      ),
    );
  const embedderInst = embedder ?? getEmbeddingProvider();
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
  document: Document | null;
  knowledgeSource: KnowledgeSource | null;
}

/**
 * Top-k cosine-nearest chunks for `query` in the workspace. Uses pgvector's
 * `<=>` (cosine distance) operator — similarity = 1 - distance.
 */
export async function retrieve(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  query: string,
  options: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  if (!query.trim()) return [];
  const embedder = options.embedder ?? getEmbeddingProvider();
  const result = await embedder.embed({ texts: [query] });
  const queryVec = result.embeddings[0]!;
  const literal = vectorLiteral(queryVec);
  const limit = Math.min(options.limit ?? 8, 100);

  const conditions: SQL[] = [
    eq(documentChunks.workspaceId, ctx.workspaceId),
    isNotNull(documentChunks.embedding),
  ];
  // Optional product filter — match chunks whose owning knowledge_source
  // is attached to that product.
  if (options.productProfileId !== undefined) {
    conditions.push(
      sql`(${documentChunks.knowledgeSourceId} IS NULL OR EXISTS (
        SELECT 1 FROM ${knowledgeSources}
        WHERE ${knowledgeSources.id} = ${documentChunks.knowledgeSourceId}
          AND ${options.productProfileId} = ANY(${knowledgeSources.productProfileIds})
      ))`,
    );
  }
  // Phase 22: optional purpose-category filter. Only chunks owned by a
  // knowledge_source with a matching purpose_category are returned.
  // Document-only chunks (no knowledge_source) are excluded when this
  // filter is active — purpose is a knowledge-source-level axis.
  if (options.purposeCategory !== undefined) {
    conditions.push(
      sql`EXISTS (
        SELECT 1 FROM ${knowledgeSources}
        WHERE ${knowledgeSources.id} = ${documentChunks.knowledgeSourceId}
          AND ${knowledgeSources.purposeCategory} = ${options.purposeCategory}
      )`,
    );
  }

  const rows = await db
    .select({
      chunk: documentChunks,
      document: documents,
      knowledgeSource: knowledgeSources,
      similarity: sql<number>`1 - (${documentChunks.embedding} <=> ${sql.raw(`'${literal}'::vector`)})`.as('similarity'),
    })
    .from(documentChunks)
    .leftJoin(documents, eq(documents.id, documentChunks.documentId))
    .leftJoin(knowledgeSources, eq(knowledgeSources.id, documentChunks.knowledgeSourceId))
    .where(and(...conditions))
    .orderBy(sql`${documentChunks.embedding} <=> ${sql.raw(`'${literal}'::vector`)}`)
    .limit(limit);

  return rows.map((r) => ({
    chunk: r.chunk,
    similarity: Number(r.similarity),
    document: r.document,
    knowledgeSource: r.knowledgeSource,
  }));
}

export interface RetrievedLesson {
  lesson: LearningLesson;
  similarity: number;
}

/** Top-k cosine-nearest enabled learning_lessons for `query`. */
export async function retrieveLessons(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  query: string,
  options: RetrieveOptions = {},
): Promise<RetrievedLesson[]> {
  if (!query.trim()) return [];
  const embedder = options.embedder ?? getEmbeddingProvider();
  const result = await embedder.embed({ texts: [query] });
  const queryVec = result.embeddings[0]!;
  const literal = vectorLiteral(queryVec);
  const limit = Math.min(options.limit ?? 8, 50);

  const conditions: SQL[] = [
    eq(learningLessons.workspaceId, ctx.workspaceId),
    eq(learningLessons.enabled, true),
    isNotNull(learningLessons.embedding),
  ];
  if (options.productProfileId !== undefined) {
    conditions.push(
      sql`(${learningLessons.productProfileId} IS NULL OR ${learningLessons.productProfileId} = ${options.productProfileId})`,
    );
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

export async function listIndexingJobs(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: { documentId?: bigint; knowledgeSourceId?: bigint; limit?: number } = {},
): Promise<IndexingJob[]> {
  const conditions: SQL[] = [eq(indexingJobs.workspaceId, ctx.workspaceId)];
  if (filter.documentId !== undefined) {
    conditions.push(eq(indexingJobs.documentId, filter.documentId));
  }
  if (filter.knowledgeSourceId !== undefined) {
    conditions.push(eq(indexingJobs.knowledgeSourceId, filter.knowledgeSourceId));
  }
  return db
    .select()
    .from(indexingJobs)
    .where(and(...conditions))
    .orderBy(desc(indexingJobs.createdAt))
    .limit(Math.min(filter.limit ?? 50, 500));
}

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
        eq(documentChunks.documentId, documentId),
      ),
    );
}
