import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  customType,
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
 * document body (or a knowledge_source's text/url-extracted body), embedded
 * once and reused for retrieval.
 *
 * Lifecycle:
 *   - On document upload, the indexer extracts plain text, splits into
 *     ~500-token chunks, and embeds each. One row per chunk.
 *   - When a document is re-indexed (e.g., model upgrade), we delete its
 *     chunks and re-embed.
 *   - Knowledge sources of kind `text` and `url` are also chunked here, with
 *     `document_id` null and `knowledge_source_id` set.
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
    knowledgeSourceId: bigint('knowledge_source_id', { mode: 'bigint' }).references(
      () => knowledgeSources.id,
      { onDelete: 'cascade' },
    ),

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
    // The vector index is created out-of-band in the migration SQL so we can
    // pick HNSW vs IVFFlat per environment. Drizzle's index() builder does
    // not yet support `USING hnsw (embedding vector_cosine_ops)`.
  }),
);

export type DocumentChunk = typeof documentChunks.$inferSelect;
export type NewDocumentChunk = typeof documentChunks.$inferInsert;

export const VECTOR_DIMENSION = VECTOR_DIM;

/**
 * `indexing_jobs` — operational log of (re)indexing runs over a document or
 * knowledge_source. Drives the UI status panel ("Indexing… / 23 chunks /
 * complete") and gives us a place to stash retry/error metadata.
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

    /** queued | running | succeeded | failed */
    status: text('status').notNull().default('queued'),
    chunkCount: integer('chunk_count').notNull().default(0),
    embeddingModel: text('embedding_model'),
    error: text('error'),

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
  }),
);

export type IndexingJob = typeof indexingJobs.$inferSelect;
export type NewIndexingJob = typeof indexingJobs.$inferInsert;
