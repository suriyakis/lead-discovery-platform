// PC-06: the automation gate — one answer to "may this workspace do
// <capability> now?", asked at every place such work starts.
//
//   AutomationState   what the gate decides on, loaded per workspace:
//                     the enforced holds (state 'active', not expired —
//                     compared against now(), so an expired hold stops
//                     applying without any job running), the platform-wide
//                     outbound stop, and whether the workspace still has an
//                     accountable owner.
//   decideGate()      pure: (state, capability, {manual}) → allowed, or
//                     blocked with a reason and a sentence for the operator.
//   assertGate()      loads + decides + throws AutomationGateError — for
//                     services a person calls (compose, Sync, Run now…).
//   checkGate()       loads + decides, never throws — for loops that must
//                     stop cleanly (the drain re-checks before each row).
//   activeWorkspacesForTicks()
//                     every active workspace with its state and an
//                     automation context, for the background ticks.
//
// Order of the checks (first match wins):
//   1. automatic work in an archived workspace
//   2. Sending under the platform-wide outbound stop (super-admins only;
//      it refuses manual sends too, and a tenant cannot lift it)
//   3. a hold covering the capability (scope 'all', or the capability in
//      its list) — automatic AND manual work alike; platform holds first
//   4. the accountable-owner rule, automatic work only: automation acts as
//      workspaces.owner_user_id, so when that user is not active or no
//      longer a member it stops (no_accountable_owner) — there is no
//      fallback to another member. Manual work by other members goes on.
//      The first time a gate finds this, it raises one incident (an audit
//      row plus a notification to the workspace admins) until PC-07's
//      incident stream lands; it is cleared when the owner is back.
//
// PC-05 extends the same state with the workspace pause and decideGate's
// options with the wallet and mailbox status.

import { and, eq, gt, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import { users, type AccountStatus } from '@/lib/db/schema/auth';
import {
  AUTOMATION_CAPABILITIES,
  workspaceHolds,
  type AutomationCapability,
  type WorkspaceHoldSource,
} from '@/lib/db/schema/holds';
import { platformSettings } from '@/lib/db/schema/platform-settings';
import { workspaceMembers, workspaces, type WorkspaceStatus } from '@/lib/db/schema/workspaces';
import { isAutomatic, makeAutomationContext, type WorkspaceContext } from './context';

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
};

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
  evaluatedAt: Date;
}

export type GateBlockReason =
  | 'workspace_archived'
  | 'platform_outbound_stop'
  | 'hold'
  | 'no_accountable_owner';

export type GateDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: GateBlockReason;
      capability: AutomationCapability;
      /** The hold that blocked it (reason 'hold'). */
      hold?: EnforcedHold;
      /** One sentence for the operator. */
      message: string;
    };

export interface GateOptions {
  /** A person asked for this work now (compose, Sync, Run now). Automatic
   *  work (ticks, autopilot, the queue drain) passes false. Defaults to
   *  the context: manual unless ctx.trigger is 'automation'. */
  manual?: boolean;
  /** Evaluate expiry against this instant (tests). */
  now?: Date;
}

/** Thrown by assertGate (and by services that run it) when the gate says
 *  no. `code` is constant so action error helpers can recognise it; the
 *  message is written for the operator. */
export class AutomationGateError extends Error {
  public readonly code = 'automation_held' as const;
  public readonly reason: GateBlockReason;
  public readonly capability: AutomationCapability;
  public readonly holdId: bigint | null;
  constructor(decision: Extract<GateDecision, { allowed: false }>) {
    super(decision.message);
    this.name = 'AutomationGateError';
    this.reason = decision.reason;
    this.capability = decision.capability;
    this.holdId = decision.hold?.id ?? null;
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

/**
 * The gate. Pure: everything it needs is in `state`. `manual` is required
 * here (callers resolve the default from their context).
 */
export function decideGate(
  state: AutomationState,
  capability: AutomationCapability,
  options: { manual: boolean; now?: Date },
): GateDecision {
  const now = options.now ?? state.evaluatedAt;

  if (!options.manual && state.workspaceStatus !== 'active') {
    return {
      allowed: false,
      reason: 'workspace_archived',
      capability,
      message: 'This workspace is archived, so nothing runs automatically.',
    };
  }

  if (capability === 'sending' && state.platformOutboundStop) {
    return {
      allowed: false,
      reason: 'platform_outbound_stop',
      capability,
      message: `Outbound email is stopped for every workspace by the platform: ${state.platformOutboundStop.reason}`,
    };
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
    return {
      allowed: false,
      reason: 'hold',
      capability,
      hold,
      message: `${what} (placed ${by}): ${hold.reason}`,
    };
  }

  if (!options.manual && state.ownerProblem) {
    return {
      allowed: false,
      reason: 'no_accountable_owner',
      capability,
      message: ownerProblemMessage(state),
    };
  }

  return { allowed: true };
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

// ---- loading the state ---------------------------------------------

/**
 * Load the automation state of the given workspaces (keyed by id string).
 * Three queries whatever the number of workspaces. Unknown ids are absent
 * from the map.
 */
export async function loadAutomationStates(
  workspaceIds: readonly bigint[],
  now: Date = new Date(),
): Promise<Map<string, AutomationState>> {
  const out = new Map<string, AutomationState>();
  if (workspaceIds.length === 0) return out;
  const ids = [...new Set(workspaceIds.map((id) => id.toString()))].map((s) => BigInt(s));

  const wsRows = await db
    .select({
      id: workspaces.id,
      status: workspaces.status,
      ownerUserId: workspaces.ownerUserId,
      incidentAt: workspaces.automationOwnerIncidentAt,
      ownerAccountStatus: users.accountStatus,
      memberId: workspaceMembers.id,
    })
    .from(workspaces)
    .leftJoin(users, eq(users.id, workspaces.ownerUserId))
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, workspaces.id),
        eq(workspaceMembers.userId, workspaces.ownerUserId),
      ),
    )
    .where(inArray(workspaces.id, ids));
  if (wsRows.length === 0) return out;

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
        inArray(
          workspaceHolds.workspaceId,
          wsRows.map((w) => w.id),
        ),
        eq(workspaceHolds.kind, 'hold'),
        eq(workspaceHolds.state, 'active'),
        or(isNull(workspaceHolds.expiresAt), gt(workspaceHolds.expiresAt, now)),
      ),
    )
    .orderBy(workspaceHolds.placedAt);

  const platformOutboundStop = await loadPlatformOutboundStop();

  const holdsByWs = new Map<string, EnforcedHold[]>();
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

  for (const w of wsRows) {
    const ownerIsMember = w.memberId !== null;
    const ownerProblem: OwnerProblem | null =
      w.ownerAccountStatus !== 'active'
        ? 'owner_inactive'
        : !ownerIsMember
          ? 'owner_not_member'
          : null;
    out.set(w.id.toString(), {
      workspaceId: w.id,
      workspaceStatus: w.status,
      ownerUserId: w.ownerUserId,
      ownerAccountStatus: w.ownerAccountStatus,
      ownerIsMember,
      ownerProblem,
      ownerIncidentOpenSince: w.incidentAt,
      holds: holdsByWs.get(w.id.toString()) ?? [],
      platformOutboundStop,
      evaluatedAt: now,
    });
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
  return decideGate(state, capability, { manual, now: options.now });
}

/** checkGate, throwing AutomationGateError on a "no". */
export async function assertGate(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'trigger'>,
  capability: AutomationCapability,
  options: GateOptions = {},
): Promise<void> {
  const decision = await checkGate(ctx, capability, options);
  if (!decision.allowed) throw new AutomationGateError(decision);
}

// ---- ticks -----------------------------------------------------------

export interface TickWorkspace {
  workspaceId: bigint;
  ownerUserId: string;
  /** Automation context: acts as the accountable owner. */
  ctx: WorkspaceContext;
  state: AutomationState;
  /** decideGate for this tick's capability, automatic. */
  gate(capability: AutomationCapability): GateDecision;
}

/**
 * Every active workspace, each with its automation state and an
 * automation context — the one list every background tick iterates. The
 * caller asks `gate(capability)` per workspace and skips a "no" (it is
 * not an error). No-accountable-owner incidents are raised / cleared here,
 * so they surface within one tick of the owner's change.
 */
export async function activeWorkspacesForTicks(now: Date = new Date()): Promise<TickWorkspace[]> {
  const rows = await db
    .select({ id: workspaces.id, ownerUserId: workspaces.ownerUserId })
    .from(workspaces)
    .where(eq(workspaces.status, 'active'))
    .orderBy(workspaces.id);
  const states = await loadAutomationStates(
    rows.map((r) => r.id),
    now,
  );
  const out: TickWorkspace[] = [];
  for (const r of rows) {
    const state = states.get(r.id.toString());
    if (!state) continue; // deleted between the two reads
    await reconcileOwnerIncident(state);
    out.push({
      workspaceId: r.id,
      ownerUserId: r.ownerUserId,
      ctx: makeAutomationContext(r.id, r.ownerUserId),
      state,
      gate: (capability) => decideGate(state, capability, { manual: false, now }),
    });
  }
  return out;
}

/** Console line for a tick that skipped a workspace. */
export function logGateSkip(
  tick: string,
  workspaceId: bigint,
  decision: Extract<GateDecision, { allowed: false }>,
): void {
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
}

/** What the shell banner shows any member: enforced holds, the platform
 *  stop and a missing accountable owner. Read-only. */
export async function getWorkspaceAutomationNotice(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<WorkspaceAutomationNotice> {
  const state = await loadAutomationState(ctx.workspaceId);
  return {
    platformOutboundStop: state.platformOutboundStop,
    holds: state.holds,
    ownerProblemMessage: state.ownerProblem ? ownerProblemMessage(state) : null,
  };
}
