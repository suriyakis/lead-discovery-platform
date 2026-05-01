import {
  bigint,
  bigserial,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { workspaces } from './workspaces';
import { sourceRecords } from './connectors';

/**
 * Lifecycle of a review item:
 *
 *   new            ← seeded automatically when a source_record arrives
 *   needs_review   ← optional: explicitly flagged for human attention
 *                    (Phase 7+ qualification engine emits low-confidence
 *                    classifications into this state)
 *   approved       ← human has approved the lead
 *   rejected       ← human has rejected the lead (with a reason)
 *   ignored        ← out of scope but not strictly rejected
 *   duplicate      ← merged into another item / soft dedupe
 *   archived       ← out of the active queue, history kept
 *
 * We use plain text for the enum value column so future states (e.g.,
 * 'pending_research') can be added without a migration. Validation lives
 * in the service.
 */
export const reviewItemState = pgEnum('review_item_state', [
  'new',
  'needs_review',
  'approved',
  'rejected',
  'ignored',
  'duplicate',
  'archived',
]);

export const reviewItems = pgTable(
  'review_items',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceRecordId: bigint('source_record_id', { mode: 'bigint' })
      .notNull()
      .references(() => sourceRecords.id, { onDelete: 'cascade' }),
    state: reviewItemState('state').notNull().default('new'),

    assignedToUserId: text('assigned_to_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    approvedByUserId: text('approved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvedAt: timestamp('approved_at', { mode: 'date', withTimezone: true }),

    rejectedByUserId: text('rejected_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    rejectedAt: timestamp('rejected_at', { mode: 'date', withTimezone: true }),
    rejectionReason: text('rejection_reason'),

    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceSourceRecordKey: uniqueIndex('review_items_ws_source_record_idx').on(
      table.workspaceId,
      table.sourceRecordId,
    ),
    workspaceStateIdx: index('review_items_ws_state_idx').on(
      table.workspaceId,
      table.state,
    ),
    assignedIdx: index('review_items_assigned_idx').on(
      table.workspaceId,
      table.assignedToUserId,
    ),
  }),
);

export const reviewComments = pgTable(
  'review_comments',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    reviewItemId: bigint('review_item_id', { mode: 'bigint' })
      .notNull()
      .references(() => reviewItems.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    comment: text('comment').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    itemCreatedIdx: index('review_comments_item_created_idx').on(
      table.reviewItemId,
      table.createdAt,
    ),
  }),
);

export type ReviewItem = typeof reviewItems.$inferSelect;
export type NewReviewItem = typeof reviewItems.$inferInsert;
export type ReviewItemState = (typeof reviewItemState.enumValues)[number];
export type ReviewComment = typeof reviewComments.$inferSelect;
export type NewReviewComment = typeof reviewComments.$inferInsert;
