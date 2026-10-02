import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
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

/**
 * Phase 21: per-workspace autopilot configuration. The autopilot orchestrator
 * runs through a fixed set of steps; each step is gated by its own boolean
 * here. Stopping everything is the workspace pause (PC-05,
 * workspaces.automation_paused_at), not a column of this table.
 *
 * The default for all `enable_*` flags is `false` so a workspace turning
 * autopilot on must opt in explicitly to each automated action.
 */
export const autopilotSettings = pgTable('autopilot_settings', {
  workspaceId: bigint('workspace_id', { mode: 'bigint' })
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),

  /** Master switch — when false, runOnce() does nothing and the autopilot
   *  tick skips the workspace (PC-35). */
  autopilotEnabled: boolean('autopilot_enabled').notNull().default(false),
  /**
   * @deprecated PC-05: read by nothing. Migrated into the workspace pause
   * (workspaces.automation_paused_at); kept one release as a write-only
   * mirror of it (services/automation-pause.ts) so a rollback to the old
   * code still sees a pause, then dropped.
   */
  emergencyPause: boolean('emergency_pause').notNull().default(false),

  /** PC-35 (I066): the guard state runOnce() last recorded — 'open' (it got
   *  past the guard) or the reason it stopped: 'autopilot_disabled', or the
   *  automation gate's refusal ('paused', 'hold:<id>', 'no_accountable_owner',
   *  'plan_no_autopilot', …; services/autopilot.ts guardStateOf). A `guard`
   *  row is written to autopilot_log only when this changes, not on every
   *  run. NULL = never evaluated. */
  guardState: text('guard_state'),
  guardStateAt: timestamp('guard_state_at', { mode: 'date', withTimezone: true }),

  /** Step toggles (the four autopilot steps, AUTOPILOT_STEP_KEYS in
   *  services/automation-policy.ts — the only reader). */
  enableAutoApproveProjects: boolean('enable_auto_approve_projects').notNull().default(false),
  /** Min relevance score required for auto-approval (0..100). */
  autoApproveThreshold: smallint('auto_approve_threshold').notNull().default(70),
  enableAutoEnqueueOutreach: boolean('enable_auto_enqueue_outreach').notNull().default(false),
  /**
   * @deprecated PC-13 (I019): read by nothing. "Auto-drain the send queue"
   * only added an extra drain pass inside an autopilot run — the 30 s
   * drain tick sends approved mail whatever it said. Removed from code and
   * UI; set to false by migration p1_automation_control_policy and dropped
   * one release later (kept so a rollback's select() still finds it).
   */
  enableAutoDrainQueue: boolean('enable_auto_drain_queue').notNull().default(false),
  /**
   * @deprecated PC-13 (I019, I067): read by nothing. "Sync inbound mail"
   * synced every mailbox inside each autopilot run, bypassing the IMAP
   * tick's backoff; the IMAP tick (Mailbox auto-sync) is the only
   * automatic inbound path now. Same lifecycle as enableAutoDrainQueue.
   */
  enableAutoSyncInbound: boolean('enable_auto_sync_inbound').notNull().default(false),
  enableAutoCrmContactSync: boolean('enable_auto_crm_contact_sync').notNull().default(false),
  enableAutoCrmDealOnQualified: boolean('enable_auto_crm_deal_on_qualified').notNull().default(false),

  /** Daily-action caps — independent from queue daily cap. */
  maxApprovalsPerRun: smallint('max_approvals_per_run').notNull().default(20),
  maxEnqueuesPerRun: smallint('max_enqueues_per_run').notNull().default(20),

  /** Default mailbox for auto-enqueue (null = workspace default). */
  defaultMailboxId: bigint('default_mailbox_id', { mode: 'bigint' }),
  /** Default CRM connection for auto-sync. */
  defaultCrmConnectionId: bigint('default_crm_connection_id', { mode: 'bigint' }),

  updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AutopilotSettings = typeof autopilotSettings.$inferSelect;
export type NewAutopilotSettings = typeof autopilotSettings.$inferInsert;

/**
 * Phase 27 / PC-13: per-product overlay. A row exists when a product
 * narrows what the workspace runs for it, or is paused.
 *
 * PC-13 (I020): overlays are NARROW-ONLY and enforced. Each override
 * column is NULL (inherit the workspace) or false (off for this product);
 * true is refused by the service and by the narrow-only CHECK constraint
 * (added by migration p1_automation_control_policy after it cleared the
 * old, never-applied "on" values — so the constraint lives in its custom
 * SQL, not here). A threshold can only be raised: the resolver uses the
 * higher of the workspace's and the product's. `paused_at` is the product
 * pause: autopilot does nothing for the product, and its queued emails and
 * follow-ups are held (still queued, never failed) until an owner or admin
 * resumes it. services/automation-policy.ts is the only reader.
 */
export const autopilotProductSettings = pgTable(
  'autopilot_product_settings',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    productProfileId: bigint('product_profile_id', { mode: 'bigint' }).notNull(),

    // Override columns — NULL means inherit, false means off for this
    // product; never true (narrow-only, see above).
    autopilotEnabled: boolean('autopilot_enabled'),
    /**
     * @deprecated PC-13: never applied (I020) and read by nothing. The
     * migration carried a true value into paused_at and cleared it; the
     * product pause is paused_at. Dropped one release later.
     */
    emergencyPause: boolean('emergency_pause'),
    enableAutoApproveProjects: boolean('enable_auto_approve_projects'),
    autoApproveThreshold: smallint('auto_approve_threshold'),
    enableAutoEnqueueOutreach: boolean('enable_auto_enqueue_outreach'),
    enableAutoCrmContactSync: boolean('enable_auto_crm_contact_sync'),
    enableAutoCrmDealOnQualified: boolean('enable_auto_crm_deal_on_qualified'),
    defaultMailboxId: bigint('default_mailbox_id', { mode: 'bigint' }),

    /** PC-13: the product pause. Non-NULL = paused since then. Any write
     *  role pauses; owners and admins resume (services/autopilot.ts). */
    pausedAt: timestamp('paused_at', { mode: 'date', withTimezone: true }),
    pausedByUserId: text('paused_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceProductIdx: uniqueIndex('autopilot_product_settings_ws_product_idx').on(
      table.workspaceId,
      table.productProfileId,
    ),
  }),
);

export type AutopilotProductSettings = typeof autopilotProductSettings.$inferSelect;
export type NewAutopilotProductSettings = typeof autopilotProductSettings.$inferInsert;

/**
 * Phase 21: per-step audit log. Append-only. The `guard` step is written
 * only when the guard state changes (autopilot_settings.guard_state), not
 * on every run. Rows older than AUTOPILOT_LOG_RETENTION_DAYS (30) are
 * deleted by the daily retention tick (PC-35, src/lib/services/retention.ts).
 */
export const autopilotLog = pgTable(
  'autopilot_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** The orchestrator run id — every action in one runOnce() shares an id. */
    runId: text('run_id').notNull(),
    /** e.g. 'approve_project' | 'enqueue_outreach' | 'drain_queue' | ... */
    step: text('step').notNull(),
    /** 'success' | 'skipped' | 'error' */
    outcome: text('outcome').notNull(),
    detail: text('detail'),
    /** Affected entity, when applicable. */
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceCreatedIdx: index('autopilot_log_ws_created_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
    workspaceRunIdx: index('autopilot_log_ws_run_idx').on(
      table.workspaceId,
      table.runId,
    ),
    /** PC-35: the retention tick deletes by age across every workspace. */
    createdIdx: index('autopilot_log_created_idx').on(table.createdAt),
  }),
);

export type AutopilotLogEntry = typeof autopilotLog.$inferSelect;
export type NewAutopilotLogEntry = typeof autopilotLog.$inferInsert;
