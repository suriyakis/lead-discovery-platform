import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { workspaces } from './workspaces';
import { sourceRecords } from './connectors';
import { productProfiles } from './products';
import { learningEvents, OPERATOR_VERDICTS } from './learning';

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

    /** Geo gate audit trail (locality compliance). `targetCountry` is the
     *  normalized ISO alpha-2 the discovering recipe demanded (null = no
     *  gate), `inferredCountry` is where the company appears to be based,
     *  and `geoStatus` is the gate outcome the outreach queue re-checks
     *  before dispatch: no_gate | match | mismatch | unverified. */
    targetCountry: text('target_country'),
    inferredCountry: text('inferred_country'),
    geoStatus: text('geo_status').notNull().default('no_gate'),

    /** KL-02: the operator's verdict for this (record, product) — domain
     *  state, not a learning hint. 'not_fit' binds downstream: Promote,
     *  ensureQualifiedLead, generateOutreachDraft and autopilot's
     *  auto-enqueue refuse the pair. Written only by an operator decision
     *  (review.ts, inside the decision's transaction); re-classification
     *  never touches these columns (upsertQualification's conflict set
     *  leaves them out). */
    operatorVerdict: text('operator_verdict', { enum: OPERATOR_VERDICTS }),
    operatorDecidedBy: text('operator_decided_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    operatorDecidedAt: timestamp('operator_decided_at', { mode: 'date', withTimezone: true }),
    /** The learning event that carries the verdict. */
    operatorEventId: bigint('operator_event_id', { mode: 'bigint' }).references(
      () => learningEvents.id,
      { onDelete: 'set null' },
    ),
    /** A person approved this product while the location was unverified,
     *  i.e. confirmed the company is inside the target country. The send-
     *  time geo re-check accepts 'unverified' only with this set (or a
     *  legacy human approval). */
    geoConfirmedBy: text('geo_confirmed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    geoConfirmedAt: timestamp('geo_confirmed_at', { mode: 'date', withTimezone: true }),

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
    operatorVerdictCheck: check(
      'qualifications_operator_verdict_check',
      sql`${table.operatorVerdict} IS NULL OR ${table.operatorVerdict} IN ('fit', 'not_fit')`,
    ),
    /** A verdict always says when it was given, and only a verdict does. */
    operatorDecidedCheck: check(
      'qualifications_operator_decided_check',
      sql`(${table.operatorVerdict} IS NULL) = (${table.operatorDecidedAt} IS NULL)`,
    ),
  }),
);

export type Qualification = typeof qualifications.$inferSelect;
export type NewQualification = typeof qualifications.$inferInsert;
/**
 * qualifications.method values (DS-09 registry; the column is text).
 * 'rules_fallback' = AI was attempted but unavailable, so the rules
 * decided (qualification.ts); 'hybrid' is kept for older rows.
 */
export const qualificationMethods = ['rules', 'ai', 'rules_fallback', 'hybrid'] as const;
export type QualificationMethod = (typeof qualificationMethods)[number];
