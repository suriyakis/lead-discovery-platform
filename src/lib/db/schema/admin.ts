import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { workspaces } from './workspaces';

/**
 * `impersonation_sessions` — HISTORY ONLY. Phase 14 recorded a row here
 * each time a super-admin clicked "Impersonate", but nothing ever applied
 * it: no session callback, resolver or middleware read this table, so the
 * acting identity, role and workspace never changed (I047). The control and
 * its service functions were removed in PC-03; no code writes or reads
 * these rows any more. The table is kept, unchanged, for the history it
 * holds until a real read-only "view as" feature is designed (PC-18).
 */
export const impersonationSessions = pgTable(
  'impersonation_sessions',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    /** The super-admin doing the impersonating. */
    actorUserId: text('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The user being impersonated. */
    targetUserId: text('target_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The workspace the actor is operating in (must be one the target belongs to). */
    targetWorkspaceId: bigint('target_workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    reason: text('reason').notNull(),
    startedAt: timestamp('started_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp('ended_at', { mode: 'date', withTimezone: true }),
    endedByUserId: text('ended_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => ({
    actorIdx: index('impersonation_sessions_actor_idx').on(
      table.actorUserId,
      table.startedAt,
    ),
    targetIdx: index('impersonation_sessions_target_idx').on(
      table.targetUserId,
      table.startedAt,
    ),
    /** At most one active session per actor (open ones — endedAt is null). */
    activePerActorIdx: uniqueIndex('impersonation_sessions_active_actor_idx')
      .on(table.actorUserId)
      .where(sql`ended_at IS NULL`),
  }),
);

export type ImpersonationSession = typeof impersonationSessions.$inferSelect;
export type NewImpersonationSession = typeof impersonationSessions.$inferInsert;

/**
 * `feature_flags` — LEGACY, read by nothing (I048). The console toggled
 * these per workspace, but no runtime path ever read them, so a disabled
 * `outreach.send` or `mailbox.imap_sync` stopped nothing (X6). PC-06
 * replaced them with holds (`workspace_holds`, services/holds.ts): the
 * console no longer writes this table, and
 * scripts/import-legacy-feature-flags.ts turns its disabled rows into
 * pending_review holds (not enforced until the platform owner confirms
 * them). The table is dropped one release after that import has run.
 */
export const featureFlags = pgTable(
  'feature_flags',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Stable key, e.g. `crm.hubspot`, `rag.openai`, `outreach.send`. */
    key: text('key').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    config: jsonb('config').notNull().default(sql`'{}'::jsonb`),

    setBy: text('set_by').references(() => users.id, { onDelete: 'set null' }),
    setAt: timestamp('set_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceKeyIdx: uniqueIndex('feature_flags_ws_key_idx').on(
      table.workspaceId,
      table.key,
    ),
  }),
);

export type FeatureFlag = typeof featureFlags.$inferSelect;
export type NewFeatureFlag = typeof featureFlags.$inferInsert;
