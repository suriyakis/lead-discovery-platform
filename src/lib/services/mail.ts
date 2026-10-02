// Mail send/receive service. Wraps IMailProvider with persistence: every
// outbound + inbound message is persisted, threaded by header heuristic,
// and audit-logged. Suppression list is checked before every send.

import { appOrigin } from '@/lib/app-origin';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  mailMessages,
  mailThreads,
  mailboxes,
  type Mailbox,
  type MailMessage,
  type MailThread,
  type NewMailMessage,
  type NewMailThread,
} from '@/lib/db/schema/mailing';
import type { MailFolder } from './mail-folders';
import {
  classifySyncFailure,
  computeBackoffMs,
  nextSyncAfterEmpty,
  syncFailureThreshold,
} from './imap-backoff';
import { recordAuditEvent } from './audit';
import {
  AutomationGateError,
  assertGate,
  checkGate,
  decideGate,
  loadAutomationState,
  originForDraft,
  reconcileOwnerIncident,
  type SendOrigin,
} from './automation-gate';
import { canWrite, isAutomatic, type WorkspaceContext } from './context';
import {
  buildProviderFor,
  markMailboxFailing,
  recordMailboxConnectionCheck,
  runConnectionTest,
  type MailboxCheckOutcome,
} from './mailbox';
import { attachContact, upsertContact } from './contacts';
import { isSuppressed, recordBounce } from './suppression';
import {
  classifySmtpError,
  hardRejectedFromPartial,
  isRecipientHardBounceText,
} from '@/lib/mail/smtp-errors';
import { isAfterDelivery, tagAfterDelivery, tagTransportFailure } from '@/lib/mail/send-failure';
import { outreachQueue } from '@/lib/db/schema/outreach';
import { resolveSendInterrupted } from '@/lib/ops/work-incidents';
import {
  DELIVERED_MESSAGE_STATUSES,
  draftIsBeingSent,
  findDeliveredCopyOfDraft,
  markDraftQueueEntriesSent,
  trashEarlierFailedCopies,
} from './outreach-queue-sent';
import { defaultSignature, renderSignatureHtml, renderSignatureText } from './signatures';
import { analyseReply } from './reply-classifier';
import { maybeAutoTranslateInbound } from './translation';
import { assessInboundRelevance } from './inbound-relevance';
import {
  extractRelevanceSignals,
  isOutreachLinked,
  type OutreachRelevance,
} from '@/lib/mail/relevance';
import { getUnsubscribeFooter } from '@/lib/i18n/email-footer';
import { randomUUID } from 'node:crypto';
import {
  classifyMailboxFailure,
  describeConnectionError,
  type MailboxFailureClass,
} from '@/lib/mail/connection-errors';
import { describeLeaseHolder, withWorkLease, type LeaseHolder } from './work-leases';
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

/**
 * flow:F-05 (I089) — what kind of mail this is.
 *   one_to_one → a person writing to a person: compose, thread replies,
 *                drafts answering a prospect's reply. No bulk unsubscribe
 *                footer and no List-Unsubscribe headers.
 *   sequence   → outreach the platform sends on the operator's behalf:
 *                cold first touches and follow-ups. Carries the visible
 *                unsubscribe footer plus RFC 8058 List-Unsubscribe(-Post).
 * Required on every send so no caller gets either behaviour by accident.
 */
export type SendMode = 'one_to_one' | 'sequence';

/** Mode of an already-sent / failed message, read back from the headers
 *  it was built with (only sequence mail carries List-Unsubscribe). */
export function sendModeFromHeaders(headers: unknown): SendMode {
  if (headers && typeof headers === 'object') {
    for (const key of Object.keys(headers as Record<string, unknown>)) {
      if (key.toLowerCase() === 'list-unsubscribe') return 'sequence';
    }
  }
  return 'one_to_one';
}

export interface SendMailInput {
  /** flow:F-05 — see SendMode. */
  mode: SendMode;
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
  /** Phase 63 (Flow A) dual-language. `text`/`html` are the target-language
   *  text actually sent; these record the operator-approved native-language
   *  reference and the ISO codes of each side so the thread view can show
   *  both. All optional — single-language sends leave them undefined. */
  bodyTextNative?: string | null;
  nativeLanguage?: string | null;
  targetLanguage?: string | null;
  /** Phase 57 — one-shot signature override.
   *    undefined → use the mailbox default (current behaviour)
   *    null      → no signature
   *    bigint    → use that specific signature (validated against workspace) */
  signatureId?: bigint | null;
  /** PC-06: true for sends the platform makes on its own (the queue
   *  drain, a follow-up the tick sends without approval). Defaults to the
   *  context (ctx.trigger). The automation gate refuses every send under
   *  a Sending hold or the platform outbound stop; automatic ones also
   *  when the workspace has no accountable owner. */
  automatic?: boolean;
  /** flow:F-07 / PC-05 — where this email comes from (SendOrigin): the
   *  go-live hold holds cold, follow_up and ai_reply mail until the
   *  workspace is live. Required on every send, like `mode`, so no caller
   *  slips past the hold by accident. */
  origin: SendOrigin;
  /** PC-05: a person confirmed "send anyway" while automation is paused.
   *  Only manual sends can be confirmed; each confirmed send is audited
   *  (outbound.override) before it goes out. */
  confirmPaused?: boolean;
  /**
   * PC-10 (I013): runs inside the transaction that inserts the sent
   * message's mail_messages row, so the caller's own record of the send
   * (the queue row turning 'sent') commits together with it. If the hook
   * fails, the message is recorded on its own (it WAS delivered) and the
   * caller's record is reconciled later (the stuck-work reaper finds the
   * sent copy).
   */
  onPersisted?: (tx: SendTx, message: MailMessage) => Promise<void>;
  /** Test-only override; production passes undefined. */
  providerOverride?: IMailProvider;
}

/** The transaction handed to SendMailInput.onPersisted. */
export type SendTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Send one email and record it.
 *
 * PC-10: errors are tagged for the queue's failure model
 * (src/lib/mail/send-failure.ts) without changing them: a provider.send
 * failure carries its SMTP classification, and anything thrown after the
 * server accepted the message is marked "after delivery" — the email went
 * out, so no caller may treat it as unsent and send it again.
 */
export async function sendMessage(
  ctx: WorkspaceContext,
  input: SendMailInput,
): Promise<MailMessage> {
  const phase: SendPhase = { delivered: false };
  try {
    return await sendAndRecord(ctx, input, phase);
  } catch (err) {
    if (phase.delivered) tagAfterDelivery(err);
    throw err;
  }
}

interface SendPhase {
  /** Set once provider.send has returned: the server took the message. */
  delivered: boolean;
}

async function sendAndRecord(
  ctx: WorkspaceContext,
  input: SendMailInput,
  phase: SendPhase,
): Promise<MailMessage> {
  if (!canWrite(ctx)) throw permissionDenied('mail.send');
  if (input.to.length === 0) throw invalid('at least one recipient required');
  const subject = input.subject.trim();
  if (!subject) throw invalid('subject required');
  if (!input.text && !input.html) throw invalid('text or html body required');

  // PC-06 + PC-05: holds, the platform outbound stop, (automatic sends)
  // the accountable-owner rule, the workspace pause (a manual send only
  // after "send anyway") and the go-live hold for this origin — before
  // anything is rendered or sent.
  const manual = input.automatic === undefined ? !isAutomatic(ctx) : !input.automatic;
  const gateState = await loadAutomationState(ctx.workspaceId);
  if (!manual) await reconcileOwnerIncident(gateState);
  const gateItem = {
    manual,
    origin: input.origin,
    confirmPaused: manual && input.confirmPaused === true,
  };
  const gate = decideGate(gateState, 'sending', gateItem);
  if (!gate.allowed) throw new AutomationGateError(gate);

  // Suppression check — reject if ANY recipient is suppressed.
  for (const addr of [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])]) {
    if (await isSuppressed(ctx, addr.address)) throw suppressed(addr.address);
  }

  const { mailbox, provider } = await buildProviderFor(
    ctx,
    input.mailboxId,
    input.providerOverride,
  );
  // PC-05 (P0-F08, I095): an automatic send from a mailbox that is not
  // active is held by the gate (the caller defers it, nothing fails); a
  // person sending by hand gets the mailbox's own reason below.
  const mailboxGate = decideGate(gateState, 'sending', {
    ...gateItem,
    mailboxStatus: mailbox.status,
  });
  if (!mailboxGate.allowed) throw new AutomationGateError(mailboxGate);
  if (mailbox.status === 'archived') {
    throw new MailServiceError('mailbox is archived', 'invalid_input');
  }
  if (mailbox.status === 'paused') {
    throw new MailServiceError(
      'mailbox is paused — re-enable it from Edit mailbox to resume sends',
      'invalid_input',
    );
  }
  // PC-05: a manual send the person confirmed while automation is paused
  // is audited before it goes out, so it is on record even if the send
  // then fails.
  if (gate.pauseOverridden) {
    await recordAuditEvent(ctx, {
      kind: 'outbound.override',
      entityType: 'mailbox',
      entityId: mailbox.id,
      payload: {
        override: 'automation_paused',
        origin: input.origin,
        pausedAt: gateState.pause?.since.toISOString() ?? null,
        pausedByUserId: gateState.pause?.byUserId ?? null,
        to: input.to.map((a) => a.address),
        subject,
      },
    });
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
          and(eq(signatures.workspaceId, ctx.workspaceId), eq(signatures.id, input.signatureId)),
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
  // The public origin (APP_URL, else AUTH_URL; never a loopback one in
  // production): the base of the pixel and unsubscribe links.
  const appUrl = appOrigin().origin;
  if (outboundHtml) {
    const pixelUrl = `${appUrl}/api/track/${trackingToken}.gif`;
    outboundHtml = `${outboundHtml}<img src="${pixelUrl}" width="1" height="1" alt="" style="display:block;margin:0;padding:0;border:0" />`;
  }

  // Phase 35: RFC 8058 one-click unsubscribe. Same trackingToken doubles
  // as the unsubscribe token (workspace-scoped, single-use, opaque). The
  // public route lives at /api/unsubscribe/<token>: GET shows a
  // confirmation page, only POST records the opt-out (flow:F-05).
  // flow:F-05: sequence mail only — a one-to-one message (compose, a
  // thread reply) is personal correspondence and carries neither the
  // headers nor the bulk footer.
  if (input.mode === 'sequence') {
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
    // Phase 63: localize the unsubscribe footer to the email's target
    // language so a foreign-language body doesn't carry an English footer.
    const footer = getUnsubscribeFooter(input.targetLanguage);
    const footerText = `\n\n---\n${footer.prompt} ${unsubUrl}`;
    const footerHtml = `<div dir="${footer.dir}" style="margin-top:24px;padding-top:12px;border-top:1px solid #ccc;font-size:12px;color:#888;font-family:Arial,sans-serif"><a href="${unsubUrl}" style="color:#888;text-decoration:underline">${footer.unsubscribe}</a></div>`;
    outboundText = (outboundText ?? '') + footerText;
    if (outboundHtml) {
      outboundHtml = outboundHtml + footerHtml;
    }
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

  const attempted = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])].map((a) => a.address);

  let sendResult;
  try {
    sendResult = await provider.send(out);
  } catch (err) {
    // flow:F-05 (I007): classify before suppressing. Only a recipient the
    // server refused at RCPT TO as non-existent / disabled is suppressed
    // (source smtp). Our own failures — a refused login, a dead
    // connection, a 4xx, a policy or relay refusal — never touch the
    // recipient; a refused login marks the mailbox failing instead.
    const e = err as { responseCode?: number; message?: string };
    const responseCode = e?.responseCode ?? null;
    const failure = classifySmtpError(err, attempted);
    let failedRowId: bigint | null = null;
    // P61-08: persist the failure as a mail_messages row so it lands in
    // the Errors folder AND so future bounce-loop detection has the
    // history to count against. We never let the persistence fail bubble
    // up — the send already threw and that contract is preserved.
    try {
      const failureReason = e?.message ?? (err instanceof Error ? err.message : String(err));
      // 'bounced' is reserved for a recipient hard rejection; isHardBounce
      // (and so Retry) relies on that.
      const failedStatus: MailMessage['status'] =
        failure.kind === 'recipient_hard' ? 'bounced' : 'failed';
      const primaryAddress = input.to[0]?.address ?? null;
      const isLoop =
        primaryAddress !== null &&
        (await detectBounceLoop(ctx, mailbox.id, primaryAddress, {
          excludeDraftId: input.sourceDraftId ?? null,
        }));
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
        bodyTextNative: input.bodyTextNative ?? null,
        nativeLanguage: input.nativeLanguage ?? null,
        targetLanguage: input.targetLanguage ?? null,
        headers: headers as unknown as Record<string, unknown>,
        attachments: [],
        failureReason: responseCode
          ? `${responseCode} ${failureReason}`.slice(0, 4000)
          : failureReason.slice(0, 4000),
        sourceDraftId: input.sourceDraftId ?? null,
        spamAt: isLoop ? new Date() : null,
        spamReason: isLoop ? 'bounce_loop' : null,
        createdBy: ctx.userId,
      };
      const [failedInserted] = await db
        .insert(mailMessages)
        .values(failedRow)
        .returning({ id: mailMessages.id });
      failedRowId = failedInserted?.id ?? null;
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

    for (const address of failure.hardRejectedRecipients) {
      try {
        await recordBounce(
          ctx,
          address,
          'hard',
          (e?.message ?? null)?.slice(0, 1000) ?? null,
          failedRowId ? `mail_message:${failedRowId}` : null,
        );
      } catch (bounceErr) {
        console.error('[mail.send] bounce suppression failed:', bounceErr);
      }
    }
    if (failure.kind === 'auth') {
      // PC-09: class 'auth' — nothing retries the login automatically.
      try {
        await markMailboxFailing(ctx, mailbox.id, {
          protocol: 'smtp',
          message: e?.message ?? String(err),
          failureClass: 'auth',
        });
      } catch (markErr) {
        console.error('[mail.send] could not mark the mailbox failing:', markErr);
      }
    }
    // PC-10: the queue reads this to decide retry / hold / fail.
    tagTransportFailure(err, failure);
    throw err;
  }
  phase.delivered = true;

  // flow:F-05: the server accepted the message but refused some
  // recipients. A refusal that says the address does not exist suppresses
  // that address only; anything else is left alone.
  const partialHard = hardRejectedFromPartial(sendResult.rejected, attempted);

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
    bodyTextNative: input.bodyTextNative ?? null,
    nativeLanguage: input.nativeLanguage ?? null,
    targetLanguage: input.targetLanguage ?? null,
    headers: headers as unknown as Record<string, unknown>,
    attachments: [],
    sentAt: new Date(),
    sourceDraftId: input.sourceDraftId ?? null,
    contactId,
    trackingToken,
    createdBy: ctx.userId,
  };

  const created = await persistSentMessage(row, input.onPersisted);

  // PC-10 (I013): from here on the email is delivered AND recorded. The
  // bookkeeping below is best-effort: a failure in it must not reach the
  // caller, which would read it as a failed send (and the queue would
  // mark a delivered email failed, or send it again).
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

  for (const address of partialHard) {
    try {
      const rejection = sendResult.rejected?.find(
        (r) => r.address.trim().toLowerCase() === address,
      );
      await recordBounce(
        ctx,
        address,
        'hard',
        rejection?.response?.slice(0, 1000) ?? null,
        `mail_message:${created.id}`,
      );
    } catch (bounceErr) {
      console.error('[mail.send] bounce suppression failed:', bounceErr);
    }
  }

  try {
    await recordAuditEvent(ctx, {
      kind: 'mail.send',
      entityType: 'mail_message',
      entityId: created.id,
      payload: {
        mailboxId: mailbox.id.toString(),
        mode: input.mode,
        to: input.to.map((a) => a.address),
        threadId: thread.id.toString(),
        sourceDraftId: input.sourceDraftId?.toString() ?? null,
        ...(sendResult.rejected && sendResult.rejected.length > 0
          ? {
              rejected: sendResult.rejected.map((r) => ({
                address: r.address,
                response: r.response,
                suppressed: partialHard.includes(r.address.trim().toLowerCase()),
              })),
            }
          : {}),
      },
    });
  } catch (err) {
    console.error(
      `[mail.send] audit row for sent message ${created.id} not written:`,
      err instanceof Error ? err.message : err,
    );
  }

  try {
    await touchThread(thread.id);
  } catch (err) {
    console.error(
      `[mail.send] thread ${thread.id} counters not updated:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Phase 58: schedule auto follow-ups when this is the FIRST outbound
  // on a thread linked to a qualified lead. Best-effort — failures log
  // but never break the send.
  // PC-10: the first DELIVERED outbound. A failed attempt reached nobody
  // (as for the caps and the cooldown): a first touch that went out on an
  // automatic retry shares the thread with its failed attempts and still
  // gets its follow-ups.
  try {
    const outboundCount = await db
      .select({ id: mailMessages.id })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.workspaceId, ctx.workspaceId),
          eq(mailMessages.threadId, thread.id),
          eq(mailMessages.direction, 'outbound'),
          inArray(mailMessages.status, [...DELIVERED_MESSAGE_STATUSES]),
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

/**
 * PC-10: insert the delivered message's row and run the caller's
 * onPersisted hook in one transaction. When the transaction fails with a
 * hook, the row is inserted on its own: the email went out and must be
 * on record; the caller's state (a queue row still 'sending') is settled
 * by the stuck-work reaper, which matches it to this row. Without a hook
 * an insert failure propagates as before.
 */
async function persistSentMessage(
  row: NewMailMessage,
  onPersisted: SendMailInput['onPersisted'],
): Promise<MailMessage> {
  try {
    return await db.transaction(async (tx) => {
      const [inserted] = await tx.insert(mailMessages).values(row).returning();
      if (!inserted) throw invariant('mail_message insert returned no row');
      if (onPersisted) await onPersisted(tx, inserted);
      return inserted;
    });
  } catch (err) {
    if (!onPersisted) throw err;
    console.error(
      '[mail.send] recording the send with its caller hook failed; recording the message alone:',
      err instanceof Error ? err.message : err,
    );
    const [inserted] = await db.insert(mailMessages).values(row).returning();
    if (!inserted) throw invariant('mail_message insert returned no row');
    return inserted;
  }
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
  // PC-05: a test send bypasses sendMessage, so it asks the gate itself.
  // A Sending hold or the platform outbound stop refuses it like any send;
  // the workspace pause does not — pressing "Send test" on the mailbox page
  // is the person's explicit, audited (mail.send_test) choice, made to
  // check the mailbox, which is what one does while paused.
  await assertGate(ctx, 'sending', { manual: true, origin: 'manual', confirmPaused: true });

  const { mailbox, provider } = await buildProviderFor(
    ctx,
    input.mailboxId,
    input.providerOverride,
  );
  if (mailbox.status === 'archived') {
    throw new MailServiceError('mailbox is archived', 'invalid_input');
  }
  if (mailbox.status === 'paused') {
    throw new MailServiceError(
      'mailbox is paused — re-enable it from Edit mailbox to resume sends',
      'invalid_input',
    );
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
      .where(and(eq(signatures.workspaceId, ctx.workspaceId), eq(signatures.id, input.signatureId)))
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

/** PC-12: the mailbox's sync lease is held by another sync or check. */
export const MAILBOX_BUSY = 'mailbox_busy';

/** "A sync or connection check of this mailbox is already running since …". */
export function mailboxBusyMessage(held: LeaseHolder): string {
  return `A sync or connection check of this mailbox is already running ${describeLeaseHolder(held)}. Try again when it has finished.`;
}

/**
 * Fetch and store a mailbox's new inbound mail. PC-12 (I067): under the
 * mailbox's 'mailbox.sync' lease, like every other sync and connection
 * check of it; while another holds it this throws MAILBOX_BUSY and
 * touches nothing. The IMAP tick and the Sync buttons go through
 * safeSyncOne (backoff and failure bookkeeping); this is the bare sync.
 */
export async function syncInbound(
  ctx: WorkspaceContext,
  mailboxId: bigint,
  providerOverride?: IMailProvider,
): Promise<SyncInboundResult> {
  if (!canWrite(ctx)) throw permissionDenied('mail.sync_inbound');
  // PC-06: an Inbox-sync hold stops the tick and manual Sync alike (X6:
  // the disabled feature flag stopped nothing).
  await assertGate(ctx, 'inbox_sync');
  const leased = await withWorkLease(
    ctx,
    { kind: 'mailbox.sync', resource: mailboxId, purpose: 'sync' },
    () => syncInboundHeld(ctx, mailboxId, providerOverride),
  );
  if (leased.status === 'ran') return leased.value;
  throw new MailServiceError(mailboxBusyMessage(leased.held), MAILBOX_BUSY);
}

/** syncInbound's work; the caller holds the mailbox's sync lease. */
async function syncInboundHeld(
  ctx: WorkspaceContext,
  mailboxId: bigint,
  providerOverride?: IMailProvider,
): Promise<SyncInboundResult> {
  const { mailbox, provider } = await buildProviderFor(ctx, mailboxId, providerOverride);
  const since = mailbox.lastSyncedAt ?? undefined;
  const messages = await provider.fetchInbound({ since, limit: 100 });

  let inserted = 0;
  let duplicates = 0;
  const relevance: Partial<Record<OutreachRelevance, number>> = {};
  for (const inbound of messages) {
    const outcome = await persistInbound(ctx, mailbox.id, inbound);
    if (outcome.existed) {
      duplicates++;
    } else {
      inserted++;
      relevance[outcome.relevance] = (relevance[outcome.relevance] ?? 0) + 1;
    }
  }

  await db
    .update(mailboxes)
    .set({ lastSyncedAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(and(eq(mailboxes.workspaceId, ctx.workspaceId), eq(mailboxes.id, mailbox.id)));

  // PC-35 (I066): audited only when the sync stored something. An empty
  // (or all-duplicate) sync changed nothing, and the 2-minute IMAP tick
  // used to fill the audit log with them. The mailbox's last_synced_at
  // above still says when it last synced. These rows are kept
  // SYNC_AUDIT_RETENTION_DAYS (services/retention.ts).
  if (inserted > 0) {
    await recordAuditEvent(ctx, {
      kind: 'mail.sync_inbound',
      entityType: 'mailbox',
      entityId: mailbox.id,
      payload: { fetched: messages.length, inserted, duplicates, relevance },
    });
  }

  return { fetched: messages.length, inserted, duplicates };
}

type PersistInboundOutcome = { existed: true } | { existed: false; relevance: OutreachRelevance };

/**
 * Store one fetched message, then run the reply pipeline only when it is
 * about our outreach (flow:F-01, X1). Every message is stored and threaded
 * so it still shows in Conversations; what differs is the side effects:
 *
 *   relevance        contact  classify+auto-actions  translate  notify
 *   prospect_reply     yes            yes               yes       yes
 *   auto_reply         yes            yes               yes        —
 *   bounce              —             yes                —         —
 *   bulk / unrelated    —              —                 —         —
 *
 * "classify" (analyseReply) also covers the outreach reply handler and
 * follow-up cancellation. A bounce's sender is the mailer daemon, so it is
 * never made a contact; lead.replied is for people answering us (I161).
 *
 * PC-12 (I067): the insert is ON CONFLICT (workspace, message_id) DO
 * NOTHING. The same email can reach two of a workspace's mailboxes (CC'd
 * to both) and their syncs run side by side; the one that stores it second
 * used to hit the unique index, throw, and count a spurious IMAP failure
 * against a healthy mailbox. Now it is a duplicate like any other, with no
 * side effects.
 */
async function persistInbound(
  ctx: WorkspaceContext,
  mailboxId: bigint,
  inbound: InboundMessage,
): Promise<PersistInboundOutcome> {
  // Dedup by (workspace, message_id) — the cheap check; the insert below
  // settles a race the check cannot see.
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
  if (existing[0]) return { existed: true };

  const assessment = await assessInboundRelevance(ctx, {
    fromAddress: inbound.from.address,
    inReplyTo: inbound.inReplyTo,
    references: inbound.references,
    receivedAt: inbound.receivedAt,
    signals:
      inbound.relevanceSignals ??
      extractRelevanceSignals({
        headers: inbound.headers,
        fromAddress: inbound.from.address,
        source: 'stored_headers',
      }),
  });
  const relevance = assessment.relevance;
  const fromCounterpart = relevance === 'prospect_reply' || relevance === 'auto_reply';

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

  // Phase 16: resolve / upsert the sender as a contact + attach — only for
  // people answering our outreach (I165: newsletters, no-reply and daemon
  // senders no longer fill the contact book).
  let contactId: bigint | null = null;
  if (fromCounterpart) {
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
  }

  const [insertedRow] = await db
    .insert(mailMessages)
    .values({
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
      outreachRelevance: relevance,
      relevanceSignals: assessment.signals,
    } satisfies NewMailMessage)
    .onConflictDoNothing({ target: [mailMessages.workspaceId, mailMessages.messageId] })
    .returning({ id: mailMessages.id });
  // Another sync stored it between the check above and this insert.
  if (!insertedRow) return { existed: true };

  await touchThread(thread.id);

  // Bulk and unrelated mail stops here: stored, threaded, no side effects.
  if (!isOutreachLinked(relevance)) {
    return { existed: false, relevance };
  }

  // Phase 20: classify the inbound + run auto-actions inline. Best-effort.
  // Phase 42: auto-translate non-English bodies inline so the operator
  // sees the English version on first thread open. Heuristic-gated so
  // English mail never bills the AI.
  try {
    await analyseReply(ctx, insertedRow.id);
    if (fromCounterpart) {
      await maybeAutoTranslateInbound(ctx, insertedRow.id);
    }
  } catch (err) {
    console.error('[mail.persistInbound] post-receive hooks failed:', err);
  }

  // Pull the team back to the app — a reply is the highest-value event
  // in the whole pipeline. Only a person answering our outreach counts
  // (I161): not auto-replies, not bounces. Best-effort by construction
  // (notify never throws) and deduped per thread while unread.
  if (relevance === 'prospect_reply') {
    const { notify } = await import('./notifications');
    await notify(ctx.workspaceId, {
      kind: 'lead.replied',
      title: `Reply from ${inbound.from.name ?? inbound.from.address}`,
      body: inbound.subject?.slice(0, 200) ?? null,
      href: `/communication/${thread.id}`,
      dedupeKey: `lead.replied:${thread.id}`,
    });
  }

  return { existed: false, relevance };
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
    .where(and(eq(mailThreads.workspaceId, ctx.workspaceId), eq(mailThreads.mailboxId, mailboxId)));
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
    .where(and(eq(mailThreads.workspaceId, ctx.workspaceId), eq(mailThreads.id, threadId)))
    .limit(1);
  if (!threadRows[0]) throw notFound();
  const messages = await db
    .select()
    .from(mailMessages)
    .where(and(eq(mailMessages.workspaceId, ctx.workspaceId), eq(mailMessages.threadId, threadId)))
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
      return and(isNull(mailMessages.trashedAt), isNotNull(mailMessages.spamAt)) as SQL;
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

export type MailSourceFilter = 'all' | 'outreach' | 'external';

export interface ListMessagesFilter {
  /** Omit to list across every mailbox in the workspace (Gmail-style
   *  unified inbox). Set to scope to a single mailbox. */
  mailboxId?: bigint;
  folder: MailFolder;
  limit?: number;
  offset?: number;
  /** Substring match against subject + from address + to addresses
   *  (case-insensitive). */
  search?: string;
  /** P61-17: filter by date range on mail_messages.createdAt. */
  dateFrom?: Date;
  dateTo?: Date;
  /** P61-17: 'outreach' = thread is linked to an outreach_thread_state
   *  row (i.e., app-driven conversation); 'external' = NOT linked
   *  (random inbound, manual sends); 'all' = both. */
  source?: MailSourceFilter;
  /** P61-17: filter to messages whose thread is linked to a qualified
   *  lead for this product. */
  productId?: bigint;
}

/** Shared WHERE-clause builder for listMessages + countMessagesMatching.
 *  Splitting it out so both helpers stay in lockstep. */
async function buildMessageFilterConditions(
  workspaceId: bigint,
  filter: ListMessagesFilter,
): Promise<SQL[]> {
  const conditions: SQL[] = [
    eq(mailMessages.workspaceId, workspaceId),
    folderFilter(filter.folder),
  ];
  if (filter.mailboxId !== undefined) {
    conditions.push(eq(mailMessages.mailboxId, filter.mailboxId));
  }
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
  if (filter.dateFrom) {
    conditions.push(gte(mailMessages.createdAt, filter.dateFrom));
  }
  if (filter.dateTo) {
    conditions.push(lte(mailMessages.createdAt, filter.dateTo));
  }
  if (filter.source === 'outreach' || filter.source === 'external') {
    const { outreachThreadState } = await import('@/lib/db/schema/outreach');
    const exists = sql`EXISTS (
      SELECT 1 FROM ${outreachThreadState}
      WHERE ${outreachThreadState.threadId} = ${mailMessages.threadId}
        AND ${outreachThreadState.workspaceId} = ${mailMessages.workspaceId}
    )`;
    conditions.push(
      filter.source === 'outreach'
        ? (exists as unknown as SQL)
        : (sql`NOT ${exists}` as unknown as SQL),
    );
  }
  if (filter.productId !== undefined) {
    const { outreachThreadState } = await import('@/lib/db/schema/outreach');
    const { qualifiedLeads } = await import('@/lib/db/schema/pipeline');
    conditions.push(
      sql`EXISTS (
        SELECT 1 FROM ${outreachThreadState}
        JOIN ${qualifiedLeads} ON ${qualifiedLeads.id} = ${outreachThreadState.qualifiedLeadId}
        WHERE ${outreachThreadState.threadId} = ${mailMessages.threadId}
          AND ${outreachThreadState.workspaceId} = ${mailMessages.workspaceId}
          AND ${qualifiedLeads.productProfileId} = ${filter.productId}
      )` as SQL,
    );
  }
  return conditions;
}

export interface MessageListRow {
  message: MailMessage;
  thread: { id: bigint; subject: string } | null;
}

export async function listMessages(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: ListMessagesFilter,
): Promise<MessageListRow[]> {
  const conditions = await buildMessageFilterConditions(ctx.workspaceId, filter);

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

/** P61-17: total count of messages matching `filter`. Same WHERE as
 *  listMessages. Drives pagination + dashboard totals. */
export async function countMessagesMatching(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: ListMessagesFilter,
): Promise<number> {
  const conditions = await buildMessageFilterConditions(ctx.workspaceId, filter);
  const rows = await db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(mailMessages)
    .where(and(...conditions));
  return rows[0]?.c ?? 0;
}

export type FolderCounts = Record<MailFolder, number>;

/** Single query returning all six folder counts. Pass `mailboxId` to
 *  scope to a single mailbox, or omit for the workspace-wide unified
 *  inbox count. Mirrors the priority order in deriveFolder via
 *  COUNT(*) FILTER. */
export async function countMessagesByFolder(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  mailboxId?: bigint,
): Promise<FolderCounts> {
  const where: SQL[] = [eq(mailMessages.workspaceId, ctx.workspaceId)];
  if (mailboxId !== undefined) {
    where.push(eq(mailMessages.mailboxId, mailboxId));
  }
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
    .where(and(...where));
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
    .where(and(eq(mailMessages.workspaceId, ctx.workspaceId), eq(mailMessages.id, id)))
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
      and(eq(mailMessages.workspaceId, ctx.workspaceId), inArray(mailMessages.id, eligibleIds)),
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

// ---- safe-sync (P61-25, flow:F-04, PC-09) --------------------------

export type SafeSyncOutcome =
  | {
      kind: 'synced';
      fetched: number;
      inserted: number;
      duplicates: number;
      /** A failing mailbox passed its check and is active again. */
      recovered: boolean;
    }
  /** The mailbox is failing and nothing was synced: it was just marked
   *  failing (a refused login, or too many failures in a row for its
   *  class), or it was already failing and a person's check failed again. */
  | {
      kind: 'failing';
      message: string;
      /** PC-09: why it fails (decides how it may recover). */
      failureClass: MailboxFailureClass | null;
      /** A new mailbox.failing notification was raised. */
      notified: boolean;
      /** When the health probes look at it next (null: nothing retries it
       *  automatically, or it was not marked). */
      nextProbeAt: Date | null;
    }
  | {
      kind: 'transient_failed';
      message: string;
      consecutiveFailures: number;
      nextSyncAfter: Date;
    }
  /** PC-12 (I067): another sync or check of this mailbox holds its lease
   *  (the tick and a Sync button at once). Nothing was done and nothing is
   *  recorded: not a failure, no backoff. */
  | {
      kind: 'busy';
      message: string;
      held: LeaseHolder;
    }
  /** PC-09: automatic work found the mailbox no longer active under its
   *  lease (it failed, or was paused, since the tick listed it). Nothing
   *  was done: a failing mailbox's recovery is the health probes', never
   *  a sync's login. */
  | {
      kind: 'skipped';
      message: string;
    };

/** Wraps syncInbound + the cron's post-result mailbox bookkeeping into
 *  one helper so both the IMAP tick (mail.imap.tick) AND the manual
 *  Sync buttons apply the same auth/backoff/auto-pause logic. Without
 *  this, manual clicks bypass the fail2ban defense and a broken
 *  mailbox can rack up failed LOGINs from operator impatience.
 *
 *  flow:F-04 / PC-09 — every failure is classified
 *  (lib/mail/connection-errors.ts) and leaves a non-null gate:
 *    - below its class's threshold (a network failure: 10 in a row; an
 *      unclear error: 3 — syncFailureThreshold): 2 min doubling to
 *      60 min, status stays active;
 *    - a refused login, or the threshold: markMailboxFailing with the
 *      class (its probe schedule, the incident, one notification);
 *    - a mailbox that is already failing is NOT synced. A person's Sync
 *      runs a full SMTP + IMAP check first (recordMailboxConnectionCheck):
 *      a pass makes it active and the sync runs. Automatic work never
 *      logs in to a failing mailbox: it is 'skipped' (the health probes
 *      own its recovery, services/mailbox-probes.ts).
 *
 *  Caller passes the resolved mailbox row — this helper does NOT
 *  enforce the imap_next_sync_after cooldown gate; that's the cron's
 *  job. Manual sync is explicitly "do it now".
 *
 *  PC-12 (I067): this is the one automatic inbound path (autopilot's own
 *  sync step is gone, PC-13), and it runs under the mailbox's
 *  'mailbox.sync' lease: a second sync or check of the same mailbox while
 *  one is running returns `busy` without logging in, so the two can no
 *  longer race on the message-id index and record a spurious failure.
 *  The row is re-read under the lease — the caller's copy may predate the
 *  sync that just finished (its counters, its failing status). */
export async function safeSyncOne(
  ctx: WorkspaceContext,
  mailbox: Pick<
    Mailbox,
    'id' | 'status' | 'imapHost' | 'imapConsecutiveFailures' | 'imapEmptySyncs'
  >,
): Promise<SafeSyncOutcome> {
  // Outside the try: a permission error is the caller's, not the server's,
  // and must not count as a mailbox failure.
  if (!canWrite(ctx)) throw permissionDenied('mail.sync_inbound');
  // PC-06: also outside the try. A hold is not a mailbox failure, so it
  // must neither count towards the auto-pause nor push the backoff.
  await assertGate(ctx, 'inbox_sync');

  const leased = await withWorkLease(
    ctx,
    {
      kind: 'mailbox.sync',
      resource: mailbox.id,
      purpose: isAutomatic(ctx) ? 'IMAP tick' : 'manual sync',
    },
    async () => safeSyncHeld(ctx, (await currentMailboxRow(ctx, mailbox.id)) ?? mailbox),
  );
  if (leased.status === 'ran') return leased.value;
  return { kind: 'busy', message: mailboxBusyMessage(leased.held), held: leased.held };
}

type SyncableMailbox = Pick<
  Mailbox,
  'id' | 'status' | 'imapHost' | 'imapConsecutiveFailures' | 'imapEmptySyncs'
>;

/** The mailbox's row as it is now (null when it is gone). */
async function currentMailboxRow(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  mailboxId: bigint,
): Promise<SyncableMailbox | null> {
  const [row] = await db
    .select({
      id: mailboxes.id,
      status: mailboxes.status,
      imapHost: mailboxes.imapHost,
      imapConsecutiveFailures: mailboxes.imapConsecutiveFailures,
      imapEmptySyncs: mailboxes.imapEmptySyncs,
    })
    .from(mailboxes)
    .where(and(eq(mailboxes.workspaceId, ctx.workspaceId), eq(mailboxes.id, mailboxId)))
    .limit(1);
  return row ?? null;
}

/** safeSyncOne's work; the caller holds the mailbox's sync lease. */
async function safeSyncHeld(
  ctx: WorkspaceContext,
  mailbox: SyncableMailbox,
): Promise<SafeSyncOutcome> {
  let recovered = false;
  if (isAutomatic(ctx) && mailbox.status !== 'active') {
    return {
      kind: 'skipped',
      message: `the mailbox is ${mailbox.status}; automatic sync only reads active mailboxes`,
    };
  }
  if (mailbox.status === 'failing') {
    const check = await recheckFailingMailbox(ctx, mailbox);
    if (!check.ok) {
      return {
        kind: 'failing',
        message: check.lastError ?? 'failed',
        failureClass: check.failureClass,
        notified: check.notified,
        nextProbeAt: check.nextProbeAt,
      };
    }
    recovered = check.recovered;
    // Outbound-only mailbox: the check was the whole job.
    if (!mailbox.imapHost) {
      return { kind: 'synced', fetched: 0, inserted: 0, duplicates: 0, recovered };
    }
  }
  const priorFailures = recovered ? 0 : mailbox.imapConsecutiveFailures;
  const priorEmpty = recovered ? 0 : mailbox.imapEmptySyncs;
  const scope = and(eq(mailboxes.workspaceId, ctx.workspaceId), eq(mailboxes.id, mailbox.id));

  try {
    // This call holds the lease already (syncInbound would find it held).
    const result = await syncInboundHeld(ctx, mailbox.id);
    // Success — reset failure counters, apply adaptive empty-sync delay.
    const nextEmpty = result.fetched === 0 ? priorEmpty + 1 : 0;
    const adaptiveNext = nextSyncAfterEmpty(new Date(), nextEmpty);
    await db
      .update(mailboxes)
      .set({
        imapConsecutiveFailures: 0,
        imapNextSyncAfter: adaptiveNext,
        imapEmptySyncs: nextEmpty,
        lastError: null,
        lastErrorAt: null,
        updatedAt: new Date(),
      })
      .where(scope);
    return {
      kind: 'synced',
      fetched: result.fetched,
      inserted: result.inserted,
      duplicates: result.duplicates,
      recovered,
    };
  } catch (err) {
    // describeConnectionError keeps imapflow's response code and text —
    // its refused LOGIN is otherwise a bare "Command failed".
    const msg = describeConnectionError(err);
    const failureClass = classifySyncFailure(err);
    const nextCount = priorFailures + 1;

    // Failing when the error is a refused login, or this class has failed
    // too often in a row (slow-burn fail2ban defense; an unclear error
    // sooner than a network one).
    if (nextCount >= syncFailureThreshold(failureClass)) {
      const marked = await markMailboxFailing(ctx, mailbox.id, {
        protocol: 'imap',
        message: msg,
        failureClass,
        consecutiveFailures: nextCount,
      });
      if (marked.marked) {
        return {
          kind: 'failing',
          message: msg,
          failureClass: marked.failureClass,
          notified: marked.notified,
          nextProbeAt: marked.nextProbeAt,
        };
      }
      // Paused / archived (a manual Sync): keep the operator's status and
      // record the failure like a transient one below.
    }

    const now = new Date();
    const nextSyncAfter = new Date(now.getTime() + computeBackoffMs(nextCount));
    await db
      .update(mailboxes)
      .set({
        imapConsecutiveFailures: nextCount,
        imapNextSyncAfter: nextSyncAfter,
        lastError: `IMAP: ${msg}`.slice(0, 2000),
        lastErrorAt: now,
        updatedAt: now,
      })
      .where(scope);
    return {
      kind: 'transient_failed',
      message: msg,
      consecutiveFailures: nextCount,
      nextSyncAfter,
    };
  }
}

/** A person's Sync of a failing mailbox checks it first (SMTP + IMAP),
 *  never just syncs it: an IMAP sync passing says nothing about the SMTP
 *  login that may be what failed. Counts as one more consecutive failed
 *  check when it fails. Never automatic (safeSyncHeld skips those). */
async function recheckFailingMailbox(
  ctx: WorkspaceContext,
  mailbox: Pick<Mailbox, 'id' | 'imapConsecutiveFailures'>,
): Promise<MailboxCheckOutcome> {
  const consecutiveFailures = mailbox.imapConsecutiveFailures + 1;
  let built: Awaited<ReturnType<typeof buildProviderFor>>;
  try {
    built = await buildProviderFor(ctx, mailbox.id);
  } catch (err) {
    // E.g. a password secret went missing — as much a failure as a
    // refused login, and the operator fixes it the same way.
    const message = describeConnectionError(err);
    const protocol = /\bSMTP\b/.test(message) ? 'smtp' : 'imap';
    const marked = await markMailboxFailing(ctx, mailbox.id, {
      protocol,
      message,
      failureClass: classifyMailboxFailure({ error: err }),
      consecutiveFailures,
    });
    return {
      ok: false,
      recovered: false,
      lastError: `${protocol === 'smtp' ? 'SMTP' : 'IMAP'}: ${message}`.slice(0, 2000),
      notified: marked.notified,
      failureClass: marked.failureClass,
      nextProbeAt: marked.nextProbeAt,
    };
  }
  const result = await runConnectionTest(built.provider);
  return recordMailboxConnectionCheck(ctx, built.mailbox, result, { consecutiveFailures });
}

// ---- trash purge (P61-09) ------------------------------------------

export const TRASH_RETENTION_DAYS_MIN = 0;
export const TRASH_RETENTION_DAYS_MAX = 365;
export const TRASH_RETENTION_DAYS_DEFAULT = 30;

export interface TrashPurgeResult {
  deleted: number;
  retentionDays: number;
  /** PC-05: the automation gate held the purge (the workspace pause, a
   *  Trash purge hold, no accountable owner); nothing was deleted. */
  heldReason?: string;
}

/** Unattended (cron) version: hard-delete rows in this workspace whose
 *  `trashed_at` is older than the workspace's `trash_retention_days`.
 *  A retention of 0 disables auto-purge (operator can still manually
 *  Empty trash now). Returns the count + the resolved retention so the
 *  cron logs are self-explanatory. */
export async function purgeOldTrashUnattended(workspaceId: bigint): Promise<TrashPurgeResult> {
  const { workspaces } = await import('@/lib/db/schema/workspaces');
  const rows = await db
    .select({ retentionDays: workspaces.trashRetentionDays })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const retentionDays = rows[0]?.retentionDays ?? TRASH_RETENTION_DAYS_DEFAULT;
  if (retentionDays <= 0) return { deleted: 0, retentionDays };
  // PC-05: the purge is automatic work — it stops while automation is
  // paused (and under a Trash purge hold), so nothing is lost while a
  // workspace is being looked at.
  const gate = await checkGate({ workspaceId, trigger: 'automation' }, 'trash_purge', {
    manual: false,
  });
  if (!gate.allowed) return { deleted: 0, retentionDays, heldReason: gate.message };
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
export async function emptyTrashNow(ctx: WorkspaceContext): Promise<{ deleted: number }> {
  const { canAdminWorkspace } = await import('./context');
  if (!canAdminWorkspace(ctx)) throw permissionDenied('mail.empty_trash_now');
  const deleted = await db
    .delete(mailMessages)
    .where(and(eq(mailMessages.workspaceId, ctx.workspaceId), isNotNull(mailMessages.trashedAt)))
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

/** P61-23: toggle IMAP auto-sync for the workspace. Admin-gated.
 *  When set to false the IMAP cron tick skips this workspace entirely;
 *  the operator only ever pulls mail via the manual Sync button.
 *  Returns the new value (true / false). */
export async function updateImapAutoSync(
  ctx: WorkspaceContext,
  enabled: boolean,
): Promise<{ imapAutoSyncEnabled: boolean }> {
  const { canAdminWorkspace } = await import('./context');
  if (!canAdminWorkspace(ctx)) throw permissionDenied('mail.update_auto_sync');
  const { workspaces } = await import('@/lib/db/schema/workspaces');
  await db
    .update(workspaces)
    .set({ imapAutoSyncEnabled: enabled, updatedAt: new Date() })
    .where(eq(workspaces.id, ctx.workspaceId));
  await recordAuditEvent(ctx, {
    kind: 'mail.update_auto_sync',
    payload: { imapAutoSyncEnabled: enabled },
  });
  return { imapAutoSyncEnabled: enabled };
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
  const clamped = Math.max(TRASH_RETENTION_DAYS_MIN, Math.min(TRASH_RETENTION_DAYS_MAX, days));
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
 *  cc / bcc — bounce loops only make sense for the primary recipient.
 *
 *  PC-10: a loop is different EMAILS failing, not one email retried. The
 *  queue retries a temporary failure up to 5 times and every attempt
 *  leaves a failed copy, so copies are counted per email: the failed
 *  copies of one draft count once, and those of `excludeDraftId` (the
 *  email being sent now) not at all. Mail without a draft counts per row. */
export async function detectBounceLoop(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  mailboxId: bigint,
  recipient: string,
  options: { excludeDraftId?: bigint | null } = {},
): Promise<boolean> {
  const cutoff = new Date(Date.now() - BOUNCE_LOOP_WINDOW_MS);
  const excludeDraftId = options.excludeDraftId ?? null;
  const rows = await db
    .select({
      // Raw SQL: one key per email — the draft when there is one, else
      // the row itself.
      c: sql<number>`COUNT(DISTINCT COALESCE('d' || ${mailMessages.sourceDraftId}::text, 'm' || ${mailMessages.id}::text))::int`,
    })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        eq(mailMessages.mailboxId, mailboxId),
        eq(mailMessages.direction, 'outbound'),
        inArray(mailMessages.status, ['failed', 'bounced']),
        sql`${recipient} = ANY (${mailMessages.toAddresses})`,
        gt(mailMessages.createdAt, cutoff),
        excludeDraftId !== null
          ? or(isNull(mailMessages.sourceDraftId), ne(mailMessages.sourceDraftId, excludeDraftId))
          : undefined,
      ),
    );
  const count = rows[0]?.c ?? 0;
  return count >= BOUNCE_LOOP_THRESHOLD - 1;
}

// ---- retry (P61-07) ------------------------------------------------

/** A message is "hard bounced" if either:
 *    - its status is 'bounced' (since flow:F-05 only set when the
 *      receiving server refused a recipient as non-existent / disabled), or
 *    - it failed and its failureReason reads as such a refusal (enhanced
 *      status 5.1.x / 5.2.1, or 550-class "user unknown" wording).
 *  Hard bounces are not retryable — re-sending will just bounce again.
 *  Any other 5xx (a refused SMTP login, a relay or policy refusal) is the
 *  sender's problem and stays retryable once it is fixed. */
export function isHardBounce(msg: {
  status: MailMessage['status'];
  failureReason: string | null;
}): boolean {
  if (msg.status === 'bounced') return true;
  if (msg.status !== 'failed') return false;
  return isRecipientHardBounceText(msg.failureReason);
}

/** flow:F-07: the origin of an email we already tried to send — from its
 *  draft when it had one (cold first touch or AI reply), otherwise a
 *  sequence email without a draft is a follow-up and anything else was
 *  written by a person. */
async function originOfSentMessage(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  msg: Pick<MailMessage, 'sourceDraftId' | 'headers'>,
): Promise<SendOrigin> {
  if (msg.sourceDraftId !== null) {
    const { outreachDrafts } = await import('@/lib/db/schema/outreach');
    const [draft] = await db
      .select({
        stage: outreachDrafts.stage,
        triggeredByMessageId: outreachDrafts.triggeredByMessageId,
      })
      .from(outreachDrafts)
      .where(
        and(
          eq(outreachDrafts.workspaceId, ctx.workspaceId),
          eq(outreachDrafts.id, msg.sourceDraftId),
        ),
      )
      .limit(1);
    // A draft that no longer exists was outreach: fail closed (cold).
    return draft ? originForDraft(draft) : 'cold';
  }
  return sendModeFromHeaders(msg.headers) === 'sequence' ? 'follow_up' : 'manual';
}

export interface RetryResult {
  retried: bigint[];
  skippedHardBounce: bigint[];
  skippedIneligible: bigint[];
  /** PC-10: copies of a draft whose email has already gone out (a sent
   *  copy exists, or a queue row of the draft is 'sent'). Not re-sent:
   *  moved to Trash with the draft's other failed copies. */
  skippedAlreadySent: bigint[];
  /** PC-10: further copies of a draft already tried earlier in the same
   *  batch. Automatic retries leave one failed copy per attempt; one
   *  email is tried once per Retry. */
  skippedDuplicate: bigint[];
  errors: Array<{ id: bigint; error: string }>;
  /** PC-10: outreach queue rows settled as 'sent' by a successful retry
   *  of their draft's email (failed ones, and waiting ones that would
   *  otherwise have sent it a second time). */
  queueEntriesSent: bigint[];
}

/** Why a retry of a draft-backed copy waits: the queue has it in flight. */
export const RETRY_DRAFT_IN_FLIGHT_ERROR =
  'The send queue is sending this email right now. Check Sent in a few minutes before retrying it.';

/** Re-send a batch of failed messages. For each id we look up the
 *  original row, skip ineligible ones (not outbound, not in
 *  failed/bounced), skip hard bounces, and otherwise call sendMessage
 *  with the original payload. On success we trash the original so the
 *  Errors folder stays clean — the new send gets its own row + its own
 *  messageId and threads onto the same conversation.
 *
 *  PC-10: a draft's email goes out once. Automatic queue retries leave a
 *  failed copy per attempt, so Errors can hold several copies of one
 *  email. Before each draft-backed copy the database is asked again (not
 *  the batch read) whether the draft's email has gone out — by an earlier
 *  copy in this batch, by the queue, or by another operator — and if so
 *  the copy is trashed, not sent. A draft is tried once per batch, and
 *  not while the queue is sending it. A delivered retry trashes every
 *  failed copy of its draft and settles the draft's queue rows in the same
 *  transaction as its mail row. */
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
    skippedAlreadySent: [],
    skippedDuplicate: [],
    errors: [],
    queueEntriesSent: [],
  };
  if (ids.length === 0) return result;
  // PC-06: refuse the whole batch up front under a Sending hold instead of
  // collecting the same refusal once per message. PC-05: also while
  // automation is paused — a bulk retry has no per-message "send anyway".
  {
    const gate = await checkGate(ctx, 'sending');
    if (!gate.allowed) {
      throw new AutomationGateError(
        gate.reason === 'paused'
          ? {
              ...gate,
              overridable: false,
              message:
                'Automation is paused, so failed emails are not retried. An owner or admin can resume it; to send one email now, reply from its thread and confirm "send anyway".',
            }
          : gate,
      );
    }
  }

  const originals = await db
    .select()
    .from(mailMessages)
    .where(and(eq(mailMessages.workspaceId, ctx.workspaceId), inArray(mailMessages.id, [...ids])))
    .orderBy(asc(mailMessages.id));

  /** Drafts already tried in this batch (sent or not). */
  const draftsTried = new Set<string>();
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
    const draftId = original.sourceDraftId;
    if (draftId !== null) {
      const delivered = await findDeliveredCopyOfDraft(db, {
        workspaceId: ctx.workspaceId,
        draftId,
      });
      if (delivered) {
        await trashStaleCopies(ctx, original.id, draftId, delivered.messageId);
        result.skippedAlreadySent.push(original.id);
        continue;
      }
      if (draftsTried.has(draftId.toString())) {
        result.skippedDuplicate.push(original.id);
        continue;
      }
      if (await draftIsBeingSent(db, { workspaceId: ctx.workspaceId, draftId })) {
        result.errors.push({ id: original.id, error: RETRY_DRAFT_IN_FLIGHT_ERROR });
        continue;
      }
      draftsTried.add(draftId.toString());
    }
    /** Queue rows of the draft the reaper had failed as interrupted. */
    let interruptedSettled: bigint[] = [];
    let sent: MailMessage | null = null;
    try {
      sent = await sendMessage(ctx, {
        // flow:F-05: a retry keeps the original's kind of mail.
        mode: sendModeFromHeaders(original.headers),
        mailboxId: original.mailboxId,
        to: original.toAddresses.map((address) => ({ address })),
        cc: original.ccAddresses.map((address) => ({ address })),
        bcc: original.bccAddresses.map((address) => ({ address })),
        subject: original.subject,
        text: original.bodyText ?? undefined,
        html: original.bodyHtml ?? undefined,
        inReplyTo: original.inReplyTo ?? undefined,
        references: original.references,
        sourceDraftId: draftId ?? undefined,
        // flow:F-07: a retry is the original email again, so it keeps the
        // original's origin (a retried cold email waits for go-live too).
        origin: await originOfSentMessage(ctx, original),
        // PC-10 (I013): the queue rows behind this draft are settled in the
        // same transaction — they no longer stay 'failed' after the email
        // went out, and a requeued copy cannot send it again. Every other
        // failed copy of the draft leaves Errors in the same step.
        onPersisted: draftId
          ? async (tx, message) => {
              const settled = await markDraftQueueEntriesSent(tx, {
                workspaceId: ctx.workspaceId,
                draftId,
                messageId: message.id,
              });
              interruptedSettled = settled.interrupted;
              await trashEarlierFailedCopies(tx, {
                workspaceId: ctx.workspaceId,
                draftId,
                deliveredMessageId: message.id,
              });
            }
          : undefined,
        providerOverride,
      });
    } catch (err) {
      // PC-10: an error after the server took the message is not a failed
      // retry — the email went out. Treat it as retried, or the original
      // stays in Errors and the next Retry sends it a second time.
      if (!isAfterDelivery(err)) {
        result.errors.push({
          id: original.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      console.error(
        `[mail.retry_send] message ${original.id} was re-sent but not fully recorded:`,
        err instanceof Error ? err.message : err,
      );
    }
    // Trash the original so a successful retry actually clears the
    // Errors folder. The full history stays in audit_log + the row
    // is recoverable from Trash if the operator needs to inspect it.
    try {
      const now = new Date();
      await db
        .update(mailMessages)
        .set({ trashedAt: now, updatedAt: now })
        .where(eq(mailMessages.id, original.id));
    } catch (err) {
      console.error(
        `[mail.retry_send] re-sent message ${original.id} not moved to Trash:`,
        err instanceof Error ? err.message : err,
      );
    }
    result.retried.push(original.id);
    if (sent && draftId) {
      // Read back what the hook settled (it may have been rolled back if
      // the message had to be recorded on its own).
      try {
        const settled = await db
          .select({ id: outreachQueue.id })
          .from(outreachQueue)
          .where(
            and(
              eq(outreachQueue.workspaceId, ctx.workspaceId),
              eq(outreachQueue.draftId, draftId),
              eq(outreachQueue.sentMessageId, sent.id),
            ),
          );
        result.queueEntriesSent.push(...settled.map((r) => r.id));
        // The email went out: an interrupted row of the draft no longer
        // needs anyone — close its incident (only rows the hook settled).
        const settledIds = new Set(settled.map((r) => r.id.toString()));
        for (const entryId of interruptedSettled) {
          if (settledIds.has(entryId.toString())) {
            await resolveSendInterrupted(ctx.workspaceId, entryId, null);
          }
        }
      } catch (err) {
        console.error(
          `[mail.retry_send] settled queue rows for message ${sent.id} not read:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  if (
    result.retried.length > 0 ||
    result.errors.length > 0 ||
    result.skippedHardBounce.length > 0 ||
    result.skippedAlreadySent.length > 0 ||
    result.skippedDuplicate.length > 0
  ) {
    await recordAuditEvent(ctx, {
      kind: 'mail.retry_send',
      entityType: 'mail_message',
      payload: {
        retried: result.retried.map(String),
        skippedHardBounce: result.skippedHardBounce.map(String),
        skippedIneligible: result.skippedIneligible.map(String),
        skippedAlreadySent: result.skippedAlreadySent.map(String),
        skippedDuplicate: result.skippedDuplicate.map(String),
        errors: result.errors.map((e) => ({
          id: e.id.toString(),
          error: e.error,
        })),
        queueEntriesSent: result.queueEntriesSent.map(String),
      },
    });
  }

  return result;
}

/** A failed copy of a draft whose email has gone out: it and the draft's
 *  other failed copies leave Errors (best-effort — skipping the send is
 *  what matters). */
async function trashStaleCopies(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  originalId: bigint,
  draftId: bigint,
  deliveredMessageId: bigint | null,
): Promise<void> {
  try {
    const now = new Date();
    await db
      .update(mailMessages)
      .set({ trashedAt: now, updatedAt: now })
      .where(
        and(
          eq(mailMessages.workspaceId, ctx.workspaceId),
          eq(mailMessages.id, originalId),
          isNull(mailMessages.trashedAt),
        ),
      );
    await trashEarlierFailedCopies(db, {
      workspaceId: ctx.workspaceId,
      draftId,
      deliveredMessageId,
      now,
    });
  } catch (err) {
    console.error(
      `[mail.retry_send] stale copies of draft ${draftId} not moved to Trash:`,
      err instanceof Error ? err.message : err,
    );
  }
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
        const merged = mergeUniqueLower([...threadRows[0].participants, ...input.participants]);
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
    const merged = mergeUniqueLower([...existing[0].participants, ...input.participants]);
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
