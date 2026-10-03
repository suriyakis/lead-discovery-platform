import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * PC-38 (I184, X10): the shared rate limiter's state
 * (src/lib/rate-limit.ts). One row per limiter key, a fixed window:
 *
 *   key           'assistant:ws:12', 'action:learning.synthesize:ws:12', …
 *   window_start  when the current window opened
 *   count         requests let through in it (never above the limit)
 *   expires_at    window_start + the window: a request at or after it
 *                 opens a new window with count 1
 *
 * Every check is one INSERT … ON CONFLICT DO UPDATE … WHERE (the window
 * expired OR count < limit) RETURNING: a returned row means "allowed", no
 * row means "rejected". Postgres serialises the upsert on the row, so two
 * processes (the web server and the worker, or one before and one after a
 * deploy) count against the same window. Times come from the database
 * clock (clock_timestamp()), never a process clock.
 *
 * Before this table the limiter was a Map in the web process: every
 * deploy or restart handed every key a fresh quota, and a second process
 * would have counted on its own.
 *
 * Not tenant-owned: a key may name a workspace, a user or (in future) an
 * IP, so there is no foreign key. Rows are tiny and transient; the
 * retention tick deletes those whose window ended more than a day ago
 * (policy rate_limit_buckets.expired). CHECK constraints (migration custom
 * block): count ≥ 1, expires_at > window_start, key 1–200 characters.
 */
export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    key: text('key').primaryKey(),
    windowStart: timestamp('window_start', { mode: 'date', withTimezone: true }).notNull(),
    count: integer('count').notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => ({
    expiresIdx: index('rate_limit_buckets_expires_idx').on(table.expiresAt),
  }),
);

export type RateLimitBucketRow = typeof rateLimitBuckets.$inferSelect;
