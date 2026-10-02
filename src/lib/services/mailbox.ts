// Mailbox service. CRUD on the mailboxes table, secret-key wiring through
// workspace_secrets, connection testing, and a builder that hands the
// outreach service a ready IMailProvider per mailbox.

import { and, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db/client';
import {
  mailboxes,
  type Mailbox,
  type MailboxStatus,
  type NewMailbox,
} from '@/lib/db/schema/mailing';
import { recordAuditEvent, recordSystemAuditEvent } from './audit';
import {
  clearBackOnlineNotice,
  describeRecoveryPlan,
  endMailboxFailingIncident,
  healthySchedule,
  initialFailingSchedule,
  legacyMailboxFailingKey,
  mailboxFailingFingerprint,
  notifyMailboxBackOnline,
  raiseMailboxFailingIncident,
  scheduleAfterFailedRecovery,
  scheduleAfterSettingsEdit,
  type ProbeSchedule,
} from './mailbox-health';
import { notifyWorkspaceAdmins, resolveNotifications, type NotifyInput } from './notifications';
import {
  canAdminWorkspace,
  canWrite,
  isAutomatic,
  type WorkspaceContext,
} from './context';
import { deleteSecret, getSecret, setSecret } from './secrets';
import { describeLeaseHolder, withWorkLease } from './work-leases';
import {
  createMailProvider,
  type ConnectionCheck,
  type ConnectionTestResult,
  type IMailProvider,
  type MailboxConfig,
} from '@/lib/mail';
import {
  adviseConnectionFailure,
  classifyMailboxFailure,
  describeConnectionError,
  isAuthFailure,
  parseStoredMailboxError,
  type MailboxFailureClass,
  type MailProtocol,
} from '@/lib/mail/connection-errors';

export class MailboxServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'MailboxServiceError';
    this.code = code;
  }
}

const permissionDenied = (op: string) =>
  new MailboxServiceError(`Permission denied: ${op}`, 'permission_denied');
const notFound = () => new MailboxServiceError('mailbox not found', 'not_found');
const invariant = (msg: string) =>
  new MailboxServiceError(msg, 'invariant_violation');
const invalid = (msg: string) =>
  new MailboxServiceError(msg, 'invalid_input');

// ---- create / update -----------------------------------------------

export interface CreateMailboxInput {
  name: string;
  fromAddress: string;
  fromName?: string | null;
  replyTo?: string | null;
  smtpHost: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser: string;
  /** Cleartext password — encrypted into workspace_secrets, never stored on the row. */
  smtpPassword: string;
  imap?: {
    host: string;
    port?: number;
    secure?: boolean;
    user: string;
    password: string;
    folder?: string;
  } | null;
  isDefault?: boolean;
}

export async function createMailbox(
  ctx: WorkspaceContext,
  input: CreateMailboxInput,
): Promise<Mailbox> {
  if (!canWrite(ctx)) throw permissionDenied('mailbox.create');

  // Plan ceiling — count-then-insert, same non-transactional tradeoff
  // as product profiles.
  const existingRows = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(eq(mailboxes.workspaceId, ctx.workspaceId));
  const { assertCanAddMailbox } = await import('./plan-limits');
  await assertCanAddMailbox(ctx, existingRows.length);

  const fromAddress = normalizeAddress(input.fromAddress);
  if (!isValidEmail(fromAddress)) throw invalid('invalid fromAddress');
  if (!input.smtpHost.trim() || !input.smtpUser.trim() || !input.smtpPassword) {
    throw invalid('smtp host/user/password required');
  }
  if (input.imap) {
    if (!input.imap.host.trim() || !input.imap.user.trim() || !input.imap.password) {
      throw invalid('imap host/user/password required when imap is set');
    }
  }

  // Ensure only one default per workspace.
  if (input.isDefault) {
    await db
      .update(mailboxes)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(
        and(
          eq(mailboxes.workspaceId, ctx.workspaceId),
          eq(mailboxes.isDefault, true),
        ),
      );
  }

  // Reserve secret keys via a per-mailbox slot id. The secrets layer
  // requires keys of the form `<lowercase-scope>.<field>` so we cannot
  // embed the email address verbatim — use a 12-char hex slot per mailbox.
  const slot = randomUUID().replace(/-/g, '').slice(0, 12);
  const smtpSecretKey = `mailbox.smtpPassword_${slot}`;
  const imapSecretKey = input.imap ? `mailbox.imapPassword_${slot}` : null;

  await setSecret(ctx, smtpSecretKey, input.smtpPassword);
  if (imapSecretKey && input.imap) {
    await setSecret(ctx, imapSecretKey, input.imap.password);
  }

  const row: NewMailbox = {
    workspaceId: ctx.workspaceId,
    name: input.name.trim() || fromAddress,
    fromAddress,
    fromName: input.fromName?.trim() || null,
    replyTo: input.replyTo ? normalizeAddress(input.replyTo) : null,
    smtpHost: input.smtpHost.trim(),
    smtpPort: input.smtpPort ?? 587,
    smtpSecure: input.smtpSecure ?? false,
    smtpUser: input.smtpUser.trim(),
    smtpPasswordSecretKey: smtpSecretKey,
    imapHost: input.imap?.host.trim() ?? null,
    imapPort: input.imap?.port ?? (input.imap ? 993 : null),
    imapSecure: input.imap?.secure ?? true,
    imapUser: input.imap?.user.trim() ?? null,
    imapPasswordSecretKey: imapSecretKey,
    imapFolder: input.imap?.folder?.trim() || 'INBOX',
    status: 'active',
    isDefault: input.isDefault ?? false,
    createdBy: ctx.userId,
  };

  const [created] = await db.insert(mailboxes).values(row).returning();
  if (!created) throw invariant('mailbox insert returned no row');

  await recordAuditEvent(ctx, {
    kind: 'mailbox.create',
    entityType: 'mailbox',
    entityId: created.id,
    payload: {
      fromAddress,
      smtpHost: created.smtpHost,
      imapHost: created.imapHost,
    },
  });

  return created;
}

export interface UpdateMailboxInput {
  name?: string;
  fromName?: string | null;
  replyTo?: string | null;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPassword?: string;
  imap?: {
    host: string;
    port?: number;
    secure?: boolean;
    user: string;
    password?: string;
    folder?: string;
  } | null;
  status?: MailboxStatus;
  isDefault?: boolean;
}

export async function updateMailbox(
  ctx: WorkspaceContext,
  id: bigint,
  input: UpdateMailboxInput,
): Promise<Mailbox> {
  if (!canWrite(ctx)) throw permissionDenied('mailbox.update');
  const existing = await loadMailbox(ctx, id);
  const updates: Partial<Mailbox> & { updatedAt: Date } = { updatedAt: new Date() };

  if (input.name !== undefined) updates.name = input.name.trim() || existing.name;
  if (input.fromName !== undefined) updates.fromName = input.fromName?.trim() || null;
  if (input.replyTo !== undefined) {
    updates.replyTo = input.replyTo ? normalizeAddress(input.replyTo) : null;
  }
  if (input.smtpHost !== undefined) updates.smtpHost = input.smtpHost.trim();
  if (input.smtpPort !== undefined) updates.smtpPort = input.smtpPort;
  if (input.smtpSecure !== undefined) updates.smtpSecure = input.smtpSecure;
  if (input.smtpUser !== undefined) updates.smtpUser = input.smtpUser.trim();
  if (input.smtpPassword !== undefined && input.smtpPassword) {
    await setSecret(ctx, existing.smtpPasswordSecretKey, input.smtpPassword);
  }
  if (input.imap === null) {
    updates.imapHost = null;
    updates.imapPort = null;
    updates.imapUser = null;
    updates.imapPasswordSecretKey = null;
  } else if (input.imap !== undefined) {
    updates.imapHost = input.imap.host.trim();
    updates.imapPort = input.imap.port ?? 993;
    updates.imapSecure = input.imap.secure ?? true;
    updates.imapUser = input.imap.user.trim();
    updates.imapFolder = input.imap.folder?.trim() || 'INBOX';
    if (!existing.imapPasswordSecretKey) {
      const slot = randomUUID().replace(/-/g, '').slice(0, 12);
      updates.imapPasswordSecretKey = `mailbox.imapPassword_${slot}`;
    }
    if (input.imap.password) {
      const key = updates.imapPasswordSecretKey ?? existing.imapPasswordSecretKey;
      if (key) await setSecret(ctx, key, input.imap.password);
    }
  }
  const now = updates.updatedAt;
  if (input.status !== undefined) {
    updates.status = input.status;
    if (input.status !== 'failing') Object.assign(updates, NOT_FAILING);
    // Back in service (from paused): its health probe runs next tick.
    if (input.status === 'active' && existing.status !== 'active') updates.nextProbeAt = now;
  }
  // PC-09: new connection settings get checked — a failing mailbox gets ONE
  // recovery check (an 'auth' one is otherwise never retried), an active
  // one its authenticated verify, both at the next probe tick.
  const recoveryCheck = connectionSettingsChanged(existing, input);
  if (recoveryCheck) {
    Object.assign(updates, scheduleAfterSettingsEdit(updates.status ?? existing.status, now));
  }
  if (input.isDefault === true) {
    await db
      .update(mailboxes)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(
        and(
          eq(mailboxes.workspaceId, ctx.workspaceId),
          eq(mailboxes.isDefault, true),
        ),
      );
    updates.isDefault = true;
  } else if (input.isDefault === false) {
    updates.isDefault = false;
  }

  const [updated] = await db
    .update(mailboxes)
    .set(updates)
    .where(
      and(
        eq(mailboxes.workspaceId, ctx.workspaceId),
        eq(mailboxes.id, id),
      ),
    )
    .returning();
  if (!updated) throw invariant('mailbox update returned no row');

  await recordAuditEvent(ctx, {
    kind: 'mailbox.update',
    entityType: 'mailbox',
    entityId: id,
    ...(recoveryCheck ? { payload: { connectionSettingsChanged: true, checkScheduledFor: now.toISOString() } } : {}),
  });
  if (existing.status === 'failing' && updated.status !== 'failing') {
    await endMailboxFailingIncident(ctx.workspaceId, id, { resolvedBy: ctx.userId });
  }

  return updated;
}

/** PC-09: did this edit change how we connect or log in? (The edit form
 *  re-submits every field, so compare with the row; a password is a
 *  change whenever one is given.) */
function connectionSettingsChanged(existing: Mailbox, input: UpdateMailboxInput): boolean {
  if (input.smtpHost !== undefined && input.smtpHost.trim() !== existing.smtpHost) return true;
  if (input.smtpPort !== undefined && input.smtpPort !== existing.smtpPort) return true;
  if (input.smtpSecure !== undefined && input.smtpSecure !== existing.smtpSecure) return true;
  if (input.smtpUser !== undefined && input.smtpUser.trim() !== existing.smtpUser) return true;
  if (input.smtpPassword) return true;
  if (input.imap === null) return existing.imapHost !== null;
  if (input.imap !== undefined) {
    if (existing.imapHost === null) return true;
    if (input.imap.host.trim() !== existing.imapHost) return true;
    if ((input.imap.port ?? 993) !== existing.imapPort) return true;
    if ((input.imap.secure ?? true) !== existing.imapSecure) return true;
    if (input.imap.user.trim() !== existing.imapUser) return true;
    if ((input.imap.folder?.trim() || 'INBOX') !== existing.imapFolder) return true;
    if (input.imap.password) return true;
  }
  return false;
}

export async function archiveMailbox(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<Mailbox> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('mailbox.archive');
  const existing = await loadMailbox(ctx, id);
  if (existing.status === 'archived') return existing;
  const [updated] = await db
    .update(mailboxes)
    .set({ status: 'archived', isDefault: false, ...NOT_FAILING, updatedAt: new Date() })
    .where(
      and(
        eq(mailboxes.workspaceId, ctx.workspaceId),
        eq(mailboxes.id, id),
      ),
    )
    .returning();
  if (!updated) throw invariant('mailbox archive returned no row');
  await recordAuditEvent(ctx, {
    kind: 'mailbox.archive',
    entityType: 'mailbox',
    entityId: id,
  });
  if (existing.status === 'failing') {
    await endMailboxFailingIncident(ctx.workspaceId, id, { resolvedBy: ctx.userId });
  }
  return updated;
}

/**
 * Permanent delete. Archived-first so the operator has had a chance to
 * back out (mirrors the workspace delete flow). Cascading FKs sweep the
 * mailbox's mail history (messages, threads, sync state) with it, and
 * the SMTP/IMAP credential secrets are removed from workspace_secrets.
 * The audit event is written BEFORE the delete so the trail still
 * carries the doomed id and address.
 */
export async function deleteMailbox(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<void> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('mailbox.delete');
  const existing = await loadMailbox(ctx, id);
  if (existing.status !== 'archived') {
    throw new MailboxServiceError(
      'archive the mailbox before deleting it permanently',
      'invalid_state',
    );
  }
  // Credentials first — best-effort, a missing secret row must never
  // block the delete.
  try {
    await deleteSecret(ctx, existing.smtpPasswordSecretKey);
  } catch (err) {
    console.error('[mailbox.delete] smtp secret cleanup failed:', err);
  }
  if (existing.imapPasswordSecretKey) {
    try {
      await deleteSecret(ctx, existing.imapPasswordSecretKey);
    } catch (err) {
      console.error('[mailbox.delete] imap secret cleanup failed:', err);
    }
  }
  await recordAuditEvent(ctx, {
    kind: 'mailbox.delete',
    entityType: 'mailbox',
    entityId: id,
    payload: { fromAddress: existing.fromAddress },
  });
  await db
    .delete(mailboxes)
    .where(and(eq(mailboxes.workspaceId, ctx.workspaceId), eq(mailboxes.id, id)));
}

/**
 * Phase 51: bring a `failing` mailbox back to `active` without a check.
 * Resets the consecutive-failure counter and the sync gate and wipes the
 * stored lastError. flow:F-04 / PC-09: ends the failing episode (the
 * incident is resolved by this person, the notifications are marked
 * read, so a new failure notifies again) and asks the probe tick for the
 * authenticated SMTP verify now: a mailbox reactivated with the same bad
 * password is caught by that one login, not by a stream of syncs.
 */
export async function reactivateMailbox(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<Mailbox> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('mailbox.reactivate');
  const existing = await loadMailbox(ctx, id);
  if (existing.status === 'archived') {
    throw new MailboxServiceError(
      'cannot reactivate an archived mailbox — un-archive first',
      'invalid_state',
    );
  }
  const now = new Date();
  const [updated] = await db
    .update(mailboxes)
    .set({
      status: 'active',
      imapConsecutiveFailures: 0,
      imapNextSyncAfter: null,
      imapEmptySyncs: 0,
      lastError: null,
      lastErrorAt: null,
      failingSince: null,
      failureClass: null,
      nextProbeAt: now,
      probeAttempts: 0,
      smtpVerifiedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(mailboxes.workspaceId, ctx.workspaceId),
        eq(mailboxes.id, id),
      ),
    )
    .returning();
  if (!updated) throw invariant('mailbox reactivate returned no row');
  await recordAuditEvent(ctx, {
    kind: 'mailbox.reactivate',
    entityType: 'mailbox',
    entityId: id,
  });
  await endMailboxFailingIncident(ctx.workspaceId, id, { resolvedBy: ctx.userId });
  return updated;
}

/**
 * Operator-driven pause: flips an `active` or `failing` mailbox to
 * `paused`. While paused, neither the IMAP tick nor the health probes
 * touch it and `mail.sendMessage` refuses to send through it.
 * The pause is sticky until the operator re-enables. Counters and
 * lastError are preserved so a later Reactivate still has the
 * forensic trail.
 */
export async function pauseMailbox(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<Mailbox> {
  if (!canWrite(ctx)) throw permissionDenied('mailbox.pause');
  const existing = await loadMailbox(ctx, id);
  if (existing.status === 'archived') {
    throw new MailboxServiceError(
      'cannot pause an archived mailbox',
      'invalid_state',
    );
  }
  if (existing.status === 'paused') return existing;
  const [updated] = await db
    .update(mailboxes)
    .set({
      status: 'paused',
      ...NOT_FAILING,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mailboxes.workspaceId, ctx.workspaceId),
        eq(mailboxes.id, id),
      ),
    )
    .returning();
  if (!updated) throw invariant('mailbox pause returned no row');
  await recordAuditEvent(ctx, {
    kind: 'mailbox.pause',
    entityType: 'mailbox',
    entityId: id,
  });
  // A paused mailbox is not probed or alarmed about; the operator has
  // taken it out of service, so the failing episode is over.
  if (existing.status === 'failing') {
    await endMailboxFailingIncident(ctx.workspaceId, id, { resolvedBy: ctx.userId });
  }
  return updated;
}

/** The PC-09 columns of a mailbox that is not failing (the CHECK on
 *  failure_class). failing_since and lastError stay as the forensic trail. */
const NOT_FAILING = {
  failureClass: null,
  nextProbeAt: null,
  probeAttempts: 0,
} as const;

// ---- failure lifecycle (flow:F-04, flow:F-05, PC-09) ----------------
//
//   active ──markMailboxFailing(class)──▶ failing ──passing check──▶ active
//                                          │   ▲
//                                          └───┘ a failed check: the class
//                                                and the probe schedule
//
// One way in: markMailboxFailing, from an IMAP sync (a refused login, or
// too many failures in a row), a failed Test again, a refused login at
// send time (flow:F-05) and the health probes (services/mailbox-probes.ts).
// It classifies the failure (auth / connection / ambiguous —
// lib/mail/connection-errors.ts) and sets the probe schedule for that
// class (services/mailbox-health.ts). While 'failing', nothing reads its
// inbox (the IMAP tick only syncs active mailboxes), the outreach queue
// and follow-ups hold its mail, one ops_event is open for it (PC-08
// alerts the platform owner) and its owners / admins have one
// notification. It leaves 'failing' through a passing check (a probe,
// Test again, a manual Sync — all recordMailboxConnectionCheck),
// Reactivate, pause or archive; each ends the episode
// (endMailboxFailingIncident), and a passing check also says it is back
// online.

/** Dedupe key of a mailbox's 'mailbox.failing' notification: PC-09 uses
 *  the incident's fingerprint (each admin's copy appends adminDedupeKey's
 *  ':user:<id>'). */
export function mailboxFailingDedupeKey(workspaceId: bigint, mailboxId: bigint): string {
  return mailboxFailingFingerprint(workspaceId, mailboxId);
}

export interface MailboxFailure {
  /** Which side failed; prefixes lastError ("SMTP: …" / "IMAP: …") the
   *  same way testMailboxConnection does. */
  protocol: MailProtocol;
  /** The server's / library's message (describeConnectionError output). */
  message: string;
  /** PC-09: the recovery class. Default: 'auth' when `auth` is set, else
   *  classifyMailboxFailure(message). */
  failureClass?: MailboxFailureClass;
  /** The server refused our credentials (shorthand for failureClass 'auth'). */
  auth?: boolean;
  /** When the error happened (lastErrorAt); defaults to now. */
  occurredAt?: Date;
  /** Consecutive failed checks to store (IMAP syncs / re-checks). Left
   *  unchanged when omitted (a send-time failure is not an IMAP check). */
  consecutiveFailures?: number;
  /** PC-09: the probe columns to write — an automatic recovery attempt
   *  computes them (scheduleAfterFailedRecovery). Default: a mailbox
   *  entering 'failing' or changing class starts that class's schedule
   *  (initialFailingSchedule); a repeat in the same class keeps it, so a
   *  manual Test again neither resets nor spends the automatic budget. */
  schedule?: ProbeSchedule;
  /** The clock (tests; the probe tick passes its own). */
  now?: Date;
}

export interface MarkMailboxFailingResult {
  /** False when the mailbox is paused / archived / gone — left untouched. */
  marked: boolean;
  /** True when this call created the (deduped) notification. */
  notified: boolean;
  /** The class it is failing with (null when not marked). */
  failureClass: MailboxFailureClass | null;
  /** When the probe tick looks at it next; null = nothing retries it
   *  automatically (or not marked). */
  nextProbeAt: Date | null;
}

/** What a failing mailbox stops doing — the same words on the
 *  notification, the mailbox page and the health check. */
export function failingMailboxImpact(protocol: MailProtocol): string {
  return protocol === 'smtp'
    ? 'Nothing can be sent from it, replies to it are not read, and its queued outreach and ' +
        'follow-ups are held. No recipient was suppressed.'
    : 'Replies to it are not read, and its queued outreach and follow-ups are held until it works again.';
}

export interface MailboxFailureSummary {
  protocol: MailProtocol;
  /** failingMailboxImpact(protocol). */
  impact: string;
  /** The operator's next step (adviseConnectionFailure). */
  advice: string;
  /** PC-09: what the probes do next (describeRecoveryPlan). */
  recovery: string;
}

/** Explain a mailbox's stored lastError: which side, what it stops, what
 *  to do, and what happens on its own. */
export function summarizeMailboxFailure(
  mailbox: Pick<
    Mailbox,
    | 'lastError'
    | 'smtpHost'
    | 'smtpPort'
    | 'imapHost'
    | 'imapPort'
    | 'status'
    | 'failureClass'
    | 'nextProbeAt'
    | 'probeAttempts'
  >,
): MailboxFailureSummary {
  const { protocol, message } = parseStoredMailboxError(mailbox.lastError);
  return {
    protocol,
    impact: failingMailboxImpact(protocol),
    advice: adviseConnectionFailure(protocol, message, mailbox),
    recovery: describeRecoveryPlan(mailbox),
  };
}

/** How much of the server's error text the notification quotes; the
 *  mailbox page shows all of it. */
const NOTICE_ERROR_EXCERPT = 200;

function failingNotice(mailbox: Mailbox): Omit<NotifyInput, 'userId'> {
  const summary = summarizeMailboxFailure(mailbox);
  const error = mailbox.lastError ?? 'unknown';
  const excerpt =
    error.length > NOTICE_ERROR_EXCERPT ? `${error.slice(0, NOTICE_ERROR_EXCERPT - 1)}…` : error;
  return {
    kind: 'mailbox.failing',
    title: `Mailbox "${mailbox.name}" is failing`,
    body: `${summary.impact} ${summary.advice} ${summary.recovery} Last error — ${excerpt}`,
    // The mailbox page's fix panel: the advice, Edit settings, Test again.
    href: `/mailbox/${mailbox.id}#fix`,
    dedupeKey: mailboxFailingDedupeKey(mailbox.workspaceId, mailbox.id),
  };
}

function storedError(protocol: MailProtocol, message: string): string {
  return `${protocol === 'smtp' ? 'SMTP' : 'IMAP'}: ${message}`.slice(0, 2000);
}

/**
 * Mark a mailbox as failing after a connection / credential failure that
 * is ours, not a recipient's (see the lifecycle above). Sets status
 * 'failing', lastError + lastErrorAt, failing_since (kept while it stays
 * failing), the failure class and its probe schedule.
 *
 * PC-09: raises the mailbox's incident on every call (repeats count as
 * occurrences of the open one) and notifies the workspace owners / admins
 * when the episode starts or its class changes — a repeat in the same
 * class only counts. A paused or archived mailbox keeps its status: those
 * are operator decisions and nothing is sent through them anyway.
 */
export async function markMailboxFailing(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
  mailboxId: bigint,
  failure: MailboxFailure,
): Promise<MarkMailboxFailingResult> {
  const now = failure.now ?? new Date();
  const lastError = storedError(failure.protocol, failure.message);
  const notMarked: MarkMailboxFailingResult = {
    marked: false,
    notified: false,
    failureClass: null,
    nextProbeAt: null,
  };

  const prior = (
    await db
      .select()
      .from(mailboxes)
      .where(and(eq(mailboxes.workspaceId, ctx.workspaceId), eq(mailboxes.id, mailboxId)))
      .limit(1)
  )[0];
  if (!prior || (prior.status !== 'active' && prior.status !== 'failing')) return notMarked;

  const wasFailing = prior.status === 'failing';
  const failingSince = wasFailing && prior.failingSince ? prior.failingSince : now;
  const failureClass: MailboxFailureClass =
    failure.failureClass ??
    (failure.auth ? 'auth' : classifyMailboxFailure({ message: failure.message }));
  const classChanged = !wasFailing || prior.failureClass !== failureClass;
  const schedule: ProbeSchedule =
    failure.schedule ??
    (classChanged
      ? initialFailingSchedule(failureClass, now)
      : { nextProbeAt: prior.nextProbeAt, probeAttempts: prior.probeAttempts });

  const [updated] = await db
    .update(mailboxes)
    .set({
      status: 'failing',
      lastError,
      lastErrorAt: failure.occurredAt ?? now,
      failingSince,
      failureClass,
      nextProbeAt: schedule.nextProbeAt,
      probeAttempts: schedule.probeAttempts,
      ...(failure.consecutiveFailures !== undefined
        ? { imapConsecutiveFailures: failure.consecutiveFailures }
        : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(mailboxes.workspaceId, ctx.workspaceId),
        eq(mailboxes.id, mailboxId),
        inArray(mailboxes.status, ['active', 'failing']),
      ),
    )
    .returning();
  if (!updated) return notMarked;

  if (classChanged) {
    await recordAuditEvent(ctx, {
      kind: 'mailbox.marked_failing',
      entityType: 'mailbox',
      entityId: mailboxId,
      payload: {
        protocol: failure.protocol,
        lastError,
        failureClass,
        priorStatus: prior.status,
        priorFailureClass: prior.failureClass,
        nextProbeAt: schedule.nextProbeAt?.toISOString() ?? null,
      },
    });
  }

  await raiseMailboxFailingIncident(
    {
      workspaceId: ctx.workspaceId,
      mailboxId,
      failureClass,
      protocol: failure.protocol,
      lastError,
      nextProbeAt: schedule.nextProbeAt,
    },
    now,
  );

  let notified = false;
  if (classChanged) {
    await clearBackOnlineNotice(ctx.workspaceId, mailboxId);
    // A class change replaces the unread notice with one that says what
    // is wrong now (the dedupe index would drop the new one otherwise).
    if (wasFailing) {
      await resolveNotifications(ctx.workspaceId, mailboxFailingDedupeKey(ctx.workspaceId, mailboxId));
      await resolveNotifications(ctx.workspaceId, legacyMailboxFailingKey(mailboxId));
    }
    const rows = await notifyWorkspaceAdmins(ctx.workspaceId, failingNotice(updated));
    notified = rows.length > 0;
  }
  return { marked: true, notified, failureClass, nextProbeAt: schedule.nextProbeAt };
}

/**
 * A passing check on a failing mailbox: back to active, counters, the
 * sync gate and the class cleared, the next probe on the normal cadence
 * and smtp_verified_at stamped (every check that recovers logged in to
 * SMTP), the episode ended (incident resolved, notifications read) and
 * the owners / admins told it is back online. Returns the row, or null
 * when it was not failing (nothing changed).
 */
async function markMailboxRecovered(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId' | 'trigger'>,
  mailbox: Mailbox,
  now: Date,
): Promise<Mailbox | null> {
  const schedule = healthySchedule(now);
  const [row] = await db
    .update(mailboxes)
    .set({
      status: 'active',
      imapConsecutiveFailures: 0,
      imapNextSyncAfter: null,
      imapEmptySyncs: 0,
      lastError: null,
      lastErrorAt: null,
      failingSince: null,
      failureClass: null,
      nextProbeAt: schedule.nextProbeAt,
      probeAttempts: schedule.probeAttempts,
      smtpVerifiedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(mailboxes.workspaceId, ctx.workspaceId),
        eq(mailboxes.id, mailbox.id),
        eq(mailboxes.status, 'failing'),
      ),
    )
    .returning();
  if (!row) return null;
  await recordAuditEvent(ctx, {
    kind: 'mailbox.recovered',
    entityType: 'mailbox',
    entityId: mailbox.id,
    payload: {
      failingSince: mailbox.failingSince?.toISOString() ?? null,
      lastError: mailbox.lastError,
      failureClass: mailbox.failureClass,
      by: isAutomatic(ctx) ? 'probe' : 'check',
    },
  });
  // The check passing resolved it, whoever started the check.
  await endMailboxFailingIncident(ctx.workspaceId, mailbox.id);
  await notifyMailboxBackOnline(ctx.workspaceId, row);
  return row;
}

/** provider.testConnection() that never throws: a thrown error becomes a
 *  failed SMTP check (the side tested first). */
export async function runConnectionTest(provider: IMailProvider): Promise<ConnectionTestResult> {
  try {
    return await provider.testConnection();
  } catch (err) {
    return {
      smtp: {
        ok: false,
        detail: describeConnectionError(err),
        authFailed: isAuthFailure(err),
        failureClass: classifyMailboxFailure({ error: err }),
      },
      imap: null,
    };
  }
}

/** The recovery class of one failed side of a check. */
export function checkFailureClass(check: ConnectionCheck): MailboxFailureClass {
  if (check.authFailed) return 'auth';
  return check.failureClass ?? classifyMailboxFailure({ message: check.detail ?? '' });
}

export interface MailboxCheckOutcome {
  /** SMTP passed and IMAP passed or is not configured. */
  ok: boolean;
  /** A failing mailbox went back to active. */
  recovered: boolean;
  /** The stored error when !ok ("SMTP: …" / "IMAP: …"). */
  lastError: string | null;
  /** A new mailbox.failing notification was raised. */
  notified: boolean;
  /** The class of the failure when !ok. */
  failureClass: MailboxFailureClass | null;
  /** When the probe tick looks at it next after a failure (null when ok,
   *  not marked, or nothing retries it automatically). */
  nextProbeAt: Date | null;
}

/**
 * Record the result of a full (authenticated SMTP + IMAP) connection check
 * — Test again, a manual Sync of a failing mailbox, a recovery check of
 * the probe tick. A pass recovers a failing mailbox and clears a healthy
 * one's stale error (and stamps smtp_verified_at); a paused / archived one
 * keeps its status either way. A failure goes through markMailboxFailing
 * (SMTP is reported first when both fail).
 *
 * PC-09: `automatic` (the probe tick) moves the probe schedule on
 * (scheduleAfterFailedRecovery, from the row as the caller read it under
 * the mailbox lease); a person's check leaves the automatic schedule and
 * budget as they were unless the class changed.
 */
export async function recordMailboxConnectionCheck(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId' | 'trigger'>,
  mailbox: Mailbox,
  result: ConnectionTestResult,
  options: { consecutiveFailures?: number; automatic?: boolean; now?: Date } = {},
): Promise<MailboxCheckOutcome> {
  const now = options.now ?? new Date();
  const ok = result.smtp.ok && (result.imap === null || result.imap.ok);
  const scope = and(eq(mailboxes.workspaceId, ctx.workspaceId), eq(mailboxes.id, mailbox.id));

  if (ok) {
    if (mailbox.status === 'failing') {
      const row = await markMailboxRecovered(ctx, mailbox, now);
      return {
        ok,
        recovered: row !== null,
        lastError: null,
        notified: false,
        failureClass: null,
        nextProbeAt: null,
      };
    }
    await db
      .update(mailboxes)
      .set(
        mailbox.status === 'active'
          ? {
              lastError: null,
              lastErrorAt: null,
              imapConsecutiveFailures: 0,
              imapNextSyncAfter: null,
              smtpVerifiedAt: now,
              updatedAt: now,
            }
          : { lastError: null, lastErrorAt: null, smtpVerifiedAt: now, updatedAt: now },
      )
      .where(scope);
    return { ok, recovered: false, lastError: null, notified: false, failureClass: null, nextProbeAt: null };
  }

  const failedSide: { protocol: MailProtocol; check: ConnectionCheck } = !result.smtp.ok
    ? { protocol: 'smtp', check: result.smtp }
    : { protocol: 'imap', check: result.imap! };
  const message = failedSide.check.detail?.trim() || 'failed';
  const failureClass = checkFailureClass(failedSide.check);
  const marked = await markMailboxFailing(ctx, mailbox.id, {
    protocol: failedSide.protocol,
    message,
    failureClass,
    consecutiveFailures: options.consecutiveFailures,
    schedule: options.automatic
      ? scheduleAfterFailedRecovery(
          mailbox.status === 'failing'
            ? { failureClass: mailbox.failureClass, probeAttempts: mailbox.probeAttempts }
            : { failureClass: null, probeAttempts: 0 },
          failureClass,
          now,
        )
      : undefined,
    now,
  });
  const lastError = storedError(failedSide.protocol, message);
  if (!marked.marked) {
    // Paused / archived: keep the operator's status, still show the result.
    await db
      .update(mailboxes)
      .set({ lastError, lastErrorAt: now, updatedAt: now })
      .where(scope);
  }
  return {
    ok,
    recovered: false,
    lastError,
    notified: marked.notified,
    failureClass: marked.failureClass ?? failureClass,
    nextProbeAt: marked.nextProbeAt,
  };
}

/**
 * PC-09 backfill (src/lib/remediation/mailbox-health-backfill.ts): a
 * mailbox that was failing before PC-09 (failure_class NULL) gets its
 * class, its incident and its owners' / admins' notification — after the
 * owner reviewed the dry run. It is NOT scheduled for probing
 * (next_probe_at stays NULL): it waits for a person (Edit settings, Test
 * again, Reactivate). No network. Returns tracked: false when the row is
 * no longer an untracked failing mailbox.
 *
 * A system writer (a reviewed remediation script, nobody acting in the
 * workspace): its audit row is a system event (user_id NULL, payload
 * actor 'system', backfill 'PC-09'), like the reaper's — never filed
 * under the workspace owner.
 */
export async function trackPreexistingFailingMailbox(
  workspaceId: bigint,
  mailboxId: bigint,
  now: Date = new Date(),
): Promise<{ tracked: boolean; failureClass: MailboxFailureClass | null; notified: boolean }> {
  const [row] = await db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.id, mailboxId)))
    .limit(1);
  if (!row || row.status !== 'failing' || row.failureClass !== null) {
    return { tracked: false, failureClass: null, notified: false };
  }
  const stored = parseStoredMailboxError(row.lastError);
  const failureClass = classifyMailboxFailure({ message: stored.message });
  const [updated] = await db
    .update(mailboxes)
    .set({
      failureClass,
      failingSince: row.failingSince ?? row.lastErrorAt ?? row.updatedAt,
      nextProbeAt: null,
      probeAttempts: 0,
      updatedAt: now,
    })
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        eq(mailboxes.id, mailboxId),
        eq(mailboxes.status, 'failing'),
        isNull(mailboxes.failureClass),
      ),
    )
    .returning();
  if (!updated) return { tracked: false, failureClass: null, notified: false };
  const lastError = row.lastError ?? storedError(stored.protocol, stored.message);
  await recordSystemAuditEvent(workspaceId, {
    kind: 'mailbox.marked_failing',
    entityType: 'mailbox',
    entityId: mailboxId,
    payload: {
      protocol: stored.protocol,
      lastError,
      failureClass,
      priorStatus: 'failing',
      priorFailureClass: null,
      nextProbeAt: null,
      backfill: 'PC-09',
    },
  });
  await raiseMailboxFailingIncident(
    {
      workspaceId: workspaceId,
      mailboxId,
      failureClass,
      protocol: stored.protocol,
      lastError,
      nextProbeAt: null,
      backfill: true,
    },
    now,
  );
  // flow:F-04 may have notified already under its own key: replace it.
  await resolveNotifications(workspaceId, legacyMailboxFailingKey(mailboxId));
  const rows = await notifyWorkspaceAdmins(workspaceId, failingNotice(updated));
  return { tracked: true, failureClass, notified: rows.length > 0 };
}

// ---- read ----------------------------------------------------------

export async function listMailboxes(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: { includeArchived?: boolean } = {},
): Promise<Mailbox[]> {
  const conditions: SQL[] = [eq(mailboxes.workspaceId, ctx.workspaceId)];
  // (We exclude archived by default via a status filter, post-query for
  // simplicity — the table is tiny per workspace.)
  const rows = await db
    .select()
    .from(mailboxes)
    .where(and(...conditions))
    .orderBy(desc(mailboxes.createdAt));
  if (filter.includeArchived) return rows;
  return rows.filter((m) => m.status !== 'archived');
}

export async function getMailbox(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<Mailbox> {
  return loadMailbox(ctx, id);
}

export async function defaultMailbox(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<Mailbox | null> {
  const rows = await db
    .select()
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.workspaceId, ctx.workspaceId),
        eq(mailboxes.isDefault, true),
        eq(mailboxes.status, 'active'),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ---- provider construction -----------------------------------------

/**
 * Resolve all secrets and return an IMailProvider ready to send/fetch.
 * The caller can pass `providerOverride` (the test seam used by the
 * mail service tests) — when set, we return that and skip the secret +
 * config lookup entirely.
 */
export async function buildProviderFor(
  ctx: WorkspaceContext,
  mailboxId: bigint,
  providerOverride?: IMailProvider,
): Promise<{ mailbox: Mailbox; provider: IMailProvider }> {
  const mailbox = await loadMailbox(ctx, mailboxId);
  if (providerOverride) return { mailbox, provider: providerOverride };
  if (providerFactoryForTests) return { mailbox, provider: providerFactoryForTests(mailbox) };

  const config = await resolveConfig(ctx, mailbox);
  const provider = createMailProvider(config);
  return { mailbox, provider };
}

/**
 * Manual "Test connection" / "Test again". Runs SMTP + IMAP checks and
 * records the outcome the same way the IMAP tick's re-check does
 * (recordMailboxConnectionCheck): a pass brings a failing mailbox back to
 * active (an operator's pause is left alone); a failure marks it failing
 * with backoff and the deduped notification.
 *
 * PC-12: under the mailbox's 'mailbox.sync' lease, like every sync: while
 * a sync or another check of it runs this throws MAILBOX_BUSY ('busy'
 * code) without logging in — one more login beside a running one is what
 * a provider's rate limit (fail2ban) counts, and the two would record
 * their results over each other.
 */
export async function testMailboxConnection(
  ctx: WorkspaceContext,
  mailboxId: bigint,
  providerOverride?: IMailProvider,
): Promise<ConnectionTestResult> {
  if (!canWrite(ctx)) throw permissionDenied('mailbox.test_connection');
  const leased = await withWorkLease(
    ctx,
    { kind: 'mailbox.sync', resource: mailboxId, purpose: 'connection test' },
    () => testConnectionHeld(ctx, mailboxId, providerOverride),
  );
  if (leased.status === 'ran') return leased.value;
  throw new MailboxServiceError(
    `A sync or connection check of this mailbox is already running ${describeLeaseHolder(leased.held)}. Try again when it has finished.`,
    'busy',
  );
}

async function testConnectionHeld(
  ctx: WorkspaceContext,
  mailboxId: bigint,
  providerOverride?: IMailProvider,
): Promise<ConnectionTestResult> {
  const { provider, mailbox } = await buildProviderFor(ctx, mailboxId, providerOverride);
  const result = await runConnectionTest(provider);
  const outcome = await recordMailboxConnectionCheck(ctx, mailbox, result);
  await recordAuditEvent(ctx, {
    kind: 'mailbox.test_connection',
    entityType: 'mailbox',
    entityId: mailbox.id,
    payload: {
      allOk: outcome.ok,
      smtp: result.smtp.ok,
      imap: result.imap?.ok ?? null,
      recovered: outcome.recovered,
    },
  });
  return result;
}

/** Test-only seam: the IMAP tick and safeSyncOne take no provider
 *  argument, so tests route buildProviderFor through this factory. */
let providerFactoryForTests: ((mailbox: Mailbox) => IMailProvider) | null = null;

export function _setMailProviderFactoryForTests(
  factory: ((mailbox: Mailbox) => IMailProvider) | null,
): void {
  providerFactoryForTests = factory;
}

// ---- internals -----------------------------------------------------

async function loadMailbox(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<Mailbox> {
  const rows = await db
    .select()
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.workspaceId, ctx.workspaceId),
        eq(mailboxes.id, id),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound();
  return rows[0];
}

async function resolveConfig(
  ctx: WorkspaceContext,
  mailbox: Mailbox,
): Promise<MailboxConfig> {
  const smtpPassword = await getSecret(ctx, mailbox.smtpPasswordSecretKey);
  if (!smtpPassword) {
    throw new MailboxServiceError(
      `SMTP password missing for mailbox ${mailbox.id}`,
      'secret_missing',
    );
  }
  const imap = mailbox.imapHost && mailbox.imapPort && mailbox.imapUser && mailbox.imapPasswordSecretKey
    ? {
        host: mailbox.imapHost,
        port: mailbox.imapPort,
        secure: mailbox.imapSecure,
        user: mailbox.imapUser,
        password: (await getSecret(ctx, mailbox.imapPasswordSecretKey)) ?? '',
        folder: mailbox.imapFolder,
      }
    : null;
  if (imap && !imap.password) {
    throw new MailboxServiceError(
      `IMAP password missing for mailbox ${mailbox.id}`,
      'secret_missing',
    );
  }
  return {
    smtpHost: mailbox.smtpHost,
    smtpPort: mailbox.smtpPort,
    smtpSecure: mailbox.smtpSecure,
    smtpUser: mailbox.smtpUser,
    smtpPassword,
    imap,
  };
}

function normalizeAddress(input: string): string {
  return input.trim().toLowerCase();
}

function isValidEmail(input: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);
}
