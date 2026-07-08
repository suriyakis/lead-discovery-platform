// Minimal in-process rate limiter (fixed window per key). Good enough for
// a single-container deployment — the goal is stopping cost-DoS floods
// against AI endpoints, not precise distributed quotas. If the app ever
// scales to multiple containers, swap the store for Redis.

interface WindowState {
  windowStart: number;
  count: number;
}

const buckets = new Map<string, WindowState>();
let lastSweep = 0;

/**
 * Returns true when the caller identified by `key` is within `limit`
 * requests per `windowMs`, false when it should be rejected (429).
 */
export function rateLimitAllow(
  key: string,
  limit: number,
  windowMs: number,
): boolean {
  const now = Date.now();

  // Opportunistic sweep so abandoned keys don't accumulate forever.
  if (now - lastSweep > 10 * 60_000) {
    lastSweep = now;
    for (const [k, v] of buckets) {
      if (now - v.windowStart > windowMs * 2) buckets.delete(k);
    }
  }

  const state = buckets.get(key);
  if (!state || now - state.windowStart >= windowMs) {
    buckets.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (state.count >= limit) return false;
  state.count += 1;
  return true;
}

/** Test seam. */
export function _resetRateLimitsForTests(): void {
  buckets.clear();
}
