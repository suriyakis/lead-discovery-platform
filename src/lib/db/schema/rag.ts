import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { workspaces } from './workspaces';
import { documents, knowledgeSources } from './documents';

/**
 * Custom Drizzle type for pgvector. We expose `number[]` on the JS side and
 * stringify on the way to the driver per pgvector's `[1,2,3]` literal form.
 *
 * Phase 12 fixes the dimension at 1536 to match OpenAI text-embedding-3-small
 * (and most current embeddings). When we adopt a different model, add a new
 * column with the new dimension rather than changing this one in place.
 */
const VECTOR_DIM = 1536;

const vector = customType<{ data: number[]; default: false; driverData: string }>({
  dataType: () => `vector(${VECTOR_DIM})`,
  fromDriver(value: unknown): number[] {
    if (Array.isArray(value)) return value as number[];
    if (typeof value === 'string') {
      return value
        .replace(/^\[/, '')
        .replace(/\]$/, '')
        .split(',')
        .map((n) => Number(n));
    }
    return [];
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
});

/**
 * `document_chunks` — output of the indexing job. Each chunk is a slice of a
 * knowledge source's body (a document's extracted text, a URL's text, or a
 * text excerpt), embedded once and reused for retrieval.
 *
 * KL-05 ownership: every chunk belongs to exactly one knowledge source
 * (knowledge_source_id NOT NULL, composite FK on workspace_id, cascading).
 * Retrieval decides scope from that source (scope_kind +
 * knowledge_source_products) and reaches the document through
 * knowledge_sources.document_id. document_id is legacy: the indexer no
 * longer writes it (before KL-05, a NULL source meant "workspace-wide",
 * which is how product-scoped documents leaked — I039).
 *
 * Re-indexing a source replaces its chunks in one transaction.
 */
export const documentChunks = pgTable(
  'document_chunks',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    documentId: bigint('document_id', { mode: 'bigint' }).references(
      () => documents.id,
      { onDelete: 'cascade' },
    ),
    /** The owning knowledge source (KL-05). FK: document_chunks_knowledge_source_fk. */
    knowledgeSourceId: bigint('knowledge_source_id', { mode: 'bigint' }).notNull(),

    /** 0-based chunk index within the source. */
    chunkIndex: integer('chunk_index').notNull().default(0),
    /** UTF-8 character offset into the source text where this chunk starts. */
    startChar: integer('start_char').notNull().default(0),
    endChar: integer('end_char').notNull().default(0),

    /** The chunk text itself, capped at ~2000 chars by the indexer. */
    content: text('content').notNull(),
    /** Approx token count — driven by the indexer's tokenizer estimate. */
    tokenCount: integer('token_count').notNull().default(0),

    /** Embedding vector. Populated post-insert by the indexing job. */
    embedding: vector('embedding'),
    embeddingModel: text('embedding_model'),
    embeddingDim: integer('embedding_dim').notNull().default(VECTOR_DIM),
    embeddedAt: timestamp('embedded_at', { mode: 'date', withTimezone: true }),

    /** Free-form metadata (e.g., page number for PDFs). */
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),

    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceDocIdx: index('document_chunks_ws_doc_idx').on(
      table.workspaceId,
      table.documentId,
    ),
    workspaceKsIdx: index('document_chunks_ws_ks_idx').on(
      table.workspaceId,
      table.knowledgeSourceId,
    ),
    /** KL-05: a chunk can only belong to a source of its own workspace. */
    knowledgeSourceFk: foreignKey({
      name: 'document_chunks_knowledge_source_fk',
      columns: [table.workspaceId, table.knowledgeSourceId],
      foreignColumns: [knowledgeSources.workspaceId, knowledgeSources.id],
    }).onDelete('cascade'),
    // The vector index is created out-of-band in the migration SQL so we can
    // pick HNSW vs IVFFlat per environment. Drizzle's index() builder does
    // not yet support `USING hnsw (embedding vector_cosine_ops)`.
  }),
);

export type DocumentChunk = typeof documentChunks.$inferSelect;
export type NewDocumentChunk = typeof documentChunks.$inferInsert;

export const VECTOR_DIMENSION = VECTOR_DIM;

/** KL-06: the outbox states of an indexing run. */
export const INDEXING_JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type IndexingJobStatus = (typeof INDEXING_JOB_STATUSES)[number];

/**
 * `indexing_jobs` — one (re)indexing run of a knowledge source, and since
 * KL-06 the knowledge.index job's OUTBOX: a request writes the row
 * 'queued' inside its own transaction (with the source's index_status),
 * the job claims it ('running', attempts + 1), and it ends 'succeeded' or
 * 'failed'. A retryable failure puts it back to 'queued' with
 * next_attempt_at (backoff); knowledge.index.sweep re-enqueues due rows
 * and fails runs older than 15 minutes. Drives the status panel and the
 * receipts on /knowledge/[id] and /documents/[id].
 *
 * Two partial unique indexes (created in the KL-06 migration's custom
 * block, after closing legacy rows, so drizzle does not declare them):
 * at most one 'queued' and at most one 'running' row per knowledge source
 * — requests coalesce and two workers never index one source at once.
 * document_id rows are pre-KL-05 history.
 */
export const indexingJobs = pgTable(
  'indexing_jobs',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    /** Exactly one of these is set per row. */
    documentId: bigint('document_id', { mode: 'bigint' }).references(
      () => documents.id,
      { onDelete: 'cascade' },
    ),
    knowledgeSourceId: bigint('knowledge_source_id', { mode: 'bigint' }).references(
      () => knowledgeSources.id,
      { onDelete: 'cascade' },
    ),

    /** queued | running | succeeded | failed (CHECK). */
    status: text('status').notNull().default('queued'),
    chunkCount: integer('chunk_count').notNull().default(0),
    embeddingModel: text('embedding_model'),
    error: text('error'),

    /** KL-06: runs started (a claim counts). Retries stop at
     *  MAX_INDEX_ATTEMPTS (knowledge-indexing.ts). */
    attempts: integer('attempts').notNull().default(0),
    /** A queued row is due when NULL or past (retry backoff, or deferred
     *  while another run held the source). */
    nextAttemptAt: timestamp('next_attempt_at', { mode: 'date', withTimezone: true }),
    /** Admin "Re-extract with OCR": OCR the PDF even when the cached text
     *  exists or the PDF has a text layer. Satisfied by an OCR extraction
     *  newer than the row (so a retry or a second source never re-pays). */
    forceOcr: boolean('force_ocr').notNull().default(false),
    /** Why the run was requested: create | edit | reindex | document |
     *  reextract_ocr. */
    reason: text('reason'),
    /** How it ended, for the receipt: unchanged (same text + model, nothing
     *  re-embedded) | embedded | superseded | timed_out. */
    note: text('note'),

    startedAt: timestamp('started_at', { mode: 'date', withTimezone: true }),
    finishedAt: timestamp('finished_at', { mode: 'date', withTimezone: true }),

    triggeredBy: text('triggered_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceCreatedIdx: index('indexing_jobs_ws_created_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
    workspaceStatusIdx: index('indexing_jobs_ws_status_idx').on(
      table.workspaceId,
      table.status,
    ),
    sourceStatusIdx: index('indexing_jobs_source_status_idx').on(
      table.knowledgeSourceId,
      table.status,
    ),
    statusCheck: check(
      'indexing_jobs_status_check',
      sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed')`,
    ),
  }),
);

export type IndexingJob = typeof indexingJobs.$inferSelect;
export type NewIndexingJob = typeof indexingJobs.$inferInsert;
