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
 *
 * flow:F-04 adds the schedule for a mailbox that is already 'failing':
 * the IMAP tick re-checks it (a full SMTP + IMAP connection test) only
 * when its imap_next_sync_after gate has passed, and that gate grows with
 * how long the mailbox has been failing — see failingRecheckDelayMs.
 */

import {
  describeConnectionError,
  isAuthFailure,
  looksLikeAuthFailure,
} from '@/lib/mail/connection-errors';

export type ImapErrorClass = 'auth' | 'transient';

/** After this many CONSECUTIVE 'transient' failures (e.g. the generic
 *  imapflow "Command failed" with no auth signature), treat the
 *  mailbox as effectively dead and stop polling — same as an auth
 *  failure. The cap defeats slow-burn fail2ban risk for misconfigured
 *  mailboxes whose error text never tripped an AUTH signature.
 *  Tracked as imap_consecutive_failures in the schema. */
export const TRANSIENT_FAILURE_PAUSE_THRESHOLD = 10;

/** Is this a refused login? The structured flags imapflow / nodemailer
 *  set (authenticationFailed, serverResponseCode AUTHENTICATIONFAILED,
 *  EAUTH) win — imapflow's own message is a bare "Command failed", which
 *  is how prod's workspace-2 mailbox ran 13 "transient" failures — then
 *  the text, response included, is matched against the auth signatures
 *  (case-insensitive, biased toward "auth": misreading transient as auth
 *  costs one fewer retry, the reverse a stream of bad logins). */
export function classifyImapError(err: unknown): ImapErrorClass {
  if (isAuthFailure(err)) return 'auth';
  return looksLikeAuthFailure(describeConnectionError(err)) ? 'auth' : 'transient';
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

/** First re-check of a failing mailbox after a connection / server error. */
export const FAILING_RECHECK_BASE_MS = 60 * 60 * 1000;
/** First re-check after a refused login. Hours apart, because every check
 *  is another failed LOGIN on what is often a shared host running fail2ban
 *  (several workspaces' mailboxes live on one Plesk host; a ban of our IP
 *  there would take all of them down). */
export const FAILING_RECHECK_AUTH_BASE_MS = 6 * 60 * 60 * 1000;
/** Never wait longer than a day: a fixed server should not stay "failing". */
export const FAILING_RECHECK_CAP_MS = 24 * 60 * 60 * 1000;

/**
 * flow:F-04: how long a failing mailbox waits before the tick re-checks it.
 * The wait equals how long it has been failing, clamped to
 * [base, 24 h] — which doubles the interval between failed re-checks
 * without a counter: failing for 0 → wait 1 h; the re-check at 1 h fails →
 * wait 1 h (2 h in) → 2 h (4 h in) → 4 h → … → 24 h. A refused login
 * starts at 6 h. Same-age callers get the same answer, so a manual Test
 * again in between does not reset or shorten the schedule.
 */
export function failingRecheckDelayMs(failingForMs: number, auth: boolean): number {
  const base = auth ? FAILING_RECHECK_AUTH_BASE_MS : FAILING_RECHECK_BASE_MS;
  const age = Number.isFinite(failingForMs) ? Math.max(0, failingForMs) : 0;
  return Math.min(FAILING_RECHECK_CAP_MS, Math.max(base, age));
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
