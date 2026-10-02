import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { workspaces } from './workspaces';

/**
 * PC-07 (I022): one row per background job name — the eight repeatable
 * ticks plus the on-demand `connector.run`. Written by the `instrumented()`
 * wrapper around every job handler (start + finish) and, for ticks, by the
 * schedule registration at boot (`registered_at`, `boot_id`,
 * `interval_ms`, `queue_provider`).
 *
 * Staleness is NOT stored: it is computed from these columns on read
 * (src/lib/jobs/tick-schedule.ts — the expected-slot rule), so a stopped
 * worker that writes nothing still turns stale.
 *
 * Not tenant-owned: a tick fans out over every workspace. Per-workspace
 * outcomes live in `ops_events`.
 */
export const jobHeartbeats = pgTable('job_heartbeats', {
  /** Job name, e.g. `outreach.drain.tick`, `connector.run`. */
  name: text('name').primaryKey(),
  /** 'tick' (repeatable, has an interval) | 'job' (on demand). */
  kind: text('kind').notNull().default('tick'),
  /** Cadence of a repeatable tick; NULL for on-demand jobs. */
  intervalMs: integer('interval_ms'),
  /** Queue provider the schedule was registered with ('bullmq' slots are
   *  epoch-aligned, 'memory' slots count from `registered_at`). */
  queueProvider: text('queue_provider'),
  /** Process (boot) that last registered the schedule. */
  bootId: text('boot_id'),
  registeredAt: timestamp('registered_at', { mode: 'date', withTimezone: true }),
  lastStartedAt: timestamp('last_started_at', { mode: 'date', withTimezone: true }),
  lastFinishedAt: timestamp('last_finished_at', { mode: 'date', withTimezone: true }),
  /** Last finish that did not throw (status 'ok' or 'degraded'). */
  lastOkAt: timestamp('last_ok_at', { mode: 'date', withTimezone: true }),
  /** 'running' | 'ok' | 'degraded' (finished, some workspaces failed) | 'failed'. */
  lastStatus: text('last_status'),
  lastDurationMs: integer('last_duration_ms'),
  /** Masked message of the last thrown error. */
  lastError: text('last_error'),
  lastErrorAt: timestamp('last_error_at', { mode: 'date', withTimezone: true }),
  /** The handler's structured summary of its last successful run. */
  lastSummary: jsonb('last_summary')
    .notNull()
    .default(sql`'{}'::jsonb`),
  /** Next expected slot after the last start (or the first slot after
   *  registration). Informational; readiness recomputes it. */
  nextDueAt: timestamp('next_due_at', { mode: 'date', withTimezone: true }),
  runCount: integer('run_count').notNull().default(0),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
});

/**
 * PC-07 (I021/I022): the incident stream. One OPEN row per fingerprint
 * (partial unique index); a repeat bumps `occurrences` and `last_seen_at`
 * instead of inserting. `resolveOpsEvent` closes it (auto on the next
 * success, or manually later from the console); the next failure after
 * that opens a fresh row, so the history keeps one row per incident.
 *
 * Scope: 'platform' (worker, Redis, a whole tick failing; workspace_id
 * NULL) or 'workspace' (one tenant's failure inside a tick; workspace_id
 * set). The CHECK constraints for that pairing, the severity and the
 * scope values live in the migration's custom block.
 *
 * Messages and payload strings are masked before they are stored
 * (src/lib/ops/mask.ts). Resolved rows are kept for
 * OPS_EVENTS_RETENTION_DAYS (90) — the retention tick is PC-35.
 */
export const opsEvents = pgTable(
  'ops_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    /** 'platform' | 'workspace'. */
    scope: text('scope').notNull(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' }).references(() => workspaces.id, {
      onDelete: 'cascade',
    }),
    /** e.g. 'tick.workspace_failed', 'tick.failed', 'job.failed', 'worker.error'. */
    kind: text('kind').notNull(),
    /** 'info' | 'warning' | 'error' | 'critical'. */
    severity: text('severity').notNull(),
    /** Subsystem that raised it: a job name or 'bullmq.worker' / 'startup'. */
    source: text('source').notNull(),
    /** Stable, readable subject key, e.g. `autopilot.tick:ws=12`. */
    dedupeKey: text('dedupe_key').notNull(),
    /** sha256 over (scope, workspace, kind, dedupe key) — the identity of
     *  the incident. Also the notification dedupe key for PC-08/PC-09. */
    fingerprint: text('fingerprint').notNull(),
    title: text('title').notNull(),
    /** Latest masked error message. */
    message: text('message'),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    occurrences: integer('occurrences').notNull().default(1),
    firstSeenAt: timestamp('first_seen_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    acknowledgedAt: timestamp('acknowledged_at', { mode: 'date', withTimezone: true }),
    acknowledgedBy: text('acknowledged_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { mode: 'date', withTimezone: true }),
    resolvedBy: text('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    /** 'auto' (the next success) | 'manual'. */
    resolution: text('resolution'),
  },
  (table) => ({
    openFingerprintIdx: uniqueIndex('ops_events_open_fingerprint_idx')
      .on(table.fingerprint)
      .where(sql`resolved_at IS NULL`),
    sourceOpenIdx: index('ops_events_source_open_idx')
      .on(table.source)
      .where(sql`resolved_at IS NULL`),
    workspaceLastSeenIdx: index('ops_events_ws_last_seen_idx').on(
      table.workspaceId,
      table.lastSeenAt,
    ),
    lastSeenIdx: index('ops_events_last_seen_idx').on(table.lastSeenAt),
    resolvedAtIdx: index('ops_events_resolved_at_idx').on(table.resolvedAt),
  }),
);

/**
 * PC-08: owner-alert rate-limit state. One row per ALERT KEY: an incident
 * fingerprint (`ops_events.fingerprint`), a control-change key
 * (`control:…`) or the daily digest (`digest:daily`).
 *
 * The key outlives the incident row on purpose: an incident that resolves
 * and reopens within the re-alert window (a flapping tick) keeps its key,
 * so it does not page again. Claiming a key is one INSERT … ON CONFLICT DO
 * UPDATE … WHERE last_alerted_at <= cutoff, which is what stops two
 * processes (or two overlapping passes) from sending the same alert.
 * See src/lib/services/ops-alerts.ts.
 */
export const opsAlertState = pgTable(
  'ops_alert_state',
  {
    alertKey: text('alert_key').primaryKey(),
    lastAlertedAt: timestamp('last_alerted_at', { mode: 'date', withTimezone: true }).notNull(),
    /** The incident row the last alert was about (NULL for control
     *  changes and digests, or once retention deleted the row). */
    lastEventId: bigint('last_event_id', { mode: 'bigint' }).references(() => opsEvents.id, {
      onDelete: 'set null',
    }),
    alertCount: integer('alert_count').notNull().default(1),
  },
  (table) => ({
    lastAlertedIdx: index('ops_alert_state_last_alerted_idx').on(table.lastAlertedAt),
  }),
);

/**
 * PC-08: every message sent (or attempted) to the owner-alert sink. The
 * hourly message budget is counted from here, the console's "recent
 * alerts" list reads it, and it is the record of what left the platform.
 * Titles and errors are masked; the topic and the access token are never
 * stored. Same 90-day retention as ops_events (the deletion is PC-35).
 */
export const opsAlertDeliveries = pgTable(
  'ops_alert_deliveries',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    /** 'incident' | 'digest' (a burst folded into one message) |
     *  'daily_digest' | 'control' (stop / hold / pause change) | 'test'. */
    kind: text('kind').notNull(),
    /** The sink format; only 'ntfy' today. */
    sink: text('sink').notNull().default('ntfy'),
    /** 'sent' | 'failed'. */
    status: text('status').notNull(),
    title: text('title').notNull(),
    /** ntfy priority 1 (min) … 5 (max). */
    priority: integer('priority').notNull(),
    /** Incidents (ops_events rows) the message covers. */
    eventCount: integer('event_count').notNull().default(0),
    /** { alertKeys, eventIds }: bounded lists. */
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** HTTP status the sink answered with, when it answered. */
    httpStatus: integer('http_status'),
    /** Masked failure reason. */
    error: text('error'),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    kindCreatedIdx: index('ops_alert_deliveries_kind_created_idx').on(table.kind, table.createdAt),
    createdIdx: index('ops_alert_deliveries_created_idx').on(table.createdAt),
  }),
);

export type JobHeartbeat = typeof jobHeartbeats.$inferSelect;
export type NewJobHeartbeat = typeof jobHeartbeats.$inferInsert;
export type OpsEvent = typeof opsEvents.$inferSelect;
export type NewOpsEvent = typeof opsEvents.$inferInsert;
export type OpsAlertState = typeof opsAlertState.$inferSelect;
export type OpsAlertDelivery = typeof opsAlertDeliveries.$inferSelect;
export type NewOpsAlertDelivery = typeof opsAlertDeliveries.$inferInsert;
