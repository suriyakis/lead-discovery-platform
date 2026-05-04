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
 * here. A single emergency_pause toggle disables every step at once.
 *
 * The default for all `enable_*` flags is `false` so a workspace turning
 * autopilot on must opt in explicitly to each automated action.
 */
export const autopilotSettings = pgTable('autopilot_settings', {
  workspaceId: bigint('workspace_id', { mode: 'bigint' })
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),

  /** Master switch — when false, runOnce() is a no-op. */
  autopilotEnabled: boolean('autopilot_enabled').notNull().default(false),
  /** Kill switch — when true, runOnce() is a no-op even if autopilotEnabled. */
  emergencyPause: boolean('emergency_pause').notNull().default(false),

  /** Step toggles. */
  enableAutoApproveProjects: boolean('enable_auto_approve_projects').notNull().default(false),
  /** Min relevance score required for auto-approval (0..100). */
  autoApproveThreshold: smallint('auto_approve_threshold').notNull().default(70),
  enableAutoEnqueueOutreach: boolean('enable_auto_enqueue_outreach').notNull().default(false),
  enableAutoDrainQueue: boolean('enable_auto_drain_queue').notNull().default(false),
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
 * Phase 27: per-product autopilot overlay. A row here exists when a
 * specific product profile wants to override the workspace defaults for
 * any product-scoped step (auto-approve, auto-enqueue, CRM contact sync,
 * CRM deal-on-qualified). Workspace-wide steps (sync inbound, drain
 * queue) stay strictly workspace-level.
 *
 * NULL columns mean "fall through to workspace defaults"; non-NULL
 * columns are the explicit per-product override. The resolution helper
 * `getEffectiveAutopilotSettings(ctx, productId)` handles the merge.
 */
export const autopilotProductSettings = pgTable(
  'autopilot_product_settings',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    productProfileId: bigint('product_profile_id', { mode: 'bigint' }).notNull(),

    // Override columns — NULL means inherit.
    autopilotEnabled: boolean('autopilot_enabled'),
    emergencyPause: boolean('emergency_pause'),
    enableAutoApproveProjects: boolean('enable_auto_approve_projects'),
    autoApproveThreshold: smallint('auto_approve_threshold'),
    enableAutoEnqueueOutreach: boolean('enable_auto_enqueue_outreach'),
    enableAutoCrmContactSync: boolean('enable_auto_crm_contact_sync'),
    enableAutoCrmDealOnQualified: boolean('enable_auto_crm_deal_on_qualified'),
    defaultMailboxId: bigint('default_mailbox_id', { mode: 'bigint' }),

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
 * Phase 21: per-step audit log. Append-only; never trimmed automatically
 * (operator can purge from /admin if it grows unbounded).
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
  }),
);

export type AutopilotLogEntry = typeof autopilotLog.$inferSelect;
export type NewAutopilotLogEntry = typeof autopilotLog.$inferInsert;
