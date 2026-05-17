// Mail send/receive service. Wraps IMailProvider with persistence: every
// outbound + inbound message is persisted, threaded by header heuristic,
// and audit-logged. Suppression list is checked before every send.

import { and, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
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
    if (e?.responseCode && e.responseCode >= 500 && e.responseCode < 600) {
      for (const recipient of input.to) {
        try {
          await recordBounce(ctx, recipient.address, 'hard', e.message ?? null);
        } catch {
          // best-effort
        }
      }
    } else if (e?.responseCode && e.responseCode >= 400 && e.responseCode < 500) {
      for (const recipient of input.to) {
        try {
          await recordBounce(ctx, recipient.address, 'soft', e.message ?? null);
        } catch {
          // best-effort
        }
      }
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
