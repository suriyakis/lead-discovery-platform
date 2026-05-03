import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { workspaces } from './workspaces';
import { qualifiedLeads } from './pipeline';

/**
 * `crm_connections` — per-workspace per-system CRM hookup. The credential
 * lives in `workspace_secrets` (encrypted at rest) and is referenced here
 * by its key. Configuration that's not a secret (HubSpot portal id,
 * field mappings, default pipeline) lives in `config_json`.
 *
 * Status drives the UI badge:
 *   active        — credential resolved, last sync succeeded
 *   paused        — manually paused; no syncs run
 *   failing       — last sync failed
 *   archived      — retired, kept for audit
 */
export const crmConnectionStatus = pgEnum('crm_connection_status', [
  'active',
  'paused',
  'failing',
  'archived',
]);

export const crmConnections = pgTable(
  'crm_connections',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    /** Adapter id, e.g. 'hubspot' | 'salesforce' | 'csv' (csv is psuedo-CRM). */
    system: text('system').notNull(),
    /** Display name. */
    name: text('name').notNull(),

    /** Secret key in workspace_secrets (e.g., crm.<id>.token). Null for csv. */
    credentialSecretKey: text('credential_secret_key'),

    /** Adapter-specific configuration (field mapping, portal id, ...). */
    config: jsonb('config').notNull().default(sql`'{}'::jsonb`),

    status: crmConnectionStatus('status').notNull().default('active'),
    lastSyncedAt: timestamp('last_synced_at', { mode: 'date', withTimezone: true }),
    lastError: text('last_error'),

    createdBy: text('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceSystemIdx: index('crm_connections_ws_system_idx').on(
      table.workspaceId,
      table.system,
    ),
    workspaceStatusIdx: index('crm_connections_ws_status_idx').on(
      table.workspaceId,
      table.status,
    ),
  }),
);

export type CrmConnection = typeof crmConnections.$inferSelect;
export type NewCrmConnection = typeof crmConnections.$inferInsert;
export type CrmConnectionStatus = (typeof crmConnectionStatus.enumValues)[number];

/**
 * `crm_sync_log` — append-only record of every CRM sync attempt. One row
 * per (lead, connection) push. Lets the UI surface "last synced" + retry
 * paths.
 *
 * Direction: Phase 13 is one-way (out): we push qualified_leads to the CRM.
 * Future bi-directional sync can flip this column.
 */
export const crmSyncOutcome = pgEnum('crm_sync_outcome', [
  'pending',
  'succeeded',
  'failed',
  'skipped',
]);

/**
 * Phase 18: a sync log entry can describe a contact push, a note push, or
 * a deal push. Defaults to contact for back-compat with Phase 13 rows.
 */
export const crmSyncKind = pgEnum('crm_sync_kind', ['contact', 'note', 'deal']);

export const crmSyncLog = pgTable(
  'crm_sync_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    crmConnectionId: bigint('crm_connection_id', { mode: 'bigint' })
      .notNull()
      .references(() => crmConnections.id, { onDelete: 'cascade' }),
    qualifiedLeadId: bigint('qualified_lead_id', { mode: 'bigint' })
      .notNull()
      .references(() => qualifiedLeads.id, { onDelete: 'cascade' }),
    kind: crmSyncKind('kind').notNull().default('contact'),
    /** When kind=note, the mail_message id this note was bundled from. */
    relatedMessageId: bigint('related_message_id', { mode: 'bigint' }),

    outcome: crmSyncOutcome('outcome').notNull().default('pending'),
    /** Adapter-assigned external id, when present. */
    externalId: text('external_id'),
    /** HTTP status / API error code, when present. */
    statusCode: integer('status_code'),
    error: text('error'),

    /** Snapshot of the payload sent to the CRM (audit). */
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    /** Snapshot of the response from the CRM (audit). */
    response: jsonb('response').notNull().default(sql`'{}'::jsonb`),

    triggeredBy: text('triggered_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    startedAt: timestamp('started_at', { mode: 'date', withTimezone: true }),
    finishedAt: timestamp('finished_at', { mode: 'date', withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceCreatedIdx: index('crm_sync_log_ws_created_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
    leadConnectionIdx: index('crm_sync_log_lead_conn_idx').on(
      table.qualifiedLeadId,
      table.crmConnectionId,
    ),
    /** One pending row at a time per (lead, connection) — service enforces. */
    leadConnectionUniquePending: uniqueIndex('crm_sync_log_pending_idx')
      .on(table.qualifiedLeadId, table.crmConnectionId)
      .where(sql`outcome = 'pending'`),
  }),
);

export type CrmSyncEntry = typeof crmSyncLog.$inferSelect;
export type NewCrmSyncEntry = typeof crmSyncLog.$inferInsert;
export type CrmSyncOutcome = (typeof crmSyncOutcome.enumValues)[number];
export type CrmSyncKind = (typeof crmSyncKind.enumValues)[number];
