// Outreach send queue. Approved drafts (or one-off scheduled sends) land
// here with a scheduled_send_at. A worker (BullMQ recurring or manual
// drainQueue() call from /mailbox/queue UI) picks queued items past their
// schedule, applies suppression + domain-cooldown + daily-cap checks, and
// dispatches via mail.sendMessage.
//
// Phase 19 ships the schema + service + manual drain. The BullMQ recurring
// worker is a thin wrapper around drainQueue() that any deployment can
// schedule (left out of the service layer to keep tests clean).

import { and, asc, count, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  outreachDrafts,
  outreachQueue,
  outreachSendSettings,
  type NewOutreachQueueEntry,
  type OutreachQueueEntry,
  type OutreachQueueStatus,
  type OutreachSendSettings,
  type OutreachStage,
  type SendDelayMode,
} from '@/lib/db/schema/outreach';
import { mailMessages, mailboxes, type MailboxStatus } from '@/lib/db/schema/mailing';
import { workspaces } from '@/lib/db/schema/workspaces';
import { classifySmtpError } from '@/lib/mail/smtp-errors';
import { qualifications } from '@/lib/db/schema/qualifications';
import { reviewItems } from '@/lib/db/schema/review';
import { recordAuditEvent } from './audit';
import {
  AutomationGateError,
  PAUSED_MESSAGE,
  checkGate,
  deferUntil,
  mailboxHeldMessage,
  originForDraft,
  type SendOrigin,
} from './automation-gate';
import { productPauseOf, productPausedMessage } from './automation-policy';
import {
  canAdminWorkspace,
  canWrite,
  type WorkspaceContext,
} from './context';
import { sendMessage, type SendMode } from './mail';
import { prepareOutboundDualBody } from './language-resolution';
import { isSuppressed } from './suppression';
import {
  canSendNow,
  evaluateBusinessWindow,
  getOrCreateMailboxSendingLimits,
  recordSendCounter,
} from './sending-policy';
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
  // Only human-approved drafts may enter the send queue. This is the
  // approval gate for cold outreach: 'draft' / 'needs_edit' content that
  // nobody reviewed can never reach a recipient. Autopilot approves
  // explicitly (attributed to the workspace owner who enabled it) before
  // enqueueing, so the invariant holds on that path too.
  if (draft.status !== 'approved') {
    throw conflict(
      `draft is ${draft.status}; only approved drafts can be enqueued — approve it first`,
    );
  }

  const settings = await getSendSettings(ctx);
  const delayMode = input.delayMode ?? settings.defaultDelayMode;

  // Phase 43: respect the per-mailbox business window when computing
  // scheduledSendAt. The base computation honours the workspace delay
  // mode; if the resulting instant falls outside the mailbox's working
  // window we push it to the next window opening. Caller-supplied
  // overrides (scheduledSendAt) bypass the policy gate.
  let scheduledSendAt =
    input.scheduledSendAt ?? computeScheduledAt(delayMode, settings);
  if (!input.scheduledSendAt) {
    const limits = await getOrCreateMailboxSendingLimits(
      ctx.workspaceId,
      input.mailboxId,
    );
    const window = evaluateBusinessWindow(limits, scheduledSendAt);
    if (!window.allowed && window.retryAfter) {
      scheduledSendAt = window.retryAfter;
    }
  }

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
  /** Not sent this pass: suppressed, geo-blocked, domain cooldown, the
   *  sending policy's window, or deferred by the gate (see `deferred`). */
  skipped: number;
  /** PC-05: rows the gate deferred (still queued, due again later, the
   *  reason in last_error): the go-live hold for their origin, a paused /
   *  failing / archived mailbox, or (PC-13) a paused product. Counted in
   *  `skipped` too. */
  deferred: number;
  /** PC-06 / PC-05: set when the automation gate stopped the drain (the
   *  workspace pause, a Sending hold, the platform outbound stop, no
   *  accountable owner). The rows it did not reach stay queued, untouched. */
  heldReason?: string;
}

export interface DrainOptions {
  /** Max entries to attempt this pass. */
  limit?: number;
  /** Test seam — overrides the IMailProvider used by sendMessage. */
  providerOverride?: IMailProvider;
  /** Test seam — pretend "now" is this Date. */
  now?: Date;
}

/**
 * Send the queued entries that are due. Draining is automatic work
 * whoever triggers it (the 30 s tick, autopilot, "Send due emails now"),
 * so the gate applies its automatic rules: the workspace pause, holds,
 * the platform stop and the accountable owner stop the whole drain; the
 * go-live hold and a mailbox that is not active defer just that row.
 *
 * PC-05: the gate is asked again before every row, and the claim itself
 * refuses while the workspace is paused (under a share lock on the
 * workspace row, which the pause has to wait for), so a pause committed
 * while row k is being sent leaves every later row queued and untouched,
 * and no row is claimed after the pause time.
 *
 * PC-13 (I020): a row whose draft belongs to a paused product is deferred
 * the same way (still queued, its reason in last_error) — read fresh
 * before each row, so a product paused mid-drain holds its remaining rows.
 */
export async function drainQueue(
  ctx: WorkspaceContext,
  options: DrainOptions = {},
): Promise<DrainResult> {
  if (!canWrite(ctx)) throw denied('outreach.queue.drain');
  const empty = { picked: 0, sent: 0, failed: 0, skipped: 0, deferred: 0 };
  const gate = await checkGate(ctx, 'sending', { manual: false });
  if (!gate.allowed) return { ...empty, heldReason: gate.message };
  const settings = await getSendSettings(ctx);
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
  if (limit === 0) return empty;

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
  const { origins, products } = await draftFactsForEntries(ctx, due);

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let deferred = 0;
  let heldReason: string | undefined;
  for (const entry of due) {
    const origin = origins.get(entry.id.toString()) ?? 'cold';
    // PC-05: re-check before every claim — the pause, holds, the platform
    // stop, the owner, this row's origin (go-live) and its mailbox.
    const decision = await checkGate(ctx, 'sending', {
      manual: false,
      origin,
      mailboxStatus: await mailboxStatusOf(ctx, entry.mailboxId),
    });
    if (!decision.allowed) {
      if (decision.scope === 'workspace') {
        heldReason = decision.message;
        break;
      }
      if (await deferEntry(entry, now, decision.message)) {
        deferred++;
        skipped++;
      }
      continue;
    }
    // PC-13: the draft's product is paused — hold the row, never fail it.
    const productId = products.get(entry.id.toString());
    if (productId !== undefined) {
      const productPause = await productPauseOf(ctx, productId);
      if (productPause) {
        if (await deferEntry(entry, now, productPausedMessage(productPause.productName))) {
          deferred++;
          skipped++;
        }
        continue;
      }
    }
    const result = await processEntry(ctx, entry, settings, origin, options.providerOverride, now);
    if (result.kind === 'stopped') {
      heldReason = result.reason;
      break;
    }
    if (result.kind === 'sent') sent++;
    else if (result.kind === 'failed') failed++;
    else {
      skipped++;
      if (result.kind === 'deferred') deferred++;
    }
  }
  return {
    picked: due.length,
    sent,
    failed,
    skipped,
    deferred,
    ...(heldReason ? { heldReason } : {}),
  };
}

/** Where each entry's email comes from (flow:F-07) and, PC-13, which
 *  product its draft is for (keyed by entry id). A draft decides both; an
 *  entry without one (a one-off send, or its draft was deleted) fails
 *  closed as cold and belongs to no product. */
async function draftFactsForEntries(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  entries: ReadonlyArray<OutreachQueueEntry>,
): Promise<{ origins: Map<string, SendOrigin>; products: Map<string, bigint> }> {
  const out = new Map<string, SendOrigin>();
  const products = new Map<string, bigint>();
  const draftIds = [
    ...new Set(entries.map((e) => e.draftId).filter((d): d is bigint => d !== null)),
  ];
  const drafts =
    draftIds.length === 0
      ? []
      : await db
          .select({
            id: outreachDrafts.id,
            stage: outreachDrafts.stage,
            triggeredByMessageId: outreachDrafts.triggeredByMessageId,
            productProfileId: outreachDrafts.productProfileId,
          })
          .from(outreachDrafts)
          .where(
            and(
              eq(outreachDrafts.workspaceId, ctx.workspaceId),
              inArray(outreachDrafts.id, draftIds),
            ),
          );
  const byId = new Map(drafts.map((d) => [d.id.toString(), d]));
  for (const e of entries) {
    const draft = e.draftId !== null ? byId.get(e.draftId.toString()) : undefined;
    out.set(e.id.toString(), draft ? originForDraft(draft) : 'cold');
    if (draft) products.set(e.id.toString(), draft.productProfileId);
  }
  return { origins: out, products };
}

async function mailboxStatusOf(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  mailboxId: bigint,
): Promise<MailboxStatus | undefined> {
  const [row] = await db
    .select({ status: mailboxes.status })
    .from(mailboxes)
    .where(and(eq(mailboxes.workspaceId, ctx.workspaceId), eq(mailboxes.id, mailboxId)))
    .limit(1);
  return row?.status;
}

type EntryOutcome =
  | { kind: 'sent' }
  | { kind: 'failed' }
  | { kind: 'skipped' }
  /** Still queued, due again later, the reason on the row. */
  | { kind: 'deferred' }
  /** The workspace-level gate refused (the pause landed, a hold): the
   *  entry is untouched or handed back as it was; stop the drain. */
  | { kind: 'stopped'; reason: string };

/**
 * PC-05: claim the row — 'queued' → 'sending', stamped claimed_at from the
 * database clock — unless the workspace is paused. The share lock on the
 * workspace row makes a concurrent pause (which locks the row FOR UPDATE
 * before stamping its time) wait for this claim, or this claim wait for
 * the pause and then see it. KEY SHARE, so ordinary workspace updates
 * (token debits) never wait on a claim.
 */
async function claimEntry(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  entry: OutreachQueueEntry,
): Promise<'claimed' | 'paused' | 'lost'> {
  return db.transaction(async (tx) => {
    const [ws] = await tx
      .select({ pausedAt: workspaces.automationPausedAt })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId))
      .for('key share');
    if (!ws || ws.pausedAt) return 'paused';
    const rows = await tx
      .update(outreachQueue)
      .set({
        status: 'sending',
        attemptCount: entry.attemptCount + 1,
        claimedAt: sql`clock_timestamp()`,
        updatedAt: new Date(),
      })
      .where(and(eq(outreachQueue.id, entry.id), eq(outreachQueue.status, 'queued')))
      .returning({ id: outreachQueue.id });
    return rows.length > 0 ? 'claimed' : 'lost';
  });
}

async function processEntry(
  ctx: WorkspaceContext,
  entry: OutreachQueueEntry,
  settings: OutreachSendSettings,
  origin: SendOrigin,
  providerOverride: IMailProvider | undefined,
  now: Date,
): Promise<EntryOutcome> {
  const claim = await claimEntry(ctx, entry);
  if (claim === 'paused') return { kind: 'stopped', reason: PAUSED_MESSAGE };
  if (claim === 'lost') return { kind: 'skipped' };

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
        return { kind: 'skipped' };
      }
    }

    // Locality guard (hard requirement): the qualification's geo gate is
    // re-checked at dispatch, so an out-of-country lead can never be mailed
    // even if it somehow survived qualification + review. 'mismatch' blocks
    // outright; 'unverified' blocks unless a human approved the review item
    // (the review UI shows the geo warning, so approval = explicit human
    // confirmation the company is inside the target country).
    if (entry.draftId) {
      const geoVerdict = await checkGeoAtSendTime(ctx, entry.draftId);
      if (!geoVerdict.allowed) {
        await db
          .update(outreachQueue)
          .set({
            status: 'skipped',
            lastError: geoVerdict.reason,
            updatedAt: new Date(),
          })
          .where(eq(outreachQueue.id, entry.id));
        await recordAuditEvent(ctx, {
          kind: 'outreach.geo_blocked',
          entityType: 'outreach_queue',
          entityId: entry.id,
          payload: {
            draftId: entry.draftId.toString(),
            reason: geoVerdict.reason,
            to: entry.toAddresses,
          },
        });
        return { kind: 'skipped' };
      }
    }

    // Phase 43: per-mailbox sending policy. Checks business window
    // (timezone-aware), daily/hourly counters, and per-domain 24h cap.
    // On a denial we re-queue with scheduledSendAt=retryAfter and set
    // last_error to the human-readable reason — the entry stays as
    // 'queued' so it'll be picked up again at retryAfter rather than
    // marked 'skipped' permanently.
    const primaryDomain = entry.toAddresses[0]?.split('@')[1]?.toLowerCase() ?? null;
    const policy = await canSendNow({
      workspaceId: ctx.workspaceId,
      mailboxId: entry.mailboxId,
      recipientDomain: primaryDomain,
      now,
    });
    if (!policy.allowed) {
      await db
        .update(outreachQueue)
        .set({
          status: 'queued',
          // De-claim — back into the queue at retryAfter.
          attemptCount: entry.attemptCount, // undo the +1 from claim
          scheduledSendAt: policy.retryAfter ?? new Date(now.getTime() + 60 * 60 * 1000),
          lastError: policy.reason ?? 'sending policy blocked',
          updatedAt: new Date(),
        })
        .where(eq(outreachQueue.id, entry.id));
      return { kind: 'skipped' };
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
          return { kind: 'skipped' };
        }
      }
    }

    // Phase 63 (Flow A): the queued body is the operator-approved NATIVE
    // text. Translate it into the recipient's resolved target language at
    // dispatch and persist both sides. Applies to draft-backed text sends;
    // one-off / html-only sends pass through unchanged.
    let sendText = entry.bodyText ?? undefined;
    let sendSubject = entry.subject;
    let bodyTextNative: string | undefined;
    let nativeLanguage: string | undefined;
    let targetLanguage: string | undefined;
    if (entry.draftId && entry.bodyText && entry.bodyText.trim()) {
      const draft = await loadDraftForSend(ctx, entry.draftId);
      if (draft && draft.bodyTranslated && draft.targetLanguage) {
        // The operator generated + (possibly) edited a translation on the
        // draft. Send that exact text rather than auto-translating.
        sendText = draft.bodyTranslated;
        sendSubject = draft.subjectTranslated ?? entry.subject;
        bodyTextNative = draft.body;
        nativeLanguage = (draft.language ?? 'en').toLowerCase().split('-')[0] ?? 'en';
        targetLanguage = draft.targetLanguage;
      } else if (draft) {
        // No stored translation — auto-translate at dispatch (Flow A). The
        // draft subject is composed in the native language too, so translate
        // it alongside the body.
        const dual = await prepareOutboundDualBody(ctx, {
          reviewItemId: draft.reviewItemId,
          productProfileId: draft.productProfileId,
          nativeBody: entry.bodyText,
          nativeSubject: entry.subject,
        });
        sendText = dual.sendText;
        sendSubject = dual.sendSubject ?? entry.subject;
        bodyTextNative = dual.bodyTextNative;
        nativeLanguage = dual.nativeLanguage;
        targetLanguage = dual.targetLanguage;
      }
    }

    // Send. flow:F-05: cold first touches are sequence mail (unsubscribe
    // footer + List-Unsubscribe); a draft answering the prospect's reply
    // is one-to-one.
    const sendInput: Parameters<typeof sendMessage>[1] = {
      mode: await sendModeForEntry(ctx, entry),
      mailboxId: entry.mailboxId,
      to: entry.toAddresses.map((address) => ({ address })),
      cc: entry.ccAddresses.length > 0
        ? entry.ccAddresses.map((address) => ({ address }))
        : undefined,
      bcc: entry.bccAddresses.length > 0
        ? entry.bccAddresses.map((address) => ({ address }))
        : undefined,
      subject: sendSubject,
      text: sendText,
      html: entry.bodyHtml ?? undefined,
      sourceDraftId: entry.draftId ?? undefined,
      bodyTextNative,
      nativeLanguage,
      targetLanguage,
      // PC-06: the drain sends on its own — the accountable-owner rule applies.
      automatic: true,
      // flow:F-07: sendMessage checks the go-live hold for it again.
      origin,
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
    // Phase 43: bump the per-mailbox counters so subsequent canSendNow
    // calls see the updated sentToday/sentThisHour. Best-effort.
    try {
      await recordSendCounter({
        workspaceId: ctx.workspaceId,
        mailboxId: entry.mailboxId,
        now,
      });
    } catch (counterErr) {
      console.error('[outreach-queue] recordSendCounter failed:', counterErr);
    }
    return { kind: 'sent' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // PC-06 / PC-05: the automation gate refused the send after the claim
    // — never this entry's failure. A workspace-level refusal (a hold
    // placed mid-drain) hands it back exactly as it was and stops the
    // drain; an item-level one (its mailbox stopped being active) defers it.
    if (err instanceof AutomationGateError) {
      if (err.scope === 'item') {
        await deferClaimedEntry(entry, now, message);
        return { kind: 'deferred' };
      }
      await db
        .update(outreachQueue)
        .set({
          status: 'queued',
          attemptCount: entry.attemptCount,
          claimedAt: null,
          lastError: message.slice(0, 2000),
          updatedAt: new Date(),
        })
        // Only our own claim: never overwrite a row another writer moved on.
        .where(and(eq(outreachQueue.id, entry.id), eq(outreachQueue.status, 'sending')));
      return { kind: 'stopped', reason: message };
    }
    // flow:F-05: a refused SMTP login is the mailbox's problem (sendMessage
    // has marked it failing), not this entry's — keep it queued behind the
    // failing-mailbox hold instead of failing it.
    if (classifySmtpError(err, entry.toAddresses).kind === 'auth') {
      await deferClaimedEntry(
        entry,
        now,
        `${mailboxHeldMessage('failing')} Last error: ${message}`,
      );
      return { kind: 'deferred' };
    }
    await db
      .update(outreachQueue)
      .set({
        status: 'failed',
        lastError: message,
        updatedAt: new Date(),
      })
      .where(eq(outreachQueue.id, entry.id));
    return { kind: 'failed' };
  }
}

// ---- recipient opt-out (flow:F-05) --------------------------------

/**
 * Cancel every still-queued entry addressed to `address` (any of its
 * to-addresses, case-insensitive) — used when that recipient unsubscribes.
 * Entries already being sent are left alone; sendMessage's suppression
 * check stops them. Returns the cancelled ids; the caller audits.
 */
export async function cancelQueuedForRecipient(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  address: string,
  reason: string,
): Promise<bigint[]> {
  const normalized = address.trim().toLowerCase();
  if (!normalized) return [];
  const rows = await db
    .update(outreachQueue)
    .set({ status: 'cancelled', lastError: reason.slice(0, 2000), updatedAt: new Date() })
    .where(
      and(
        eq(outreachQueue.workspaceId, ctx.workspaceId),
        eq(outreachQueue.status, 'queued'),
        // Raw SQL: case-insensitive membership in the to_addresses text[]
        // (one scalar parameter, no JS array splat).
        sql`EXISTS (SELECT 1 FROM unnest(${outreachQueue.toAddresses}) AS rcpt(addr) WHERE lower(rcpt.addr) = ${normalized})`,
      ),
    )
    .returning({ id: outreachQueue.id });
  return rows.map((r) => r.id);
}

// ---- send mode + held entries (flow:F-05, PC-05) ------------------

/**
 * A draft is one-to-one when it answers a prospect's reply: it was
 * triggered by an inbound message and is past the discovery stage. A
 * discovery draft is a first touch — cold, or an intro to a referred
 * contact — and is sequence mail even when a reply triggered it.
 */
export function sendModeForDraft(draft: {
  stage: OutreachStage;
  triggeredByMessageId: bigint | null;
}): SendMode {
  return draft.triggeredByMessageId !== null && draft.stage !== 'discovery'
    ? 'one_to_one'
    : 'sequence';
}

async function sendModeForEntry(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  entry: OutreachQueueEntry,
): Promise<SendMode> {
  if (!entry.draftId) return 'sequence';
  const [draft] = await db
    .select({
      stage: outreachDrafts.stage,
      triggeredByMessageId: outreachDrafts.triggeredByMessageId,
    })
    .from(outreachDrafts)
    .where(
      and(
        eq(outreachDrafts.workspaceId, ctx.workspaceId),
        eq(outreachDrafts.id, entry.draftId),
      ),
    )
    .limit(1);
  return draft ? sendModeForDraft(draft) : 'sequence';
}

/** PC-05: defer an entry the gate held before it was claimed (the go-live
 *  hold, a mailbox that is not active): still 'queued', due again after
 *  GATE_DEFER_MS, the reason in last_error — never 'failed'. Conditional
 *  on 'queued' so a concurrent cancel wins. True when it was deferred. */
async function deferEntry(entry: OutreachQueueEntry, now: Date, reason: string): Promise<boolean> {
  const rows = await db
    .update(outreachQueue)
    .set({
      scheduledSendAt: deferUntil(now),
      lastError: reason.slice(0, 2000),
      updatedAt: new Date(),
    })
    .where(and(eq(outreachQueue.id, entry.id), eq(outreachQueue.status, 'queued')))
    .returning({ id: outreachQueue.id });
  return rows.length > 0;
}

/** Put a claimed entry back to 'queued' (undoing the claim's attempt
 *  bump) and defer it like deferEntry. */
async function deferClaimedEntry(
  entry: OutreachQueueEntry,
  now: Date,
  reason: string,
): Promise<void> {
  await db
    .update(outreachQueue)
    .set({
      status: 'queued',
      attemptCount: entry.attemptCount,
      claimedAt: null,
      scheduledSendAt: deferUntil(now),
      lastError: reason.slice(0, 2000),
      updatedAt: new Date(),
    })
    // Only our own claim: never overwrite a row another writer moved on.
    .where(and(eq(outreachQueue.id, entry.id), eq(outreachQueue.status, 'sending')));
}

// ---- internals ----------------------------------------------------

/** Fetch a draft's (review_item, product) pair for language resolution. */
/**
 * Send-time locality re-check. Resolves the qualification behind a draft
 * (draft → review item → source record + product) and refuses dispatch when
 * its geo gate wasn't satisfied:
 *
 *   mismatch              → always blocked
 *   unverified            → blocked unless the review item is human-approved
 *   match / no_gate       → allowed
 *   chain unresolvable    → allowed (one-off sends have no qualification;
 *                            blocking them would break manual mail)
 */
async function checkGeoAtSendTime(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  draftId: bigint,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const rows = await db
    .select({
      geoStatus: qualifications.geoStatus,
      targetCountry: qualifications.targetCountry,
      inferredCountry: qualifications.inferredCountry,
      reviewState: reviewItems.state,
    })
    .from(outreachDrafts)
    .innerJoin(reviewItems, eq(reviewItems.id, outreachDrafts.reviewItemId))
    .innerJoin(
      qualifications,
      and(
        eq(qualifications.workspaceId, outreachDrafts.workspaceId),
        eq(qualifications.sourceRecordId, reviewItems.sourceRecordId),
        eq(qualifications.productProfileId, outreachDrafts.productProfileId),
      ),
    )
    .where(
      and(
        eq(outreachDrafts.workspaceId, ctx.workspaceId),
        eq(outreachDrafts.id, draftId),
      ),
    )
    .limit(1);

  const q = rows[0];
  if (!q) return { allowed: true };

  if (q.geoStatus === 'mismatch') {
    return {
      allowed: false,
      reason:
        `geo blocked: company located in ${q.inferredCountry ?? 'unknown'} but ` +
        `recipe targets ${q.targetCountry ?? 'unknown'}`,
    };
  }
  if (q.geoStatus === 'unverified' && q.reviewState !== 'approved') {
    return {
      allowed: false,
      reason:
        `geo blocked: company location unverified for target ${q.targetCountry ?? 'unknown'} ` +
        `and review item not human-approved (state=${q.reviewState})`,
    };
  }
  return { allowed: true };
}

async function loadDraftForSend(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  draftId: bigint,
): Promise<{
  reviewItemId: bigint;
  productProfileId: bigint;
  body: string;
  language: string | null;
  subjectTranslated: string | null;
  bodyTranslated: string | null;
  targetLanguage: string | null;
} | null> {
  const rows = await db
    .select({
      reviewItemId: outreachDrafts.reviewItemId,
      productProfileId: outreachDrafts.productProfileId,
      body: outreachDrafts.body,
      language: outreachDrafts.language,
      subjectTranslated: outreachDrafts.subjectTranslated,
      bodyTranslated: outreachDrafts.bodyTranslated,
      targetLanguage: outreachDrafts.targetLanguage,
    })
    .from(outreachDrafts)
    .where(
      and(
        eq(outreachDrafts.workspaceId, ctx.workspaceId),
        eq(outreachDrafts.id, draftId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

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
