// Mail send/receive service. Wraps IMailProvider with persistence: every
// outbound + inbound message is persisted, threaded by header heuristic,
// and audit-logged. Suppression list is checked before every send.

import { and, asc, desc, eq, inArray, or, type SQL } from 'drizzle-orm';
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

  // Phase 17: append the default signature for this mailbox to the body
  // (text + html). Caller-supplied bodies are passed through untouched.
  let outboundText = input.text;
  let outboundHtml = input.html;
  try {
    const sig = await defaultSignature(ctx, mailbox.id);
    if (sig) {
      const sigText = renderSignatureText(sig);
      const sigHtml = renderSignatureHtml(sig);
      if (outboundText && sigText) outboundText = `${outboundText}\n\n${sigText}`;
      if (outboundHtml && sigHtml) outboundHtml = `${outboundHtml}\n${sigHtml}`;
    }
  } catch (err) {
    console.error('[mail.send] signature render failed:', err);
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
  return false;
}

// ---- read ----------------------------------------------------------

export interface ListThreadsFilter {
  mailboxId?: bigint;
  limit?: number;
}

export async function listThreads(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: ListThreadsFilter = {},
): Promise<MailThread[]> {
  const conditions: SQL[] = [eq(mailThreads.workspaceId, ctx.workspaceId)];
  if (filter.mailboxId !== undefined) {
    conditions.push(eq(mailThreads.mailboxId, filter.mailboxId));
  }
  return db
    .select()
    .from(mailThreads)
    .where(and(...conditions))
    .orderBy(desc(mailThreads.lastMessageAt))
    .limit(Math.min(filter.limit ?? 200, 1000));
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
