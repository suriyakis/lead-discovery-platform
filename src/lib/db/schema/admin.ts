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
 * `impersonation_sessions` — audit trail of every super-admin impersonation
 * "session". Phase 14 god-mode: a super_admin can act as a user inside a
 * workspace for diagnostics. Both start and end events live here.
 *
 * Active sessions have `ended_at IS NULL`. The Auth.js session callback
 * checks for an active row and overlays the target identity onto the
 * actor's session — but the original actor user_id is preserved on every
 * audit_log + pipeline_event so blame doesnt go missing.
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
 * `feature_flags` — workspace-scoped premium-module toggles. Each entry is
 * (workspace_id, key) with a boolean enabled flag and optional config jsonb.
 * Future plan-tier logic will hydrate this table from a `plans` table; for
 * now the super-admin toggles per-workspace directly via /admin.
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
