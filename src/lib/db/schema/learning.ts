import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
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

// Free-form text columns for category and actionType — keeps Phase 5+ open
// to new categories without a migration. Validation lives in the service.
//
// Reference list of categories the rest of the codebase reads from:
//   qualification_positive, qualification_negative, outreach_style,
//   contact_role, sector_preference, connector_quality, false_positive,
//   false_negative, dedupe_hint, general_instruction, reply_quality,
//   product_positioning

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

/**
 * Structured durable lesson distilled from one or more `learning_events`.
 * Mutable: enable/disable, edit text. Soft-delete only — lessons are never
 * hard-deleted in Phase 5 so audit trail is preserved.
 *
 * Phase 12 adds an `embedding` vector(1536) column (requires the pgvector
 * extension). Migration is additive when that lands.
 */
export const learningLessons = pgTable(
  'learning_lessons',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** null = workspace-wide; non-null = scoped to one product profile. */
    productProfileId: bigint('product_profile_id', { mode: 'bigint' }).references(
      () => productProfiles.id,
      { onDelete: 'cascade' },
    ),
    category: text('category').notNull(),
    /** One-sentence imperative, e.g. "Skip councils for Vetrofluid offers." */
    rule: text('rule').notNull(),
    evidenceEventIds: bigint('evidence_event_ids', { mode: 'bigint' })
      .array()
      .notNull()
      .default(sql`'{}'::bigint[]`),
    enabled: boolean('enabled').notNull().default(true),
    confidence: smallint('confidence').notNull().default(60),
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
    workspaceEnabledIdx: index('learning_lessons_ws_enabled_idx').on(
      table.workspaceId,
      table.enabled,
    ),
    productCategoryIdx: index('learning_lessons_product_category_idx').on(
      table.productProfileId,
      table.category,
      table.enabled,
    ),
  }),
);

export type LearningEvent = typeof learningEvents.$inferSelect;
export type NewLearningEvent = typeof learningEvents.$inferInsert;
export type LearningLesson = typeof learningLessons.$inferSelect;
export type NewLearningLesson = typeof learningLessons.$inferInsert;
