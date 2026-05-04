import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './auth';

export const workspaceMemberRole = pgEnum('workspace_member_role', [
  'owner',
  'admin',
  'manager',
  'member',
  'viewer',
]);

/**
 * Phase 23: workspace lifecycle. `archived` workspaces deny access to all
 * members (super-admins can still see + restore them). Used as the
 * super-admin "off" toggle for workspaces.
 */
export const workspaceStatus = pgEnum('workspace_status', ['active', 'archived']);

export const workspaces = pgTable('workspaces', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  status: workspaceStatus('status').notNull().default('active'),
  archivedAt: timestamp('archived_at', { mode: 'date', withTimezone: true }),
  archivedBy: text('archived_by'),
  archivedReason: text('archived_reason'),
  /**
   * Phase 28: protected workspace flag. Default-flagged workspaces cannot
   * be archived or deleted — useful as an environment-level "system"
   * tenant that survives nuking everything else.
   */
  isDefault: boolean('is_default').notNull().default(false),
  ownerUserId: text('owner_user_id')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: workspaceMemberRole('role').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceUser: uniqueIndex('workspace_members_workspace_user_idx').on(
      table.workspaceId,
      table.userId,
    ),
  }),
);

export const workspaceSettings = pgTable('workspace_settings', {
  workspaceId: bigint('workspace_id', { mode: 'bigint' })
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMember = typeof workspaceMembers.$inferInsert;
export type WorkspaceMemberRole = (typeof workspaceMemberRole.enumValues)[number];
export type WorkspaceStatus = (typeof workspaceStatus.enumValues)[number];
