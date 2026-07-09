import {
  bigint,
  bigserial,
  boolean,
  index,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { workspaces } from './workspaces';

/**
 * Customer ↔ platform-admin support conversations.
 *
 * A thread belongs to ONE workspace (the customer side); the admin side is
 * any platform super-admin working from the /admin console. Unread state is
 * one flag per side, set by the opposite side's writes and cleared when the
 * owning side opens the thread — cheap, and race-tolerant enough for a
 * support inbox (a lost clear just re-shows a read thread as unread).
 */
export const supportThreads = pgTable(
  'support_threads',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    /** open | closed. A customer reply to a closed thread reopens it. */
    status: text('status').notNull().default('open'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    lastMessageAt: timestamp('last_message_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    /** True when the ADMIN has messages the customer hasn't seen. */
    customerUnread: boolean('customer_unread').notNull().default(false),
    /** True when the CUSTOMER has messages the admin hasn't seen. */
    adminUnread: boolean('admin_unread').notNull().default(true),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    wsLastMessageIdx: index('support_threads_ws_last_idx').on(
      t.workspaceId,
      t.lastMessageAt,
    ),
    statusAdminUnreadIdx: index('support_threads_status_unread_idx').on(
      t.status,
      t.adminUnread,
    ),
  }),
);

export const supportMessages = pgTable(
  'support_messages',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    threadId: bigint('thread_id', { mode: 'bigint' })
      .notNull()
      .references(() => supportThreads.id, { onDelete: 'cascade' }),
    /** Denormalized for cheap workspace-scoped queries. */
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** customer | admin — which SIDE wrote it (render alignment + name). */
    senderKind: text('sender_kind').notNull(),
    senderUserId: text('sender_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    threadIdx: index('support_messages_thread_idx').on(t.threadId, t.id),
  }),
);

export type SupportThread = typeof supportThreads.$inferSelect;
export type NewSupportThread = typeof supportThreads.$inferInsert;
export type SupportMessage = typeof supportMessages.$inferSelect;
export type NewSupportMessage = typeof supportMessages.$inferInsert;
