// Mail send/receive service. Wraps IMailProvider with persistence: every
// outbound + inbound message is persisted, threaded by header heuristic,
// and audit-logged. Suppression list is checked before every send.

import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  mailMessages,
  mailThreads,
  mailboxes,
  type MailMessage,
  type MailThread,
  type NewMailMessage,
  type NewMailThread,
} from '@/lib/db/schema/mailing';
import type { MailFolder } from './mail-folders';
import { recordAuditEvent } from './audit';
import { canWrite, type WorkspaceContext } from './context';
import { buildProviderFor } from './mailbox';
import { attachContact, upsertContact } from './contacts';
import { isSuppressed, recordBounce } from './suppression';
import {
  defaultSignature,
  renderSignatureHtml,
  renderSignatureText,
} from './signatures';
import { analyseReply } from './reply-classifier';
import { maybeAutoTranslateInbound } from './translation';
import { randomUUID } from 'node:crypto';
import {
  type IMailProvider,
  type InboundMessage,
  type MailAddress,
  type OutboundMessage,
} from '@/lib/mail';

export class MailServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'MailServiceError';
    this.code = code;
  }
}

const permissionDenied = (op: string) =>
  new MailServiceError(`Permission denied: ${op}`, 'permission_denied');
const notFound = () => new MailServiceError('not found', 'not_found');
const invariant = (msg: string) => new MailServiceError(msg, 'invariant_violation');
const invalid = (msg: string) => new MailServiceError(msg, 'invalid_input');
const suppressed = (addr: string) =>
  new MailServiceError(`suppressed address: ${addr}`, 'suppressed');

// ---- send ----------------------------------------------------------

export interface SendMailInput {
  mailboxId: bigint;
  to: ReadonlyArray<MailAddress>;
  cc?: ReadonlyArray<MailAddress>;
  bcc?: ReadonlyArray<MailAddress>;
  subject: string;
  text?: string;
  html?: string;
  /** Header overrides (Reply-To handled via mailbox config). */
  headers?: Record<string, string>;
  inReplyTo?: string;
  references?: ReadonlyArray<string>;
  /** Optional link to outreach_drafts.id when this came from a draft. */
  sourceDraftId?: bigint;
  /** Phase 57 — one-shot signature override.
   *    undefined → use the mailbox default (current behaviour)
   *    null      → no signature
   *    bigint    → use that specific signature (validated against workspace) */
  signatureId?: bigint | null;
  /** Test-only override; production passes undefined. */
  providerOverride?: IMailProvider;
}

export async function sendMessage(
  ctx: WorkspaceContext,
  input: SendMailInput,
): Promise<MailMessage> {
  if (!canWrite(ctx)) throw permissionDenied('mail.send');
  if (input.to.length === 0) throw invalid('at least one recipient required');
  const subject = input.subject.trim();
  if (!subject) throw invalid('subject required');
  if (!input.text && !input.html) throw invalid('text or html body required');

  // Suppression check — reject if ANY recipient is suppressed.
  for (const addr of [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])]) {
    if (await isSuppressed(ctx, addr.address)) throw suppressed(addr.address);
  }

  const { mailbox, provider } = await buildProviderFor(
    ctx,
    input.mailboxId,
    input.providerOverride,
  );
  if (mailbox.status === 'archived') {
    throw new MailServiceError('mailbox is archived', 'invalid_input');
  }
  if (mailbox.status === 'paused') {
    throw new MailServiceError('mailbox is paused — re-enable it from Edit mailbox to resume sends', 'invalid_input');
  }

  const headers: Record<string, string> = { ...(input.headers ?? {}) };
  if (input.inReplyTo) headers['In-Reply-To'] = input.inReplyTo;
  if (input.references && input.references.length > 0) {
    headers['References'] = input.references.join(' ');
  }

  // Phase 17 + 57: signature resolution.
  //   undefined → mailbox default
  //   null      → no signature (operator picked "none")
  //   bigint    → that specific signature (validated workspace-scoped)
  let outboundText = input.text;
  let outboundHtml = input.html;
  try {
    let sig = null;
    if (input.signatureId === undefined) {
      sig = await defaultSignature(ctx, mailbox.id);
    } else if (input.signatureId !== null) {
      const { signatures } = await import('@/lib/db/schema/mailing');
      const rows = await db
        .select()
        .from(signatures)
        .where(
          and(
            eq(signatures.workspaceId, ctx.workspaceId),
            eq(signatures.id, input.signatureId),
          ),
        )
        .limit(1);
      sig = rows[0] ?? null;
    }
    if (sig) {
      const sigText = renderSignatureText(sig);
      const sigHtml = renderSignatureHtml(sig);
      if (outboundText && sigText) outboundText = `${outboundText}\n\n${sigText}`;
      if (outboundHtml && sigHtml) outboundHtml = `${outboundHtml}\n${sigHtml}`;
    }
  } catch (err) {
    console.error('[mail.send] signature render failed:', err);
  }

  // Phase 22: tracking pixel. Token is opaque + workspace-scoped; URL is
  // /api/track/<token>.gif. We embed it ONLY when the caller supplied an
  // HTML body (text-only emails skip the pixel).
  const trackingToken = randomUUID().replace(/-/g, '');
  const appUrl = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  if (outboundHtml) {
    const pixelUrl = `${appUrl}/api/track/${trackingToken}.gif`;
    outboundHtml = `${outboundHtml}<img src="${pixelUrl}" width="1" height="1" alt="" style="display:block;margin:0;padding:0;border:0" />`;
  }

  // Phase 35: RFC 8058 one-click unsubscribe. Same trackingToken doubles
  // as the unsubscribe token (workspace-scoped, single-use, opaque). The
  // public route lives at /api/unsubscribe/<token> and adds the
  // recipient address(es) to the suppression list.
  const unsubUrl = `${appUrl}/api/unsubscribe/${trackingToken}`;
  const unsubMailto = `mailto:${mailbox.fromAddress}?subject=unsubscribe`;
  // Two-value List-Unsubscribe: HTTPS first (preferred by Gmail/Yahoo),
  // mailto: as a fallback for old clients. Plus List-Unsubscribe-Post
  // for the one-click POST handshake (RFC 8058).
  headers['List-Unsubscribe'] = `<${unsubUrl}>, <${unsubMailto}>`;
  headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';

  // Render a visible unsubscribe footer in the body. CAN-SPAM requires
  // the link be conspicuous; modern bulk senders also do this for
  // engagement reasons.
  const footerText = `\n\n---\nDon't want these messages? Unsubscribe: ${unsubUrl}`;
  const footerHtml = `<div style="margin-top:24px;padding-top:12px;border-top:1px solid #ccc;font-size:12px;color:#888;font-family:Arial,sans-serif"><a href="${unsubUrl}" style="color:#888;text-decoration:underline">Unsubscribe</a></div>`;
  outboundText = (outboundText ?? '') + footerText;
  if (outboundHtml) {
    outboundHtml = outboundHtml + footerHtml;
  }

  const out: OutboundMessage = {
    from: { address: mailbox.fromAddress, name: mailbox.fromName ?? undefined },
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    replyTo: mailbox.replyTo ?? undefined,
    subject,
    text: outboundText,
    html: outboundHtml,
    headers,
  };

  let sendResult;
  try {
    sendResult = await provider.send(out);
  } catch (err) {
    // Phase 17: SMTP-layer rejection that includes a 5xx response triggers
    // an auto-bounce-suppress. nodemailer surfaces an `responseCode` on
    // the error object; we match conservatively to avoid suppressing on
    // transient network errors.
    const e = err as { responseCode?: number; message?: string };
    const responseCode = e?.responseCode ?? null;
    if (responseCode && responseCode >= 500 && responseCode < 600) {
      for (const recipient of input.to) {
        try {
          await recordBounce(ctx, recipient.address, 'hard', e.message ?? null);
        } catch {
          // best-effort
        }
      }
    } else if (responseCode && responseCode >= 400 && responseCode < 500) {
      for (const recipient of input.to) {
        try {
          await recordBounce(ctx, recipient.address, 'soft', e.message ?? null);
        } catch {
          // best-effort
        }
      }
    }
    // P61-08: persist the failure as a mail_messages row so it lands in
    // the Errors folder AND so future bounce-loop detection has the
    // history to count against. We never let the persistence fail bubble
    // up — the send already threw and that contract is preserved.
    try {
      const failureReason = e?.message ?? (err instanceof Error ? err.message : String(err));
      const failedStatus: MailMessage['status'] =
        responseCode && responseCode >= 500 && responseCode < 600
          ? 'bounced'
          : 'failed';
      const primaryAddress = input.to[0]?.address ?? null;
      const isLoop =
        primaryAddress !== null &&
        (await detectBounceLoop(ctx, mailbox.id, primaryAddress));
      const failedThread = await ensureThread(ctx, mailbox.id, {
        subject,
        inReplyTo: input.inReplyTo ?? null,
        references: input.references ? [...input.references] : [],
        participants: collectParticipants(out),
      });
      const failedRow: NewMailMessage = {
        workspaceId: ctx.workspaceId,
        mailboxId: mailbox.id,
        threadId: failedThread.id,
        direction: 'outbound',
        status: failedStatus,
        messageId: `<failed-${randomUUID()}@${mailbox.fromAddress.split('@')[1] ?? 'local'}>`,
        inReplyTo: input.inReplyTo ?? null,
        references: input.references ? [...input.references] : [],
        fromAddress: mailbox.fromAddress,
        fromName: mailbox.fromName ?? null,
        toAddresses: input.to.map((a) => a.address),
        ccAddresses: input.cc?.map((a) => a.address) ?? [],
        bccAddresses: input.bcc?.map((a) => a.address) ?? [],
        subject,
        bodyText: input.text ?? null,
        bodyHtml: input.html ?? null,
        headers: headers as unknown as Record<string, unknown>,
        attachments: [],
        failureReason:
          responseCode
            ? `${responseCode} ${failureReason}`.slice(0, 4000)
            : failureReason.slice(0, 4000),
        sourceDraftId: input.sourceDraftId ?? null,
        spamAt: isLoop ? new Date() : null,
        spamReason: isLoop ? 'bounce_loop' : null,
        createdBy: ctx.userId,
      };
      await db.insert(mailMessages).values(failedRow);
      await touchThread(failedThread.id);
      if (isLoop) {
        await recordAuditEvent(ctx, {
          kind: 'mail.bounce_loop_auto_spam',
          entityType: 'mail_message',
          payload: {
            recipient: primaryAddress,
            mailboxId: mailbox.id.toString(),
          },
        });
      }
    } catch (persistErr) {
      console.error('[mail.send] failed to persist failure row:', persistErr);
    }
    throw err;
  }

  // Resolve / create thread.
  const thread = await ensureThread(ctx, mailbox.id, {
    subject,
    inReplyTo: input.inReplyTo ?? null,
    references: input.references ? [...input.references] : [],
    participants: collectParticipants(out),
  });

  // Phase 16: resolve / upsert the primary recipient as a contact and
  // attach it to the thread + message. Best-effort.
  const primaryAddress = input.to[0]?.address;
  let contactId: bigint | null = null;
  if (primaryAddress) {
    try {
      const contact = await upsertContact(ctx, {
        email: primaryAddress,
        name: input.to[0]?.name,
      });
      contactId = contact.id;
      await attachContact(ctx, contact.id, {
        type: 'mail_thread',
        id: thread.id.toString(),
        relation: 'primary',
      });
    } catch (err) {
      console.error('[mail.send] contact resolve failed:', err);
    }
  }

  // Persist outbound row.
  const row: NewMailMessage = {
    workspaceId: ctx.workspaceId,
    mailboxId: mailbox.id,
    threadId: thread.id,
    direction: 'outbound',
    status: 'sent',
    messageId: sendResult.messageId,
    inReplyTo: input.inReplyTo ?? null,
    references: input.references ? [...input.references] : [],
    fromAddress: mailbox.fromAddress,
    fromName: mailbox.fromName ?? null,
    toAddresses: input.to.map((a) => a.address),
    ccAddresses: input.cc?.map((a) => a.address) ?? [],
    bccAddresses: input.bcc?.map((a) => a.address) ?? [],
    subject,
    bodyText: input.text ?? null,
    bodyHtml: input.html ?? null,
    headers: headers as unknown as Record<string, unknown>,
    attachments: [],
    sentAt: new Date(),
    sourceDraftId: input.sourceDraftId ?? null,
    contactId,
    trackingToken,
    createdBy: ctx.userId,
  };

  const [created] = await db.insert(mailMessages).values(row).returning();
  if (!created) throw invariant('mail_message insert returned no row');

  if (contactId) {
    try {
      await attachContact(ctx, contactId, {
        type: 'mail_message',
        id: created.id.toString(),
      });
    } catch (err) {
      console.error('[mail.send] contact-message attach failed:', err);
    }
  }

  await recordAuditEvent(ctx, {
    kind: 'mail.send',
    entityType: 'mail_message',
    entityId: created.id,
    payload: {
      mailboxId: mailbox.id.toString(),
      to: input.to.map((a) => a.address),
      threadId: thread.id.toString(),
      sourceDraftId: input.sourceDraftId?.toString() ?? null,
    },
  });

  await touchThread(thread.id);

  // Phase 58: schedule auto follow-ups when this is the FIRST outbound
  // on a thread linked to a qualified lead. Best-effort — failures log
  // but never break the send.
  try {
    const outboundCount = await db
      .select({ id: mailMessages.id })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.workspaceId, ctx.workspaceId),
          eq(mailMessages.threadId, thread.id),
          eq(mailMessages.direction, 'outbound'),
        ),
      );
    if (outboundCount.length === 1) {
      const { outreachThreadState } = await import('@/lib/db/schema/outreach');
      const [ots] = await db
        .select()
        .from(outreachThreadState)
        .where(
          and(
            eq(outreachThreadState.workspaceId, ctx.workspaceId),
            eq(outreachThreadState.threadId, thread.id),
          ),
        )
        .limit(1);
      if (ots) {
        const { scheduleFollowUps } = await import('./follow-up');
        await scheduleFollowUps(ctx, {
          threadId: thread.id,
          qualifiedLeadId: ots.qualifiedLeadId,
        });
      }
    }
  } catch (err) {
    console.error('[mail.send] follow-up schedule failed (best-effort):', err);
  }

  return created;
}

// ---- test email (Phase 52) -----------------------------------------

export interface SendTestEmailInput {
  mailboxId: bigint;
  to: string;
  subject: string;
  /** Plain-text body. Test emails do NOT go through the unsubscribe /
   *  tracking-pixel pipeline — they're for the operator, not recipients. */
  body: string;
  /** Optional signature pick. Null = no signature; undefined = use the
   *  mailbox default (same behaviour as a normal send). */
  signatureId?: bigint | null;
  /** Test seam. */
  providerOverride?: IMailProvider;
}

export interface SendTestEmailResult {
  messageId: string;
  smtpResponse: string;
  appendedSignature: boolean;
  signatureName: string | null;
}

/**
 * Phase 52 — operator-only deliverability + signature smoke test. Sends a
 * real email through the mailbox's SMTP, renders the chosen signature (or
 * the mailbox default), and returns the SMTP response so the operator can
 * verify:
 *   - SMTP auth + transport works end-to-end
 *   - The configured signature renders the way they expect
 *   - The remote mail server accepts mail from this account
 *
 * Crucially this does NOT:
 *   - Persist a `mail_messages` row (keeps test sends out of the threads view)
 *   - Run suppression / bounce / contact resolution (operator-internal)
 *   - Inject the unsubscribe footer or tracking pixel
 * It DOES record an `audit_log` entry of kind `mail.send_test` so the
 * operator can see the history.
 */
export async function sendTestEmail(
  ctx: WorkspaceContext,
  input: SendTestEmailInput,
): Promise<SendTestEmailResult> {
  if (!canWrite(ctx)) throw permissionDenied('mail.send_test');
  const to = input.to.trim();
  const subject = input.subject.trim();
  const body = input.body;
  if (!to) throw invalid('to required');
  if (!subject) throw invalid('subject required');
  if (!body || !body.trim()) throw invalid('body required');

  const { mailbox, provider } = await buildProviderFor(
    ctx,
    input.mailboxId,
    input.providerOverride,
  );
  if (mailbox.status === 'archived') {
    throw new MailServiceError('mailbox is archived', 'invalid_input');
  }
  if (mailbox.status === 'paused') {
    throw new MailServiceError('mailbox is paused — re-enable it from Edit mailbox to resume sends', 'invalid_input');
  }

  // Signature resolution: explicit id → that signature (validated);
  // explicit null → no signature; undefined → mailbox default.
  let sig = null;
  let appendedSignature = false;
  if (input.signatureId === undefined) {
    sig = await defaultSignature(ctx, mailbox.id);
  } else if (input.signatureId !== null) {
    const { signatures } = await import('@/lib/db/schema/mailing');
    const rows = await db
      .select()
      .from(signatures)
      .where(
        and(
          eq(signatures.workspaceId, ctx.workspaceId),
          eq(signatures.id, input.signatureId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw invalid('signature not found');
    sig = rows[0];
  }

  let text = body;
  let html: string | undefined;
  if (sig) {
    const sigText = renderSignatureText(sig);
    const sigHtml = renderSignatureHtml(sig);
    if (sigText) text = `${text}\n\n${sigText}`;
    if (sigHtml) {
      // Minimal HTML wrapper so the operator's mail client renders the
      // signature with its intended formatting + image.
      const escapedBody = body
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>\n');
      html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">${escapedBody}</div>${sigHtml}`;
    }
    appendedSignature = true;
  }

  const out: OutboundMessage = {
    from: { address: mailbox.fromAddress, name: mailbox.fromName ?? undefined },
    to: [{ address: to }],
    replyTo: mailbox.replyTo ?? undefined,
    subject,
    text,
    html,
    headers: { 'X-LDP-Test': 'true' },
  };
  const sendResult = await provider.send(out);

  await recordAuditEvent(ctx, {
    kind: 'mail.send_test',
    entityType: 'mailbox',
    entityId: mailbox.id,
    payload: {
      to,
      subject,
      messageId: sendResult.messageId,
      signatureId: sig?.id.toString() ?? null,
      signatureName: sig?.name ?? null,
    },
  });

  return {
    messageId: sendResult.messageId,
    smtpResponse: String(sendResult.raw ?? ''),
    appendedSignature,
    signatureName: sig?.name ?? null,
  };
}

// ---- receive -------------------------------------------------------

export interface SyncInboundResult {
  fetched: number;
  inserted: number;
  duplicates: number;
}

export async function syncInbound(
  ctx: WorkspaceContext,
  mailboxId: bigint,
  providerOverride?: IMailProvider,
): Promise<SyncInboundResult> {
  if (!canWrite(ctx)) throw permissionDenied('mail.sync_inbound');
  const { mailbox, provider } = await buildProviderFor(ctx, mailboxId, providerOverride);
  const since = mailbox.lastSyncedAt ?? undefined;
  const messages = await provider.fetchInbound({ since, limit: 100 });

  let inserted = 0;
  let duplicates = 0;
  for (const inbound of messages) {
    const existed = await persistInbound(ctx, mailbox.id, inbound);
    if (existed) duplicates++;
    else inserted++;
  }

  await db
    .update(mailboxes)
    .set({ lastSyncedAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(
      and(
        eq(mailboxes.workspaceId, ctx.workspaceId),
        eq(mailboxes.id, mailbox.id),
      ),
    );

  await recordAuditEvent(ctx, {
    kind: 'mail.sync_inbound',
    entityType: 'mailbox',
    entityId: mailbox.id,
    payload: { fetched: messages.length, inserted, duplicates },
  });

  return { fetched: messages.length, inserted, duplicates };
}

async function persistInbound(
  ctx: WorkspaceContext,
  mailboxId: bigint,
  inbound: InboundMessage,
): Promise<boolean> {
  // Dedup by (workspace, message_id).
  const existing = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        eq(mailMessages.messageId, inbound.messageId),
      ),
    )
    .limit(1);
  if (existing[0]) return true;

  const thread = await ensureThread(ctx, mailboxId, {
    subject: inbound.subject || '(no subject)',
    inReplyTo: inbound.inReplyTo,
    references: inbound.references,
    participants: [
      inbound.from.address,
      ...inbound.to.map((a) => a.address),
      ...inbound.cc.map((a) => a.address),
    ],
  });

  // Phase 16: resolve / upsert the inbound sender as a contact + attach.
  let contactId: bigint | null = null;
  try {
    const contact = await upsertContact(ctx, {
      email: inbound.from.address,
      name: inbound.from.name ?? null,
    });
    contactId = contact.id;
    await attachContact(ctx, contact.id, {
      type: 'mail_thread',
      id: thread.id.toString(),
      relation: 'inbound_sender',
    });
  } catch (err) {
    console.error('[mail.persistInbound] contact resolve failed:', err);
  }

  await db.insert(mailMessages).values({
    workspaceId: ctx.workspaceId,
    mailboxId,
    threadId: thread.id,
    direction: 'inbound',
    status: 'received',
    messageId: inbound.messageId,
    inReplyTo: inbound.inReplyTo,
    references: inbound.references,
    fromAddress: inbound.from.address,
    fromName: inbound.from.name ?? null,
    toAddresses: inbound.to.map((a) => a.address),
    ccAddresses: inbound.cc.map((a) => a.address),
    bccAddresses: [],
    subject: inbound.subject,
    bodyText: inbound.textBody,
    bodyHtml: inbound.htmlBody,
    contactId,
    headers: inbound.headers as unknown as Record<string, unknown>,
    attachments: inbound.attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      // Phase 10 leaves attachment bytes inline in the inbound stream.
      // Phase 11+ can offload to IStorage when the bodies grow.
    })),
    receivedAt: inbound.receivedAt,
  } satisfies NewMailMessage);

  await touchThread(thread.id);

  // Phase 20: classify the inbound + run auto-actions inline. Best-effort.
  // Phase 42: auto-translate non-English bodies inline so the operator
  // sees the English version on first thread open. Heuristic-gated so
  // English mail never bills the AI.
  try {
    const insertedRows = await db
      .select({ id: mailMessages.id })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.workspaceId, ctx.workspaceId),
          eq(mailMessages.messageId, inbound.messageId),
        ),
      )
      .limit(1);
    if (insertedRows[0]) {
      await analyseReply(ctx, insertedRows[0].id);
      await maybeAutoTranslateInbound(ctx, insertedRows[0].id);
    }
  } catch (err) {
    console.error('[mail.persistInbound] post-receive hooks failed:', err);
  }

  return false;
}

// ---- read ----------------------------------------------------------

export interface ListThreadsFilter {
  mailboxId?: bigint;
  limit?: number;
  /** Phase 52: split the thread list by whether outreach is happening.
   *  'outreach' = threads with at least one row in outreach_thread_state
   *  (i.e., linked to a qualified_lead, drafts have been generated, the
   *  staged-conversation engine treats them as in-flight).
   *  'inbox'    = threads NOT linked to outreach — random inbound mail.
   *  'all'      = everything (default, unchanged from prior behaviour). */
  kind?: 'all' | 'outreach' | 'inbox';
}

export async function listThreads(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: ListThreadsFilter = {},
): Promise<MailThread[]> {
  const conditions: SQL[] = [eq(mailThreads.workspaceId, ctx.workspaceId)];
  if (filter.mailboxId !== undefined) {
    conditions.push(eq(mailThreads.mailboxId, filter.mailboxId));
  }
  if (filter.kind === 'outreach' || filter.kind === 'inbox') {
    const { outreachThreadState } = await import('@/lib/db/schema/outreach');
    const exists = sql`EXISTS (
      SELECT 1 FROM ${outreachThreadState}
      WHERE ${outreachThreadState.threadId} = ${mailThreads.id}
        AND ${outreachThreadState.workspaceId} = ${mailThreads.workspaceId}
    )`;
    conditions.push(
      filter.kind === 'outreach'
        ? (exists as unknown as SQL)
        : (sql`NOT ${exists}` as unknown as SQL),
    );
  }
  return db
    .select()
    .from(mailThreads)
    .where(and(...conditions))
    .orderBy(desc(mailThreads.lastMessageAt))
    .limit(Math.min(filter.limit ?? 200, 1000));
}

/** Phase 52 — fast count of threads partitioned by kind, used to badge
 *  the Inbox / Outreach tabs on the mailbox detail page. */
export async function countThreadsByKind(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  mailboxId: bigint,
): Promise<{ outreach: number; inbox: number; all: number }> {
  const { outreachThreadState } = await import('@/lib/db/schema/outreach');
  // Correlated EXISTS: for each mail_threads row, look up matching
  // outreach_thread_state by (workspace_id, thread_id). All column refs
  // go through Drizzle so the alias / qualification is correct.
  const outreachExists = sql<boolean>`EXISTS (
    SELECT 1 FROM ${outreachThreadState}
    WHERE ${outreachThreadState.threadId} = ${mailThreads.id}
      AND ${outreachThreadState.workspaceId} = ${mailThreads.workspaceId}
  )`;
  const rows = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      outreach: sql<number>`COUNT(*) FILTER (WHERE ${outreachExists})::int`,
    })
    .from(mailThreads)
    .where(
      and(
        eq(mailThreads.workspaceId, ctx.workspaceId),
        eq(mailThreads.mailboxId, mailboxId),
      ),
    );
  const all = rows[0]?.total ?? 0;
  const outreach = rows[0]?.outreach ?? 0;
  return { all, outreach, inbox: all - outreach };
}

export async function getThread(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  threadId: bigint,
): Promise<{ thread: MailThread; messages: MailMessage[] }> {
  const threadRows = await db
    .select()
    .from(mailThreads)
    .where(
      and(
        eq(mailThreads.workspaceId, ctx.workspaceId),
        eq(mailThreads.id, threadId),
      ),
    )
    .limit(1);
  if (!threadRows[0]) throw notFound();
  const messages = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        eq(mailMessages.threadId, threadId),
      ),
    )
    .orderBy(asc(mailMessages.createdAt));
  return { thread: threadRows[0], messages };
}

// ---- folders (P61) -------------------------------------------------

/** Stays in sync with deriveFolder() in mail-folders.ts. Any change in
 *  one place must update the other (the test matrix in
 *  mail-folders.test.ts pins the cases). */
function folderFilter(folder: MailFolder): SQL {
  switch (folder) {
    case 'trash':
      return isNotNull(mailMessages.trashedAt);
    case 'spam':
      return and(
        isNull(mailMessages.trashedAt),
        isNotNull(mailMessages.spamAt),
      ) as SQL;
    case 'errors':
      return and(
        isNull(mailMessages.trashedAt),
        isNull(mailMessages.spamAt),
        inArray(mailMessages.status, ['failed', 'bounced']),
      ) as SQL;
    case 'queued':
      return and(
        isNull(mailMessages.trashedAt),
        isNull(mailMessages.spamAt),
        inArray(mailMessages.status, ['queued', 'sending']),
      ) as SQL;
    case 'sent':
      return and(
        isNull(mailMessages.trashedAt),
        isNull(mailMessages.spamAt),
        eq(mailMessages.direction, 'outbound'),
        inArray(mailMessages.status, ['sent', 'delivered']),
      ) as SQL;
    case 'inbox':
      return and(
        isNull(mailMessages.trashedAt),
        isNull(mailMessages.spamAt),
        eq(mailMessages.direction, 'inbound'),
      ) as SQL;
  }
}

export interface ListMessagesFilter {
  mailboxId: bigint;
  folder: MailFolder;
  limit?: number;
  offset?: number;
  /** Substring match against subject + from address + to addresses
   *  (case-insensitive). */
  search?: string;
}

export interface MessageListRow {
  message: MailMessage;
  thread: { id: bigint; subject: string } | null;
}

export async function listMessages(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: ListMessagesFilter,
): Promise<MessageListRow[]> {
  const conditions: SQL[] = [
    eq(mailMessages.workspaceId, ctx.workspaceId),
    eq(mailMessages.mailboxId, filter.mailboxId),
    folderFilter(filter.folder),
  ];
  if (filter.search && filter.search.trim()) {
    const q = `%${filter.search.trim()}%`;
    conditions.push(
      or(
        ilike(mailMessages.subject, q),
        ilike(mailMessages.fromAddress, q),
        sql`EXISTS (SELECT 1 FROM unnest(${mailMessages.toAddresses}) addr WHERE addr ILIKE ${q})`,
      ) as SQL,
    );
  }

  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);

  const rows = await db
    .select({
      message: mailMessages,
      threadId: mailThreads.id,
      threadSubject: mailThreads.subject,
    })
    .from(mailMessages)
    .leftJoin(mailThreads, eq(mailMessages.threadId, mailThreads.id))
    .where(and(...conditions))
    .orderBy(desc(mailMessages.createdAt), desc(mailMessages.id))
    .limit(limit)
    .offset(offset);

  return rows.map((r) => ({
    message: r.message,
    thread:
      r.threadId !== null && r.threadSubject !== null
        ? { id: r.threadId, subject: r.threadSubject }
        : null,
  }));
}

export type FolderCounts = Record<MailFolder, number>;

/** Single query returning all six folder counts for a mailbox. Mirrors
 *  the priority order in deriveFolder via COUNT(*) FILTER. */
export async function countMessagesByFolder(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  mailboxId: bigint,
): Promise<FolderCounts> {
  const rows = await db
    .select({
      trash: sql<number>`COUNT(*) FILTER (WHERE ${mailMessages.trashedAt} IS NOT NULL)::int`,
      spam: sql<number>`COUNT(*) FILTER (WHERE ${mailMessages.trashedAt} IS NULL AND ${mailMessages.spamAt} IS NOT NULL)::int`,
      errors: sql<number>`COUNT(*) FILTER (WHERE ${mailMessages.trashedAt} IS NULL AND ${mailMessages.spamAt} IS NULL AND ${mailMessages.status} IN ('failed','bounced'))::int`,
      queued: sql<number>`COUNT(*) FILTER (WHERE ${mailMessages.trashedAt} IS NULL AND ${mailMessages.spamAt} IS NULL AND ${mailMessages.status} IN ('queued','sending'))::int`,
      sent: sql<number>`COUNT(*) FILTER (WHERE ${mailMessages.trashedAt} IS NULL AND ${mailMessages.spamAt} IS NULL AND ${mailMessages.direction} = 'outbound' AND ${mailMessages.status} IN ('sent','delivered'))::int`,
      inbox: sql<number>`COUNT(*) FILTER (WHERE ${mailMessages.trashedAt} IS NULL AND ${mailMessages.spamAt} IS NULL AND ${mailMessages.direction} = 'inbound')::int`,
    })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        eq(mailMessages.mailboxId, mailboxId),
      ),
    );
  const r = rows[0];
  return {
    inbox: r?.inbox ?? 0,
    sent: r?.sent ?? 0,
    queued: r?.queued ?? 0,
    errors: r?.errors ?? 0,
    spam: r?.spam ?? 0,
    trash: r?.trash ?? 0,
  };
}

export async function getMessage(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<MailMessage> {
  const rows = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        eq(mailMessages.id, id),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound();
  return rows[0];
}

// ---- per-message actions (P61) -------------------------------------

export interface ActionResult {
  affected: number;
  ids: bigint[];
}

/** Soft-delete a batch of messages — sets trashed_at = now() on every row
 *  belonging to the workspace. Idempotent: messages already in trash stay
 *  with their original trashedAt timestamp (NOT updated). Returns the ids
 *  actually moved (excludes already-trashed). */
export async function moveToTrash(
  ctx: WorkspaceContext,
  ids: ReadonlyArray<bigint>,
): Promise<ActionResult> {
  if (!canWrite(ctx)) throw permissionDenied('mail.move_to_trash');
  if (ids.length === 0) return { affected: 0, ids: [] };
  const now = new Date();
  const updated = await db
    .update(mailMessages)
    .set({ trashedAt: now, updatedAt: now })
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        inArray(mailMessages.id, [...ids]),
        isNull(mailMessages.trashedAt),
      ),
    )
    .returning({ id: mailMessages.id });
  const movedIds = updated.map((r) => r.id);
  if (movedIds.length > 0) {
    await recordAuditEvent(ctx, {
      kind: 'mail.move_to_trash',
      entityType: 'mail_message',
      payload: { ids: movedIds.map(String), count: movedIds.length },
    });
  }
  return { affected: movedIds.length, ids: movedIds };
}

/** Undo moveToTrash — clears trashed_at. Only affects currently-trashed
 *  rows in the workspace. */
export async function restoreFromTrash(
  ctx: WorkspaceContext,
  ids: ReadonlyArray<bigint>,
): Promise<ActionResult> {
  if (!canWrite(ctx)) throw permissionDenied('mail.restore_from_trash');
  if (ids.length === 0) return { affected: 0, ids: [] };
  const now = new Date();
  const updated = await db
    .update(mailMessages)
    .set({ trashedAt: null, updatedAt: now })
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        inArray(mailMessages.id, [...ids]),
        isNotNull(mailMessages.trashedAt),
      ),
    )
    .returning({ id: mailMessages.id });
  const restoredIds = updated.map((r) => r.id);
  if (restoredIds.length > 0) {
    await recordAuditEvent(ctx, {
      kind: 'mail.restore_from_trash',
      entityType: 'mail_message',
      payload: { ids: restoredIds.map(String), count: restoredIds.length },
    });
  }
  return { affected: restoredIds.length, ids: restoredIds };
}

/** Flag a batch as spam. Stamps spam_at = now() and stores the reason.
 *  Idempotent on already-spammed rows. */
export async function markAsSpam(
  ctx: WorkspaceContext,
  ids: ReadonlyArray<bigint>,
  reason: string = 'manual',
): Promise<ActionResult> {
  if (!canWrite(ctx)) throw permissionDenied('mail.mark_as_spam');
  if (ids.length === 0) return { affected: 0, ids: [] };
  const trimmed = reason.trim();
  if (!trimmed) throw invalid('spam reason cannot be empty');
  const now = new Date();
  const updated = await db
    .update(mailMessages)
    .set({ spamAt: now, spamReason: trimmed, updatedAt: now })
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        inArray(mailMessages.id, [...ids]),
        isNull(mailMessages.spamAt),
      ),
    )
    .returning({ id: mailMessages.id });
  const flaggedIds = updated.map((r) => r.id);
  if (flaggedIds.length > 0) {
    await recordAuditEvent(ctx, {
      kind: 'mail.mark_as_spam',
      entityType: 'mail_message',
      payload: {
        ids: flaggedIds.map(String),
        count: flaggedIds.length,
        reason: trimmed,
      },
    });
  }
  return { affected: flaggedIds.length, ids: flaggedIds };
}

/** Undo markAsSpam — clears spam_at + spam_reason. */
export async function unmarkSpam(
  ctx: WorkspaceContext,
  ids: ReadonlyArray<bigint>,
): Promise<ActionResult> {
  if (!canWrite(ctx)) throw permissionDenied('mail.unmark_spam');
  if (ids.length === 0) return { affected: 0, ids: [] };
  const now = new Date();
  const updated = await db
    .update(mailMessages)
    .set({ spamAt: null, spamReason: null, updatedAt: now })
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        inArray(mailMessages.id, [...ids]),
        isNotNull(mailMessages.spamAt),
      ),
    )
    .returning({ id: mailMessages.id });
  const clearedIds = updated.map((r) => r.id);
  if (clearedIds.length > 0) {
    await recordAuditEvent(ctx, {
      kind: 'mail.unmark_spam',
      entityType: 'mail_message',
      payload: { ids: clearedIds.map(String), count: clearedIds.length },
    });
  }
  return { affected: clearedIds.length, ids: clearedIds };
}

/** Hard-delete rows. Refuses to delete anything that isn't already in
 *  trash — the UI guides the operator through trash first, then delete.
 *  Throws if any requested id is missing (wrong workspace, wrong id, or
 *  not trashed); the entire batch is rejected so the caller can show a
 *  precise error. */
export async function permanentlyDelete(
  ctx: WorkspaceContext,
  ids: ReadonlyArray<bigint>,
): Promise<ActionResult> {
  if (!canWrite(ctx)) throw permissionDenied('mail.permanently_delete');
  if (ids.length === 0) return { affected: 0, ids: [] };
  // Verify every id is in this workspace AND already trashed before we
  // delete anything. A bulk delete with a permissive WHERE would silently
  // drop ineligible ids and the operator would not notice.
  const eligible = await db
    .select({ id: mailMessages.id })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        inArray(mailMessages.id, [...ids]),
        isNotNull(mailMessages.trashedAt),
      ),
    );
  if (eligible.length !== ids.length) {
    throw invalid(
      `permanentlyDelete: ${ids.length - eligible.length} of ${ids.length} id(s) are not in trash`,
    );
  }
  const eligibleIds = eligible.map((r) => r.id);
  const deleted = await db
    .delete(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        inArray(mailMessages.id, eligibleIds),
      ),
    )
    .returning({ id: mailMessages.id });
  const deletedIds = deleted.map((r) => r.id);
  if (deletedIds.length > 0) {
    await recordAuditEvent(ctx, {
      kind: 'mail.permanently_delete',
      entityType: 'mail_message',
      payload: { ids: deletedIds.map(String), count: deletedIds.length },
    });
  }
  return { affected: deletedIds.length, ids: deletedIds };
}

// ---- trash purge (P61-09) ------------------------------------------

export const TRASH_RETENTION_DAYS_MIN = 0;
export const TRASH_RETENTION_DAYS_MAX = 365;
export const TRASH_RETENTION_DAYS_DEFAULT = 30;

export interface TrashPurgeResult {
  deleted: number;
  retentionDays: number;
}

/** Unattended (cron) version: hard-delete rows in this workspace whose
 *  `trashed_at` is older than the workspace's `trash_retention_days`.
 *  A retention of 0 disables auto-purge (operator can still manually
 *  Empty trash now). Returns the count + the resolved retention so the
 *  cron logs are self-explanatory. */
export async function purgeOldTrashUnattended(
  workspaceId: bigint,
): Promise<TrashPurgeResult> {
  const { workspaces } = await import('@/lib/db/schema/workspaces');
  const rows = await db
    .select({ retentionDays: workspaces.trashRetentionDays })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const retentionDays = rows[0]?.retentionDays ?? TRASH_RETENTION_DAYS_DEFAULT;
  if (retentionDays <= 0) return { deleted: 0, retentionDays };
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, workspaceId),
        isNotNull(mailMessages.trashedAt),
        lt(mailMessages.trashedAt, cutoff),
      ),
    )
    .returning({ id: mailMessages.id });
  return { deleted: deleted.length, retentionDays };
}

/** Admin-gated "Empty trash now" — hard-deletes EVERY trashed message
 *  in the workspace regardless of age. Emits an audit event. */
export async function emptyTrashNow(
  ctx: WorkspaceContext,
): Promise<{ deleted: number }> {
  const { canAdminWorkspace } = await import('./context');
  if (!canAdminWorkspace(ctx)) throw permissionDenied('mail.empty_trash_now');
  const deleted = await db
    .delete(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        isNotNull(mailMessages.trashedAt),
      ),
    )
    .returning({ id: mailMessages.id });
  if (deleted.length > 0) {
    await recordAuditEvent(ctx, {
      kind: 'mail.empty_trash_now',
      entityType: 'mail_message',
      payload: { count: deleted.length },
    });
  }
  return { deleted: deleted.length };
}

/** Update workspaces.trash_retention_days. Admin-gated. Clamps to
 *  [TRASH_RETENTION_DAYS_MIN, TRASH_RETENTION_DAYS_MAX]. */
export async function updateTrashRetentionDays(
  ctx: WorkspaceContext,
  days: number,
): Promise<{ trashRetentionDays: number }> {
  const { canAdminWorkspace } = await import('./context');
  if (!canAdminWorkspace(ctx)) throw permissionDenied('mail.update_retention');
  if (!Number.isInteger(days)) throw invalid('trash_retention_days must be an integer');
  const clamped = Math.max(
    TRASH_RETENTION_DAYS_MIN,
    Math.min(TRASH_RETENTION_DAYS_MAX, days),
  );
  const { workspaces } = await import('@/lib/db/schema/workspaces');
  await db
    .update(workspaces)
    .set({ trashRetentionDays: clamped, updatedAt: new Date() })
    .where(eq(workspaces.id, ctx.workspaceId));
  await recordAuditEvent(ctx, {
    kind: 'mail.update_trash_retention',
    payload: { trashRetentionDays: clamped },
  });
  return { trashRetentionDays: clamped };
}

// ---- bounce-loop auto-spam (P61-08) --------------------------------

/** Threshold for auto-flagging the next bounce as spam.
 *  Three prior failures from the same address in the last 14 days makes
 *  the next attempt a bounce loop. Constant lives here (not workspace
 *  setting) until the data tells us otherwise. */
export const BOUNCE_LOOP_THRESHOLD = 3;
export const BOUNCE_LOOP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** True when the recipient address has accumulated at least
 *  (BOUNCE_LOOP_THRESHOLD - 1) prior bounces in the trailing window —
 *  in other words, the caller is about to write the threshold-th
 *  failure and should flag it spam_reason='bounce_loop'.
 *
 *  Workspace-scoped, mailbox-scoped, recipient-exact-match. The address
 *  is checked against the `to_addresses[]` array, not against from /
 *  cc / bcc — bounce loops only make sense for the primary recipient. */
export async function detectBounceLoop(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  mailboxId: bigint,
  recipient: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - BOUNCE_LOOP_WINDOW_MS);
  const rows = await db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        eq(mailMessages.mailboxId, mailboxId),
        eq(mailMessages.direction, 'outbound'),
        inArray(mailMessages.status, ['failed', 'bounced']),
        sql`${recipient} = ANY (${mailMessages.toAddresses})`,
        gt(mailMessages.createdAt, cutoff),
      ),
    );
  const count = rows[0]?.c ?? 0;
  return count >= BOUNCE_LOOP_THRESHOLD - 1;
}

// ---- retry (P61-07) ------------------------------------------------

const HARD_BOUNCE_RE = /\b5\d{2}\b/;

/** A message is "hard bounced" if either:
 *    - its status is 'bounced' (which is only set by the DSN parser on
 *      a permanent receiver-side rejection), or
 *    - its failureReason carries an SMTP 5xx response code.
 *  Hard bounces are not retryable — the receiving server has actively
 *  refused delivery and re-sending will just bounce again. */
export function isHardBounce(msg: {
  status: MailMessage['status'];
  failureReason: string | null;
}): boolean {
  if (msg.status === 'bounced') return true;
  return msg.failureReason ? HARD_BOUNCE_RE.test(msg.failureReason) : false;
}

export interface RetryResult {
  retried: bigint[];
  skippedHardBounce: bigint[];
  skippedIneligible: bigint[];
  errors: Array<{ id: bigint; error: string }>;
}

/** Re-send a batch of failed messages. For each id we look up the
 *  original row, skip ineligible ones (not outbound, not in
 *  failed/bounced), skip hard bounces, and otherwise call sendMessage
 *  with the original payload. On success we trash the original so the
 *  Errors folder stays clean — the new send gets its own row + its own
 *  messageId and threads onto the same conversation. */
export async function retrySend(
  ctx: WorkspaceContext,
  ids: ReadonlyArray<bigint>,
  providerOverride?: IMailProvider,
): Promise<RetryResult> {
  if (!canWrite(ctx)) throw permissionDenied('mail.retry_send');
  const result: RetryResult = {
    retried: [],
    skippedHardBounce: [],
    skippedIneligible: [],
    errors: [],
  };
  if (ids.length === 0) return result;

  const originals = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        inArray(mailMessages.id, [...ids]),
      ),
    );

  for (const original of originals) {
    if (
      original.direction !== 'outbound' ||
      (original.status !== 'failed' && original.status !== 'bounced')
    ) {
      result.skippedIneligible.push(original.id);
      continue;
    }
    if (isHardBounce(original)) {
      result.skippedHardBounce.push(original.id);
      continue;
    }
    try {
      await sendMessage(ctx, {
        mailboxId: original.mailboxId,
        to: original.toAddresses.map((address) => ({ address })),
        cc: original.ccAddresses.map((address) => ({ address })),
        bcc: original.bccAddresses.map((address) => ({ address })),
        subject: original.subject,
        text: original.bodyText ?? undefined,
        html: original.bodyHtml ?? undefined,
        inReplyTo: original.inReplyTo ?? undefined,
        references: original.references,
        sourceDraftId: original.sourceDraftId ?? undefined,
        providerOverride,
      });
      // Trash the original so a successful retry actually clears the
      // Errors folder. The full history stays in audit_log + the row
      // is recoverable from Trash if the operator needs to inspect it.
      const now = new Date();
      await db
        .update(mailMessages)
        .set({ trashedAt: now, updatedAt: now })
        .where(eq(mailMessages.id, original.id));
      result.retried.push(original.id);
    } catch (err) {
      result.errors.push({
        id: original.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (
    result.retried.length > 0 ||
    result.errors.length > 0 ||
    result.skippedHardBounce.length > 0
  ) {
    await recordAuditEvent(ctx, {
      kind: 'mail.retry_send',
      entityType: 'mail_message',
      payload: {
        retried: result.retried.map(String),
        skippedHardBounce: result.skippedHardBounce.map(String),
        skippedIneligible: result.skippedIneligible.map(String),
        errors: result.errors.map((e) => ({
          id: e.id.toString(),
          error: e.error,
        })),
      },
    });
  }

  return result;
}

// ---- threading -----------------------------------------------------

interface ThreadKeyInput {
  subject: string;
  inReplyTo: string | null;
  references: string[];
  participants: string[];
}

async function ensureThread(
  ctx: WorkspaceContext,
  mailboxId: bigint,
  input: ThreadKeyInput,
): Promise<MailThread> {
  const key = computeThreadKey(input);

  // First, see whether a prior message we already persisted carries any of
  // the message IDs in the reply chain. If so, that's our thread — even if
  // the original was created under a subject-derived key (likely when this
  // thread started as our outbound). This is what stitches together the
  // first send (no References) with its first reply (References = first).
  const replyChainIds = mergeUniqueLower([
    ...input.references,
    ...(input.inReplyTo ? [input.inReplyTo] : []),
  ]);
  if (replyChainIds.length > 0) {
    const linked = await db
      .select({ threadId: mailMessages.threadId })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.workspaceId, ctx.workspaceId),
          eq(mailMessages.mailboxId, mailboxId),
          inArray(mailMessages.messageId, replyChainIds),
        ),
      )
      .limit(1);
    if (linked[0]?.threadId) {
      const threadRows = await db
        .select()
        .from(mailThreads)
        .where(eq(mailThreads.id, linked[0].threadId))
        .limit(1);
      if (threadRows[0]) {
        const merged = mergeUniqueLower([
          ...threadRows[0].participants,
          ...input.participants,
        ]);
        if (merged.length !== threadRows[0].participants.length) {
          await db
            .update(mailThreads)
            .set({ participants: merged, updatedAt: new Date() })
            .where(eq(mailThreads.id, threadRows[0].id));
        }
        return threadRows[0];
      }
    }
  }

  const existing = await db
    .select()
    .from(mailThreads)
    .where(
      and(
        eq(mailThreads.workspaceId, ctx.workspaceId),
        eq(mailThreads.mailboxId, mailboxId),
        eq(mailThreads.externalThreadKey, key),
      ),
    )
    .limit(1);
  if (existing[0]) {
    // Merge participants (lowercased + deduped).
    const merged = mergeUniqueLower([
      ...existing[0].participants,
      ...input.participants,
    ]);
    if (merged.length !== existing[0].participants.length) {
      await db
        .update(mailThreads)
        .set({ participants: merged, updatedAt: new Date() })
        .where(eq(mailThreads.id, existing[0].id));
    }
    return existing[0];
  }

  const row: NewMailThread = {
    workspaceId: ctx.workspaceId,
    mailboxId,
    subject: stripReplyPrefix(input.subject),
    externalThreadKey: key,
    messageCount: 0,
    participants: mergeUniqueLower(input.participants),
  };
  const [created] = await db.insert(mailThreads).values(row).returning();
  if (!created) throw invariant('mail_thread insert returned no row');
  return created;
}

function computeThreadKey(input: ThreadKeyInput): string {
  // Prefer the root of the References chain, falling back to In-Reply-To,
  // falling back to a normalized subject.
  if (input.references.length > 0) return input.references[0]!;
  if (input.inReplyTo) return input.inReplyTo;
  return `subj:${stripReplyPrefix(input.subject).toLowerCase().slice(0, 200)}`;
}

function stripReplyPrefix(subject: string): string {
  return subject.replace(/^(re|fw|fwd|aw|sv)\s*[:：]\s*/gi, '').trim();
}

function mergeUniqueLower(list: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const v = raw.trim().toLowerCase();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function collectParticipants(out: OutboundMessage): string[] {
  return [
    out.from.address,
    ...out.to.map((a) => a.address),
    ...(out.cc ?? []).map((a) => a.address),
    ...(out.bcc ?? []).map((a) => a.address),
  ];
}

async function touchThread(threadId: bigint): Promise<void> {
  const counts = await db
    .select()
    .from(mailMessages)
    .where(eq(mailMessages.threadId, threadId))
    .orderBy(desc(mailMessages.createdAt));
  await db
    .update(mailThreads)
    .set({
      messageCount: counts.length,
      lastMessageAt: counts[0]?.createdAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(eq(mailThreads.id, threadId));
}

// re-export for tests
void inArray;
void or;
