import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
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
export type DocumentStatus = (typeof documentStatus.enumValues)[number];

/**
 * `knowledge_sources` — a unifying wrapper around things the workspace
 * considers "knowledge" about its products, sectors, or leads. A source
 * is one of:
 *   - a document  (kind='document', document_id set)
 *   - a URL       (kind='url',      url set)
 *   - a text blob (kind='text',     text_excerpt set)
 *
 * Phase 9 ships document + url; text is reserved for later but the schema
 * accepts it from day one. A knowledge source can be linked to multiple
 * product profiles via `product_profile_ids`. Future phases (RAG) will
 * read these rows and chunk/embed them.
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
    productProfileIds: bigint('product_profile_ids', { mode: 'bigint' })
      .array()
      .notNull()
      .default(sql`'{}'::bigint[]`),

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
  }),
);

export type KnowledgeSource = typeof knowledgeSources.$inferSelect;
export type NewKnowledgeSource = typeof knowledgeSources.$inferInsert;
export type KnowledgeSourceKind = (typeof knowledgeSourceKind.enumValues)[number];
