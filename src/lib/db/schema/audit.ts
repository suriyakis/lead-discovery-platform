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
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { workspaces } from './workspaces';

// Append-only audit history. Significant user-visible actions write here.
// Stored even when workspaceId/userId are null (platform-level events).
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' }).references(() => workspaces.id, {
      onDelete: 'set null',
    }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceCreatedAtIdx: index('audit_log_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
    kindCreatedAtIdx: index('audit_log_kind_created_idx').on(table.kind, table.createdAt),
  }),
);

// Append-only usage / cost tracking. Per workspace, per provider.
// `units` is kind-specific: tokens for ai.generate_text, queries for
// search.query, bytes for storage.bytes, etc.
export const usageLog = pgTable(
  'usage_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    provider: text('provider').notNull(),
    units: bigint('units', { mode: 'bigint' }).notNull(),
    costEstimateCents: integer('cost_estimate_cents'),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceCreatedAtIdx: index('usage_log_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
    kindCreatedAtIdx: index('usage_log_kind_created_idx').on(table.kind, table.createdAt),
  }),
);

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
export type UsageLogEntry = typeof usageLog.$inferSelect;
export type NewUsageLogEntry = typeof usageLog.$inferInsert;
