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
 * PC-09: a mailbox that is already 'failing' is no longer the IMAP
 * tick's business (it syncs active mailboxes only); its recovery follows
 * its failure class in services/mailbox-health.ts. What stays here is the
 * backoff of an ACTIVE mailbox's sync and when a run of failed syncs
 * turns it failing.
 */

import {
  classifyMailboxFailure,
  describeConnectionError,
  isAuthFailure,
  looksLikeAuthFailure,
  type MailboxFailureClass,
} from '@/lib/mail/connection-errors';

export type ImapErrorClass = 'auth' | 'transient';

/** After this many CONSECUTIVE 'transient' failures (e.g. the generic
 *  imapflow "Command failed" with no auth signature), treat the
 *  mailbox as effectively dead and stop polling — same as an auth
 *  failure. The cap defeats slow-burn fail2ban risk for misconfigured
 *  mailboxes whose error text never tripped an AUTH signature.
 *  Tracked as imap_consecutive_failures in the schema. */
export const TRANSIENT_FAILURE_PAUSE_THRESHOLD = 10;

/** PC-09: an UNCLEAR sync error (no auth signature, no network cause —
 *  imapflow's bare "Command failed") may be a refused login in disguise,
 *  so it turns the mailbox failing ('ambiguous') after this many in a row
 *  instead of TRANSIENT_FAILURE_PAUSE_THRESHOLD: three logins 2 + 4
 *  minutes apart stay under a typical fail2ban limit (5 in 10 min). A
 *  network failure logs nothing in and keeps the longer threshold. */
export const AMBIGUOUS_FAILURE_PAUSE_THRESHOLD = 3;

/** PC-09: the recovery class of a failed sync (lib/mail/connection-errors.ts). */
export function classifySyncFailure(err: unknown): MailboxFailureClass {
  return classifyImapError(err) === 'auth' ? 'auth' : classifyMailboxFailure({ error: err });
}

/** How many failed syncs in a row of this class turn an active mailbox
 *  failing (a refused login: the first). */
export function syncFailureThreshold(cls: MailboxFailureClass): number {
  switch (cls) {
    case 'auth':
      return 1;
    case 'ambiguous':
      return AMBIGUOUS_FAILURE_PAUSE_THRESHOLD;
    case 'connection':
      return TRANSIENT_FAILURE_PAUSE_THRESHOLD;
  }
}

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
