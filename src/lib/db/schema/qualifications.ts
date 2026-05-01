import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { sourceRecords } from './connectors';
import { productProfiles } from './products';

/**
 * One row per (sourceRecord, productProfile) pair. The qualification engine
 * writes this; the review queue reads it to surface relevance + reasons.
 *
 * Re-classification: a re-run produces a new row only when the inputs change.
 * The unique index forces upsert semantics so we never accumulate stale
 * duplicates for the same pair.
 *
 * `method` is the audit trail of how this row was produced:
 *   - rules: deterministic engine using keywords + sectors + lessons
 *   - ai:    AI provider classification (Phase 7+)
 *   - hybrid: rules first, AI to refine borderline cases
 */
export const qualifications = pgTable(
  'qualifications',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceRecordId: bigint('source_record_id', { mode: 'bigint' })
      .notNull()
      .references(() => sourceRecords.id, { onDelete: 'cascade' }),
    productProfileId: bigint('product_profile_id', { mode: 'bigint' })
      .notNull()
      .references(() => productProfiles.id, { onDelete: 'cascade' }),

    isRelevant: boolean('is_relevant').notNull(),
    /** 0..100. Higher = more relevant. */
    relevanceScore: smallint('relevance_score').notNull(),
    /** 0..100. Confidence of the engine in its own verdict. */
    confidence: smallint('confidence').notNull(),

    qualificationReason: text('qualification_reason'),
    rejectionReason: text('rejection_reason'),

    matchedKeywords: text('matched_keywords')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    disqualifyingSignals: text('disqualifying_signals')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /** Free-form structured detail: matched lessons, evidence URLs, etc. */
    evidence: jsonb('evidence').notNull().default(sql`'{}'::jsonb`),

    method: text('method').notNull(),
    /** Provider/model id when method != 'rules'. */
    model: text('model'),

    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pairKey: uniqueIndex('qualifications_pair_idx').on(
      table.workspaceId,
      table.sourceRecordId,
      table.productProfileId,
    ),
    workspaceProductIdx: index('qualifications_ws_product_idx').on(
      table.workspaceId,
      table.productProfileId,
    ),
    relevanceIdx: index('qualifications_ws_relevant_idx').on(
      table.workspaceId,
      table.isRelevant,
    ),
  }),
);

export type Qualification = typeof qualifications.$inferSelect;
export type NewQualification = typeof qualifications.$inferInsert;
export type QualificationMethod = 'rules' | 'ai' | 'hybrid';
