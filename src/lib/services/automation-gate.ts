// PC-06 + PC-05: the automation gate — one answer to "may this workspace
// do <capability> now?", asked at every place such work starts and again
// before every item a loop works on (a queue row, a follow-up, a recipe,
// an autopilot candidate), so a pause or a hold placed mid-loop stops it
// at the next item.
//
//   AutomationState   what the gate decides on, loaded per workspace from
//                     the workspace_automation_state view (lifecycle,
//                     accountable owner, the workspace pause, the go-live
//                     hold, wallet and plan) plus the enforced holds
//                     (state 'active', not expired — compared against
//                     now(), so an expired hold stops applying without any
//                     job running) and the platform-wide outbound stop.
//   decideGate()      pure: (state, capability, {manual, origin,
//                     mailboxStatus, spendsTokens, confirmPaused}) →
//                     allowed, or refused with a reason, a sentence for the
//                     operator and a scope ('workspace': nothing of this
//                     kind may run now, stop the loop; 'item': only this
//                     item waits — defer it and go on).
//   assertGate()      loads + decides + throws AutomationGateError — for
//                     services a person calls (compose, Sync, Run now…).
//   checkGate()       loads + decides, never throws — for loops that must
//                     stop cleanly (the drain re-checks before each row).
//   activeWorkspacesForTicks()
//                     every active workspace (selected from the view) with
//                     its state and an automation context, for the ticks.
//
// Order of the checks (first match wins):
//   1. automatic work in an archived workspace
//   2. Sending under the platform-wide outbound stop (super-admins only;
//      it refuses manual sends too, and a tenant cannot lift it)
//   3. a hold covering the capability (scope 'all', or the capability in
//      its list) — automatic AND manual work alike; platform holds first
//   4. the accountable-owner rule, automatic work only (PC-06): automation
//      acts as workspaces.owner_user_id, so when that user is not active
//      or no longer a member it stops (no_accountable_owner) — no fallback
//      to another member. Manual work by other members goes on. The first
//      gate to find it raises one incident (an audit row plus a
//      notification to the workspace admins) until PC-07's incident
//      stream lands; it is cleared when the owner is back.
//   5. the workspace pause (PC-05): automatic work of every capability but
//      Inbox sync stops (replies keep arriving; reply auto-actions wait).
//      A manual send is refused until the person confirms "send anyway"
//      (confirmPaused), which the caller audits (outbound.override).
//      Other manual work (Sync, Run now, a CRM push) goes on.
//   6. the plan (autopilot needs a plan that includes it)
//   7. the go-live hold (flow:F-07): cold, follow-up and AI-reply mail is
//      held while the workspace is not live, manual sends too; manual mail
//      (compose, a thread reply) is not.
//   8. the mailbox (automatic work on one mailbox): a paused, failing or
//      archived mailbox defers the item instead of failing it (P0-F08,
//      I014, I095); a person's manual send still gets the mailbox's own
//      message from sendMessage.
//   9. the wallet: work that spends tokens waits for a billing-exempt
//      workspace or a positive balance, automatic and manual alike.

import { and, eq, gt, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import type { AccountStatus } from '@/lib/db/schema/auth';
import { workspaceAutomationState } from '@/lib/db/schema/automation-state';
import {
  AUTOMATION_CAPABILITIES,
  workspaceHolds,
  type AutomationCapability,
  type WorkspaceHoldSource,
} from '@/lib/db/schema/holds';
import type { MailboxStatus } from '@/lib/db/schema/mailing';
import { platformSettings } from '@/lib/db/schema/platform-settings';
import { workspaces, type WorkspaceStatus } from '@/lib/db/schema/workspaces';
import { isAutomatic, makeAutomationContext, type WorkspaceContext } from './context';
import { resolveEffectivePlan } from './plan-limits';

export { AUTOMATION_CAPABILITIES, type AutomationCapability };

/** Operator-facing names (the console, the banner, error messages). */
export const CAPABILITY_LABELS: Readonly<Record<AutomationCapability, string>> = {
  sending: 'Sending',
  inbox_sync: 'Inbox sync',
  inbound_actions: 'Reply auto-actions',
  discovery: 'Discovery',
  autopilot: 'Autopilot',
  crm_sync: 'CRM sync',
  background_ai: 'Background AI',
  auto_topup: 'Auto top-up',
  trash_purge: 'Trash purge',
};

/** PC-05: what the workspace pause stops (its automatic side). Inbox sync
 *  keeps reading so replies, bounces and unsubscribes still arrive. */
export const PAUSED_CAPABILITIES: ReadonlySet<AutomationCapability> = new Set(
  AUTOMATION_CAPABILITIES.filter((c) => c !== 'inbox_sync'),
);

/**
 * flow:F-07 / F-27: where an outbound email comes from.
 *   cold       a first touch from an approved outreach draft (the queue)
 *   follow_up  a follow-up step (the tick, or a person approving it)
 *   ai_reply   a draft the platform wrote in answer to a prospect's reply
 *   manual     a person writing: compose, a thread reply, a retry
 */
export const SEND_ORIGINS = ['cold', 'follow_up', 'ai_reply', 'manual'] as const;
export type SendOrigin = (typeof SEND_ORIGINS)[number];

/** The go-live hold covers these origins until the workspace is live. */
export const HELD_UNTIL_LIVE_ORIGINS: ReadonlySet<SendOrigin> = new Set([
  'cold',
  'follow_up',
  'ai_reply',
]);

/**
 * The origin of an outreach draft's email: a draft the platform wrote in
 * answer to a prospect's reply (triggered by an inbound message, past the
 * discovery stage) is an AI reply; any other draft — a cold first touch,
 * or an intro to a referred contact — is cold. Same split as the send
 * mode (outreach-queue.ts sendModeForDraft).
 */
export function originForDraft(draft: {
  stage: string;
  triggeredByMessageId: bigint | null;
}): SendOrigin {
  return draft.triggeredByMessageId !== null && draft.stage !== 'discovery' ? 'ai_reply' : 'cold';
}

/** PC-05: how long an item the gate defers (a paused / failing mailbox,
 *  the go-live hold) waits before the loop looks at it again. Keeps held
 *  items from filling every batch; they never turn 'failed'. */
export const GATE_DEFER_MS = 15 * 60 * 1000;

/** platform_settings key of the platform-wide outbound stop: the row's
 *  value is the reason, updated_by_user_id who set it, updated_at since
 *  when. No row = no stop. Not a provider setting, so the providers
 *  console neither lists nor writes it (services/holds.ts does). */
export const PLATFORM_OUTBOUND_STOP_KEY = 'outbound.stop';

export interface EnforcedHold {
  id: bigint;
  scope: 'all' | 'capabilities';
  capabilities: AutomationCapability[];
  source: WorkspaceHoldSource;
  reason: string;
  expiresAt: Date | null;
  placedAt: Date;
  blocksAccess: boolean;
}

export interface PlatformOutboundStop {
  since: Date;
  byUserId: string | null;
  reason: string;
}

/** PC-05: the workspace pause, when paused. */
export interface WorkspacePause {
  since: Date;
  byUserId: string | null;
  reason: string | null;
  /** Where it was pressed (PAUSE_SOURCES in automation-pause.ts). */
  source: string | null;
}

/** flow:F-07: when the workspace went live, when it is. */
export interface GoLive {
  since: Date;
  byUserId: string | null;
}

/** Why the workspace has no accountable owner. */
export type OwnerProblem = 'owner_inactive' | 'owner_not_member';

export interface AutomationState {
  workspaceId: bigint;
  workspaceStatus: WorkspaceStatus;
  ownerUserId: string;
  ownerAccountStatus: AccountStatus | null;
  ownerIsMember: boolean;
  /** null = the owner is accountable (active account, still a member). */
  ownerProblem: OwnerProblem | null;
  /** When the open no-accountable-owner incident was raised, if any. */
  ownerIncidentOpenSince: Date | null;
  /** Enforced holds only (active, unexpired at `evaluatedAt`). */
  holds: EnforcedHold[];
  platformOutboundStop: PlatformOutboundStop | null;
  /** PC-05: null = running. */
  pause: WorkspacePause | null;
  /** flow:F-07: null = not live (the go-live hold applies). */
  live: GoLive | null;
  /** Billing-exempt, or a positive token balance. */
  walletHasTokens: boolean;
  /** The effective plan includes autopilot. */
  planAllowsAutopilot: boolean;
  evaluatedAt: Date;
}

export type GateBlockReason =
  | 'workspace_archived'
  | 'platform_outbound_stop'
  | 'hold'
  | 'no_accountable_owner'
  | 'paused'
  | 'plan_no_autopilot'
  | 'not_live'
  | 'mailbox_not_active'
  | 'wallet_empty';

/**
 * 'workspace': nothing of this capability may run in this workspace now —
 * a loop stops and leaves the rest untouched. 'item': only this item
 * waits (its origin is held, its mailbox is not active) — a loop defers
 * it and goes on with the next.
 */
export type GateRefusalScope = 'workspace' | 'item';

export interface GateRefusal {
  allowed: false;
  reason: GateBlockReason;
  capability: AutomationCapability;
  /** The hold that blocked it (reason 'hold'). */
  hold?: EnforcedHold;
  /** One sentence for the operator. */
  message: string;
  scope: GateRefusalScope;
  /** A person may send anyway after confirming (the pause, manual sends). */
  overridable: boolean;
}

export type GateDecision =
  | {
      allowed: true;
      /** Present (true) when a manual send passes only because the person
       *  confirmed it under the pause; the caller audits the override. */
      pauseOverridden?: true;
    }
  | GateRefusal;

export interface GateItemOptions {
  /** Sending: where the email comes from (the go-live hold). Absent =
   *  the question is about sending in general, not one email. */
  origin?: SendOrigin;
  /** Automatic work on one mailbox: its status (non-active defers). */
  mailboxStatus?: MailboxStatus;
  /** The work spends tokens (AI, search): needs a non-empty wallet. */
  spendsTokens?: boolean;
  /** A manual send the person confirmed under the pause ("send anyway"). */
  confirmPaused?: boolean;
}

export interface GateOptions extends GateItemOptions {
  /** A person asked for this work now (compose, Sync, Run now). Automatic
   *  work (ticks, autopilot, the queue drain) passes false. Defaults to
   *  the context: manual unless ctx.trigger is 'automation'. */
  manual?: boolean;
  /** Evaluate expiry against this instant (tests). */
  now?: Date;
}

/** What AutomationGateError is built from (scope / overridable default to
 *  'workspace' / false for callers that construct one by hand). */
export type GateRefusalInput = Omit<GateRefusal, 'scope' | 'overridable'> &
  Partial<Pick<GateRefusal, 'scope' | 'overridable'>>;

/** Thrown by assertGate (and by services that run it) when the gate says
 *  no. `code` is constant so action error helpers can recognise it; the
 *  message is written for the operator. */
export class AutomationGateError extends Error {
  public readonly code = 'automation_held' as const;
  public readonly reason: GateBlockReason;
  public readonly capability: AutomationCapability;
  public readonly holdId: bigint | null;
  public readonly scope: GateRefusalScope;
  public readonly overridable: boolean;
  constructor(decision: GateRefusalInput) {
    super(decision.message);
    this.name = 'AutomationGateError';
    this.reason = decision.reason;
    this.capability = decision.capability;
    this.holdId = decision.hold?.id ?? null;
    this.scope = decision.scope ?? 'workspace';
    this.overridable = decision.overridable ?? false;
  }
}

// ---- pure decision ---------------------------------------------------

export function holdCovers(
  hold: Pick<EnforcedHold, 'scope' | 'capabilities'>,
  capability: AutomationCapability,
): boolean {
  return hold.scope === 'all' || hold.capabilities.includes(capability);
}

/** Readable list of what a hold stops, e.g. "Sending and Inbox sync". */
export function describeHoldScope(hold: Pick<EnforcedHold, 'scope' | 'capabilities'>): string {
  if (hold.scope === 'all') return 'All automation and capability work';
  const labels = hold.capabilities.map((c) => CAPABILITY_LABELS[c]);
  if (labels.length <= 1) return labels[0] ?? 'Nothing';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function holdIsLive(hold: EnforcedHold, now: Date): boolean {
  return hold.expiresAt === null || hold.expiresAt.getTime() > now.getTime();
}

const ORIGIN_LABELS: Readonly<Record<SendOrigin, string>> = {
  cold: 'Cold outreach',
  follow_up: 'Follow-ups',
  ai_reply: 'AI reply drafts',
  manual: 'Manual email',
};

export const PAUSED_MESSAGE =
  'Automation is paused in this workspace: nothing is sent, composed or run automatically until an owner or admin resumes it.';
export const PAUSED_MANUAL_SEND_MESSAGE =
  'Automation is paused in this workspace. Confirm "send anyway" to send this email by hand; it is recorded in the audit log.';

function refuse(
  capability: AutomationCapability,
  reason: GateBlockReason,
  message: string,
  extra: { scope?: GateRefusalScope; overridable?: boolean; hold?: EnforcedHold } = {},
): GateRefusal {
  return {
    allowed: false,
    reason,
    capability,
    ...(extra.hold ? { hold: extra.hold } : {}),
    message,
    scope: extra.scope ?? 'workspace',
    overridable: extra.overridable ?? false,
  };
}

/**
 * The gate. Pure: everything it needs is in `state` and the options.
 * `manual` is required here (callers resolve the default from their
 * context).
 */
export function decideGate(
  state: AutomationState,
  capability: AutomationCapability,
  options: GateItemOptions & { manual: boolean; now?: Date },
): GateDecision {
  const now = options.now ?? state.evaluatedAt;
  const manual = options.manual;

  if (!manual && state.workspaceStatus !== 'active') {
    return refuse(
      capability,
      'workspace_archived',
      'This workspace is archived, so nothing runs automatically.',
    );
  }

  if (capability === 'sending' && state.platformOutboundStop) {
    return refuse(
      capability,
      'platform_outbound_stop',
      `Outbound email is stopped for every workspace by the platform: ${state.platformOutboundStop.reason}`,
    );
  }

  // Platform holds first: they are the ones the tenant cannot release, so
  // they are the more useful reason to show.
  const live = state.holds.filter((h) => holdIsLive(h, now) && holdCovers(h, capability));
  const hold = live.find((h) => h.source === 'platform') ?? live[0];
  if (hold) {
    const by = hold.source === 'platform' ? 'by the platform' : 'by this workspace';
    const what =
      hold.scope === 'all'
        ? 'All automation is on hold'
        : `${CAPABILITY_LABELS[capability]} is on hold`;
    return refuse(capability, 'hold', `${what} (placed ${by}): ${hold.reason}`, { hold });
  }

  if (!manual && state.ownerProblem) {
    return refuse(capability, 'no_accountable_owner', ownerProblemMessage(state));
  }

  let pauseOverridden = false;
  if (state.pause && PAUSED_CAPABILITIES.has(capability)) {
    if (!manual) return refuse(capability, 'paused', PAUSED_MESSAGE);
    if (capability === 'sending') {
      if (!options.confirmPaused) {
        return refuse(capability, 'paused', PAUSED_MANUAL_SEND_MESSAGE, { overridable: true });
      }
      pauseOverridden = true;
    }
  }

  if (capability === 'autopilot' && !state.planAllowsAutopilot) {
    return refuse(
      capability,
      'plan_no_autopilot',
      'Autopilot needs a subscription that includes it; nothing runs until the plan does. Upgrade in Settings → Billing.',
    );
  }

  if (
    capability === 'sending' &&
    options.origin &&
    HELD_UNTIL_LIVE_ORIGINS.has(options.origin) &&
    !state.live
  ) {
    return refuse(
      capability,
      'not_live',
      `Held: this workspace is not live yet. ${ORIGIN_LABELS[options.origin]} waits until the platform releases the workspace for outreach; manual email sends normally.`,
      { scope: 'item' },
    );
  }

  if (!manual && options.mailboxStatus && options.mailboxStatus !== 'active') {
    return refuse(capability, 'mailbox_not_active', mailboxHeldMessage(options.mailboxStatus), {
      scope: 'item',
    });
  }

  if (options.spendsTokens && !state.walletHasTokens) {
    return refuse(
      capability,
      'wallet_empty',
      'No tokens left, so AI and discovery work waits. A workspace admin can buy a token pack in Settings → Billing.',
    );
  }

  return pauseOverridden ? { allowed: true, pauseOverridden: true } : { allowed: true };
}

/** Why automatic work on a mailbox waits, in the operator's words. */
export function mailboxHeldMessage(status: MailboxStatus): string {
  switch (status) {
    case 'failing':
      return 'Held: the mailbox is failing (see its last error). Fix it under Edit settings and Reactivate — this then goes out; nothing is lost.';
    case 'paused':
      return 'Held: the mailbox is paused. Re-enable it from Edit mailbox and this goes out; nothing is lost.';
    case 'archived':
      return 'Held: the mailbox is archived. Restore it, or cancel this and send from another mailbox.';
    default:
      return 'Held: the mailbox is not active.';
  }
}

export function ownerProblemMessage(
  state: Pick<AutomationState, 'ownerProblem' | 'ownerAccountStatus'>,
): string {
  const why =
    state.ownerProblem === 'owner_not_member'
      ? 'is no longer a member of it'
      : `account is ${state.ownerAccountStatus ?? 'missing'}`;
  return `Automatic work is stopped: this workspace's owner ${why}, and automation only ever acts as an active owner. Manual work still runs. A super-admin can reactivate the owner or transfer ownership.`;
}

/** The instant a deferred item is looked at again. */
export function deferUntil(now: Date): Date {
  return new Date(now.getTime() + GATE_DEFER_MS);
}

// ---- loading the state ---------------------------------------------

type StateRow = typeof workspaceAutomationState.$inferSelect;

function stateFromRow(
  row: StateRow,
  holds: EnforcedHold[],
  platformOutboundStop: PlatformOutboundStop | null,
  now: Date,
): AutomationState {
  const ownerProblem: OwnerProblem | null =
    row.ownerAccountStatus !== 'active'
      ? 'owner_inactive'
      : !row.ownerIsMember
        ? 'owner_not_member'
        : null;
  return {
    workspaceId: row.workspaceId,
    workspaceStatus: row.workspaceStatus,
    ownerUserId: row.ownerUserId,
    ownerAccountStatus: row.ownerAccountStatus,
    ownerIsMember: row.ownerIsMember,
    ownerProblem,
    ownerIncidentOpenSince: row.ownerIncidentAt,
    holds,
    platformOutboundStop,
    pause: row.pausedAt
      ? {
          since: row.pausedAt,
          byUserId: row.pausedByUserId,
          reason: row.pauseReason,
          source: row.pauseSource,
        }
      : null,
    live: row.outreachLiveAt
      ? { since: row.outreachLiveAt, byUserId: row.outreachLiveByUserId }
      : null,
    walletHasTokens: row.walletHasTokens,
    planAllowsAutopilot: resolveEffectivePlan(row).limits.autopilot,
    evaluatedAt: now,
  };
}

async function loadEnforcedHolds(
  workspaceIds: readonly bigint[],
  now: Date,
): Promise<Map<string, EnforcedHold[]>> {
  const holdsByWs = new Map<string, EnforcedHold[]>();
  if (workspaceIds.length === 0) return holdsByWs;
  const holdRows = await db
    .select({
      id: workspaceHolds.id,
      workspaceId: workspaceHolds.workspaceId,
      scope: workspaceHolds.scope,
      capabilities: workspaceHolds.capabilities,
      source: workspaceHolds.source,
      reason: workspaceHolds.reason,
      expiresAt: workspaceHolds.expiresAt,
      placedAt: workspaceHolds.placedAt,
      blocksAccess: workspaceHolds.blocksAccess,
    })
    .from(workspaceHolds)
    .where(
      and(
        inArray(workspaceHolds.workspaceId, [...workspaceIds]),
        eq(workspaceHolds.kind, 'hold'),
        eq(workspaceHolds.state, 'active'),
        or(isNull(workspaceHolds.expiresAt), gt(workspaceHolds.expiresAt, now)),
      ),
    )
    .orderBy(workspaceHolds.placedAt);
  for (const h of holdRows) {
    const key = h.workspaceId.toString();
    const list = holdsByWs.get(key) ?? [];
    list.push({
      id: h.id,
      scope: h.scope,
      capabilities: [...h.capabilities],
      source: h.source,
      reason: h.reason,
      expiresAt: h.expiresAt,
      placedAt: h.placedAt,
      blocksAccess: h.blocksAccess,
    });
    holdsByWs.set(key, list);
  }
  return holdsByWs;
}

/**
 * Load the automation state of the given workspaces (keyed by id string)
 * from the workspace_automation_state view, their holds and the platform
 * stop. Three queries whatever the number of workspaces. Unknown ids are
 * absent from the map.
 */
export async function loadAutomationStates(
  workspaceIds: readonly bigint[],
  now: Date = new Date(),
): Promise<Map<string, AutomationState>> {
  const out = new Map<string, AutomationState>();
  if (workspaceIds.length === 0) return out;
  const ids = [...new Set(workspaceIds.map((id) => id.toString()))].map((s) => BigInt(s));

  const rows = await db
    .select()
    .from(workspaceAutomationState)
    .where(inArray(workspaceAutomationState.workspaceId, ids));
  if (rows.length === 0) return out;

  const holdsByWs = await loadEnforcedHolds(
    rows.map((r) => r.workspaceId),
    now,
  );
  const platformOutboundStop = await loadPlatformOutboundStop();
  for (const row of rows) {
    out.set(
      row.workspaceId.toString(),
      stateFromRow(row, holdsByWs.get(row.workspaceId.toString()) ?? [], platformOutboundStop, now),
    );
  }
  return out;
}

export class AutomationStateNotFoundError extends Error {
  public readonly code = 'not_found' as const;
  constructor(workspaceId: bigint) {
    super(`workspace ${workspaceId} not found`);
    this.name = 'AutomationStateNotFoundError';
  }
}

export async function loadAutomationState(
  workspaceId: bigint,
  now: Date = new Date(),
): Promise<AutomationState> {
  const state = (await loadAutomationStates([workspaceId], now)).get(workspaceId.toString());
  if (!state) throw new AutomationStateNotFoundError(workspaceId);
  return state;
}

export async function loadPlatformOutboundStop(): Promise<PlatformOutboundStop | null> {
  const rows = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.key, PLATFORM_OUTBOUND_STOP_KEY))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    since: row.updatedAt,
    byUserId: row.updatedByUserId,
    reason: row.value.trim() || 'no reason recorded',
  };
}

// ---- gate entry points ---------------------------------------------

function resolveManual(ctx: Pick<WorkspaceContext, 'trigger'>, options: GateOptions): boolean {
  return options.manual ?? !isAutomatic(ctx);
}

function itemOptions(options: GateOptions): GateItemOptions {
  return {
    origin: options.origin,
    mailboxStatus: options.mailboxStatus,
    spendsTokens: options.spendsTokens,
    confirmPaused: options.confirmPaused,
  };
}

/** Load the workspace's state and decide. Automatic checks also keep the
 *  no-accountable-owner incident in step with the state. Never throws on
 *  a "no"; throws only when the workspace does not exist. */
export async function checkGate(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'trigger'>,
  capability: AutomationCapability,
  options: GateOptions = {},
): Promise<GateDecision> {
  const manual = resolveManual(ctx, options);
  const state = await loadAutomationState(ctx.workspaceId, options.now);
  if (!manual) await reconcileOwnerIncident(state);
  return decideGate(state, capability, { ...itemOptions(options), manual, now: options.now });
}

/** checkGate for several capabilities at once (one state load): the first
 *  refusal in the given order, or allowed. Used where one piece of work
 *  needs more than one capability (an autopilot step that sends needs
 *  Autopilot and Sending). */
export async function checkGates(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'trigger'>,
  capabilities: readonly AutomationCapability[],
  options: GateOptions = {},
): Promise<GateDecision> {
  const manual = resolveManual(ctx, options);
  const state = await loadAutomationState(ctx.workspaceId, options.now);
  if (!manual) await reconcileOwnerIncident(state);
  for (const capability of capabilities) {
    const decision = decideGate(state, capability, {
      ...itemOptions(options),
      manual,
      now: options.now,
    });
    if (!decision.allowed) return decision;
  }
  return { allowed: true };
}

/** checkGate, throwing AutomationGateError on a "no". Returns the
 *  decision so a caller can see a confirmed pause override. */
export async function assertGate(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'trigger'>,
  capability: AutomationCapability,
  options: GateOptions = {},
): Promise<Extract<GateDecision, { allowed: true }>> {
  const decision = await checkGate(ctx, capability, options);
  if (!decision.allowed) throw new AutomationGateError(decision);
  return decision;
}

// ---- ticks -----------------------------------------------------------

export interface TickWorkspace {
  workspaceId: bigint;
  ownerUserId: string;
  /** Automation context: acts as the accountable owner. */
  ctx: WorkspaceContext;
  state: AutomationState;
  /** decideGate for this tick's capability, automatic. */
  gate(capability: AutomationCapability, item?: GateItemOptions): GateDecision;
}

/**
 * Every active workspace — selected from the workspace_automation_state
 * view — each with its automation state and an automation context: the
 * one list every background tick iterates. The caller asks
 * `gate(capability)` per workspace and skips a "no" (it is not an error);
 * loops re-check per item with checkGate(). No-accountable-owner
 * incidents are raised / cleared here, so they surface within one tick of
 * the owner's change.
 */
export async function activeWorkspacesForTicks(now: Date = new Date()): Promise<TickWorkspace[]> {
  const rows = await db
    .select()
    .from(workspaceAutomationState)
    .where(eq(workspaceAutomationState.workspaceStatus, 'active'))
    .orderBy(workspaceAutomationState.workspaceId);
  const holdsByWs = await loadEnforcedHolds(
    rows.map((r) => r.workspaceId),
    now,
  );
  const platformOutboundStop = rows.length > 0 ? await loadPlatformOutboundStop() : null;
  const out: TickWorkspace[] = [];
  for (const row of rows) {
    const state = stateFromRow(
      row,
      holdsByWs.get(row.workspaceId.toString()) ?? [],
      platformOutboundStop,
      now,
    );
    await reconcileOwnerIncident(state);
    out.push({
      workspaceId: row.workspaceId,
      ownerUserId: row.ownerUserId,
      ctx: makeAutomationContext(row.workspaceId, row.ownerUserId),
      state,
      gate: (capability, item = {}) =>
        decideGate(state, capability, { ...item, manual: false, now }),
    });
  }
  return out;
}

/** Console line for a tick that skipped a workspace. */
export function logGateSkip(tick: string, workspaceId: bigint, decision: GateRefusal): void {
  console.warn(
    `[${tick}] workspace=${workspaceId} skipped (${decision.reason}${decision.hold ? ` hold=${decision.hold.id}` : ''})`,
  );
}

// ---- accountable-owner incident --------------------------------------

export const OWNER_INCIDENT_KIND = 'automation.owner_unaccountable';
export const OWNER_INCIDENT_RESOLVED_KIND = 'automation.owner_accountable_again';

/**
 * Raise the incident the first time automation finds no accountable
 * owner, and resolve it once the owner is accountable again. The
 * conditional UPDATE on workspaces.automation_owner_incident_at makes
 * exactly one caller win across concurrent ticks, so each episode writes
 * exactly one audit row (PC-07 will turn it into an ops event). Mutates
 * `state.ownerIncidentOpenSince` to match. Best-effort: a failure is
 * logged, never thrown — the gate's answer does not depend on it.
 */
export async function reconcileOwnerIncident(state: AutomationState): Promise<void> {
  try {
    if (state.ownerProblem && !state.ownerIncidentOpenSince) {
      const at = new Date();
      const raised = await db.transaction(async (tx) => {
        const [won] = await tx
          .update(workspaces)
          .set({ automationOwnerIncidentAt: at })
          .where(
            and(eq(workspaces.id, state.workspaceId), isNull(workspaces.automationOwnerIncidentAt)),
          )
          .returning({ id: workspaces.id });
        if (!won) return false;
        await tx.insert(auditLog).values({
          workspaceId: state.workspaceId,
          userId: null,
          kind: OWNER_INCIDENT_KIND,
          entityType: 'workspace',
          entityId: state.workspaceId.toString(),
          payload: {
            ownerUserId: state.ownerUserId,
            problem: state.ownerProblem,
            ownerAccountStatus: state.ownerAccountStatus,
            ownerIsMember: state.ownerIsMember,
          },
        });
        return true;
      });
      state.ownerIncidentOpenSince = at;
      if (raised) {
        const { notifyWorkspaceAdmins } = await import('./notifications');
        await notifyWorkspaceAdmins(state.workspaceId, {
          kind: 'automation.owner_unaccountable',
          title: 'Automatic work stopped: the workspace owner is not active',
          body: ownerProblemMessage(state),
          href: null,
          dedupeKey: 'automation.owner_unaccountable',
        });
      }
      return;
    }
    if (!state.ownerProblem && state.ownerIncidentOpenSince) {
      const opened = state.ownerIncidentOpenSince;
      await db.transaction(async (tx) => {
        const [won] = await tx
          .update(workspaces)
          .set({ automationOwnerIncidentAt: null })
          .where(
            and(
              eq(workspaces.id, state.workspaceId),
              isNotNull(workspaces.automationOwnerIncidentAt),
            ),
          )
          .returning({ id: workspaces.id });
        if (!won) return;
        await tx.insert(auditLog).values({
          workspaceId: state.workspaceId,
          userId: null,
          kind: OWNER_INCIDENT_RESOLVED_KIND,
          entityType: 'workspace',
          entityId: state.workspaceId.toString(),
          payload: { ownerUserId: state.ownerUserId, openedAt: opened.toISOString() },
        });
      });
      state.ownerIncidentOpenSince = null;
    }
  } catch (err) {
    console.error(
      `[automation-gate] owner incident for workspace=${state.workspaceId} failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ---- read model for the tenant banner --------------------------------

export interface WorkspaceAutomationNotice {
  platformOutboundStop: PlatformOutboundStop | null;
  holds: EnforcedHold[];
  ownerProblemMessage: string | null;
  /** PC-05: the workspace pause, with who paused it (name or email). */
  pause: (WorkspacePause & { byLabel: string | null }) | null;
  /** flow:F-07: true while the go-live hold applies. */
  notLive: boolean;
}

/** What the shell banner shows any member: the workspace pause, enforced
 *  holds, the platform stop, a missing accountable owner and the go-live
 *  hold. Read-only. */
export async function getWorkspaceAutomationNotice(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<WorkspaceAutomationNotice> {
  const state = await loadAutomationState(ctx.workspaceId);
  let pause: WorkspaceAutomationNotice['pause'] = null;
  if (state.pause) {
    let byLabel: string | null = null;
    if (state.pause.byUserId) {
      const { users } = await import('@/lib/db/schema/auth');
      const [u] = await db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, state.pause.byUserId))
        .limit(1);
      byLabel = u ? (u.name?.trim() || u.email) : null;
    }
    pause = { ...state.pause, byLabel };
  }
  return {
    platformOutboundStop: state.platformOutboundStop,
    holds: state.holds,
    ownerProblemMessage: state.ownerProblem ? ownerProblemMessage(state) : null,
    pause,
    notLive: state.live === null,
  };
}
