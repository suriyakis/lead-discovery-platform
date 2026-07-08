import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { workspaces } from './workspaces';

/**
 * In-app notification feed. One row per event worth pulling a human back
 * to the app: a lead replied, a follow-up awaits approval, a geo-unverified
 * lead needs review, a run failed, tokens ran low, someone was mentioned
 * or assigned.
 *
 * Visibility: `userId` NULL = workspace-wide (every member sees it);
 * set = targeted (mention / assignment) — only that user sees it.
 *
 * `dedupeKey` prevents alert storms: while an UNREAD notification with the
 * same (workspace, dedupeKey) exists, further inserts are dropped (partial
 * unique index — the row leaves the index once read, so the next
 * occurrence notifies again).
 */
export const notifications = pgTable(
  'notifications',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Targeted recipient, or NULL for every workspace member. */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),

    /** 'lead.replied' | 'follow_up.awaiting_approval' | 'review.needs_review'
     *  | 'run.failed' | 'tokens.low' | 'mention' | 'assignment' — free-form
     *  text so new kinds don't need a migration. */
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    /** In-app deep link, e.g. /communication/123. */
    href: text('href'),
    dedupeKey: text('dedupe_key'),

    readAt: timestamp('read_at', { mode: 'date', withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceCreatedIdx: index('notifications_ws_created_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
    unreadIdx: index('notifications_ws_user_unread_idx').on(
      table.workspaceId,
      table.userId,
      table.readAt,
    ),
    dedupeKeyUnread: uniqueIndex('notifications_dedupe_unread_idx')
      .on(table.workspaceId, table.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL AND read_at IS NULL`),
  }),
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
