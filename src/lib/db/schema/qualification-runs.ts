import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { workspaces } from './workspaces';

/**
 * PC-38 (I028): the lifecycle of a "Re-classify all" run.
 *
 *   queued     requested; its qualification.reclassify job waits on the
 *              runs lane. Also a run handed back by a stopping worker, or
 *              one taken over after its worker died, with its progress
 *              kept: its next job resumes it after last_record_id
 *   running    the job claimed it and works through the records
 *   succeeded  every record up to up_to_record_id was classified
 *   stopped    ended early on purpose, progress kept: stop_reason
 *              'no_tokens' (the wallet ran dry), 'held' (a Background AI
 *              hold or the platform stopped it), 'lease_lost' (another
 *              holder took the run's lease over)
 *   failed     an unexpected error, or the queue could not take a fresh
 *              run's job (an abandoned run is resumed, not failed)
 */
export const QUALIFICATION_RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'stopped',
  'failed',
] as const;
export type QualificationRunStatus = (typeof QUALIFICATION_RUN_STATUSES)[number];

/** Statuses of a run that is not over; at most one per workspace. */
export const ACTIVE_QUALIFICATION_RUN_STATUSES = ['queued', 'running'] as const;

export const QUALIFICATION_RUN_STOP_REASONS = ['no_tokens', 'held', 'lease_lost'] as const;
export type QualificationRunStopReason = (typeof QUALIFICATION_RUN_STOP_REASONS)[number];

/**
 * PC-38 (I028): one "Re-classify all" pass over a workspace's source
 * records. It used to run inside the button's request (records × products
 * sequential AI calls, no progress, no wallet gate); now the request
 * writes this row and enqueues a background job (services/
 * qualification-runs.ts) that works in batches of 50 records, saves its
 * progress after each batch and stops cleanly when the wallet is empty.
 *
 * The run covers the records that existed when it was requested
 * (id ≤ up_to_record_id, total_records of them), so its progress has a
 * fixed denominator; records discovered meanwhile are classified by their
 * own discovery run. last_record_id is the cursor: every record with a
 * smaller or equal id has been processed.
 *
 * Tenant-owned (cascade on workspace delete). A partial unique index
 * allows one queued or running run per workspace: the database-level
 * guarantee behind the single-flight lease. CHECK constraints (migration
 * custom block): status and stop_reason values, non-negative counters,
 * failed_records ≤ processed_records. (processed_records may pass
 * total_records by a record or two: one whose insert committed after the
 * count, with an id below up_to_record_id.)
 */
export const qualificationRuns = pgTable(
  'qualification_runs',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** One of QUALIFICATION_RUN_STATUSES. */
    status: text('status').notNull().default('queued'),
    /** One of QUALIFICATION_RUN_STOP_REASONS while status = 'stopped'. */
    stopReason: text('stop_reason'),
    /** Operator-safe sentence for 'failed' (never provider text). */
    error: text('error'),
    requestedBy: text('requested_by').references(() => users.id, { onDelete: 'set null' }),
    /** The newest source record when the run was requested. */
    upToRecordId: bigint('up_to_record_id', { mode: 'bigint' }).notNull(),
    totalRecords: integer('total_records').notNull(),
    /** Active product profiles when the run was requested. */
    productCount: integer('product_count').notNull(),
    processedRecords: integer('processed_records').notNull().default(0),
    qualificationCount: integer('qualification_count').notNull().default(0),
    /** Records whose classification threw (logged, skipped). */
    failedRecords: integer('failed_records').notNull().default(0),
    /** Cursor: the last source record id processed. */
    lastRecordId: bigint('last_record_id', { mode: 'bigint' }),
    /** The queue's id of the job that runs it. */
    jobId: text('job_id'),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { mode: 'date', withTimezone: true }),
    /** Written at every batch: a running run whose heartbeat stopped and
     *  whose lease is free was abandoned. */
    heartbeatAt: timestamp('heartbeat_at', { mode: 'date', withTimezone: true }),
    finishedAt: timestamp('finished_at', { mode: 'date', withTimezone: true }),
  },
  (table) => ({
    oneActivePerWorkspace: uniqueIndex('qualification_runs_one_active_idx')
      .on(table.workspaceId)
      .where(sql`status IN ('queued', 'running')`),
    workspaceCreatedIdx: index('qualification_runs_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
  }),
);

export type QualificationRun = typeof qualificationRuns.$inferSelect;
export type NewQualificationRun = typeof qualificationRuns.$inferInsert;
