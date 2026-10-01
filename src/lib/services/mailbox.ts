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
import { recordAuditEvent } from './audit';
import { failingRecheckDelayMs } from './imap-backoff';
import { notifyWorkspaceAdmins, resolveNotifications, type NotifyInput } from './notifications';
import {
  canAdminWorkspace,
  canWrite,
  type WorkspaceContext,
} from './context';
import { deleteSecret, getSecret, setSecret } from './secrets';
import {
  createMailProvider,
  type ConnectionTestResult,
  type IMailProvider,
  type MailboxConfig,
} from '@/lib/mail';
import {
  adviseConnectionFailure,
  classifyConnectionFailure,
  describeConnectionError,
  isAuthFailure,
  parseStoredMailboxError,
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
  if (input.status !== undefined) updates.status = input.status;
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
  });

  return updated;
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
    .set({ status: 'archived', isDefault: false, updatedAt: new Date() })
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
    await resolveNotifications(ctx.workspaceId, mailboxFailingDedupeKey(id));
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
 * Phase 51: bring a `failing` mailbox back to `active`. Resets the
 * consecutive-failure counter, clears the cooldown gate, and wipes the
 * stored lastError so the next IMAP tick re-attempts the connection.
 * Use after fixing the underlying credential / config issue. flow:F-04:
 * also ends the failing episode and resolves its notification, so a new
 * failure notifies again. (Test again does the same after a passing
 * check; Reactivate skips the check.)
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
      updatedAt: new Date(),
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
  await resolveNotifications(ctx.workspaceId, mailboxFailingDedupeKey(id));
  return updated;
}

/**
 * Operator-driven pause: flips an `active` or `failing` mailbox to
 * `paused`. While paused, the IMAP tick skips this row (it only syncs
 * 'active' and re-checks 'failing' ones) and `mail.sendMessage` refuses
 * to send through it.
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
    .set({ status: 'paused', updatedAt: new Date() })
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
  // A paused mailbox is not re-checked or alarmed about; the operator has
  // taken it out of service, so the failing alarm is over.
  if (existing.status === 'failing') {
    await resolveNotifications(ctx.workspaceId, mailboxFailingDedupeKey(id));
  }
  return updated;
}

// ---- failure lifecycle (flow:F-05 send-time EAUTH, flow:F-04) -------
//
//   active ──markMailboxFailing──▶ failing ──passing check──▶ active
//                                     │  ▲
//                                     └──┘ failed re-check: error, backoff
//                                          and notification refreshed
//
// While 'failing', nothing reads its inbox (the IMAP tick only re-checks
// the connection, on the imap_next_sync_after gate), the outreach queue
// and follow-ups hold its mail (flow:F-05), and one 'mailbox.failing'
// notification stays in the bell (deduped while unread). It leaves
// 'failing' through a passing re-check (the tick, Test again, or a manual
// Sync — all recordMailboxConnectionCheck), Reactivate, pause or archive;
// each resolves the notification so the next failure notifies again.

/** Dedupe key of a mailbox's 'mailbox.failing' notification (each
 *  admin's copy appends adminDedupeKey's ':user:<id>'). */
export function mailboxFailingDedupeKey(mailboxId: bigint): string {
  return `mailbox.failing:${mailboxId}`;
}

export interface MailboxFailure {
  /** Which side failed; prefixes lastError ("SMTP: …" / "IMAP: …") the
   *  same way testMailboxConnection does. */
  protocol: MailProtocol;
  /** The server's / library's message (describeConnectionError output). */
  message: string;
  /** The server refused our credentials: re-checks start 6 h apart, not
   *  1 h. Defaults to reading `message`. */
  auth?: boolean;
  /** When the error happened (lastErrorAt); defaults to now. */
  occurredAt?: Date;
  /** Consecutive failed checks to store (IMAP syncs / re-checks). Left
   *  unchanged when omitted (a send-time failure is not an IMAP check). */
  consecutiveFailures?: number;
}

export interface MarkMailboxFailingResult {
  /** False when the mailbox is paused / archived / gone — left untouched. */
  marked: boolean;
  /** True when this call created the (deduped) notification. */
  notified: boolean;
  /** When the IMAP tick may re-check it; null when not marked. */
  nextSyncAfter: Date | null;
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
}

/** Explain a mailbox's stored lastError: which side, what it stops, what to do. */
export function summarizeMailboxFailure(
  mailbox: Pick<Mailbox, 'lastError' | 'smtpHost' | 'smtpPort' | 'imapHost' | 'imapPort'>,
): MailboxFailureSummary {
  const { protocol, message } = parseStoredMailboxError(mailbox.lastError);
  return {
    protocol,
    impact: failingMailboxImpact(protocol),
    advice: adviseConnectionFailure(protocol, message, mailbox),
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
    body: `${summary.impact} ${summary.advice} Last error — ${excerpt}`,
    href: `/mailbox/${mailbox.id}`,
    dedupeKey: mailboxFailingDedupeKey(mailbox.id),
  };
}

/**
 * Mark a mailbox as failing after a connection / credential failure that
 * is ours, not a recipient's: send-time EAUTH (F-05), the IMAP auto-pause
 * and a failed re-check or Test again (F-04). Sets status 'failing',
 * lastError + lastErrorAt and a non-null imap_next_sync_after — also when
 * the mailbox is already failing, so a repeat failure refreshes the error
 * and pushes the re-check out (failingRecheckDelayMs: the wait grows with
 * how long it has been failing, 1 h or 6 h after a refused login, capped
 * at 24 h) — and raises one 'mailbox.failing' notification per mailbox,
 * deduped while unread (a read one is re-raised by the next failure).
 *
 * A paused or archived mailbox keeps its status: those are operator
 * decisions and nothing is sent through them anyway. The notification
 * goes to the workspace owners / admins — the people who can fix the
 * credentials or reactivate it — one row each (notifyWorkspaceAdmins).
 */
export async function markMailboxFailing(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
  mailboxId: bigint,
  failure: MailboxFailure,
): Promise<MarkMailboxFailingResult> {
  const now = new Date();
  const label = failure.protocol === 'smtp' ? 'SMTP' : 'IMAP';
  const lastError = `${label}: ${failure.message}`.slice(0, 2000);
  const notMarked: MarkMailboxFailingResult = { marked: false, notified: false, nextSyncAfter: null };

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
  const auth = failure.auth ?? classifyConnectionFailure(failure.message) === 'auth';
  const nextSyncAfter = new Date(
    now.getTime() + failingRecheckDelayMs(now.getTime() - failingSince.getTime(), auth),
  );

  const [updated] = await db
    .update(mailboxes)
    .set({
      status: 'failing',
      lastError,
      lastErrorAt: failure.occurredAt ?? now,
      failingSince,
      imapNextSyncAfter: nextSyncAfter,
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

  if (!wasFailing) {
    await recordAuditEvent(ctx, {
      kind: 'mailbox.marked_failing',
      entityType: 'mailbox',
      entityId: mailboxId,
      payload: {
        protocol: failure.protocol,
        lastError,
        auth,
        priorStatus: prior.status,
        nextSyncAfter: nextSyncAfter.toISOString(),
      },
    });
  }

  const rows = await notifyWorkspaceAdmins(ctx.workspaceId, failingNotice(updated));
  return { marked: true, notified: rows.length > 0, nextSyncAfter };
}

/**
 * A passing check on a failing mailbox: back to active, counters and the
 * gate cleared, the episode ended and its notification resolved. Returns
 * the row, or null when it was not failing (nothing changed).
 */
async function markMailboxRecovered(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
  mailbox: Mailbox,
): Promise<Mailbox | null> {
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
      updatedAt: new Date(),
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
    },
  });
  await resolveNotifications(ctx.workspaceId, mailboxFailingDedupeKey(mailbox.id));
  return row;
}

/** provider.testConnection() that never throws: a thrown error becomes a
 *  failed SMTP check (the side tested first). */
export async function runConnectionTest(provider: IMailProvider): Promise<ConnectionTestResult> {
  try {
    return await provider.testConnection();
  } catch (err) {
    return {
      smtp: { ok: false, detail: describeConnectionError(err), authFailed: isAuthFailure(err) },
      imap: null,
    };
  }
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
  /** The re-check gate after a failure (null when ok or not marked). */
  nextSyncAfter: Date | null;
}

/**
 * Record the result of a full connection check (Test again, the IMAP
 * tick's re-check of a failing mailbox, a manual Sync of one). A pass
 * recovers a failing mailbox and clears a healthy one's stale error; a
 * paused / archived one keeps its status either way. A failure goes
 * through markMailboxFailing (SMTP is reported first when both fail).
 */
export async function recordMailboxConnectionCheck(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
  mailbox: Mailbox,
  result: ConnectionTestResult,
  options: { consecutiveFailures?: number } = {},
): Promise<MailboxCheckOutcome> {
  const ok = result.smtp.ok && (result.imap === null || result.imap.ok);
  const scope = and(eq(mailboxes.workspaceId, ctx.workspaceId), eq(mailboxes.id, mailbox.id));

  if (ok) {
    if (mailbox.status === 'failing') {
      const row = await markMailboxRecovered(ctx, mailbox);
      return { ok, recovered: row !== null, lastError: null, notified: false, nextSyncAfter: null };
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
              updatedAt: new Date(),
            }
          : { lastError: null, lastErrorAt: null, updatedAt: new Date() },
      )
      .where(scope);
    return { ok, recovered: false, lastError: null, notified: false, nextSyncAfter: null };
  }

  const failedSide: { protocol: MailProtocol; detail?: string; authFailed?: boolean } = !result.smtp.ok
    ? { protocol: 'smtp', ...result.smtp }
    : { protocol: 'imap', ...result.imap! };
  const message = failedSide.detail?.trim() || 'failed';
  const marked = await markMailboxFailing(ctx, mailbox.id, {
    protocol: failedSide.protocol,
    message,
    auth: failedSide.authFailed || undefined,
    consecutiveFailures: options.consecutiveFailures,
  });
  const lastError = `${failedSide.protocol === 'smtp' ? 'SMTP' : 'IMAP'}: ${message}`.slice(0, 2000);
  if (!marked.marked) {
    // Paused / archived: keep the operator's status, still show the result.
    await db
      .update(mailboxes)
      .set({ lastError, lastErrorAt: new Date(), updatedAt: new Date() })
      .where(scope);
  }
  return {
    ok,
    recovered: false,
    lastError,
    notified: marked.notified,
    nextSyncAfter: marked.nextSyncAfter,
  };
}

/**
 * flow:F-04 (X7): failing mailboxes with no re-check gate — rows that
 * failed before F-04 (prod: workspace 1's since 2026-05-08, workspace 2's
 * after 13 failures), or that some path set to 'failing' without
 * markMailboxFailing. No network: the stored error is re-recorded through
 * markMailboxFailing (keeping its time), which writes the gate and raises
 * the deduped notification. Run by every IMAP tick for every active
 * workspace — also where IMAP auto-sync is off — so each such mailbox is
 * announced within one tick. Returns how many were adopted.
 */
export async function adoptUntrackedFailingMailboxes(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
): Promise<number> {
  const rows = await db
    .select()
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.workspaceId, ctx.workspaceId),
        eq(mailboxes.status, 'failing'),
        isNull(mailboxes.imapNextSyncAfter),
      ),
    );
  let adopted = 0;
  for (const mb of rows) {
    const stored = parseStoredMailboxError(mb.lastError);
    const r = await markMailboxFailing(ctx, mb.id, {
      ...stored,
      occurredAt: mb.lastErrorAt ?? mb.updatedAt,
    });
    if (r.marked) adopted++;
  }
  return adopted;
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
 */
export async function testMailboxConnection(
  ctx: WorkspaceContext,
  mailboxId: bigint,
  providerOverride?: IMailProvider,
): Promise<ConnectionTestResult> {
  if (!canWrite(ctx)) throw permissionDenied('mailbox.test_connection');
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
