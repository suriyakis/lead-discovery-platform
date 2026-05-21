/**
 * Phase 51 — IMAP error classification + backoff schedule.
 *
 * Pure helpers — no DB, no network. The cron handler in
 * `src/lib/jobs/repeatables.ts` consumes these to decide whether to
 * mark a mailbox as `failing` (auth-permanent) or just delay the next
 * tick (transient + adaptive polling).
 *
 * Why: the original tick re-attempted every 2 minutes regardless of
 * error class. A mailbox with a stale password produced 30 failed
 * IMAP logins per hour, every hour, which trips fail2ban / Dovecot
 * rate-limits on most upstream mail providers within minutes.
 */

export type ImapErrorClass = 'auth' | 'transient';

/** Substrings that imapflow / dovecot / outlook surface for credential
 *  failures. Match is case-insensitive; we want a broad net here because
 *  the cost of misclassifying transient → auth (false positive ban) is
 *  one fewer retry, while auth → transient is a steady stream of bad
 *  logins. Bias toward calling it auth. */
const AUTH_SIGNATURES: readonly string[] = [
  'AUTHENTICATIONFAILED',
  'Invalid credentials',
  'Authentication failed',
  'auth failed',
  'LOGIN failed',
  'LOGIN_DISABLED',
  'AUTHORIZATIONFAILED',
  'Application-specific password required',
  'incorrect password',
  'bad password',
  'Account is disabled',
  'Account locked',
];

/** After this many CONSECUTIVE 'transient' failures (e.g. the generic
 *  imapflow "Command failed" with no auth signature), treat the
 *  mailbox as effectively dead and stop polling — same as an auth
 *  failure. The cap defeats slow-burn fail2ban risk for misconfigured
 *  mailboxes whose error text never tripped an AUTH signature.
 *  Tracked as imap_consecutive_failures in the schema. */
export const TRANSIENT_FAILURE_PAUSE_THRESHOLD = 10;

export function classifyImapError(err: unknown): ImapErrorClass {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  for (const sig of AUTH_SIGNATURES) {
    if (lower.includes(sig.toLowerCase())) return 'auth';
  }
  return 'transient';
}

/**
 * Exponential backoff for transient failures.
 * count=1 → 2 min, 2 → 4 min, 3 → 8 min, 4 → 16 min, 5 → 32 min,
 * 6+ → 60 min (cap).
 *
 * Base 2 min matches the normal IMAP_TICK_MS so the first retry is at
 * the natural cadence, then each subsequent failure doubles the wait.
 */
export function computeBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const BASE_MS = 2 * 60 * 1000;
  const CAP_MS = 60 * 60 * 1000;
  const candidate = BASE_MS * Math.pow(2, consecutiveFailures - 1);
  return Math.min(candidate, CAP_MS);
}

/**
 * Adaptive polling: after N consecutive ticks that pulled zero new
 * messages, stretch the next-sync gate so a quiet mailbox doesn't keep
 * pinging the server every 2 minutes for nothing.
 *
 * emptySyncs <  EMPTY_THRESHOLD → null (natural 2-min cadence)
 * emptySyncs >= EMPTY_THRESHOLD → 15-min cooldown.
 */
export function nextSyncAfterEmpty(
  now: Date,
  emptySyncs: number,
): Date | null {
  const EMPTY_THRESHOLD = 5;
  const QUIET_INTERVAL_MS = 15 * 60 * 1000;
  if (emptySyncs < EMPTY_THRESHOLD) return null;
  return new Date(now.getTime() + QUIET_INTERVAL_MS);
}
