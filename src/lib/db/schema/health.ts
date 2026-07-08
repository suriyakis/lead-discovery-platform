import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  jsonb,
  pgTable,
  smallint,
  timestamp,
} from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';

/**
 * One row per AI workspace health check. `findings` are the rule-based
 * configuration/operations problems; `commReview` is the AI's reading of
 * sampled recent conversations (naturalness, repetition, flow); `advice`
 * is the merged, actionable to-do list. Score 0–100.
 */
export const workspaceHealthReports = pgTable(
  'workspace_health_reports',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    /** 0–100 — 100 is a clean bill of health. */
    score: smallint('score').notNull(),
    /** Array<{severity:'warning'|'info', code, message, href?}> */
    findings: jsonb('findings').notNull().default(sql`'[]'::jsonb`),
    /** Array<{threadId, subject, naturalness, issues[], advice[]}> */
    commReview: jsonb('comm_review').notNull().default(sql`'[]'::jsonb`),
    /** Array<string> — merged actionable advice. */
    advice: jsonb('advice').notNull().default(sql`'[]'::jsonb`),

    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceCreatedIdx: index('health_reports_ws_created_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
  }),
);

export type WorkspaceHealthReport = typeof workspaceHealthReports.$inferSelect;
export type NewWorkspaceHealthReport = typeof workspaceHealthReports.$inferInsert;
