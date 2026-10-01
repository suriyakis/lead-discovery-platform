import { sql } from 'drizzle-orm';
import { bigint, bigserial, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { workspaces } from './workspaces';

/**
 * flow:F-06 — production data remediation bookkeeping.
 *
 * Remediation is done by versioned scripts (scripts/remediation/<batch>/),
 * never by hand. A dry run writes a report whose plan hash the owner
 * reviews; `--apply` recomputes the plan, refuses on a hash mismatch, and
 * records one `remediation_runs` row (id = the report's batch id, so the
 * same report can never be applied twice) plus one `remediation_log` row
 * per changed row with its before- and after-image. `--revert` restores the
 * before-images from the log.
 *
 * Neither table is tenant-owned: a run can span workspaces and is driven
 * by a platform operator. `remediation_log.workspace_id` records which
 * tenant a row belongs to.
 */
export const remediationRuns = pgTable('remediation_runs', {
  /** The batch id from the dry-run report, e.g.
   *  `2026-10-funnel.mail.20261001T120000Z.ab12cd`. */
  id: text('id').primaryKey(),
  /** Script folder, e.g. `2026-10-funnel`. */
  script: text('script').notNull(),
  /** Module inside the script, e.g. `mail`. */
  module: text('module').notNull(),
  /** sha256 of the reviewed plan; the apply recomputed the same hash. */
  planHash: text('plan_hash').notNull(),
  /** sha256 of the owner's decisions file. */
  decisionsHash: text('decisions_hash'),
  /** Options the plan was computed with (from the report). */
  options: jsonb('options')
    .notNull()
    .default(sql`'{}'::jsonb`),
  /** applying → applied | failed; then reverted | revert_partial. */
  status: text('status').notNull(),
  /** Per-category counts and decisions; post-apply check results. */
  summary: jsonb('summary')
    .notNull()
    .default(sql`'{}'::jsonb`),
  error: text('error'),
  appliedBy: text('applied_by').references(() => users.id, { onDelete: 'set null' }),
  startedAt: timestamp('started_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { mode: 'date', withTimezone: true }),
  revertedBy: text('reverted_by').references(() => users.id, { onDelete: 'set null' }),
  revertedAt: timestamp('reverted_at', { mode: 'date', withTimezone: true }),
});

export const remediationLog = pgTable(
  'remediation_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => remediationRuns.id, { onDelete: 'cascade' }),
    workspaceId: bigint('workspace_id', { mode: 'bigint' }).references(() => workspaces.id, {
      onDelete: 'set null',
    }),
    /** Remediation category, e.g. `R1a`, `R4`. */
    category: text('category').notNull(),
    /** Table the change was made in (an allow-listed name). */
    tableName: text('table_name').notNull(),
    /** Primary key of the changed row, as text. */
    rowId: text('row_id').notNull(),
    /** 'update' | 'delete' | 'ledger_credit'. */
    action: text('action').notNull(),
    /** update: the changed columns before; delete: the whole row;
     *  ledger_credit: the wallet balance before. */
    before: jsonb('before'),
    /** update: the changed columns after; delete: NULL; ledger_credit: the
     *  ledger row that was appended. */
    after: jsonb('after'),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
    revertedAt: timestamp('reverted_at', { mode: 'date', withTimezone: true }),
  },
  (table) => ({
    runIdx: index('remediation_log_run_idx').on(table.runId, table.id),
    rowIdx: index('remediation_log_table_row_idx').on(table.tableName, table.rowId),
  }),
);

export type RemediationRun = typeof remediationRuns.$inferSelect;
export type NewRemediationRun = typeof remediationRuns.$inferInsert;
export type RemediationLogEntry = typeof remediationLog.$inferSelect;
export type NewRemediationLogEntry = typeof remediationLog.$inferInsert;
