import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { productProfiles } from './products';
import { workspaces } from './workspaces';

/**
 * `documents` — pure file-object metadata. The bytes live in IStorage (local
 * filesystem in dev, S3-compatible in prod). One row per uploaded file.
 *
 * Lifecycle:
 *   uploading  ← row created before bytes finish; storage_key reserved
 *   ready      ← bytes flushed, sha256 computed, file usable
 *   failed     ← upload aborted or content rejected
 *   archived   ← soft-deleted; the storage object may still exist
 *
 * SHA-256 is captured to enable dedup detection within a workspace.
 */
export const documentStatus = pgEnum('document_status', [
  'uploading',
  'ready',
  'failed',
  'archived',
]);

export const documents = pgTable(
  'documents',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    /** Display name. Defaults to filename when unset. */
    name: text('name').notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull().default('application/octet-stream'),
    sizeBytes: integer('size_bytes').notNull().default(0),
    /** Hex sha256 of the bytes. Empty string while status='uploading'. */
    sha256: text('sha256').notNull().default(''),

    /** IStorage key (e.g., `workspaces/<id>/documents/<uuid>.<ext>`). */
    storageKey: text('storage_key').notNull(),
    storageProvider: text('storage_provider').notNull().default('local'),

    status: documentStatus('status').notNull().default('uploading'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /**
     * KL-06 extraction cache (I040). The text the indexer extracted from
     * these bytes, written once, right after extraction and before any
     * embedding, so a retry, a re-index or a second source never pays for
     * parsing or OCR again. Valid only while extracted_sha256 equals
     * sha256; a document with the same sha256 in the workspace (e.g. a
     * re-upload of an archived file) reuses it. Only the explicit admin
     * action "Re-extract with OCR" replaces it.
     */
    extractedText: text('extracted_text'),
    /** How the cache was produced: 'text' | 'html' | 'pdf' | 'docx' |
     *  'ocr:<provider>/<model>'. */
    extractor: text('extractor'),
    extractedAt: timestamp('extracted_at', { mode: 'date', withTimezone: true }),
    /** sha256 of the bytes extracted_text came from. */
    extractedSha256: text('extracted_sha256'),
    /** ISO 639-1 guess from the extracted text (lib/i18n/language); NULL
     *  when too short or unclear. */
    detectedLanguage: text('detected_language'),
    /** PDF pages (pdf-parse or OCR). Drives the OCR cost estimate. */
    pageCount: integer('page_count'),

    createdBy: text('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceIdx: index('documents_ws_idx').on(table.workspaceId),
    workspaceShaIdx: index('documents_ws_sha_idx').on(
      table.workspaceId,
      table.sha256,
    ),
    workspaceStatusIdx: index('documents_ws_status_idx').on(
      table.workspaceId,
      table.status,
    ),
  }),
);

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
/** KL-06: a document without its cached extracted text (which can be
 *  megabytes) — what lists and joins read (services/documents.ts
 *  documentMetaColumns). */
export type DocumentMeta = Omit<Document, 'extractedText'>;
export type DocumentStatus = (typeof documentStatus.enumValues)[number];

/**
 * `knowledge_sources` — a unifying wrapper around things the workspace
 * considers "knowledge" about its products, sectors, or leads. A source
 * is one of:
 *   - a document  (kind='document', document_id set)
 *   - a URL       (kind='url',      url set)
 *   - a text blob (kind='text',     text_excerpt set)
 *
 * KL-05: every retrievable chunk belongs to exactly one source
 * (document_chunks.knowledge_source_id NOT NULL); a document is only a
 * blob that a document-kind source wraps. Scope is explicit:
 * scope_kind 'workspace' (every product) or 'products' (exactly the rows
 * in knowledge_source_products). A 'products' source with no rows left
 * (its products were deleted) "Needs a scope" and is retrieved nowhere.
 */
export const knowledgeSourceKind = pgEnum('knowledge_source_kind', [
  'document',
  'url',
  'text',
]);

/**
 * Phase 22: purpose category — used by RAG retrieval to filter by intent
 * (technical specs vs marketing collateral vs case studies vs internal
 * notes vs objection-handling).
 */
export const knowledgePurposeCategory = pgEnum('knowledge_purpose_category', [
  'technical',
  'marketing',
  'case_study',
  'internal_note',
  'objection_handling',
  'general',
]);

/** KL-05: where a knowledge source applies. 'workspace' = every product;
 *  'products' = exactly the knowledge_source_products rows. */
export const knowledgeScopeKind = pgEnum('knowledge_scope_kind', ['workspace', 'products']);
export type KnowledgeScopeKind = (typeof knowledgeScopeKind.enumValues)[number];

/**
 * KL-06: where a source's index stands (the honest status, I104/I108).
 *   queued   — an indexing_jobs row waits for the knowledge.index job
 *   indexing — a run holds it
 *   indexed  — its chunks reflect indexed_content_hash (current content)
 *   stale    — its content, URL, summary or products changed since the
 *              last run (or it was never indexed); chunks from an earlier
 *              run still serve until the next run finishes
 *   failed   — the last run gave up (last_index_error says why); chunks
 *              from an earlier run, if any, still serve
 */
export const knowledgeIndexStatus = pgEnum('knowledge_index_status', [
  'queued',
  'indexing',
  'indexed',
  'stale',
  'failed',
]);
export type KnowledgeIndexStatus = (typeof knowledgeIndexStatus.enumValues)[number];

export const knowledgeSources = pgTable(
  'knowledge_sources',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    kind: knowledgeSourceKind('kind').notNull(),
    documentId: bigint('document_id', { mode: 'bigint' }).references(
      () => documents.id,
      { onDelete: 'set null' },
    ),
    url: text('url'),
    textExcerpt: text('text_excerpt'),

    title: text('title').notNull(),
    summary: text('summary'),
    language: text('language').notNull().default('en'),
    purposeCategory: knowledgePurposeCategory('purpose_category')
      .notNull()
      .default('general'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** KL-05: 'workspace' (every product) or 'products' (exactly the
     *  knowledge_source_products rows). No default: every writer states it. */
    scopeKind: knowledgeScopeKind('scope_kind').notNull(),

    /** Phase 50: which vector-storage provider indexed this source, e.g.
     *  'pgvector' (chunks live in `document_chunks`) or 'openai' (file
     *  uploaded to the product's OpenAI Vector Store). NULL when never
     *  indexed. Cleared on provider switch so re-indexing is idempotent. */
    externalProviderId: text('external_provider_id'),
    /** Phase 50: provider-specific opaque id (`file-...` for OpenAI; for
     *  pgvector this stays NULL since chunks reference the row by id). */
    externalFileId: text('external_file_id'),
    /** Phase 50: 'pending' | 'indexed' | 'failed'. Auto-attach pipeline
     *  writes 'pending' on create, flips on success / failure. */
    externalStatus: text('external_status').notNull().default('pending'),
    externalError: text('external_error'),
    externalIndexedAt: timestamp('external_indexed_at', {
      mode: 'date',
      withTimezone: true,
    }),

    /** KL-06: THE index status (see knowledgeIndexStatus). Writers that
     *  queue a run set 'queued'; the default covers rows written without
     *  one (seeds, imports): not indexed yet. */
    indexStatus: knowledgeIndexStatus('index_status').notNull().default('stale'),
    /** When the last successful run finished. */
    indexedAt: timestamp('indexed_at', { mode: 'date', withTimezone: true }),
    /** sha256 of the exact text the current chunks were embedded from,
     *  stamped in the chunk-swap transaction. Same hash + same model = no
     *  re-embed. */
    indexedContentHash: text('indexed_content_hash'),
    indexedEmbeddingModel: text('indexed_embedding_model'),
    /** Why the last run failed (kept while a retry is queued). */
    lastIndexError: text('last_index_error'),

    createdBy: text('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceIdx: index('knowledge_sources_ws_idx').on(table.workspaceId),
    workspaceKindIdx: index('knowledge_sources_ws_kind_idx').on(
      table.workspaceId,
      table.kind,
    ),
    /** KL-05: target of the composite (workspace_id, id) FKs from
     *  knowledge_source_products and document_chunks — a scope row or a
     *  chunk can only belong to a source of its own workspace. */
    workspaceIdUnique: unique('knowledge_sources_workspace_id_id_unique').on(
      table.workspaceId,
      table.id,
    ),
    documentIdx: index('knowledge_sources_document_idx').on(table.documentId),
    workspaceIndexStatusIdx: index('knowledge_sources_ws_index_status_idx').on(
      table.workspaceId,
      table.indexStatus,
    ),
  }),
);

export type KnowledgeSource = typeof knowledgeSources.$inferSelect;
export type NewKnowledgeSource = typeof knowledgeSources.$inferInsert;
export type KnowledgeSourceKind = (typeof knowledgeSourceKind.enumValues)[number];

/**
 * KL-05 (I039, I109): the products a 'products'-scoped knowledge source
 * applies to. Both FKs are composite on workspace_id, so the database
 * refuses a row joining a source to another tenant's product, and
 * deleting a product (or the source) cascades its rows. Replaces the
 * FK-less knowledge_sources.product_profile_ids array.
 */
export const knowledgeSourceProducts = pgTable(
  'knowledge_source_products',
  {
    sourceId: bigint('source_id', { mode: 'bigint' }).notNull(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' }).notNull(),
    productProfileId: bigint('product_profile_id', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: 'knowledge_source_products_pk',
      columns: [table.sourceId, table.productProfileId],
    }),
    sourceFk: foreignKey({
      name: 'knowledge_source_products_source_fk',
      columns: [table.workspaceId, table.sourceId],
      foreignColumns: [knowledgeSources.workspaceId, knowledgeSources.id],
    }).onDelete('cascade'),
    productFk: foreignKey({
      name: 'knowledge_source_products_product_fk',
      columns: [table.workspaceId, table.productProfileId],
      foreignColumns: [productProfiles.workspaceId, productProfiles.id],
    }).onDelete('cascade'),
    workspaceProductIdx: index('knowledge_source_products_ws_product_idx').on(
      table.workspaceId,
      table.productProfileId,
    ),
  }),
);

export type KnowledgeSourceProduct = typeof knowledgeSourceProducts.$inferSelect;
