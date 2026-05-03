// Outreach send queue. Approved drafts (or one-off scheduled sends) land
// here with a scheduled_send_at. A worker (BullMQ recurring or manual
// drainQueue() call from /mailbox/queue UI) picks queued items past their
// schedule, applies suppression + domain-cooldown + daily-cap checks, and
// dispatches via mail.sendMessage.
//
// Phase 19 ships the schema + service + manual drain. The BullMQ recurring
// worker is a thin wrapper around drainQueue() that any deployment can
// schedule (left out of the service layer to keep tests clean).

import { and, asc, count, eq, gte, lte, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  outreachDrafts,
  outreachQueue,
  outreachSendSettings,
  type NewOutreachQueueEntry,
  type OutreachQueueEntry,
  type OutreachQueueStatus,
  type OutreachSendSettings,
  type SendDelayMode,
} from '@/lib/db/schema/outreach';
import { mailMessages } from '@/lib/db/schema/mailing';
import { recordAuditEvent } from './audit';
import {
  canAdminWorkspace,
  canWrite,
  type WorkspaceContext,
} from './context';
import { sendMessage } from './mail';
import { isSuppressed } from './suppression';
import type { IMailProvider } from '@/lib/mail';

export class OutreachQueueError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'OutreachQueueError';
    this.code = code;
  }
}

const denied = (op: string) =>
  new OutreachQueueError(`Permission denied: ${op}`, 'permission_denied');
const notFound = () => new OutreachQueueError('queue entry not found', 'not_found');
const invalid = (msg: string) =>
  new OutreachQueueError(msg, 'invalid_input');
const conflict = (msg: string) =>
  new OutreachQueueError(msg, 'conflict');

// ---- settings -----------------------------------------------------

export async function getSendSettings(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<OutreachSendSettings> {
  const rows = await db
    .select()
    .from(outreachSendSettings)
    .where(eq(outreachSendSettings.workspaceId, ctx.workspaceId))
    .limit(1);
  if (rows[0]) return rows[0];
  // Lazy-init defaults so first read in a workspace is cheap + idempotent.
  const [created] = await db
    .insert(outreachSendSettings)
    .values({ workspaceId: ctx.workspaceId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  // Race: another caller created it. Re-fetch.
  const reload = await db
    .select()
    .from(outreachSendSettings)
    .where(eq(outreachSendSettings.workspaceId, ctx.workspaceId))
    .limit(1);
  if (!reload[0]) {
    throw new OutreachQueueError(
      'send settings init returned no row',
      'invariant_violation',
    );
  }
  return reload[0];
}

export interface UpdateSendSettingsInput {
  dailyEmailLimit?: number;
  domainCooldownHours?: number;
  defaultDelayMode?: SendDelayMode;
  fixedDelayMinutes?: number;
  randomDelayMinMinutes?: number;
  randomDelayMaxMinutes?: number;
  emergencyPause?: boolean;
}

export async function updateSendSettings(
  ctx: WorkspaceContext,
  input: UpdateSendSettingsInput,
): Promise<OutreachSendSettings> {
  if (!canAdminWorkspace(ctx)) throw denied('outreach.send_settings.update');
  await getSendSettings(ctx); // ensure row exists
  const updates: Partial<OutreachSendSettings> & { updatedAt: Date } = {
    updatedAt: new Date(),
    updatedBy: ctx.userId,
  };
  if (input.dailyEmailLimit !== undefined) {
    updates.dailyEmailLimit = clampInt(input.dailyEmailLimit, 0, 10_000);
  }
  if (input.domainCooldownHours !== undefined) {
    updates.domainCooldownHours = clampInt(input.domainCooldownHours, 0, 24 * 30);
  }
  if (input.defaultDelayMode !== undefined) {
    updates.defaultDelayMode = input.defaultDelayMode;
  }
  if (input.fixedDelayMinutes !== undefined) {
    updates.fixedDelayMinutes = clampInt(input.fixedDelayMinutes, 0, 24 * 60);
  }
  if (input.randomDelayMinMinutes !== undefined) {
    updates.randomDelayMinMinutes = clampInt(
      input.randomDelayMinMinutes,
      0,
      24 * 60,
    );
  }
  if (input.randomDelayMaxMinutes !== undefined) {
    updates.randomDelayMaxMinutes = clampInt(
      input.randomDelayMaxMinutes,
      0,
      24 * 60,
    );
  }
  if (input.emergencyPause !== undefined) {
    updates.emergencyPause = input.emergencyPause;
  }
  const [updated] = await db
    .update(outreachSendSettings)
    .set(updates)
    .where(eq(outreachSendSettings.workspaceId, ctx.workspaceId))
    .returning();
  if (!updated) {
    throw new OutreachQueueError(
      'send settings update returned no row',
      'invariant_violation',
    );
  }
  await recordAuditEvent(ctx, {
    kind: 'outreach.send_settings.update',
    entityType: 'workspace',
    entityId: ctx.workspaceId,
    payload: { ...input } as Record<string, unknown>,
  });
  return updated;
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

// ---- enqueue ------------------------------------------------------

export interface EnqueueDraftInput {
  draftId: bigint;
  mailboxId: bigint;
  delayMode?: SendDelayMode;
  /** Override the computed scheduled_send_at. */
  scheduledSendAt?: Date;
}

export async function enqueueDraft(
  ctx: WorkspaceContext,
  input: EnqueueDraftInput,
): Promise<OutreachQueueEntry> {
  if (!canWrite(ctx)) throw denied('outreach.enqueue');
  const draftRows = await db
    .select()
    .from(outreachDrafts)
    .where(
      and(
        eq(outreachDrafts.workspaceId, ctx.workspaceId),
        eq(outreachDrafts.id, input.draftId),
      ),
    )
    .limit(1);
  if (!draftRows[0]) throw notFound();
  const draft = draftRows[0];
  if (draft.status === 'rejected' || draft.status === 'superseded') {
    throw conflict(`draft is ${draft.status}; cannot enqueue`);
  }

  const settings = await getSendSettings(ctx);
  const delayMode = input.delayMode ?? settings.defaultDelayMode;
  const scheduledSendAt =
    input.scheduledSendAt ?? computeScheduledAt(delayMode, settings);

  // Resolve recipient from the lead.
  // For Phase 19 simplicity we pull from outreach_drafts.evidence.contactEmail
  // — in reality, draft has subject/body but no explicit To. The lead's
  // contactEmail (via qualified_leads) is the right source. Use mailMessage
  // path: check the latest mail message for this draft's review_item if
  // any, else fall back to qualified_lead.contactEmail.
  // Simpler: enqueueDraft requires a `to` in the input upgrade later. For now,
  // pull from the lead.
  const { qualifiedLeads } = await import('@/lib/db/schema/pipeline');
  const leadRows = await db
    .select()
    .from(qualifiedLeads)
    .where(
      and(
        eq(qualifiedLeads.workspaceId, ctx.workspaceId),
        eq(qualifiedLeads.reviewItemId, draft.reviewItemId),
        eq(qualifiedLeads.productProfileId, draft.productProfileId),
      ),
    )
    .limit(1);
  const recipient = leadRows[0]?.contactEmail ?? null;
  if (!recipient) {
    throw invalid('cannot enqueue: no contact email on the lead');
  }

  const row: NewOutreachQueueEntry = {
    workspaceId: ctx.workspaceId,
    mailboxId: input.mailboxId,
    draftId: draft.id,
    toAddresses: [recipient],
    subject: draft.subject ?? '(no subject)',
    bodyText: draft.body,
    delayMode,
    scheduledSendAt,
    status: 'queued',
    createdBy: ctx.userId,
  };
  const [created] = await db.insert(outreachQueue).values(row).returning();
  if (!created) {
    throw new OutreachQueueError(
      'queue insert returned no row',
      'invariant_violation',
    );
  }
  await recordAuditEvent(ctx, {
    kind: 'outreach.enqueue',
    entityType: 'outreach_queue',
    entityId: created.id,
    payload: {
      draftId: draft.id.toString(),
      mailboxId: input.mailboxId.toString(),
      scheduledSendAt: scheduledSendAt.toISOString(),
      delayMode,
    },
  });
  return created;
}

function computeScheduledAt(
  mode: SendDelayMode,
  settings: OutreachSendSettings,
): Date {
  const now = Date.now();
  if (mode === 'immediate') return new Date(now);
  if (mode === 'fixed') return new Date(now + settings.fixedDelayMinutes * 60_000);
  // random
  const min = Math.min(settings.randomDelayMinMinutes, settings.randomDelayMaxMinutes);
  const max = Math.max(settings.randomDelayMinMinutes, settings.randomDelayMaxMinutes);
  const mins = min + Math.random() * (max - min);
  return new Date(now + mins * 60_000);
}

// ---- mutate -------------------------------------------------------

export async function cancelQueueEntry(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<OutreachQueueEntry> {
  if (!canWrite(ctx)) throw denied('outreach.queue.cancel');
  const existing = await loadEntry(ctx, id);
  if (existing.status !== 'queued') {
    throw conflict(`cannot cancel entry in status ${existing.status}`);
  }
  const [updated] = await db
    .update(outreachQueue)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(outreachQueue.id, id))
    .returning();
  if (!updated) {
    throw new OutreachQueueError(
      'cancel returned no row',
      'invariant_violation',
    );
  }
  await recordAuditEvent(ctx, {
    kind: 'outreach.queue.cancel',
    entityType: 'outreach_queue',
    entityId: id,
  });
  return updated;
}

export async function rescheduleQueueEntry(
  ctx: WorkspaceContext,
  id: bigint,
  scheduledSendAt: Date,
): Promise<OutreachQueueEntry> {
  if (!canWrite(ctx)) throw denied('outreach.queue.reschedule');
  const existing = await loadEntry(ctx, id);
  if (existing.status !== 'queued') {
    throw conflict(`cannot reschedule entry in status ${existing.status}`);
  }
  const [updated] = await db
    .update(outreachQueue)
    .set({ scheduledSendAt, updatedAt: new Date() })
    .where(eq(outreachQueue.id, id))
    .returning();
  if (!updated) {
    throw new OutreachQueueError(
      'reschedule returned no row',
      'invariant_violation',
    );
  }
  return updated;
}

// ---- read ---------------------------------------------------------

export interface ListQueueFilter {
  status?: OutreachQueueStatus;
  mailboxId?: bigint;
  limit?: number;
}

export async function listQueueEntries(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: ListQueueFilter = {},
): Promise<OutreachQueueEntry[]> {
  const conditions: SQL[] = [eq(outreachQueue.workspaceId, ctx.workspaceId)];
  if (filter.status) conditions.push(eq(outreachQueue.status, filter.status));
  if (filter.mailboxId !== undefined) {
    conditions.push(eq(outreachQueue.mailboxId, filter.mailboxId));
  }
  return db
    .select()
    .from(outreachQueue)
    .where(and(...conditions))
    .orderBy(asc(outreachQueue.scheduledSendAt))
    .limit(Math.min(filter.limit ?? 200, 1000));
}

// ---- drain --------------------------------------------------------

export interface DrainResult {
  picked: number;
  sent: number;
  failed: number;
  skipped: number;
}

export interface DrainOptions {
  /** Max entries to attempt this pass. */
  limit?: number;
  /** Test seam — overrides the IMailProvider used by sendMessage. */
  providerOverride?: IMailProvider;
  /** Test seam — pretend "now" is this Date. */
  now?: Date;
}

export async function drainQueue(
  ctx: WorkspaceContext,
  options: DrainOptions = {},
): Promise<DrainResult> {
  if (!canWrite(ctx)) throw denied('outreach.queue.drain');
  const settings = await getSendSettings(ctx);
  if (settings.emergencyPause) {
    return { picked: 0, sent: 0, failed: 0, skipped: 0 };
  }
  const now = options.now ?? new Date();

  // Daily cap: count outbound mail sent in the trailing 24h.
  const dayStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sentToday = await db
    .select({ c: count() })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        eq(mailMessages.direction, 'outbound'),
        gte(mailMessages.createdAt, dayStart),
      ),
    );
  const remainingCap = Math.max(
    0,
    settings.dailyEmailLimit - Number(sentToday[0]?.c ?? 0),
  );

  const limit = Math.min(options.limit ?? 50, remainingCap, 200);
  if (limit === 0) {
    return { picked: 0, sent: 0, failed: 0, skipped: 0 };
  }

  const due = await db
    .select()
    .from(outreachQueue)
    .where(
      and(
        eq(outreachQueue.workspaceId, ctx.workspaceId),
        eq(outreachQueue.status, 'queued'),
        lte(outreachQueue.scheduledSendAt, now),
      ),
    )
    .orderBy(asc(outreachQueue.scheduledSendAt))
    .limit(limit);

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const entry of due) {
    const result = await processEntry(ctx, entry, settings, options.providerOverride, now);
    if (result === 'sent') sent++;
    else if (result === 'failed') failed++;
    else skipped++;
  }
  return { picked: due.length, sent, failed, skipped };
}

async function processEntry(
  ctx: WorkspaceContext,
  entry: OutreachQueueEntry,
  settings: OutreachSendSettings,
  providerOverride: IMailProvider | undefined,
  now: Date,
): Promise<'sent' | 'failed' | 'skipped'> {
  // Claim the row. Best-effort optimistic update.
  const claim = await db
    .update(outreachQueue)
    .set({ status: 'sending', attemptCount: entry.attemptCount + 1, updatedAt: new Date() })
    .where(and(eq(outreachQueue.id, entry.id), eq(outreachQueue.status, 'queued')))
    .returning();
  if (claim.length === 0) return 'skipped';

  try {
    // Suppression check (any recipient).
    for (const addr of entry.toAddresses) {
      if (await isSuppressed(ctx, addr)) {
        await db
          .update(outreachQueue)
          .set({
            status: 'skipped',
            lastError: `suppressed: ${addr}`,
            updatedAt: new Date(),
          })
          .where(eq(outreachQueue.id, entry.id));
        return 'skipped';
      }
    }

    // Domain cooldown: any prior outbound to this domain in the last
    // domainCooldownHours triggers skip.
    if (settings.domainCooldownHours > 0) {
      const cutoff = new Date(
        now.getTime() - settings.domainCooldownHours * 60 * 60_000,
      );
      const domains = entry.toAddresses
        .map((a) => a.split('@')[1]?.toLowerCase())
        .filter((d): d is string => Boolean(d));
      if (domains.length > 0) {
        const recent = await db
          .select()
          .from(mailMessages)
          .where(
            and(
              eq(mailMessages.workspaceId, ctx.workspaceId),
              eq(mailMessages.direction, 'outbound'),
              gte(mailMessages.createdAt, cutoff),
            ),
          );
        const blockedDomain = recent.find((m) =>
          m.toAddresses.some((to) => {
            const d = to.split('@')[1]?.toLowerCase();
            return d ? domains.includes(d) : false;
          }),
        );
        if (blockedDomain) {
          await db
            .update(outreachQueue)
            .set({
              status: 'skipped',
              lastError: 'domain cooldown',
              updatedAt: new Date(),
            })
            .where(eq(outreachQueue.id, entry.id));
          return 'skipped';
        }
      }
    }

    // Send.
    const sendInput: Parameters<typeof sendMessage>[1] = {
      mailboxId: entry.mailboxId,
      to: entry.toAddresses.map((address) => ({ address })),
      cc: entry.ccAddresses.length > 0
        ? entry.ccAddresses.map((address) => ({ address }))
        : undefined,
      bcc: entry.bccAddresses.length > 0
        ? entry.bccAddresses.map((address) => ({ address }))
        : undefined,
      subject: entry.subject,
      text: entry.bodyText ?? undefined,
      html: entry.bodyHtml ?? undefined,
      sourceDraftId: entry.draftId ?? undefined,
      providerOverride,
    };
    if (entry.inReplyTo) sendInput.inReplyTo = entry.inReplyTo;
    if (entry.references.length > 0) sendInput.references = entry.references;

    const sentMessage = await sendMessage(ctx, sendInput);
    await db
      .update(outreachQueue)
      .set({
        status: 'sent',
        sentMessageId: sentMessage.id,
        updatedAt: new Date(),
      })
      .where(eq(outreachQueue.id, entry.id));
    return 'sent';
  } catch (err) {
    await db
      .update(outreachQueue)
      .set({
        status: 'failed',
        lastError: err instanceof Error ? err.message : String(err),
        updatedAt: new Date(),
      })
      .where(eq(outreachQueue.id, entry.id));
    return 'failed';
  }
}

// ---- internals ----------------------------------------------------

async function loadEntry(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<OutreachQueueEntry> {
  const rows = await db
    .select()
    .from(outreachQueue)
    .where(
      and(
        eq(outreachQueue.workspaceId, ctx.workspaceId),
        eq(outreachQueue.id, id),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound();
  return rows[0];
}
