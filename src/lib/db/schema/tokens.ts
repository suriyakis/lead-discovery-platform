import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';

/**
 * Prepaid token ledger — the authoritative history behind
 * workspaces.token_balance. Append-only: every credit (Stripe purchase,
 * admin adjustment) and every debit (metered usage) is one row carrying
 * the balance AFTER it applied, so any balance can be audited by replay.
 *
 * Idempotency: purchases carry the Stripe checkout-session id in
 * `externalRef` under a unique index, so webhook retries can never
 * double-credit.
 */
export const tokenTransactions = pgTable(
  'token_transactions',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    /** Positive = credit, negative = debit. Never zero. */
    delta: bigint('delta', { mode: 'bigint' }).notNull(),
    /** workspaces.token_balance immediately after this row applied. */
    balanceAfter: bigint('balance_after', { mode: 'bigint' }).notNull(),

    /** 'purchase' | 'usage' | 'adjustment' — validation lives in the
     *  service; free-form text so future kinds don't need a migration. */
    kind: text('kind').notNull(),
    /** For usage debits: the usage_log kind ('ai.qualification', …).
     *  For purchases: the pack id. For adjustments: operator note. */
    reason: text('reason').notNull(),
    /** Stripe checkout-session id for purchases (unique when set). */
    externalRef: text('external_ref'),
    /** Free-form detail: usage units, provider, cost cents, actor. */
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),

    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceCreatedIdx: index('token_tx_ws_created_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
    externalRefKey: uniqueIndex('token_tx_external_ref_idx')
      .on(table.externalRef)
      .where(sql`external_ref IS NOT NULL`),
  }),
);

export type TokenTransaction = typeof tokenTransactions.$inferSelect;
export type NewTokenTransaction = typeof tokenTransactions.$inferInsert;
