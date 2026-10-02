// PC-38 (I184, X10): the shared rate limiter.
//
// A fixed window per key: at most `limit` requests per `windowMs`; the
// first request after the window ends opens a new one. Callers keep the
// same three arguments as before (rateLimitAllow(key, limit, windowMs)),
// but the answer is now a Promise, because the state lives in Postgres
// (rate_limit_buckets, schema/rate-limits.ts) instead of a Map in the web
// process:
//
//   - a deploy or a restart no longer hands every key a fresh quota;
//   - the web server and the worker process count against the same window
//     (Postgres is the one store every process already has, whatever the
//     job queue; Redis is only there for BullMQ);
//   - the window is measured on the database clock, so processes agree.
//
// One check is one upsert (PostgresRateLimitStore): it lets the request in
// and counts it, or matches nothing and rejects it — never both, and two
// concurrent requests on one key are serialised by the row lock. A
// rejected request is not counted, like the old in-memory limiter.
//
// If the database cannot be reached the limiter does not fail open: it
// falls back to an in-process window (MemoryRateLimitStore, the old
// algorithm) for that check and logs it at most once a minute, so a flood
// during an outage is still capped per process. The request itself will
// most likely fail on its own database work anyway.
//
// Keys: '<area>:<scope>:<id>', e.g. 'assistant:ws:12', 'assistant:user:u1',
// 'action:learning.synthesize:ws:12' (services/action-guards.ts). Callers
// never put personal data in a key beyond the ids they already hold.

import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import { rateLimitBuckets } from '@/lib/db/schema/rate-limits';

/** The answer to one check. */
export interface RateLimitDecision {
  allowed: boolean;
  /** Rejected: how long until the window ends (0 when allowed). */
  retryAfterMs: number;
}

/** Where a limiter keeps its windows. */
export interface RateLimitStore {
  readonly id: string;
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>;
  reset(): Promise<void>;
}

const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const CheckSchema = z.object({
  key: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(1_000_000),
  windowMs: z.number().int().min(1).max(MAX_WINDOW_MS),
});

/**
 * The shared store: one row per key in rate_limit_buckets.
 *
 *   INSERT (key, now, 1, now + window)
 *   ON CONFLICT (key) DO UPDATE
 *     SET  a new window (count 1) when the old one ended, else count + 1
 *     WHERE the old window ended OR count < limit
 *   RETURNING count
 *
 * A returned row: allowed (and counted). No row: the window is live and
 * full, so rejected (and not counted); a second read says until when.
 */
export class PostgresRateLimitStore implements RateLimitStore {
  readonly id = 'postgres';

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    const ends = sql`clock_timestamp() + (${windowMs}::integer * interval '1 millisecond')`;
    const ended = sql`${rateLimitBuckets.expiresAt} <= clock_timestamp()`;
    const won = await db
      .insert(rateLimitBuckets)
      .values({ key, windowStart: sql`clock_timestamp()`, count: 1, expiresAt: ends })
      .onConflictDoUpdate({
        target: rateLimitBuckets.key,
        // Every SET expression reads the row as it was before this update.
        set: {
          windowStart: sql`CASE WHEN ${ended} THEN excluded.window_start ELSE ${rateLimitBuckets.windowStart} END`,
          count: sql`CASE WHEN ${ended} THEN 1 ELSE ${rateLimitBuckets.count} + 1 END`,
          expiresAt: sql`CASE WHEN ${ended} THEN excluded.expires_at ELSE ${rateLimitBuckets.expiresAt} END`,
        },
        setWhere: sql`${ended} OR ${rateLimitBuckets.count} < ${limit}::integer`,
      })
      .returning({ count: rateLimitBuckets.count });
    if (won.length > 0) return { allowed: true, retryAfterMs: 0 };

    const [row] = await db
      .select({
        ms: sql<string>`GREATEST(0, CEIL(EXTRACT(EPOCH FROM (${rateLimitBuckets.expiresAt} - clock_timestamp())) * 1000))`,
      })
      .from(rateLimitBuckets)
      .where(eq(rateLimitBuckets.key, key))
      .limit(1);
    return { allowed: false, retryAfterMs: row ? Number(row.ms) : 0 };
  }

  async reset(): Promise<void> {
    await db.delete(rateLimitBuckets);
  }
}

interface WindowState {
  windowStart: number;
  count: number;
}

/**
 * In-process windows (the limiter before PC-38). Only the fallback while
 * the database is unreachable; never shared between processes.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  readonly id = 'memory';
  private readonly buckets = new Map<string, WindowState>();
  private lastSweep = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    const now = this.now();
    // Opportunistic sweep so abandoned keys don't accumulate forever.
    if (now - this.lastSweep > 10 * 60_000) {
      this.lastSweep = now;
      for (const [k, v] of this.buckets) {
        if (now - v.windowStart > MAX_WINDOW_MS) this.buckets.delete(k);
      }
    }
    const state = this.buckets.get(key);
    if (!state || now - state.windowStart >= windowMs) {
      this.buckets.set(key, { windowStart: now, count: 1 });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (state.count >= limit) {
      return { allowed: false, retryAfterMs: Math.max(0, state.windowStart + windowMs - now) };
    }
    state.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }

  async reset(): Promise<void> {
    this.buckets.clear();
  }
}

const FALLBACK_LOG_EVERY_MS = 60_000;

/**
 * A limiter over a store, with an in-process fallback for when the store
 * throws. Every process makes its own instance (the module's default
 * below); instances over PostgresRateLimitStore share their windows.
 */
export class RateLimiter {
  private lastFallbackLog = 0;

  constructor(
    private readonly store: RateLimitStore,
    private readonly fallback: RateLimitStore = new MemoryRateLimitStore(),
  ) {}

  async check(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    const input = CheckSchema.parse({ key, limit, windowMs });
    try {
      return await this.store.hit(input.key, input.limit, input.windowMs);
    } catch (err) {
      const now = Date.now();
      if (now - this.lastFallbackLog >= FALLBACK_LOG_EVERY_MS) {
        this.lastFallbackLog = now;
        console.error(
          `[rate-limit] ${this.store.id} store unavailable, limiting in-process until it is back:`,
          err instanceof Error ? err.message : err,
        );
      }
      return this.fallback.hit(input.key, input.limit, input.windowMs);
    }
  }

  async allow(key: string, limit: number, windowMs: number): Promise<boolean> {
    return (await this.check(key, limit, windowMs)).allowed;
  }

  async reset(): Promise<void> {
    await Promise.all([this.store.reset(), this.fallback.reset()]);
  }
}

let shared: RateLimiter | null = null;

function limiter(): RateLimiter {
  shared ??= new RateLimiter(new PostgresRateLimitStore());
  return shared;
}

/**
 * Is the caller identified by `key` within `limit` requests per
 * `windowMs`? Counts the request when it is. False means reject (429).
 */
export async function rateLimitAllow(
  key: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  return limiter().allow(key, limit, windowMs);
}

/** rateLimitAllow, plus how long a rejected caller should wait. */
export async function rateLimitCheck(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitDecision> {
  return limiter().check(key, limit, windowMs);
}

/** Test seam: empty every window (the table and the fallback). */
export async function _resetRateLimitsForTests(): Promise<void> {
  await limiter().reset();
}
