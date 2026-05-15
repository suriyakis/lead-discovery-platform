import {
  bigint,
  bigserial,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { workspaces } from './workspaces';
import { productProfiles } from './products';

/**
 * Phase 50 — per-product vector storage bindings.
 *
 * One row per (workspace, product, provider) tracks where the product's
 * knowledge is indexed. Most workspaces will have a single row per
 * product (their active provider), but the (workspace, product, provider)
 * unique index lets us keep a stale binding around if the operator
 * switches providers — useful for showing "X files orphaned in OpenAI;
 * detach to delete" diagnostics.
 *
 * `external_store_id` is the provider's opaque handle:
 *   - openai     → 'vs_xxx' from POST /v1/vector_stores
 *   - pgvector   → empty string (chunks live in document_chunks; this
 *                  row just records the usage counters)
 *   - mock       → 'mock-vs-<workspace>-<product>'
 */
export const productVectorStores = pgTable(
  'product_vector_stores',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    productProfileId: bigint('product_profile_id', { mode: 'bigint' })
      .notNull()
      .references(() => productProfiles.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    externalStoreId: text('external_store_id').notNull(),

    /** 'active' | 'expired' | 'failed'. Providers may flip to 'failed'
     *  on quota exhaustion or auth loss — UI surfaces the reason in the
     *  product page. */
    status: text('status').notNull().default('active'),
    statusError: text('status_error'),

    /** Running counters maintained by the provider on each attach /
     *  detach. Used for the per-product byte cap enforcement. */
    usageBytes: bigint('usage_bytes', { mode: 'number' })
      .notNull()
      .default(0),
    fileCount: integer('file_count').notNull().default(0),

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
    workspaceIdx: index('product_vector_stores_ws_idx').on(table.workspaceId),
    workspaceProductProviderIdx: uniqueIndex(
      'product_vector_stores_ws_product_provider_idx',
    ).on(table.workspaceId, table.productProfileId, table.providerId),
  }),
);

export type ProductVectorStore = typeof productVectorStores.$inferSelect;
export type NewProductVectorStore = typeof productVectorStores.$inferInsert;
