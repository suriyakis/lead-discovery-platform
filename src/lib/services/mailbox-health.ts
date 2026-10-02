// PC-09 (I021, X7, I095) — mailbox health: the probe schedule, the incident
// and the tenant notifications. This module holds the rules; the probes
// that follow them live in services/mailbox-probes.ts (the mail.probe.tick)
// and the state changes in services/mailbox.ts (markMailboxFailing,
// recordMailboxConnectionCheck).
//
// Active mailboxes:
//   - a credential-free SMTP probe every PROBE_INTERVAL_MS (TCP, TLS,
//     EHLO, QUIT; no AUTH — lib/mail/probe.ts). A failed probe is retried
//     after ACTIVE_PROBE_RETRY_MS; ACTIVE_PROBE_FAILURES_TO_FAIL in a row
//     mark the mailbox failing ('connection'), so a blip pages nobody.
//   - one authenticated SMTP verify every SMTP_VERIFY_INTERVAL_MS. A
//     refused login (or an unclear error) marks it failing after that ONE
//     attempt; nothing logs in again until a person acts.
//
// Failing mailboxes recover by class (mailboxes.failure_class):
//   auth        never retried automatically (next_probe_at NULL). The
//               owner edits the settings (which schedules ONE recovery
//               check), clicks Test again or Reactivate.
//   connection  credential-free probes on a backoff from 30 min to 6 h;
//               once every configured host answers, ONE authenticated
//               check. It passing recovers the mailbox; it failing moves the
//               mailbox to that failure's class.
//   ambiguous   at most one authenticated attempt per AMBIGUOUS_RETRY_MS
//               and AMBIGUOUS_MAX_ATTEMPTS in total; then nothing until a
//               person acts.
// A mailbox that was failing before PC-09 (failure_class NULL) is never
// probed; the reviewed backfill (src/lib/remediation/mailbox-health-
// backfill.ts) raises its incident and leaves it unprobed.
//
// The incident. Every writer of 'failing' (an IMAP sync, Test again, a
// refused login at send time, a probe) raises one ops_event per mailbox
// (kind 'mailbox.failing', workspace scope, severity error — PC-08 alerts
// the platform owner on it) and notifies the workspace's owners and admins
// once (dedupe key = the incident's fingerprint, link to the fix). A
// recovery resolves both and tells the same people the mailbox is back
// online. Everything here is best-effort: recording an incident must never
// break the sync, the send or the check that found it.

import type { Mailbox, MailboxStatus } from '@/lib/db/schema/mailing';
import { formatUtc } from '@/lib/format-utc';
import type { MailboxFailureClass, MailProtocol } from '@/lib/mail/connection-errors';
import { notifyWorkspaceAdmins, resolveNotifications } from './notifications';
import { opsEventFingerprint, raiseOpsEvent, resolveOpsEvent } from './ops-events';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// ---- the schedule -----------------------------------------------------------

/** Credential-free SMTP probe of an active mailbox. */
export const PROBE_INTERVAL_MS = 30 * MINUTE;
/** Authenticated SMTP verify of an active mailbox. */
export const SMTP_VERIFY_INTERVAL_MS = 24 * HOUR;
/** A failed probe of an active mailbox is confirmed this much later … */
export const ACTIVE_PROBE_RETRY_MS = 5 * MINUTE;
/** … and this many failed probes in a row mark it failing. */
export const ACTIVE_PROBE_FAILURES_TO_FAIL = 2;
/** 'connection': the first recovery probe, doubling per failed probe … */
export const CONNECTION_BACKOFF_BASE_MS = 30 * MINUTE;
/** … up to this. */
export const CONNECTION_BACKOFF_CAP_MS = 6 * HOUR;
/** 'ambiguous': at most one authenticated attempt per this … */
export const AMBIGUOUS_RETRY_MS = 6 * HOUR;
/** … and at most this many in all (until a person acts). */
export const AMBIGUOUS_MAX_ATTEMPTS = 4;

/** Where the probe columns go next. */
export interface ProbeSchedule {
  nextProbeAt: Date | null;
  probeAttempts: number;
}

const after = (now: Date, ms: number) => new Date(now.getTime() + ms);

/**
 * The wait before the next credential-free probe of a 'connection'
 * mailbox, given how many probes have failed in a row since it started
 * failing: 0 → 30 min, 1 → 1 h, 2 → 2 h, 3 → 4 h, 4+ → 6 h.
 */
export function connectionBackoffMs(failedProbes: number): number {
  const n = Number.isFinite(failedProbes) ? Math.max(0, Math.floor(failedProbes)) : 0;
  return Math.min(CONNECTION_BACKOFF_CAP_MS, CONNECTION_BACKOFF_BASE_MS * 2 ** Math.min(n, 16));
}

/** The schedule of a mailbox that has just started failing in `cls`. */
export function initialFailingSchedule(cls: MailboxFailureClass, now: Date): ProbeSchedule {
  switch (cls) {
    case 'auth':
      return { nextProbeAt: null, probeAttempts: 0 };
    case 'connection':
      return { nextProbeAt: after(now, connectionBackoffMs(0)), probeAttempts: 0 };
    case 'ambiguous':
      return { nextProbeAt: after(now, AMBIGUOUS_RETRY_MS), probeAttempts: 0 };
  }
}

/**
 * The schedule after an AUTOMATIC recovery attempt failed with `result`.
 * `prior` is the mailbox before the attempt. An authenticated attempt that
 * comes back 'ambiguous' counts against the four; a 'connection' result
 * counts as one more failed probe; 'auth' stops everything.
 */
export function scheduleAfterFailedRecovery(
  prior: { failureClass: MailboxFailureClass | null; probeAttempts: number },
  result: MailboxFailureClass,
  now: Date,
): ProbeSchedule {
  switch (result) {
    case 'auth':
      return { nextProbeAt: null, probeAttempts: 0 };
    case 'connection': {
      const failed = prior.failureClass === 'connection' ? prior.probeAttempts + 1 : 1;
      return { nextProbeAt: after(now, connectionBackoffMs(failed)), probeAttempts: failed };
    }
    case 'ambiguous': {
      const attempts = prior.failureClass === 'ambiguous' ? prior.probeAttempts + 1 : 1;
      return {
        nextProbeAt: attempts >= AMBIGUOUS_MAX_ATTEMPTS ? null : after(now, AMBIGUOUS_RETRY_MS),
        probeAttempts: attempts,
      };
    }
  }
}

/** The schedule of an active mailbox whose probe passed. */
export function healthySchedule(now: Date): ProbeSchedule {
  return { nextProbeAt: after(now, PROBE_INTERVAL_MS), probeAttempts: 0 };
}

export type MailboxProbeRow = Pick<
  Mailbox,
  'status' | 'failureClass' | 'nextProbeAt' | 'probeAttempts' | 'smtpVerifiedAt'
>;

/**
 * What the probe tick does with a mailbox now:
 *   none     nothing is due (or nothing may be done automatically)
 *   probe    credential-free probe(s): an active mailbox's SMTP server, or
 *            every configured server of a 'connection' mailbox
 *   verify   the daily authenticated SMTP check of an active mailbox
 *   recheck  one authenticated SMTP + IMAP check of a failing mailbox
 *            ('ambiguous' within its budget, or a check an owner asked for
 *            by editing the settings — the only way an 'auth' or a
 *            pre-PC-09 mailbox gets a next_probe_at)
 */
export type ProbeAction = 'none' | 'probe' | 'verify' | 'recheck';

export function planMailboxProbe(m: MailboxProbeRow, now: Date): ProbeAction {
  if (m.status === 'active') {
    // next_probe_at paces both: the verify rides the first probe slot
    // after it falls due, and a failed one is retried on the 5-minute
    // confirmation slot, never sooner.
    const due = m.nextProbeAt === null || m.nextProbeAt.getTime() <= now.getTime();
    if (!due) return 'none';
    const verifyDue =
      m.smtpVerifiedAt === null || now.getTime() - m.smtpVerifiedAt.getTime() >= SMTP_VERIFY_INTERVAL_MS;
    return verifyDue ? 'verify' : 'probe';
  }
  if (m.status !== 'failing') return 'none';
  if (m.nextProbeAt === null || m.nextProbeAt.getTime() > now.getTime()) return 'none';
  if (m.failureClass === 'connection') return 'probe';
  if (m.failureClass === 'ambiguous' && m.probeAttempts >= AMBIGUOUS_MAX_ATTEMPTS) return 'none';
  return 'recheck';
}

/** The settings an owner edits that a recovery check is worth running for. */
export const CONNECTION_SETTING_FIELDS = [
  'smtpHost',
  'smtpPort',
  'smtpSecure',
  'smtpUser',
  'smtpPassword',
  'imap',
] as const;

/**
 * The probe columns after an owner saved new connection settings: a
 * failing mailbox gets one recovery check now (with a fresh budget), an
 * active one its authenticated verify now.
 */
export function scheduleAfterSettingsEdit(
  status: MailboxStatus,
  now: Date,
): Partial<Pick<Mailbox, 'nextProbeAt' | 'probeAttempts' | 'smtpVerifiedAt'>> {
  if (status === 'failing') return { nextProbeAt: now, probeAttempts: 0 };
  if (status === 'active') return { nextProbeAt: now, probeAttempts: 0, smtpVerifiedAt: null };
  return {};
}

// ---- the incident ------------------------------------------------------------

export const MAILBOX_FAILING_KIND = 'mailbox.failing';
/** `source` of the mailbox incidents (no tick resolves them: their own
 *  recovery does). */
export const MAILBOX_HEALTH_SOURCE = 'mailbox.health';

export function mailboxIncidentDedupeKey(mailboxId: bigint): string {
  return `mailbox:${mailboxId}`;
}

/** The mailbox's incident identity, also the tenant notification's dedupe key. */
export function mailboxFailingFingerprint(workspaceId: bigint, mailboxId: bigint): string {
  return opsEventFingerprint({
    scope: 'workspace',
    workspaceId,
    kind: MAILBOX_FAILING_KIND,
    dedupeKey: mailboxIncidentDedupeKey(mailboxId),
  });
}

/** Dedupe key of the 'back online' notification of one episode's end. */
export function mailboxRecoveredNoticeKey(workspaceId: bigint, mailboxId: bigint): string {
  return `${mailboxFailingFingerprint(workspaceId, mailboxId)}:recovered`;
}

/** flow:F-04's dedupe key, still on notifications raised before PC-09. */
export function legacyMailboxFailingKey(mailboxId: bigint): string {
  return `mailbox.failing:${mailboxId}`;
}

const CLASS_TITLE: Record<MailboxFailureClass, string> = {
  auth: 'the mail server refused the login',
  connection: 'the mail server could not be reached',
  ambiguous: 'the mail server gave an unclear error',
};

export interface MailboxIncidentInput {
  workspaceId: bigint;
  mailboxId: bigint;
  failureClass: MailboxFailureClass;
  protocol: MailProtocol;
  /** The stored error ("SMTP: …"); masked before it is stored. */
  lastError: string;
  nextProbeAt: Date | null;
  /** Raised by the PC-09 backfill for a mailbox failing since before. */
  backfill?: boolean;
}

/** Open (or count one more occurrence of) the mailbox's incident. The
 *  title names no mailbox or address: the platform owner reads it. */
export async function raiseMailboxFailingIncident(
  input: MailboxIncidentInput,
  now: Date = new Date(),
): Promise<{ opened: boolean } | null> {
  try {
    const raised = await raiseOpsEvent(
      {
        scope: 'workspace',
        workspaceId: input.workspaceId,
        kind: MAILBOX_FAILING_KIND,
        severity: 'error',
        source: MAILBOX_HEALTH_SOURCE,
        dedupeKey: mailboxIncidentDedupeKey(input.mailboxId),
        title: `A mailbox is failing: ${CLASS_TITLE[input.failureClass]}`,
        message: input.lastError,
        payload: {
          mailboxId: input.mailboxId.toString(),
          failureClass: input.failureClass,
          protocol: input.protocol,
          nextProbeAt: input.nextProbeAt?.toISOString() ?? null,
          ...(input.backfill ? { backfill: 'PC-09' } : {}),
        },
      },
      now,
    );
    return { opened: raised.opened };
  } catch (err) {
    console.error(
      `[mailbox-health] incident for mailbox ${input.mailboxId} not recorded:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * The failing episode is over (a passing check, Reactivate, pause,
 * archive): resolve the incident and mark the failing notifications read
 * (PC-09's key and flow:F-04's legacy one), so the next failure notifies
 * again. `resolvedBy` = the person who ended it (resolution 'manual').
 */
export async function endMailboxFailingIncident(
  workspaceId: bigint,
  mailboxId: bigint,
  options: { resolvedBy?: string | null } = {},
): Promise<void> {
  try {
    await resolveOpsEvent(mailboxFailingFingerprint(workspaceId, mailboxId), {
      resolution: options.resolvedBy ? 'manual' : 'auto',
      resolvedBy: options.resolvedBy ?? null,
    });
  } catch (err) {
    console.error(
      `[mailbox-health] incident of mailbox ${mailboxId} not resolved:`,
      err instanceof Error ? err.message : err,
    );
  }
  await resolveNotifications(workspaceId, mailboxFailingFingerprint(workspaceId, mailboxId));
  await resolveNotifications(workspaceId, legacyMailboxFailingKey(mailboxId));
}

/** Tell the owners / admins a failing mailbox works again. */
export async function notifyMailboxBackOnline(
  workspaceId: bigint,
  mailbox: Pick<Mailbox, 'id' | 'name'>,
): Promise<number> {
  const rows = await notifyWorkspaceAdmins(workspaceId, {
    kind: 'mailbox.recovered',
    title: `Mailbox "${mailbox.name}" is back online`,
    body: 'Its connection check passed: it sends and reads replies again, and its held emails and follow-ups go out on their schedule.',
    href: `/mailbox/${mailbox.id}`,
    dedupeKey: mailboxRecoveredNoticeKey(workspaceId, mailbox.id),
  });
  return rows.length;
}

/** A new failure makes an unread 'back online' notice stale. */
export async function clearBackOnlineNotice(workspaceId: bigint, mailboxId: bigint): Promise<void> {
  await resolveNotifications(workspaceId, mailboxRecoveredNoticeKey(workspaceId, mailboxId));
}

// ---- copy ----------------------------------------------------------------------

/**
 * What happens next to a failing mailbox, in one or two sentences — the
 * mailbox page, the notification and the health check say the same.
 */
export function describeRecoveryPlan(
  m: Pick<Mailbox, 'status' | 'failureClass' | 'nextProbeAt' | 'probeAttempts'>,
): string {
  if (m.status !== 'failing') return '';
  const next = m.nextProbeAt ? formatUtc(m.nextProbeAt) : null;
  switch (m.failureClass) {
    case 'auth':
      return next
        ? `One check runs after ${next} (the settings changed or a check was asked for); nothing else retries the login automatically.`
        :'Nothing retries the login automatically (repeated failed logins get our server blocked): fix the settings — saving them runs one check — or click Test again.';
    case 'connection':
      return next
        ? `A check that does not log in runs after ${next} (backing off to every 6 hours); once the server answers, one login is tried.`
        : 'Nothing re-checks it automatically: fix the settings or click Test again.';
    case 'ambiguous':
      return next
        ? `One login attempt runs after ${next} (${m.probeAttempts} of ${AMBIGUOUS_MAX_ATTEMPTS} automatic attempts used, 6 hours apart).`
        : `The ${AMBIGUOUS_MAX_ATTEMPTS} automatic attempts are used up: fix the settings — saving them runs one check — or click Test again.`;
    case null:
      return next
        ? `One check runs after ${next}.`
        : 'Nothing re-checks it automatically: fix the settings — saving them runs one check — or click Test again.';
  }
}
