import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { workspaces } from './workspaces';

/**
 * PC-06: the kinds of work a hold can stop. One list for the whole
 * platform — the gate (services/automation-gate.ts) is asked "may this
 * workspace do <capability> now?" at every place such work starts.
 *
 *   sending          every outbound send: the queue drain, follow-ups,
 *                    replies, compose, retry
 *   inbox_sync       IMAP sync: the tick, manual Sync, autopilot's sync step
 *   inbound_actions  reply auto-actions (auto-suppress, auto-close)
 *   discovery        connector runs: crawl plans (tick and Run now), recipe runs
 *   autopilot        autopilot runs (runOnce)
 *   crm_sync         CRM pushes: autopilot's CRM steps and the manual push
 *   background_ai    AI the platform runs on its own: knowledge compaction,
 *                    learning synthesis, the health check's AI review,
 *                    reply auto-drafting, inbound auto-translation
 *   auto_topup       charging the saved card when the wallet runs low
 *   trash_purge      PC-05: the daily hard-delete of old trash (a hold on
 *                    it keeps deleted mail, e.g. for a dispute)
 *
 * The workspace pause (PC-05) stops the automatic side of every one of
 * these except inbox_sync: replies keep arriving while paused.
 */
export const AUTOMATION_CAPABILITIES = [
  'sending',
  'inbox_sync',
  'inbound_actions',
  'discovery',
  'autopilot',
  'crm_sync',
  'background_ai',
  'auto_topup',
  'trash_purge',
] as const;

export const automationCapability = pgEnum('automation_capability', AUTOMATION_CAPABILITIES);

/** `all` stops every capability; `capabilities` stops only the listed ones. */
export const workspaceHoldScope = pgEnum('workspace_hold_scope', ['all', 'capabilities']);

/** `hold` can be enforced. `note` is never enforced: a legacy feature flag
 *  with no capability to map to (connector.serpapi), kept so the platform
 *  owner sees it once and dismisses it. */
export const workspaceHoldKind = pgEnum('workspace_hold_kind', ['hold', 'note']);

/**
 * Lifecycle:
 *   pending_review → active      (Confirm — a legacy flag the owner keeps)
 *   pending_review → discarded   (Discard)
 *   active         → released    (Release, with a reason)
 * Only `active` holds are enforced, and only until `expires_at`.
 */
export const workspaceHoldState = pgEnum('workspace_hold_state', [
  'active',
  'pending_review',
  'released',
  'discarded',
]);

/** Who placed it. A tenant cannot release a `platform` hold. */
export const workspaceHoldSource = pgEnum('workspace_hold_source', ['tenant', 'platform']);

export interface WorkspaceHoldHistoryEntry {
  /** ISO timestamp. */
  at: string;
  action: 'placed' | 'imported' | 'confirmed' | 'discarded' | 'released';
  actorUserId: string | null;
  reason: string | null;
}

export const workspaceHolds = pgTable(
  'workspace_holds',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: workspaceHoldKind('kind').notNull().default('hold'),
    scope: workspaceHoldScope('scope').notNull(),
    /** Empty when scope = 'all' (and for notes). */
    capabilities: automationCapability('capabilities')
      .array()
      .notNull()
      .default(sql`'{}'`),
    state: workspaceHoldState('state').notNull().default('active'),
    source: workspaceHoldSource('source').notNull(),
    /** Why, in words the tenant can read (they see it on the banner). */
    reason: text('reason').notNull(),
    /** PC-21: a full hold that also shows members the hold page instead of
     *  the app. Stored from PC-06, enforced from PC-21. */
    blocksAccess: boolean('blocks_access').notNull().default(false),
    /** NULL = until released. Past it the hold simply stops applying —
     *  the gate compares against now(); no job has to run. */
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }),

    placedByUserId: text('placed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    placedAt: timestamp('placed_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
    confirmedByUserId: text('confirmed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    confirmedAt: timestamp('confirmed_at', { mode: 'date', withTimezone: true }),
    /** Released or discarded: by whom, when, why. */
    endedByUserId: text('ended_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    endedAt: timestamp('ended_at', { mode: 'date', withTimezone: true }),
    endReason: text('end_reason'),

    /** Import provenance: the feature_flags key this row came from. One
     *  imported row per (workspace, key), so re-running the import is a
     *  no-op. NULL for holds placed by hand. */
    legacyFlagKey: text('legacy_flag_key'),
    /** Every transition, oldest first (the audit log has the same events). */
    history: jsonb('history')
      .$type<WorkspaceHoldHistoryEntry[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceStateIdx: index('workspace_holds_workspace_state_idx').on(
      table.workspaceId,
      table.state,
    ),
    legacyFlagIdx: uniqueIndex('workspace_holds_legacy_flag_idx')
      .on(table.workspaceId, table.legacyFlagKey)
      .where(sql`legacy_flag_key IS NOT NULL`),
    /** A hold stops either everything (no list) or a non-empty list; a
     *  note stops nothing (empty list, scope 'capabilities' so even a
     *  reader that forgot to look at `kind` would find nothing to stop)
     *  and can only wait for review or be discarded. */
    shapeCheck: check(
      'workspace_holds_shape_check',
      sql`(kind = 'hold' AND ((scope = 'all' AND cardinality(capabilities) = 0) OR (scope = 'capabilities' AND cardinality(capabilities) > 0))) OR (kind = 'note' AND scope = 'capabilities' AND cardinality(capabilities) = 0 AND state IN ('pending_review', 'discarded'))`,
    ),
    reasonCheck: check('workspace_holds_reason_check', sql`length(btrim(reason)) > 0`),
  }),
);

export type WorkspaceHold = typeof workspaceHolds.$inferSelect;
export type NewWorkspaceHold = typeof workspaceHolds.$inferInsert;
export type AutomationCapability = (typeof AUTOMATION_CAPABILITIES)[number];
export type WorkspaceHoldState = (typeof workspaceHoldState.enumValues)[number];
export type WorkspaceHoldSource = (typeof workspaceHoldSource.enumValues)[number];
