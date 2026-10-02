import { bigint, index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';

/**
 * PC-12 (I064, I067, I068): the kinds of work that must never overlap in
 * one workspace. Each kind is held per workspace and resource:
 *
 *   autopilot.run        one runOnce at a time (the 5-minute tick, Run now
 *                        and the post-crawl hook)
 *   outreach.drain       one send pass at a time (the 30 s drain tick,
 *                        "Send due emails now" and Retry now), so the daily
 *                        cap is counted by exactly one sender
 *   outreach.follow_up   one follow-up pass at a time (the hourly tick)
 *   mailbox.sync         per mailbox (resource = mailbox id): one IMAP sync
 *                        or connection check at a time (the IMAP tick, the
 *                        Sync buttons, Test connection)
 *   connector.recipe     per recipe (resource = recipe id): one executing
 *                        discovery run at a time
 *
 * The CHECK constraint on `kind` (migration custom block) lists the same
 * values.
 */
export const WORK_LEASE_KINDS = [
  'autopilot.run',
  'outreach.drain',
  'outreach.follow_up',
  'mailbox.sync',
  'connector.recipe',
] as const;
export type WorkLeaseKind = (typeof WORK_LEASE_KINDS)[number];

/**
 * PC-12: work leases. A row is a claim on one kind of work in one
 * workspace (and, for per-resource kinds, one mailbox or recipe) until
 * `expires_at`. Acquiring is one INSERT … ON CONFLICT DO UPDATE … WHERE
 * expires_at < now() (services/work-leases.ts): it succeeds when no row
 * exists or the existing one has expired, so a crashed holder blocks the
 * work for at most one TTL. The holder renews while it works and deletes
 * its row when it is done; every write is conditional on its `holder`
 * token, so a holder whose lease expired and was taken over can never
 * renew or release the new holder's lease.
 *
 * Chosen over session advisory locks because a lease is a row: the ops
 * console can list who holds what and since when, an expired row shows a
 * holder that died, and it works over the pooled client (max 10
 * connections, no pgbouncer) where a session lock would be pinned to
 * whichever pooled connection took it. Times come from the database clock
 * (clock_timestamp()), never a process clock, so the web and worker
 * processes agree on expiry.
 *
 * Tenant-owned (cascade on workspace delete). Rows are transient: deleted
 * on release; an expired one is overwritten by the next acquire, or — when
 * nobody acquires that key again (a deleted mailbox or recipe) — deleted by
 * the retention tick 7 days after it expired (policy work_leases.expired).
 */
export const workLeases = pgTable(
  'work_leases',
  {
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** One of WORK_LEASE_KINDS. */
    kind: text('kind').notNull(),
    /** The mailbox or recipe id for per-resource kinds; '' for the
     *  workspace-wide kinds. */
    resourceKey: text('resource_key').notNull().default(''),
    /** Random token of this acquisition: renew and release match on it. */
    holder: text('holder').notNull(),
    /** Who holds it, for people: process role, host, pid and boot id. */
    holderLabel: text('holder_label').notNull(),
    /** What the holder is doing ('tick', 'manual', 'post-crawl', …). */
    purpose: text('purpose').notNull().default(''),
    acquiredAt: timestamp('acquired_at', { mode: 'date', withTimezone: true }).notNull(),
    renewedAt: timestamp('renewed_at', { mode: 'date', withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: 'work_leases_pkey',
      columns: [table.workspaceId, table.kind, table.resourceKey],
    }),
    expiresIdx: index('work_leases_expires_idx').on(table.expiresAt),
  }),
);

export type WorkLeaseRow = typeof workLeases.$inferSelect;
