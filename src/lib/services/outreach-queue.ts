// Outreach send queue. Approved drafts (or one-off scheduled sends) land
// here with a scheduled_send_at. A worker (BullMQ recurring or manual
// drainQueue() call from /mailbox/queue UI) picks queued items past their
// schedule, applies suppression + domain-cooldown + daily-cap checks, and
// dispatches via mail.sendMessage.
//
// Phase 19 ships the schema + service + manual drain. The BullMQ recurring
// worker is a thin wrapper around drainQueue() that any deployment can
// schedule (left out of the service layer to keep tests clean).
//
// PC-10 (I007, I013, I014): a failed attempt is classified
// (src/lib/mail/send-failure.ts) — transient and local errors come back
// with exponential backoff, a refused mailbox login holds the entry behind
// the failing mailbox, only permanent failures end 'failed'. A delivered
// send turns 'sent' in the same transaction as its mail_messages row.
// Failed, skipped and cancelled entries can be retried or requeued by
// hand; both go back through suppression, caps and cooldown. Entries stuck
// in 'sending' are settled by the stuck-work reaper (stuck-work.ts).

import { and, asc, count, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
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
import { mailMessages, mailboxes } from '@/lib/db/schema/mailing';
import {
  SEND_FAILURE_POLICY,
  classifySendFailure,
  decideRetry,
  isAfterDelivery,
  type SendFailureKind,
} from '@/lib/mail/send-failure';
import { formatUtc } from '@/lib/format-utc';
import { resolveSendInterrupted } from '@/lib/ops/work-incidents';
import { qualifications } from '@/lib/db/schema/qualifications';
import { reviewItems } from '@/lib/db/schema/review';
import { recordAuditEvent } from './audit';
import {
  canAdminWorkspace,
  canWrite,
  type WorkspaceContext,
} from './context';
import { MailServiceError, sendMessage, type SendMode } from './mail';
import {
  DELIVERED_MESSAGE_STATUSES,
  alreadyDeliveredMessage,
  findDeliveredCopyOfDraft,
  markQueueEntrySent,
  trashEarlierFailedCopies,
} from './outreach-queue-sent';
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
  // PC-10: the operator chose the time — a pending retry backoff no
  // longer holds the entry back.
  const [updated] = await db
    .update(outreachQueue)
    .set({ scheduledSendAt, nextAttemptAt: null, updatedAt: new Date() })
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

// ---- the pre-send gate (PC-10) ------------------------------------

/** Why the gate keeps the queue from sending now. */
export const SEND_GATE_REFUSALS = ['paused', 'daily_limit'] as const;
export type SendGateRefusal = (typeof SEND_GATE_REFUSALS)[number];

export type SendGateVerdict =
  | { open: true; /** Emails the daily cap still allows. */ remaining: number }
  | { open: false; reason: SendGateRefusal };

type SendGate = (
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  settings: OutreachSendSettings,
  now: Date,
) => Promise<SendGateVerdict>;

let sendGateOverride: SendGate | null = null;

/** Tests: force the gate's verdict for every send path (null restores the
 *  real gate). */
export function _setSendGateForTests(gate: SendGate | null): void {
  sendGateOverride = gate;
}

/**
 * PC-10: THE gate in front of every send from the queue. drainQueue (the
 * drain tick and "Send now") and retryQueueEntry (Retry now) both ask it
 * before they send anything, so a manual path can never skip a check the
 * drain applies. Checks today: the send-queue emergency pause, then the
 * workspace daily cap (delivered mail only).
 *
 * INTEGRATION (automation-control lane, PC-05): the platform-wide outbound
 * stop, the per-tenant holds, the go-live hold and the workspace
 * automation pause are checked HERE, each as a new SendGateRefusal (the
 * queue page's wording for them, in mailbox/queue/forms.ts, then fails to
 * compile until it is written). Retry now is a manual send: the outbound
 * stop and the holds refuse it exactly like the drain; under the workspace
 * pause it may go out only with the operator's explicit confirmation —
 * add that as an input of this gate, not as a check beside it.
 */
export async function evaluateSendGate(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  settings: OutreachSendSettings,
  now: Date,
): Promise<SendGateVerdict> {
  if (sendGateOverride) return sendGateOverride(ctx, settings, now);
  if (settings.emergencyPause) return { open: false, reason: 'paused' };
  const remaining = await remainingDailyCap(ctx, settings, now);
  if (remaining === 0) return { open: false, reason: 'daily_limit' };
  return { open: true, remaining };
}

// ---- drain --------------------------------------------------------

export interface DrainResult {
  picked: number;
  sent: number;
  failed: number;
  skipped: number;
  /** PC-10: entries whose attempt failed for a retryable reason and that
   *  went back to the queue with a backoff (next_attempt_at). */
  retrying: number;
  /** PC-10: set when the send gate kept the whole pass from sending. */
  blocked?: SendGateRefusal;
}

export interface DrainOptions {
  /** Max entries to attempt this pass. */
  limit?: number;
  /** Test seam — overrides the IMailProvider used by sendMessage. */
  providerOverride?: IMailProvider;
  /** Test seam — pretend "now" is this Date. */
  now?: Date;
}

/** What one attempt at an entry came to. */
export type EntryOutcome = 'sent' | 'failed' | 'skipped' | 'retrying';

const EMPTY_DRAIN: DrainResult = { picked: 0, sent: 0, failed: 0, skipped: 0, retrying: 0 };

export async function drainQueue(
  ctx: WorkspaceContext,
  options: DrainOptions = {},
): Promise<DrainResult> {
  if (!canWrite(ctx)) throw denied('outreach.queue.drain');
  const settings = await getSendSettings(ctx);
  const now = options.now ?? new Date();

  const gate = await evaluateSendGate(ctx, settings, now);
  if (!gate.open) {
    return { ...EMPTY_DRAIN, blocked: gate.reason };
  }
  const limit = Math.min(options.limit ?? 50, gate.remaining, 200);
  if (limit === 0) {
    return { ...EMPTY_DRAIN };
  }

  const due = await db
    .select()
    .from(outreachQueue)
    .where(
      and(
        eq(outreachQueue.workspaceId, ctx.workspaceId),
        eq(outreachQueue.status, 'queued'),
        lte(outreachQueue.scheduledSendAt, now),
        // PC-10: an entry backing off after a failed attempt waits.
        or(isNull(outreachQueue.nextAttemptAt), lte(outreachQueue.nextAttemptAt, now)),
      ),
    )
    .orderBy(asc(outreachQueue.scheduledSendAt))
    .limit(limit);

  const result: DrainResult = { ...EMPTY_DRAIN, picked: due.length };
  for (const entry of due) {
    const outcome = await processEntry(ctx, entry, settings, options.providerOverride, now);
    if (outcome === 'sent') result.sent++;
    else if (outcome === 'failed') result.failed++;
    else if (outcome === 'retrying') result.retrying++;
    else result.skipped++;
  }
  return result;
}

/**
 * The workspace daily cap left: the limit minus the emails DELIVERED in
 * the trailing 24 hours. PC-10: failed attempts are not counted — with
 * automatic retries every failed attempt would otherwise eat a slot of
 * the cap meant for real sends.
 */
async function remainingDailyCap(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  settings: OutreachSendSettings,
  now: Date,
): Promise<number> {
  const dayStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sentToday = await db
    .select({ c: count() })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        eq(mailMessages.direction, 'outbound'),
        inArray(mailMessages.status, [...DELIVERED_STATUSES]),
        gte(mailMessages.createdAt, dayStart),
      ),
    );
  return Math.max(0, settings.dailyEmailLimit - Number(sentToday[0]?.c ?? 0));
}

/** Outbound mail_messages statuses that mean the email went out. Caps and
 *  the domain cooldown count these only; a failed or refused attempt
 *  reached nobody. */
const DELIVERED_STATUSES = DELIVERED_MESSAGE_STATUSES;

async function processEntry(
  ctx: WorkspaceContext,
  entry: OutreachQueueEntry,
  settings: OutreachSendSettings,
  providerOverride: IMailProvider | undefined,
  now: Date,
): Promise<EntryOutcome> {
  // Claim the row. Best-effort optimistic update. PC-10: claimed_at is
  // wall-clock (not the `now` test seam) — the reaper compares it with
  // the real time.
  const claim = await db
    .update(outreachQueue)
    .set({
      status: 'sending',
      attemptCount: entry.attemptCount + 1,
      claimedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(outreachQueue.id, entry.id), eq(outreachQueue.status, 'queued')))
    .returning();
  if (claim.length === 0) return 'skipped';

  try {
    // PC-10: one draft = one email. Another queue row of the draft, the
    // Errors-folder Retry or a manual compose may already have sent it.
    if (entry.draftId) {
      const delivered = await findDeliveredCopyOfDraft(db, {
        workspaceId: ctx.workspaceId,
        draftId: entry.draftId,
        excludeQueueEntryId: entry.id,
      });
      if (delivered) {
        await settleClaimed(entry.id, {
          status: 'skipped',
          nextAttemptAt: null,
          lastError: alreadyDeliveredMessage(delivered),
        });
        return 'skipped';
      }
    }

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
        return 'skipped';
      }
    }

    // flow:F-05: a mailbox marked failing (a refused SMTP login, or the
    // IMAP auto-pause — then nobody reads the replies) holds its queue: no
    // repeated failed logins against the provider's rate limit / fail2ban,
    // and no entry turns 'failed' for a problem that is ours. The entry
    // goes out once the mailbox is reactivated.
    // PC-10 (I014): a PAUSED mailbox holds its queue the same way — the
    // operator paused it to fix something, its emails wait instead of
    // failing (they used to fail, after paying for the translation).
    const mailboxState = await mailboxSendState(ctx, entry.mailboxId);
    if (mailboxState === 'failing') {
      await holdEntry(entry, now, MAILBOX_FAILING_HOLD_REASON);
      return 'skipped';
    }
    if (mailboxState === 'paused') {
      await holdEntry(entry, now, MAILBOX_PAUSED_HOLD_REASON);
      return 'skipped';
    }
    if (mailboxState === 'archived' || mailboxState === 'missing') {
      await settleClaimed(entry.id, {
        status: 'failed',
        lastFailureKind: 'policy',
        lastError:
          mailboxState === 'archived'
            ? 'Not sent: the mailbox it was queued on is archived.'
            : 'Not sent: the mailbox it was queued on no longer exists.',
      });
      return 'failed';
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
      return 'skipped';
    }

    // Domain cooldown: any prior DELIVERED outbound to this domain in the
    // last domainCooldownHours triggers skip. PC-10: a failed attempt
    // reached nobody, so it does not start a cooldown — otherwise every
    // automatic retry (or a manual Retry / Requeue) would be blocked by
    // the failed attempt before it.
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
              inArray(mailMessages.status, [...DELIVERED_STATUSES]),
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
    const draftId = entry.draftId;
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
      sourceDraftId: draftId ?? undefined,
      bodyTextNative,
      nativeLanguage,
      targetLanguage,
      // PC-10 (I013): 'sent' commits with the mail_messages row, so no
      // failure after the insert can leave a delivered email 'failed'.
      // Earlier failed attempts of the same draft leave the Errors folder
      // in the same step: nobody can re-send an email that went out.
      onPersisted: async (tx, message) => {
        await markQueueEntrySent(tx, {
          workspaceId: ctx.workspaceId,
          entryId: entry.id,
          messageId: message.id,
        });
        if (draftId) {
          await trashEarlierFailedCopies(tx, {
            workspaceId: ctx.workspaceId,
            draftId,
            deliveredMessageId: message.id,
          });
        }
      },
      providerOverride,
    };
    if (entry.inReplyTo) sendInput.inReplyTo = entry.inReplyTo;
    if (entry.references.length > 0) sendInput.references = entry.references;

    await sendMessage(ctx, sendInput);
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
    return 'sent';
  } catch (err) {
    return settleFailedAttempt(entry, err, now);
  }
}

/**
 * PC-10: what a failed attempt becomes (src/lib/mail/send-failure.ts).
 * Only rows still 'sending' (this attempt's claim) are written.
 */
async function settleFailedAttempt(
  entry: OutreachQueueEntry,
  err: unknown,
  now: Date,
): Promise<EntryOutcome> {
  const message = err instanceof Error ? err.message : String(err);

  // The mail server took the email; only recording it failed afterwards.
  // It went out — never retry it.
  if (isAfterDelivery(err)) {
    await settleClaimed(entry.id, {
      status: 'sent',
      lastFailureKind: null,
      nextAttemptAt: null,
      lastError: clip(`Sent, but recording it failed: ${message}`),
    });
    return 'sent';
  }

  // A recipient suppressed between the drain's own check and the send
  // (sendMessage refuses it): skipped, like the drain's check.
  if (err instanceof MailServiceError && err.code === 'suppressed') {
    await settleClaimed(entry.id, { status: 'skipped', lastError: clip(message) });
    return 'skipped';
  }

  const attempt = entry.attemptCount + 1; // this attempt (the claim's bump)
  const failure = classifySendFailure(err, [
    ...entry.toAddresses,
    ...entry.ccAddresses,
    ...entry.bccAddresses,
  ]);
  const decision = decideRetry(failure.kind, attempt, now);
  const label = SEND_FAILURE_POLICY[failure.kind].label;

  switch (decision.action) {
    case 'hold':
      // flow:F-05: a refused SMTP login is the mailbox's problem
      // (sendMessage has marked it failing), not this entry's — keep it
      // queued behind the failing-mailbox hold instead of failing it.
      await holdEntry(
        entry,
        now,
        clip(`${MAILBOX_FAILING_HOLD_REASON} Last error: ${message}`),
        failure.kind,
      );
      return 'skipped';
    case 'retry':
      await settleClaimed(entry.id, {
        status: 'queued',
        nextAttemptAt: decision.nextAttemptAt,
        lastFailureKind: failure.kind,
        lastError: clip(
          `Attempt ${decision.attempt} of ${decision.maxAttempts} failed (${label}): ${message} ` +
            `Next attempt after ${formatUtc(decision.nextAttemptAt)}.`,
        ),
      });
      return 'retrying';
    case 'give_up':
      await settleClaimed(entry.id, {
        status: 'failed',
        nextAttemptAt: null,
        lastFailureKind: failure.kind,
        lastError: clip(`Gave up after ${decision.attempt} attempts (${label}): ${message}`),
      });
      return 'failed';
    case 'fail':
      await settleClaimed(entry.id, {
        status: 'failed',
        nextAttemptAt: null,
        lastFailureKind: failure.kind,
        lastError: clip(`${label}: ${message}`),
      });
      return 'failed';
  }
}

function clip(text: string): string {
  return text.slice(0, 2000);
}

/** Write the outcome of this attempt — only while the row is still the
 *  attempt's own claim ('sending'). */
async function settleClaimed(
  entryId: bigint,
  set: Partial<
    Pick<
      OutreachQueueEntry,
      'status' | 'lastError' | 'lastFailureKind' | 'nextAttemptAt' | 'attemptCount' | 'scheduledSendAt'
    >
  >,
): Promise<void> {
  await db
    .update(outreachQueue)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(outreachQueue.id, entryId), eq(outreachQueue.status, 'sending')));
}

// ---- manual recovery (PC-10) --------------------------------------

/** Statuses an operator can put back into the queue. */
export const RECOVERABLE_QUEUE_STATUSES: readonly OutreachQueueStatus[] = [
  'failed',
  'skipped',
  'cancelled',
];

export function isRecoverableQueueStatus(status: OutreachQueueStatus): boolean {
  return RECOVERABLE_QUEUE_STATUSES.includes(status);
}

/** Why an entry in a non-recoverable status cannot be put back (shown to
 *  the operator as is). */
const NOT_RECOVERABLE_MESSAGE: Partial<Record<OutreachQueueStatus, string>> = {
  queued: 'That email is already waiting in the queue.',
  sending: 'That email is being sent right now.',
  sent: 'That email has already been sent.',
};

/**
 * Put a failed, skipped or cancelled entry back into the queue, due now,
 * with a fresh set of automatic attempts. Nothing is sent here: the next
 * drain picks it up and applies every check again (suppression, geography,
 * mailbox state, the mailbox's sending policy, the workspace daily cap,
 * the domain cooldown).
 */
export async function requeueQueueEntry(
  ctx: WorkspaceContext,
  id: bigint,
  options: { now?: Date } = {},
): Promise<OutreachQueueEntry> {
  if (!canWrite(ctx)) throw denied('outreach.queue.requeue');
  return putBack(ctx, id, 'requeue', options.now ?? new Date());
}

export interface RetryQueueEntryResult {
  /** 'queued' = put back but not attempted now (the send gate refused:
   *  sending paused, the daily limit used up, …); otherwise the outcome
   *  of the attempt. */
  outcome: EntryOutcome | 'queued';
  /** Why it was not attempted now ('queued' only): the gate's refusal. */
  reason?: SendGateRefusal;
  entry: OutreachQueueEntry;
}

/**
 * Retry now: put the entry back (as requeueQueueEntry) and attempt it at
 * once through the same path as the drain — the same send gate
 * (evaluateSendGate: the emergency pause, the daily cap, and whatever is
 * added there), then suppression, geography, mailbox state, the sending
 * policy and the domain cooldown. When the gate refuses, it stays queued.
 */
export async function retryQueueEntry(
  ctx: WorkspaceContext,
  id: bigint,
  options: DrainOptions = {},
): Promise<RetryQueueEntryResult> {
  if (!canWrite(ctx)) throw denied('outreach.queue.retry');
  const now = options.now ?? new Date();
  const requeued = await putBack(ctx, id, 'retry', now);
  const settings = await getSendSettings(ctx);
  const gate = await evaluateSendGate(ctx, settings, now);
  if (!gate.open) {
    return { outcome: 'queued', reason: gate.reason, entry: requeued };
  }
  const outcome = await processEntry(ctx, requeued, settings, options.providerOverride, now);
  return { outcome, entry: await loadEntry(ctx, id) };
}

async function putBack(
  ctx: WorkspaceContext,
  id: bigint,
  op: 'requeue' | 'retry',
  now: Date,
): Promise<OutreachQueueEntry> {
  const existing = await loadEntry(ctx, id);
  if (!isRecoverableQueueStatus(existing.status)) {
    throw conflict(NOT_RECOVERABLE_MESSAGE[existing.status] ?? 'That email cannot be put back.');
  }
  if (existing.draftId) {
    const [draft] = await db
      .select({ status: outreachDrafts.status })
      .from(outreachDrafts)
      .where(
        and(
          eq(outreachDrafts.workspaceId, ctx.workspaceId),
          eq(outreachDrafts.id, existing.draftId),
        ),
      )
      .limit(1);
    // Same gate as enqueueDraft: only approved content goes out.
    if (draft && draft.status !== 'approved') {
      throw conflict(
        `Its draft is now ${draft.status.replace('_', ' ')}, and only an approved draft is sent. Approve it (or queue its replacement) instead.`,
      );
    }
    // PC-10: one draft = one email. Drafts have no 'sent' status, so ask
    // whether its email went out through another queue row, the
    // Errors-folder Retry or a manual compose.
    const delivered = await findDeliveredCopyOfDraft(db, {
      workspaceId: ctx.workspaceId,
      draftId: existing.draftId,
      excludeQueueEntryId: id,
    });
    if (delivered) throw conflict(alreadyDeliveredMessage(delivered));
  }

  let updated: OutreachQueueEntry | undefined;
  try {
    [updated] = await db
      .update(outreachQueue)
      .set({
        status: 'queued',
        scheduledSendAt: now,
        nextAttemptAt: null,
        attemptCount: 0,
        claimedAt: null,
        lastError: null,
        lastFailureKind: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(outreachQueue.workspaceId, ctx.workspaceId),
          eq(outreachQueue.id, id),
          // Optimistic: nobody moved it since we read it.
          eq(outreachQueue.status, existing.status),
        ),
      )
      .returning();
  } catch (err) {
    // outreach_queue_draft_active_idx: one waiting / sending entry per draft.
    if (isUniqueViolation(err)) {
      throw conflict(
        'This draft already has an email waiting in the queue. Cancel that one first, or leave this one as it is.',
      );
    }
    throw err;
  }
  if (!updated) {
    throw conflict('That email changed in the meantime. Reload the page to see where it is now.');
  }

  await recordAuditEvent(ctx, {
    kind: `outreach.queue.${op}`,
    entityType: 'outreach_queue',
    entityId: id,
    payload: {
      from: existing.status,
      previousFailureKind: existing.lastFailureKind,
      previousError: existing.lastError?.slice(0, 500) ?? null,
      attemptsBefore: existing.attemptCount,
    },
  });
  if (existing.lastFailureKind === ('interrupted' satisfies SendFailureKind)) {
    await resolveSendInterrupted(ctx.workspaceId, id, ctx.userId);
  }
  return updated;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
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

// ---- send mode + failing-mailbox hold (flow:F-05) -----------------

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

/** How long a held entry waits before the drain looks at it again. Keeps
 *  held entries from filling every drain batch. */
export const MAILBOX_FAILING_HOLD_MS = 30 * 60 * 1000;
export const MAILBOX_FAILING_HOLD_REASON =
  'Held: the mailbox is failing (see its last error). Fix it under Edit settings and Reactivate — this send then goes out.';
/** PC-10 (I014): a paused mailbox holds its queue instead of failing it. */
export const MAILBOX_PAUSED_HOLD_REASON =
  'Held: the mailbox is paused. Set it back to active under Edit settings — this send then goes out.';

type MailboxSendState = 'active' | 'failing' | 'paused' | 'archived' | 'missing';

async function mailboxSendState(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  mailboxId: bigint,
): Promise<MailboxSendState> {
  const [row] = await db
    .select({ status: mailboxes.status })
    .from(mailboxes)
    .where(and(eq(mailboxes.workspaceId, ctx.workspaceId), eq(mailboxes.id, mailboxId)))
    .limit(1);
  return row?.status ?? 'missing';
}

/** Put a claimed entry back to 'queued' (undoing the claim's attempt
 *  bump) and look at it again after MAILBOX_FAILING_HOLD_MS. Only the
 *  attempt's own claim ('sending') is written. */
async function holdEntry(
  entry: OutreachQueueEntry,
  now: Date,
  reason: string,
  failureKind?: SendFailureKind,
): Promise<void> {
  await db
    .update(outreachQueue)
    .set({
      status: 'queued',
      attemptCount: entry.attemptCount,
      scheduledSendAt: new Date(now.getTime() + MAILBOX_FAILING_HOLD_MS),
      lastError: reason,
      ...(failureKind ? { lastFailureKind: failureKind } : {}),
      updatedAt: new Date(),
    })
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
