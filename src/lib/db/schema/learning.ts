import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

const VECTOR_DIM = 1536;
const lessonEmbedding = customType<{ data: number[]; default: false; driverData: string }>({
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
import { users } from './auth';
import { workspaces } from './workspaces';
import { productProfiles } from './products';

// `category` stays a free-form text column; the category REGISTRY
// (src/lib/services/learning-categories.ts) is the source of truth for
// which categories exist, their polarity, what reads them and who may
// create them. The service validates against it.

/**
 * Append-only feedback log. The raw signal: a user did X to entity Y
 * with optional comment text. Phase 5 extractor turns the most signal-rich
 * events into `learning_lessons`; everything else stays as raw history.
 */
export const learningEvents = pgTable(
  'learning_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    productProfileId: bigint('product_profile_id', { mode: 'bigint' }).references(
      () => productProfiles.id,
      { onDelete: 'set null' },
    ),
    /** Category-shaped action, e.g. `qualification_negative`, `outreach_style`. */
    actionType: text('action_type').notNull(),
    originalComment: text('original_comment'),
    extractedLessonId: bigint('extracted_lesson_id', { mode: 'bigint' }),
    confidence: smallint('confidence').notNull().default(50),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceCreatedIdx: index('learning_events_ws_created_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
    productActionIdx: index('learning_events_product_action_idx').on(
      table.productProfileId,
      table.actionType,
    ),
  }),
);

/** KL-01: where a rule applies. 'workspace' = every product of the
 *  workspace; 'products' = exactly the products listed in lesson_scopes.
 *  NULL never means "everywhere" any more, and a 'products' rule whose
 *  scope rows are all gone (its products were deleted) applies nowhere —
 *  it shows as "Needs a scope" until an operator re-scopes or retires it. */
export const lessonScopeKind = pgEnum('lesson_scope_kind', ['workspace', 'products']);

/** KL-01: the single lifecycle of a rule (replaces the old `enabled`).
 *  Only 'active' rules reach any prompt or scoring step.
 *   - active:   in force
 *   - proposed: suggested by the platform, waiting for an operator
 *   - disabled: switched off by an operator, can be switched back on
 *   - retired:  taken out of service for a recorded reason (below) */
export const lessonLifecycle = pgEnum('lesson_lifecycle', [
  'active',
  'proposed',
  'disabled',
  'retired',
]);

/** Why a rule was retired. `merged` / `superseded` point at the surviving
 *  rule through merged_into_id. */
export const lessonRetiredReason = pgEnum('lesson_retired_reason', [
  /** Low confidence and not used for a long time (compaction). */
  'stale',
  /** Folded into another rule (compaction merge); see merged_into_id. */
  'merged',
  /** Replaced by a narrower/rewritten rule; see merged_into_id. */
  'superseded',
  /** Lost a contradiction reconciliation against another rule. */
  'contradicted',
  /** An operator rejected it; kept so extraction cannot recreate it. */
  'operator_rejected',
  /** Its only evidence was a decision that was later undone. */
  'source_decision_voided',
  /** Absorbed into the product profile by an accepted suggestion. */
  'absorbed_into_profile',
  /** Its only product was deleted. */
  'product_deleted',
  /** Its category was removed from the registry (nothing consumed it). */
  'category_removed',
]);

/**
 * Structured durable lesson ("rule") distilled from one or more
 * `learning_events`. Soft-delete only — lessons are never hard-deleted so
 * the audit trail is preserved; `lifecycle` says whether one is in force.
 *
 * Phase 12 adds an `embedding` vector(1536) column (requires the pgvector
 * extension).
 */
export const learningLessons = pgTable(
  'learning_lessons',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** KL-01: 'workspace' or 'products' (the products are lesson_scopes
     *  rows). Every reader filters through lessonInScope() in
     *  src/lib/services/learning.ts. */
    scopeKind: lessonScopeKind('scope_kind').notNull().default('workspace'),
    category: text('category').notNull(),
    /** One-sentence imperative, e.g. "Skip councils for Vetrofluid offers." */
    rule: text('rule').notNull(),
    /** KL-01: +1 PREFER, -1 AVOID, 0 neutral guidance. Allowed values per
     *  category come from the category registry. */
    polarity: smallint('polarity').notNull().default(0),
    /** Where this lesson came from:
     *  - operator:   manual create or extracted from an operator's comment
     *  - draft_edit: learned by diffing an AI draft against the operator's edit
     *  - synthesis:  proposed by the weekly self-learning pattern miner */
    source: text('source').notNull().default('operator'),
    evidenceEventIds: bigint('evidence_event_ids', { mode: 'bigint' })
      .array()
      .notNull()
      .default(sql`'{}'::bigint[]`),
    lifecycle: lessonLifecycle('lifecycle').notNull().default('active'),
    retiredReason: lessonRetiredReason('retired_reason'),
    retiredNote: text('retired_note'),
    /** The surviving rule when this one was merged / superseded. */
    mergedIntoId: bigint('merged_into_id', { mode: 'bigint' }),
    confidence: smallint('confidence').notNull().default(60),
    /** P60-06: how many times the qualifier/outreach actually pulled this
     *  lesson into a prompt/scoring step. Compaction (P60-04) uses this +
     *  lastAppliedAt to retire dead-weight lessons. */
    applicationCount: integer('application_count').notNull().default(0),
    lastAppliedAt: timestamp('last_applied_at', { mode: 'date', withTimezone: true }),
    /** KL-01 (filled by KL-04): how often a model actually CITED this rule
     *  in a verdict — exposure (applicationCount) is not use. */
    citedCount: integer('cited_count').notNull().default(0),
    lastCitedAt: timestamp('last_cited_at', { mode: 'date', withTimezone: true }),
    /** Last confidence change from an outcome (kept apart from updatedAt,
     *  which tracks operator edits). */
    reinforcedAt: timestamp('reinforced_at', { mode: 'date', withTimezone: true }),
    /** Phase 12: vector(1536) for similarity-based lesson retrieval. Populated by the indexer. */
    embedding: lessonEmbedding('embedding'),
    embeddingModel: text('embedding_model'),
    embeddingDim: integer('embedding_dim').notNull().default(VECTOR_DIM),
    embeddedAt: timestamp('embedded_at', { mode: 'date', withTimezone: true }),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    /** Target of the composite FK from lesson_scopes: a scope row can only
     *  join a lesson and a product of the SAME workspace. */
    workspaceIdUnique: unique('learning_lessons_workspace_id_id_unique').on(
      table.workspaceId,
      table.id,
    ),
    workspaceLifecycleIdx: index('learning_lessons_ws_lifecycle_category_idx').on(
      table.workspaceId,
      table.lifecycle,
      table.category,
    ),
    mergedIntoFk: foreignKey({
      name: 'learning_lessons_merged_into_id_fk',
      columns: [table.mergedIntoId],
      foreignColumns: [table.id],
    }).onDelete('set null'),
    polarityCheck: check('learning_lessons_polarity_check', sql`${table.polarity} IN (-1, 0, 1)`),
    /** A retired rule always says why; a rule in service never carries a reason. */
    retiredReasonCheck: check(
      'learning_lessons_retired_reason_check',
      sql`(${table.lifecycle} = 'retired') = (${table.retiredReason} IS NOT NULL)`,
    ),
    mergedIntoCheck: check(
      'learning_lessons_merged_into_check',
      sql`${table.mergedIntoId} IS NULL OR (${table.lifecycle} = 'retired' AND ${table.mergedIntoId} <> ${table.id})`,
    ),
  }),
);

/**
 * KL-01: which products a 'products'-scoped rule applies to. Both FKs are
 * composite on workspace_id, so the database itself refuses a scope row
 * that joins a rule to another tenant's product (I167) — there is no code
 * path to forget. Deleting a product cascades its scope rows; a rule left
 * with none applies nowhere.
 */
export const lessonScopes = pgTable(
  'lesson_scopes',
  {
    lessonId: bigint('lesson_id', { mode: 'bigint' }).notNull(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' }).notNull(),
    productProfileId: bigint('product_profile_id', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: 'lesson_scopes_pk',
      columns: [table.lessonId, table.productProfileId],
    }),
    lessonFk: foreignKey({
      name: 'lesson_scopes_lesson_fk',
      columns: [table.workspaceId, table.lessonId],
      foreignColumns: [learningLessons.workspaceId, learningLessons.id],
    }).onDelete('cascade'),
    productFk: foreignKey({
      name: 'lesson_scopes_product_fk',
      columns: [table.workspaceId, table.productProfileId],
      foreignColumns: [productProfiles.workspaceId, productProfiles.id],
    }).onDelete('cascade'),
    workspaceProductIdx: index('lesson_scopes_ws_product_idx').on(
      table.workspaceId,
      table.productProfileId,
    ),
  }),
);

export type LearningEvent = typeof learningEvents.$inferSelect;
export type NewLearningEvent = typeof learningEvents.$inferInsert;
export type LearningLesson = typeof learningLessons.$inferSelect;
export type NewLearningLesson = typeof learningLessons.$inferInsert;
export type LessonScope = typeof lessonScopes.$inferSelect;
export type LessonScopeKind = (typeof lessonScopeKind.enumValues)[number];
export type LessonLifecycle = (typeof lessonLifecycle.enumValues)[number];
export type LessonRetiredReason = (typeof lessonRetiredReason.enumValues)[number];
