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
  type OutreachDraftStatus,
  type OutreachQueueEntry,
  type OutreachQueueStatus,
  type OutreachSendSettings,
  type OutreachStage,
  type SendDelayMode,
} from '@/lib/db/schema/outreach';
import { mailMessages, mailboxes, type MailboxStatus } from '@/lib/db/schema/mailing';
import { workspaces } from '@/lib/db/schema/workspaces';
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
  AutomationGateError,
  PAUSED_MESSAGE,
  checkGate,
  deferUntil,
  mailboxHeldMessage,
  originForDraft,
  type GateBlockReason,
  type SendOrigin,
} from './automation-gate';
import { productPauseOf, productPausedMessage } from './automation-policy';
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
import {
  withWorkLease,
  type LeaseHolder,
  type WorkLease,
  type WorkLeaseSpec,
} from './work-leases';
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

// ---- the pre-send gate (PC-10 + PC-05/PC-06) -----------------------

/**
 * Why the gate keeps the queue from sending now. All but 'daily_limit'
 * and 'send_pass_running' are the automation gate's workspace-wide
 * refusals for Sending (services/automation-gate.ts decideGate): the
 * workspace pause, a hold covering Sending, the platform-wide outbound
 * stop, no accountable owner (automatic sends only) and an archived
 * workspace (automatic only). PC-12 (I064): 'send_pass_running' — another
 * send pass holds the workspace's drain lease (the 30 s tick, "Send due
 * emails now" or a Retry now), and only the lease holder counts the daily
 * cap and sends.
 */
export const SEND_GATE_REFUSALS = [
  'paused',
  'hold',
  'platform_outbound_stop',
  'no_accountable_owner',
  'workspace_archived',
  'daily_limit',
  'send_pass_running',
] as const;
export type SendGateRefusal = (typeof SEND_GATE_REFUSALS)[number];

export type SendGateVerdict =
  | {
      open: true;
      /** Emails the daily cap still allows. */
      remaining: number;
      /** A manual send passes the workspace pause only because the
       *  operator confirmed "send anyway" (sendMessage audits it). */
      pauseOverridden?: true;
    }
  | {
      open: false;
      reason: SendGateRefusal;
      /** The automation gate's sentence for the operator (the hold's
       *  reason, who stopped outbound, …). Absent for the daily limit. */
      message?: string;
      /** A manual send may go out after the operator confirms it (the
       *  workspace pause only). */
      overridable?: boolean;
    };

export interface SendGateOptions {
  /** A person's own send (Retry now): the automation gate's manual rules
   *  — no accountable-owner or archived-workspace stop, and the pause
   *  refuses until confirmed. Default false: the drain is automatic work
   *  whoever triggers it. */
  manual?: boolean;
  /** Retry now under the workspace pause: the operator confirmed "send
   *  anyway". Ignored for automatic sends. */
  confirmPaused?: boolean;
}

type SendGate = (
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'trigger'>,
  settings: OutreachSendSettings,
  now: Date,
  options: SendGateOptions,
) => Promise<SendGateVerdict>;

let sendGateOverride: SendGate | null = null;

/** Tests: force the gate's verdict for every send path (null restores the
 *  real gate). */
export function _setSendGateForTests(gate: SendGate | null): void {
  sendGateOverride = gate;
}

/** The send-gate refusal for an automation-gate reason. The item-level
 *  reasons (go-live, mailbox, wallet) and the autopilot plan never refuse
 *  a workspace-wide Sending check; they fall back to 'hold' so a future
 *  gate rule still stops the queue rather than being ignored. */
export function sendGateRefusalOf(
  reason: GateBlockReason,
): Exclude<SendGateRefusal, 'daily_limit' | 'send_pass_running'> {
  switch (reason) {
    case 'paused':
    case 'hold':
    case 'platform_outbound_stop':
    case 'no_accountable_owner':
    case 'workspace_archived':
      return reason;
    default:
      return 'hold';
  }
}

/**
 * THE gate in front of every send from the queue. drainQueue (the drain
 * tick and "Send due emails now") and retryQueueEntry (Retry now) both
 * ask it before they send anything, so a manual path can never skip a
 * check the drain applies (PC-10). In order:
 *
 *   1. the automation gate for Sending (PC-06 / PC-05): the platform-wide
 *      outbound stop, a Sending hold, (automatic) no accountable owner or
 *      an archived workspace, and the workspace pause — which a manual
 *      send passes only with the operator's explicit "send anyway"
 *      (confirmPaused, an input of this gate);
 *   2. the workspace daily cap (delivered mail only).
 *
 * The go-live hold, the mailbox and a paused product are per email: the
 * drain asks the automation gate again for each row (with its origin and
 * mailbox) and defers just that row.
 */
export async function evaluateSendGate(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'trigger'>,
  settings: OutreachSendSettings,
  now: Date,
  options: SendGateOptions = {},
): Promise<SendGateVerdict> {
  if (sendGateOverride) return sendGateOverride(ctx, settings, now, options);
  const manual = options.manual ?? false;
  const decision = await checkGate(ctx, 'sending', {
    manual,
    confirmPaused: manual && options.confirmPaused === true,
  });
  if (!decision.allowed) {
    return {
      open: false,
      reason: sendGateRefusalOf(decision.reason),
      message: decision.message,
      overridable: decision.overridable,
    };
  }
  const remaining = await remainingDailyCap(ctx, settings, now);
  if (remaining === 0) return { open: false, reason: 'daily_limit' };
  return decision.pauseOverridden ? { open: true, remaining, pauseOverridden: true } : { open: true, remaining };
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
  /** PC-10: entries whose attempt failed for a retryable reason and that
   *  went back to the queue with a backoff (next_attempt_at). */
  retrying: number;
  /** PC-10: set when the send gate kept the pass from sending — before the
   *  first row, or (PC-05) mid-drain when a pause or hold landed. */
  blocked?: SendGateRefusal;
  /** PC-06 / PC-05: the automation gate's sentence when it stopped the
   *  drain (the workspace pause, a Sending hold, the platform outbound
   *  stop, no accountable owner). The rows it did not reach stay queued,
   *  untouched. Absent for the daily limit, which is not a hold. */
  heldReason?: string;
  /** PC-12: blocked 'send_pass_running' — the pass holding the
   *  workspace's drain lease, and since when. */
  sendPass?: LeaseHolder;
  /** PC-12: this pass stopped before its last row because it no longer
   *  held the drain lease (held past its maximum, or taken over after a
   *  stall). The rows it did not reach stay queued for the next pass. */
  leaseLost?: true;
}

export interface DrainOptions {
  /** Max entries to attempt this pass. */
  limit?: number;
  /** Test seam — overrides the IMailProvider used by sendMessage. */
  providerOverride?: IMailProvider;
  /** Test seam — pretend "now" is this Date. */
  now?: Date;
  /** PC-12: what started the pass, shown on its lease ('tick', 'manual'). */
  purpose?: string;
  /** Test seam: overrides of the drain lease's TTL / maximum hold. */
  lease?: Pick<WorkLeaseSpec, 'ttlMs' | 'maxHoldMs' | 'autoRenew'>;
}

/** What one attempt at an entry came to. 'deferred' = held by the gate
 *  (still queued, due again later, the reason on the row). */
export type EntryOutcome = 'sent' | 'failed' | 'skipped' | 'retrying' | 'deferred';

/** processEntry's result: an EntryOutcome, or 'stopped' — the automation
 *  gate refused for the whole workspace after the claim (the pause landed,
 *  a hold); the entry is handed back as it was and the drain stops. */
type AttemptResult =
  | { kind: EntryOutcome }
  | { kind: 'stopped'; refusal: Exclude<SendGateRefusal, 'daily_limit'>; message: string };

/** How processEntry sends: the drain's automatic rules, or a person's
 *  Retry now (manual, optionally confirmed under the pause). */
interface SendAs {
  manual: boolean;
  confirmPaused: boolean;
}

const AUTOMATIC_SEND: SendAs = { manual: false, confirmPaused: false };

const EMPTY_DRAIN: DrainResult = {
  picked: 0,
  sent: 0,
  failed: 0,
  skipped: 0,
  deferred: 0,
  retrying: 0,
};

/**
 * Send the queued entries that are due. Draining is automatic work
 * whoever triggers it (the 30 s tick, "Send due emails now"), so the gate
 * applies its automatic rules: the workspace pause, holds, the platform
 * stop and the accountable owner stop the whole drain; the go-live hold, a
 * mailbox that is not active and (PC-13) a paused product defer just that
 * row. PC-10: the daily cap counts delivered mail only, and an entry
 * backing off after a failed attempt waits for its next_attempt_at.
 *
 * PC-05: the gate is asked again before every row, and the claim itself
 * refuses while the workspace is paused (under a share lock on the
 * workspace row, which the pause has to wait for), so a pause committed
 * while row k is being sent leaves every later row queued and untouched,
 * and no row is claimed after the pause time.
 *
 * PC-12 (I064): one send pass per workspace at a time. The pass holds the
 * workspace's 'outreach.drain' lease (which Retry now takes too), and the
 * daily cap is counted under it, so overlapping passes can no longer each
 * count the same headroom and together send past the cap. A pass that
 * finds the lease held returns at once (blocked 'send_pass_running'); one
 * that loses it mid-way stops before its next claim.
 */
export async function drainQueue(
  ctx: WorkspaceContext,
  options: DrainOptions = {},
): Promise<DrainResult> {
  if (!canWrite(ctx)) throw denied('outreach.queue.drain');
  const leased = await withWorkLease(
    ctx,
    { kind: 'outreach.drain', purpose: options.purpose ?? 'send pass', ...options.lease },
    (lease) => drainUnderLease(ctx, options, lease),
  );
  if (leased.status === 'ran') return leased.value;
  return { ...EMPTY_DRAIN, blocked: 'send_pass_running', sendPass: leased.held };
}

async function drainUnderLease(
  ctx: WorkspaceContext,
  options: DrainOptions,
  lease: WorkLease,
): Promise<DrainResult> {
  const settings = await getSendSettings(ctx);
  const now = options.now ?? new Date();

  // The cap is counted here, under the lease: no other pass sends until
  // this one is done.
  const gate = await evaluateSendGate(ctx, settings, now);
  if (!gate.open) {
    return {
      ...EMPTY_DRAIN,
      blocked: gate.reason,
      ...(gate.message ? { heldReason: gate.message } : {}),
    };
  }
  const limit = Math.min(options.limit ?? 50, gate.remaining, 200);
  if (limit === 0) return { ...EMPTY_DRAIN };

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
  const { origins, products } = await draftFactsForEntries(ctx, due);

  const result: DrainResult = { ...EMPTY_DRAIN, picked: due.length };
  for (const entry of due) {
    // PC-12: still this pass's lease? Otherwise another pass may be
    // sending (and counting the cap) now: leave the rest to it.
    if (!(await lease.checkpoint())) {
      result.leaseLost = true;
      break;
    }
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
        result.blocked = sendGateRefusalOf(decision.reason);
        result.heldReason = decision.message;
        break;
      }
      if (await deferEntry(entry, now, decision.message)) {
        result.deferred++;
        result.skipped++;
      }
      continue;
    }
    // PC-13: the draft's product is paused — hold the row, never fail it.
    const productId = products.get(entry.id.toString());
    if (productId !== undefined) {
      const productPause = await productPauseOf(ctx, productId);
      if (productPause) {
        if (await deferEntry(entry, now, productPausedMessage(productPause.productName))) {
          result.deferred++;
          result.skipped++;
        }
        continue;
      }
    }
    const attempt = await processEntry(
      ctx,
      entry,
      settings,
      origin,
      AUTOMATIC_SEND,
      options.providerOverride,
      now,
    );
    if (attempt.kind === 'stopped') {
      result.blocked = attempt.refusal;
      result.heldReason = attempt.message;
      break;
    }
    countOutcome(result, attempt.kind);
  }
  return result;
}

function countOutcome(result: DrainResult, outcome: EntryOutcome): void {
  switch (outcome) {
    case 'sent':
      result.sent++;
      return;
    case 'failed':
      result.failed++;
      return;
    case 'retrying':
      result.retrying++;
      return;
    case 'deferred':
      result.deferred++;
      result.skipped++;
      return;
    case 'skipped':
      result.skipped++;
      return;
  }
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

/** PC-12 (I064): why a claimed entry's draft may no longer be sent, by
 *  the draft's status now (approved = it may). */
export function unapprovedDraftMessage(status: OutreachDraftStatus | null): string | null {
  switch (status) {
    case 'approved':
      return null;
    case 'superseded':
      return 'Not sent: a newer draft replaced this one after it was queued, and only an approved draft is sent. Approve and queue the new draft instead.';
    case 'rejected':
      return 'Not sent: its draft was rejected after it was queued.';
    case 'draft':
    case 'needs_edit':
      return 'Not sent: its draft went back for editing after it was queued. Approve it again to send it.';
    case null:
      return 'Not sent: its draft no longer exists.';
  }
}

/**
 * The claimed entry's draft is no longer approved: settle the claim as
 * 'skipped' with why (true), or leave it (false). Never sends, never
 * fails the row: the operator can approve the draft again and Requeue it.
 */
async function skipUnapprovedDraft(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  entry: OutreachQueueEntry,
): Promise<boolean> {
  if (!entry.draftId) return false;
  const [draft] = await db
    .select({ status: outreachDrafts.status })
    .from(outreachDrafts)
    .where(
      and(eq(outreachDrafts.workspaceId, ctx.workspaceId), eq(outreachDrafts.id, entry.draftId)),
    )
    .limit(1);
  const message = unapprovedDraftMessage(draft?.status ?? null);
  if (message === null) return false;
  await settleClaimed(entry.id, {
    status: 'skipped',
    nextAttemptAt: null,
    lastFailureKind: null,
    lastError: message,
  });
  return true;
}

/**
 * Claim the row — 'queued' → 'sending', stamped claimed_at from the
 * database clock (PC-10: the reaper compares it with the real time, never
 * the `now` test seam). PC-05: refused while the workspace is paused,
 * unless this is a manual send the operator confirmed under the pause. The
 * share lock on the workspace row makes a concurrent pause (which locks
 * the row FOR UPDATE before stamping its time) wait for this claim, or
 * this claim wait for the pause and then see it. KEY SHARE, so ordinary
 * workspace updates (token debits) never wait on a claim.
 */
async function claimEntry(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  entry: OutreachQueueEntry,
  sendAs: SendAs,
): Promise<'claimed' | 'paused' | 'lost'> {
  return db.transaction(async (tx) => {
    const [ws] = await tx
      .select({ pausedAt: workspaces.automationPausedAt })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId))
      .for('key share');
    if (!ws) return 'paused';
    if (ws.pausedAt && !(sendAs.manual && sendAs.confirmPaused)) return 'paused';
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

/** The workspace daily cap as the drain applies it (I070). */
export interface SendCapUsage {
  /** Outbound emails DELIVERED in the window, whatever path sent them
   *  (the queue, follow-ups, manual sends, replies). */
  used: number;
  /** outreach_send_settings.daily_email_limit. */
  cap: number;
  remaining: number;
  /** The window is the trailing 24 hours: [windowStart, now]. */
  windowStart: Date;
}

/** Column default of outreach_send_settings.daily_email_limit, for a
 *  workspace whose settings row was never created. */
const DEFAULT_DAILY_EMAIL_LIMIT = 50;

/**
 * THE daily-cap usage. The drain (evaluateSendGate), Today's send-queue
 * tile and the `send.cap_exhausted` finding all read it, so they cannot
 * disagree (I070): the limit minus the emails DELIVERED in the trailing
 * 24 hours. PC-10: failed attempts are not counted — with automatic
 * retries every failed attempt would otherwise eat a slot of the cap meant
 * for real sends. Pass `dailyEmailLimit` when the caller holds the
 * settings row; otherwise it is read (never created: a read must not
 * write).
 */
export async function getSendCapUsage(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  now: Date = new Date(),
  options: { dailyEmailLimit?: number } = {},
): Promise<SendCapUsage> {
  const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [sent, cap] = await Promise.all([
    db
      .select({ c: count() })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.workspaceId, ctx.workspaceId),
          eq(mailMessages.direction, 'outbound'),
          inArray(mailMessages.status, [...DELIVERED_STATUSES]),
          gte(mailMessages.createdAt, windowStart),
        ),
      ),
    options.dailyEmailLimit !== undefined
      ? Promise.resolve(options.dailyEmailLimit)
      : db
          .select({ limit: outreachSendSettings.dailyEmailLimit })
          .from(outreachSendSettings)
          .where(eq(outreachSendSettings.workspaceId, ctx.workspaceId))
          .limit(1)
          .then((rows) => rows[0]?.limit ?? DEFAULT_DAILY_EMAIL_LIMIT),
  ]);
  const used = Number(sent[0]?.c ?? 0);
  return { used, cap, remaining: Math.max(0, cap - used), windowStart };
}

/** The workspace daily cap left (getSendCapUsage). */
async function remainingDailyCap(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  settings: OutreachSendSettings,
  now: Date,
): Promise<number> {
  return (await getSendCapUsage(ctx, now, { dailyEmailLimit: settings.dailyEmailLimit }))
    .remaining;
}

/** Outbound mail_messages statuses that mean the email went out. Caps and
 *  the domain cooldown count these only; a failed or refused attempt
 *  reached nobody. */
const DELIVERED_STATUSES = DELIVERED_MESSAGE_STATUSES;

async function processEntry(
  ctx: WorkspaceContext,
  entry: OutreachQueueEntry,
  settings: OutreachSendSettings,
  origin: SendOrigin,
  sendAs: SendAs,
  providerOverride: IMailProvider | undefined,
  now: Date,
): Promise<AttemptResult> {
  const claim = await claimEntry(ctx, entry, sendAs);
  if (claim === 'paused') return { kind: 'stopped', refusal: 'paused', message: PAUSED_MESSAGE };
  if (claim === 'lost') return { kind: 'skipped' };

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
          // An earlier attempt's failure kind no longer describes the row.
          lastFailureKind: null,
          lastError: alreadyDeliveredMessage(delivered),
        });
        return { kind: 'skipped' };
      }
      // PC-12 (I064): only approved content goes out. A draft regenerated
      // (superseded), rejected or sent back for edits after its email was
      // queued is not sent.
      if (await skipUnapprovedDraft(ctx, entry)) return { kind: 'skipped' };
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

    // flow:F-05 / PC-05 / PC-10 (I014): a mailbox that is not active holds
    // its queue: no repeated failed logins against a failing mailbox's
    // provider (rate limit / fail2ban), a paused one waits for the operator
    // who paused it, an archived one for a restore — no entry turns
    // 'failed' for a problem that is ours (they used to fail, after paying
    // for the translation). The drain's per-row gate defers these before
    // the claim; this catches a mailbox that changed since, and Retry now
    // (a manual send, which the gate does not check per mailbox). Only a
    // mailbox that no longer exists fails the entry: nothing can send it.
    const mailboxState = await mailboxStatusOf(ctx, entry.mailboxId);
    if (mailboxState === undefined) {
      await settleClaimed(entry.id, {
        status: 'failed',
        lastFailureKind: 'policy',
        lastError: 'Not sent: the mailbox it was queued on no longer exists.',
      });
      return { kind: 'failed' };
    }
    if (mailboxState !== 'active') {
      await holdClaimedEntry(entry, now, mailboxHeldMessage(mailboxState));
      return { kind: 'deferred' };
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
    const draftId = entry.draftId;
    /** The reaper gave this send up as interrupted while it was still
     *  running (a hang past 10 minutes), and it went out after all. */
    let reapedMidSend = false;
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
      // PC-06: the drain sends on its own — the accountable-owner rule
      // applies. Retry now is a person's send: manual rules, and under the
      // workspace pause only with their "send anyway" (audited by
      // sendMessage as outbound.override).
      automatic: !sendAs.manual,
      ...(sendAs.manual && sendAs.confirmPaused ? { confirmPaused: true } : {}),
      // flow:F-07: sendMessage checks the go-live hold for it again.
      origin,
      // PC-10 (I013): 'sent' commits with the mail_messages row, so no
      // failure after the insert can leave a delivered email 'failed'.
      // Earlier failed attempts of the same draft leave the Errors folder
      // in the same step: nobody can re-send an email that went out.
      onPersisted: async (tx, message) => {
        const settled = await markQueueEntrySent(tx, {
          workspaceId: ctx.workspaceId,
          entryId: entry.id,
          messageId: message.id,
        });
        reapedMidSend = settled.wasInterrupted;
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

    // PC-12: asked again right before the hand-over — the translation
    // above can take a while, and a regenerate may land meanwhile.
    if (draftId && (await skipUnapprovedDraft(ctx, entry))) return { kind: 'skipped' };
    await sendMessage(ctx, sendInput);
    if (reapedMidSend) await resolveReapedMidSend(ctx, entry.id);
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
    return settleFailedAttempt(entry, err, now);
  }
}

/**
 * What a failed attempt becomes. Only rows still 'sending' (this
 * attempt's claim) are written.
 *
 * PC-06 / PC-05: the automation gate refusing the send after the claim is
 * never this entry's failure. A workspace-level refusal (the pause or a
 * hold placed mid-drain) hands it back exactly as it was and stops the
 * drain; an item-level one (the go-live hold, its mailbox stopped being
 * active) defers it. PC-10: everything else is classified
 * (src/lib/mail/send-failure.ts) — retried with backoff, held behind a
 * failing mailbox, or failed.
 */
async function settleFailedAttempt(
  entry: OutreachQueueEntry,
  err: unknown,
  now: Date,
): Promise<AttemptResult> {
  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof AutomationGateError) {
    if (err.scope === 'item') {
      await holdClaimedEntry(entry, now, message);
      return { kind: 'deferred' };
    }
    await settleClaimed(entry.id, {
      status: 'queued',
      attemptCount: entry.attemptCount,
      lastError: clip(message),
    });
    return { kind: 'stopped', refusal: sendGateRefusalOf(err.reason), message };
  }

  // The mail server took the email; only recording it failed afterwards.
  // It went out — never retry it.
  if (isAfterDelivery(err)) {
    const reaped = await settleDeliveredDespiteError(
      entry.id,
      clip(`Sent, but recording it failed: ${message}`),
    );
    if (reaped) await resolveSendInterrupted(entry.workspaceId, entry.id, null);
    return { kind: 'sent' };
  }

  // A recipient suppressed between the drain's own check and the send
  // (sendMessage refuses it): skipped, like the drain's check.
  if (err instanceof MailServiceError && err.code === 'suppressed') {
    await settleClaimed(entry.id, { status: 'skipped', lastError: clip(message) });
    return { kind: 'skipped' };
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
      await holdClaimedEntry(
        entry,
        now,
        clip(`${MAILBOX_FAILING_HOLD_REASON} Last error: ${message}`),
        failure.kind,
      );
      return { kind: 'deferred' };
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
      return { kind: 'retrying' };
    case 'give_up':
      await settleClaimed(entry.id, {
        status: 'failed',
        nextAttemptAt: null,
        lastFailureKind: failure.kind,
        lastError: clip(`Gave up after ${decision.attempt} attempts (${label}): ${message}`),
      });
      return { kind: 'failed' };
    case 'fail':
      await settleClaimed(entry.id, {
        status: 'failed',
        nextAttemptAt: null,
        lastFailureKind: failure.kind,
        lastError: clip(`${label}: ${message}`),
      });
      return { kind: 'failed' };
  }
}

function clip(text: string): string {
  return text.slice(0, 2000);
}

/**
 * PC-10: a send the reaper gave up as interrupted went out after all — its
 * send.interrupted incident no longer needs anyone. Only when the hook's
 * 'sent' committed (it is rolled back when the message had to be recorded
 * alone; the row then stays as the reaper left it). Best-effort: the send
 * itself succeeded.
 */
async function resolveReapedMidSend(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  entryId: bigint,
): Promise<void> {
  try {
    if ((await loadEntry(ctx, entryId)).status === 'sent') {
      await resolveSendInterrupted(ctx.workspaceId, entryId, null);
    }
  } catch (err) {
    console.error(
      `[outreach-queue] interrupted incident of entry ${entryId} not resolved:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * The email went out but recording it failed: the row is 'sent'. Written
 * while it is still this attempt's claim ('sending') or — when the send
 * hung past the reaper's 10 minutes — the reaper's 'interrupted' failure.
 * Returns true in the second case (the caller resolves its incident).
 */
async function settleDeliveredDespiteError(entryId: bigint, lastError: string): Promise<boolean> {
  const set = {
    status: 'sent' as const,
    lastFailureKind: null,
    nextAttemptAt: null,
    lastError,
    updatedAt: new Date(),
  };
  const [claimed] = await db
    .update(outreachQueue)
    .set(set)
    .where(and(eq(outreachQueue.id, entryId), eq(outreachQueue.status, 'sending')))
    .returning({ id: outreachQueue.id });
  if (claimed) return false;
  const [reaped] = await db
    .update(outreachQueue)
    .set(set)
    .where(
      and(
        eq(outreachQueue.id, entryId),
        eq(outreachQueue.status, 'failed'),
        eq(outreachQueue.lastFailureKind, 'interrupted'),
      ),
    )
    .returning({ id: outreachQueue.id });
  return Boolean(reaped);
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
   *  automation paused or on hold, outbound stopped, the daily limit used
   *  up, …); otherwise the outcome of the attempt — 'deferred' when this
   *  one email is held (the go-live hold, its mailbox, its paused
   *  product), the reason on the entry. */
  outcome: EntryOutcome | 'queued';
  /** Why it was not attempted now ('queued' only): the gate's refusal. */
  reason?: SendGateRefusal;
  /** The automation gate's sentence for that refusal, when it has one. */
  message?: string;
  /** PC-05: the refusal is the workspace pause, which the operator may
   *  override by confirming "send anyway". */
  overridable?: boolean;
  entry: OutreachQueueEntry;
}

export interface RetryQueueEntryOptions extends DrainOptions {
  /** PC-05: the operator confirmed "send anyway" while automation is
   *  paused (audited as outbound.override when it goes out). */
  confirmPaused?: boolean;
}

/**
 * Retry now: put the entry back (as requeueQueueEntry) and attempt it at
 * once through the same path as the drain — the same send gate
 * (evaluateSendGate: the platform outbound stop, holds, the workspace
 * pause, the daily cap), then the product pause, suppression, geography,
 * the go-live hold, mailbox state, the sending policy and the domain
 * cooldown. Retry now is a person's send: under the workspace pause it
 * goes out only with their explicit confirmation (confirmPaused). When
 * the gate refuses, it stays queued.
 *
 * PC-12: the attempt sends under the workspace's drain lease, like a
 * drain pass, so it counts the daily cap with no pass sending beside it.
 * While a pass holds the lease, the email is only put back (outcome
 * 'queued', reason 'send_pass_running'): the next pass sends it.
 */
export async function retryQueueEntry(
  ctx: WorkspaceContext,
  id: bigint,
  options: RetryQueueEntryOptions = {},
): Promise<RetryQueueEntryResult> {
  if (!canWrite(ctx)) throw denied('outreach.queue.retry');
  const now = options.now ?? new Date();
  const requeued = await putBack(ctx, id, 'retry', now);
  const leased = await withWorkLease(
    ctx,
    { kind: 'outreach.drain', purpose: 'Retry now', ...options.lease },
    () => retryUnderLease(ctx, id, requeued, options, now),
  );
  if (leased.status === 'ran') return leased.value;
  return { outcome: 'queued', reason: 'send_pass_running', entry: requeued };
}

async function retryUnderLease(
  ctx: WorkspaceContext,
  id: bigint,
  requeued: OutreachQueueEntry,
  options: RetryQueueEntryOptions,
  now: Date,
): Promise<RetryQueueEntryResult> {
  const settings = await getSendSettings(ctx);
  const sendAs: SendAs = { manual: true, confirmPaused: options.confirmPaused === true };
  const gate = await evaluateSendGate(ctx, settings, now, sendAs);
  if (!gate.open) {
    return {
      outcome: 'queued',
      reason: gate.reason,
      ...(gate.message ? { message: gate.message } : {}),
      ...(gate.overridable ? { overridable: true } : {}),
      entry: requeued,
    };
  }
  const { origins, products } = await draftFactsForEntries(ctx, [requeued]);
  // PC-13: a paused product's emails are held, whoever sends them.
  const productId = products.get(requeued.id.toString());
  if (productId !== undefined) {
    const productPause = await productPauseOf(ctx, productId);
    if (productPause) {
      await deferEntry(requeued, now, productPausedMessage(productPause.productName));
      return { outcome: 'deferred', entry: await loadEntry(ctx, id) };
    }
  }
  const attempt = await processEntry(
    ctx,
    requeued,
    settings,
    origins.get(requeued.id.toString()) ?? 'cold',
    sendAs,
    options.providerOverride,
    now,
  );
  if (attempt.kind === 'stopped') {
    return {
      outcome: 'queued',
      reason: attempt.refusal,
      message: attempt.message,
      ...(attempt.refusal === 'paused' ? { overridable: true } : {}),
      entry: await loadEntry(ctx, id),
    };
  }
  return { outcome: attempt.kind, entry: await loadEntry(ctx, id) };
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

/** True for an entry the reaper failed as "Interrupted: delivery unknown". */
export function isInterruptedQueueEntry(entry: {
  status: OutreachQueueStatus;
  lastFailureKind: string | null;
}): boolean {
  return (
    entry.status === 'failed' &&
    entry.lastFailureKind === ('interrupted' satisfies SendFailureKind)
  );
}

/**
 * PC-10: Mark as delivered — for an email cut off mid-send that the
 * operator found in the mailbox's Sent folder. The entry becomes 'sent'
 * (no mail row of ours: the copy is on the mail server), the draft's
 * failed copies leave the Errors folder so nobody sends it again, and its
 * send.interrupted incident is resolved. Any write role, like Retry and
 * Requeue; audited.
 */
export async function markQueueEntryDelivered(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<OutreachQueueEntry> {
  if (!canWrite(ctx)) throw denied('outreach.queue.mark_delivered');
  const existing = await loadEntry(ctx, id);
  if (!isInterruptedQueueEntry(existing)) {
    throw conflict(
      'Only an email cut off while it was being sent (delivery unknown) can be marked as delivered.',
    );
  }
  const now = new Date();
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(outreachQueue)
      .set({
        status: 'sent',
        lastFailureKind: null,
        nextAttemptAt: null,
        lastError: `Marked as delivered on ${formatUtc(now)}: found in the Sent folder after it was cut off mid-send.`,
        updatedAt: now,
      })
      .where(
        and(
          eq(outreachQueue.workspaceId, ctx.workspaceId),
          eq(outreachQueue.id, id),
          eq(outreachQueue.status, 'failed'),
          eq(outreachQueue.lastFailureKind, 'interrupted'),
        ),
      )
      .returning();
    if (row?.draftId) {
      await trashEarlierFailedCopies(tx, {
        workspaceId: ctx.workspaceId,
        draftId: row.draftId,
        now,
      });
    }
    return row;
  });
  if (!updated) {
    throw conflict('That email changed in the meantime. Reload the page to see where it is now.');
  }
  await recordAuditEvent(ctx, {
    kind: 'outreach.queue.mark_delivered',
    entityType: 'outreach_queue',
    entityId: id,
    payload: {
      draftId: existing.draftId?.toString() ?? null,
      previousError: existing.lastError?.slice(0, 500) ?? null,
    },
  });
  await resolveSendInterrupted(ctx.workspaceId, id, ctx.userId);
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

/** flow:F-05 / PC-10: the hold reasons a mailbox that is not active puts
 *  on its queue — the automation gate's wording (mailboxHeldMessage), so
 *  the drain's per-row gate, the in-attempt check and a refused SMTP login
 *  say the same thing. */
export const MAILBOX_FAILING_HOLD_REASON = mailboxHeldMessage('failing');
/** PC-10 (I014): a paused mailbox holds its queue instead of failing it. */
export const MAILBOX_PAUSED_HOLD_REASON = mailboxHeldMessage('paused');

/** PC-05: defer an entry the gate held before it was claimed (the go-live
 *  hold, a mailbox that is not active, a paused product): still 'queued',
 *  due again after GATE_DEFER_MS, the reason in last_error — never
 *  'failed'. Conditional on 'queued' so a concurrent cancel wins. True
 *  when it was deferred. */
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
 *  bump) and defer it like deferEntry — held, never failed (a mailbox that
 *  stopped being active, a refused SMTP login, the go-live hold). Only the
 *  attempt's own claim ('sending') is written. `failureKind` records why
 *  when an attempt was made (PC-10: sender_auth). */
async function holdClaimedEntry(
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
      scheduledSendAt: deferUntil(now),
      lastError: reason.slice(0, 2000),
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
 *   unverified            → blocked unless the review item is approved AND a
 *                            person confirmed the location (KL-02 geo
 *                            confirmation on the product, or a person's
 *                            name on the approval — not autopilot's)
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
      geoConfirmedAt: qualifications.geoConfirmedAt,
      reviewState: reviewItems.state,
      approvedByUserId: reviewItems.approvedByUserId,
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
  // Still approved, and by a person: an autopilot approval
  // (approvedByUserId NULL, KL-02) confirms nothing.
  const humanConfirmed =
    q.reviewState === 'approved' && (q.geoConfirmedAt !== null || q.approvedByUserId !== null);
  if (q.geoStatus === 'unverified' && !humanConfirmed) {
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
