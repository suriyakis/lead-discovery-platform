import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';

/**
 * AP-06: the diagnostics notify ledger — what the 6-hourly sweep has seen
 * and announced, per workspace and finding episode
 * (src/lib/diagnostics/notify.ts).
 *
 * One row per (workspace, notice key): the finding's `notify.dedupeKey`
 * (e.g. `mailbox.failing:12`, `review.noise`). Only findings whose notify
 * policy is not 'never' get a row.
 *
 *   first_seen_at     start of the current episode (the finding appeared
 *                     after being absent, or for the first time)
 *   last_seen_at      the last sweep that saw it
 *   cleared_at        the first sweep that no longer saw it (episode over;
 *                     NULL while present). Not set when the finding's rule
 *                     threw: unknown is not "gone".
 *   last_notified_at  the last notification for this key; the policies
 *                     (on_appear: once per episode; max_once_per_days(n))
 *                     and the cap of one notification per rule per
 *                     workspace per 24 h (over rule_code) read it
 *
 * Tiny by construction (one row per rule or per rule × entity); rows are
 * kept so an episode that ends and comes back is recognised. Deleted with
 * the workspace.
 */
export const diagnosticNotices = pgTable(
  'diagnostic_notices',
  {
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    noticeKey: text('notice_key').notNull(),
    /** The rule id (the per-rule 24 h cap groups on it). */
    ruleCode: text('rule_code').notNull(),
    firstSeenAt: timestamp('first_seen_at', { mode: 'date', withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { mode: 'date', withTimezone: true }).notNull(),
    clearedAt: timestamp('cleared_at', { mode: 'date', withTimezone: true }),
    lastNotifiedAt: timestamp('last_notified_at', { mode: 'date', withTimezone: true }),
    notifyCount: integer('notify_count').notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.noticeKey] }),
    workspaceRuleIdx: index('diagnostic_notices_ws_rule_idx').on(
      table.workspaceId,
      table.ruleCode,
    ),
  }),
);

export type DiagnosticNotice = typeof diagnosticNotices.$inferSelect;
export type NewDiagnosticNotice = typeof diagnosticNotices.$inferInsert;
