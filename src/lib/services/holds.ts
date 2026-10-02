// PC-06: holds — one model for "stop this work in this workspace".
//
// A hold stops either everything (scope 'all') or a list of capabilities
// (Sending, Inbox sync, Discovery, Autopilot, CRM sync, Background AI, …;
// see schema/holds.ts) for automatic AND manual work alike, until it is
// released or its optional expiry passes. The automation gate
// (automation-gate.ts) enforces them; this module places, reviews and
// ends them, with a reason, an actor and a history on every step.
//
//   source 'tenant'    placed by a workspace member with a write role
//                      (stopping is always safe); released by an owner or
//                      admin of that workspace.
//   source 'platform'  placed and released only by a super-admin from the
//                      console (PlatformContext). A tenant cannot release
//                      it. The tenant's admins are notified, and every
//                      member sees it on the shell banner.
//
// Legacy feature flags were imported as `pending_review` rows (never
// enforced): the platform owner confirms (→ active) or discards each one
// (src/lib/remediation/legacy-feature-flags.ts does the import).
//
// Above every workspace sits the platform-wide outbound stop, also
// super-admin only: it refuses every tenant's sends, manual ones too.
//
// Audit: a hold is a tenant effect, so its events are filed against that
// workspace (with the super-admin as the actor for platform holds); the
// platform stop is a platform event (workspace_id NULL).
//
// PC-08: every committed change (a hold placed, released, confirmed or
// discarded; the stop set or cleared) also reaches the platform owner as a
// control-change alert (services/ops-alerts.ts notifyControlChange,
// fire-and-forget, deduplicated against double submits).

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import {
  AUTOMATION_CAPABILITIES,
  workspaceHolds,
  type AutomationCapability,
  type NewWorkspaceHold,
  type WorkspaceHold,
  type WorkspaceHoldHistoryEntry,
  type WorkspaceHoldSource,
  type WorkspaceHoldState,
} from '@/lib/db/schema/holds';
import { platformSettings } from '@/lib/db/schema/platform-settings';
import { workspaces } from '@/lib/db/schema/workspaces';
import { recordPlatformAuditEvent } from './audit';
import {
  CAPABILITY_LABELS,
  PLATFORM_OUTBOUND_STOP_KEY,
  describeHoldScope,
  loadPlatformOutboundStop,
  type PlatformOutboundStop,
} from './automation-gate';
import { canAdminWorkspace, canWrite, type WorkspaceContext } from './context';
import { notifyControlChange } from './ops-alerts';
import { isPlatformContext, type PlatformContext } from './platform-context';

export class HoldServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'HoldServiceError';
    this.code = code;
  }
}

const denied = (op: string) =>
  new HoldServiceError(`Permission denied: ${op}`, 'permission_denied');
const notFound = () => new HoldServiceError('hold not found', 'not_found');
const conflict = (msg: string) => new HoldServiceError(msg, 'conflict');
const invalid = (msg: string) => new HoldServiceError(msg, 'invalid_input');

function assertPlatform(pctx: PlatformContext, op: string): void {
  if (!isPlatformContext(pctx)) throw denied(op);
}

// ---- input ----------------------------------------------------------

export const HOLD_REASON_MAX = 500;

const ReasonSchema = z
  .string()
  .trim()
  .min(3, 'a reason is required (at least 3 characters)')
  .max(HOLD_REASON_MAX, `reason is too long (${HOLD_REASON_MAX} characters max)`);

export const PlaceHoldInputSchema = z
  .object({
    scope: z.enum(['all', 'capabilities']),
    capabilities: z.array(z.enum(AUTOMATION_CAPABILITIES)).default([]),
    reason: ReasonSchema,
    /** NULL / absent = until released. Must be in the future. */
    expiresAt: z.date().nullable().optional(),
    /** PC-21 (stored now, enforced from PC-21): platform holds only. */
    blocksAccess: z.boolean().optional(),
  })
  .superRefine((v, issue) => {
    if (v.scope === 'capabilities' && v.capabilities.length === 0) {
      issue.addIssue({ code: 'custom', message: 'pick at least one capability to hold' });
    }
  });

export type PlaceHoldInput = z.input<typeof PlaceHoldInputSchema>;

function parsePlaceInput(input: PlaceHoldInput, now: Date) {
  const parsed = PlaceHoldInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalid(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const v = parsed.data;
  if (v.expiresAt && v.expiresAt.getTime() <= now.getTime()) {
    throw invalid('the expiry must be in the future');
  }
  const capabilities =
    v.scope === 'all' ? [] : AUTOMATION_CAPABILITIES.filter((c) => v.capabilities.includes(c));
  return { ...v, capabilities };
}

// ---- reads ------------------------------------------------------------

export interface HoldView extends WorkspaceHold {
  /** state 'active' and not past expires_at. */
  enforced: boolean;
  /** state 'active' but past expires_at. */
  expired: boolean;
  scopeLabel: string;
}

function toView(row: WorkspaceHold, now: Date): HoldView {
  const expired =
    row.state === 'active' && row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime();
  return {
    ...row,
    enforced: row.kind === 'hold' && row.state === 'active' && !expired,
    expired,
    scopeLabel: row.kind === 'note' ? 'Note (stops nothing)' : describeHoldScope(row),
  };
}

const OPEN_STATES: WorkspaceHoldState[] = ['active', 'pending_review'];

async function selectHolds(
  workspaceId: bigint,
  options: { includeEnded?: boolean },
): Promise<HoldView[]> {
  const now = new Date();
  const rows = await db
    .select()
    .from(workspaceHolds)
    .where(
      options.includeEnded
        ? eq(workspaceHolds.workspaceId, workspaceId)
        : and(
            eq(workspaceHolds.workspaceId, workspaceId),
            inArray(workspaceHolds.state, OPEN_STATES),
          ),
    )
    .orderBy(desc(workspaceHolds.placedAt))
    .limit(200);
  return rows.map((r) => toView(r, now));
}

/** A workspace's holds, for any member (open ones by default). */
export async function listWorkspaceHolds(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  options: { includeEnded?: boolean } = {},
): Promise<HoldView[]> {
  return selectHolds(ctx.workspaceId, options);
}

/** The console's view of one tenant's holds (open and ended). */
export async function listHoldsForPlatform(
  pctx: PlatformContext,
  workspaceId: bigint,
  options: { includeEnded?: boolean } = { includeEnded: true },
): Promise<HoldView[]> {
  assertPlatform(pctx, 'holds.list');
  return selectHolds(workspaceId, options);
}

// ---- place ------------------------------------------------------------

/** A workspace member places a hold on their own workspace. Any write
 *  role may stop work; releasing it takes an owner or admin. */
export async function placeTenantHold(
  ctx: WorkspaceContext,
  input: PlaceHoldInput,
): Promise<WorkspaceHold> {
  if (!canWrite(ctx)) throw denied('holds.place');
  const now = new Date();
  const v = parsePlaceInput(input, now);
  if (v.blocksAccess) throw invalid('only the platform can place a hold that blocks access');
  return insertHold({
    workspaceId: ctx.workspaceId,
    actorUserId: ctx.userId,
    source: 'tenant',
    scope: v.scope,
    capabilities: v.capabilities,
    reason: v.reason,
    expiresAt: v.expiresAt ?? null,
    blocksAccess: false,
    now,
  });
}

/** A super-admin places a hold on a tenant. The tenant cannot release it. */
export async function placePlatformHold(
  pctx: PlatformContext,
  workspaceId: bigint,
  input: PlaceHoldInput,
): Promise<WorkspaceHold> {
  assertPlatform(pctx, 'holds.place_platform');
  const now = new Date();
  const v = parsePlaceInput(input, now);
  if (v.blocksAccess && v.scope !== 'all') {
    throw invalid('only a hold on all automation can block access');
  }
  await assertWorkspaceExists(workspaceId);
  const hold = await insertHold({
    workspaceId,
    actorUserId: pctx.actorUserId,
    source: 'platform',
    scope: v.scope,
    capabilities: v.capabilities,
    reason: v.reason,
    expiresAt: v.expiresAt ?? null,
    blocksAccess: v.blocksAccess ?? false,
    now,
  });
  await notifyTenant(workspaceId, {
    title: `The platform put ${describeHoldScope(hold).toLowerCase()} on hold`,
    body: holdNoticeBody(hold),
  });
  return hold;
}

async function insertHold(p: {
  workspaceId: bigint;
  actorUserId: string;
  source: WorkspaceHoldSource;
  scope: 'all' | 'capabilities';
  capabilities: AutomationCapability[];
  reason: string;
  expiresAt: Date | null;
  blocksAccess: boolean;
  now: Date;
}): Promise<WorkspaceHold> {
  const entry: WorkspaceHoldHistoryEntry = {
    at: p.now.toISOString(),
    action: 'placed',
    actorUserId: p.actorUserId,
    reason: p.reason,
  };
  const row: NewWorkspaceHold = {
    workspaceId: p.workspaceId,
    kind: 'hold',
    scope: p.scope,
    capabilities: p.capabilities,
    state: 'active',
    source: p.source,
    reason: p.reason,
    blocksAccess: p.blocksAccess,
    expiresAt: p.expiresAt,
    placedByUserId: p.actorUserId,
    placedAt: p.now,
    history: [entry],
  };
  const placed = await db.transaction(async (tx) => {
    const [hold] = await tx.insert(workspaceHolds).values(row).returning();
    if (!hold) throw new HoldServiceError('hold insert returned no row', 'invariant_violation');
    await tx.insert(auditLog).values({
      workspaceId: p.workspaceId,
      userId: p.actorUserId,
      kind: 'workspace.hold.place',
      entityType: 'workspace_hold',
      entityId: hold.id.toString(),
      payload: holdPayload(hold),
    });
    return hold;
  });
  alertHoldChange(placed, 'placed', placed.reason);
  return placed;
}

/** PC-08: tell the platform owner (ntfy) about a committed hold change.
 *  Fire-and-forget: the change stands whatever the alert does. */
function alertHoldChange(
  hold: WorkspaceHold,
  action: 'placed' | 'released' | 'confirmed' | 'discarded',
  reason: string | null,
): void {
  notifyControlChange({
    control: 'workspace_hold',
    action,
    source: hold.source,
    workspaceId: hold.workspaceId,
    holdId: hold.id,
    scopeLabel: describeHoldScope(hold),
    reason: reason ?? undefined,
  });
}

// ---- release / confirm / discard ---------------------------------------

/** An owner or admin releases a hold their workspace placed. Platform
 *  holds are refused: only the platform releases those. */
export async function releaseTenantHold(
  ctx: WorkspaceContext,
  holdId: bigint,
  reason: string,
): Promise<WorkspaceHold> {
  if (!canAdminWorkspace(ctx)) throw denied('holds.release');
  const why = parseReason(reason);
  const hold = await loadHold(ctx.workspaceId, holdId);
  if (hold.source === 'platform') {
    throw new HoldServiceError(
      'This hold was placed by the platform; only the platform can release it. Contact support.',
      'permission_denied',
    );
  }
  return transition({
    hold,
    from: ['active'],
    to: 'released',
    actorUserId: ctx.userId,
    action: 'released',
    reason: why,
  });
}

/** A super-admin releases any hold on a tenant. */
export async function releasePlatformHold(
  pctx: PlatformContext,
  workspaceId: bigint,
  holdId: bigint,
  reason: string,
): Promise<WorkspaceHold> {
  assertPlatform(pctx, 'holds.release_platform');
  const why = parseReason(reason);
  const hold = await loadHold(workspaceId, holdId);
  const released = await transition({
    hold,
    from: ['active'],
    to: 'released',
    actorUserId: pctx.actorUserId,
    action: 'released',
    reason: why,
  });
  await notifyTenant(workspaceId, {
    title: `The platform released the hold on ${describeHoldScope(released).toLowerCase()}`,
    body: `Reason: ${why}`,
  });
  return released;
}

/** Confirm a legacy flag's pending_review hold: from now on it is enforced. */
export async function confirmLegacyHold(
  pctx: PlatformContext,
  workspaceId: bigint,
  holdId: bigint,
): Promise<WorkspaceHold> {
  assertPlatform(pctx, 'holds.confirm');
  const hold = await loadHold(workspaceId, holdId);
  if (hold.kind === 'note') {
    throw conflict('a note stops nothing, so it cannot be confirmed — discard it once read');
  }
  const confirmed = await transition({
    hold,
    from: ['pending_review'],
    to: 'active',
    actorUserId: pctx.actorUserId,
    action: 'confirmed',
    reason: null,
  });
  await notifyTenant(workspaceId, {
    title: `The platform put ${describeHoldScope(confirmed).toLowerCase()} on hold`,
    body: holdNoticeBody(confirmed),
  });
  return confirmed;
}

/** Discard a pending_review row (a legacy flag the owner does not keep, or
 *  a note once read). It was never enforced, so the tenant is not told. */
export async function discardLegacyHold(
  pctx: PlatformContext,
  workspaceId: bigint,
  holdId: bigint,
  reason?: string | null,
): Promise<WorkspaceHold> {
  assertPlatform(pctx, 'holds.discard');
  const why = reason && reason.trim() ? parseReason(reason) : null;
  const hold = await loadHold(workspaceId, holdId);
  return transition({
    hold,
    from: ['pending_review'],
    to: 'discarded',
    actorUserId: pctx.actorUserId,
    action: 'discarded',
    reason: why,
  });
}

function parseReason(reason: string): string {
  const parsed = ReasonSchema.safeParse(reason);
  if (!parsed.success) throw invalid(parsed.error.issues.map((i) => i.message).join('; '));
  return parsed.data;
}

async function loadHold(workspaceId: bigint, holdId: bigint): Promise<WorkspaceHold> {
  const [hold] = await db
    .select()
    .from(workspaceHolds)
    .where(and(eq(workspaceHolds.workspaceId, workspaceId), eq(workspaceHolds.id, holdId)))
    .limit(1);
  if (!hold) throw notFound();
  return hold;
}

const AUDIT_KIND_BY_ACTION = {
  confirmed: 'workspace.hold.confirm',
  discarded: 'workspace.hold.discard',
  released: 'workspace.hold.release',
} as const;

/** Conditional state change: refuses (conflict) when the hold is no longer
 *  in one of `from` — a stale page or a double submit changes nothing. */
async function transition(p: {
  hold: WorkspaceHold;
  from: WorkspaceHoldState[];
  to: WorkspaceHoldState;
  actorUserId: string;
  action: keyof typeof AUDIT_KIND_BY_ACTION;
  reason: string | null;
}): Promise<WorkspaceHold> {
  const now = new Date();
  const entry: WorkspaceHoldHistoryEntry = {
    at: now.toISOString(),
    action: p.action,
    actorUserId: p.actorUserId,
    reason: p.reason,
  };
  const ending = p.to === 'released' || p.to === 'discarded';
  const changed = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(workspaceHolds)
      .set({
        state: p.to,
        ...(p.action === 'confirmed' ? { confirmedByUserId: p.actorUserId, confirmedAt: now } : {}),
        ...(ending ? { endedByUserId: p.actorUserId, endedAt: now, endReason: p.reason } : {}),
        history: sql`${workspaceHolds.history} || ${JSON.stringify([entry])}::jsonb`,
        updatedAt: now,
      })
      .where(
        and(
          eq(workspaceHolds.workspaceId, p.hold.workspaceId),
          eq(workspaceHolds.id, p.hold.id),
          inArray(workspaceHolds.state, p.from),
        ),
      )
      .returning();
    if (!updated) {
      throw conflict(
        `this hold is ${p.hold.state === p.to ? 'already ' : ''}${p.hold.state} — nothing was changed`,
      );
    }
    await tx.insert(auditLog).values({
      workspaceId: updated.workspaceId,
      userId: p.actorUserId,
      kind: AUDIT_KIND_BY_ACTION[p.action],
      entityType: 'workspace_hold',
      entityId: updated.id.toString(),
      payload: { ...holdPayload(updated), from: p.hold.state, to: p.to, actionReason: p.reason },
    });
    return updated;
  });
  alertHoldChange(changed, p.action, p.reason ?? changed.reason);
  return changed;
}

function holdPayload(hold: WorkspaceHold): Record<string, unknown> {
  return {
    holdId: hold.id.toString(),
    kind: hold.kind,
    scope: hold.scope,
    capabilities: hold.capabilities,
    source: hold.source,
    state: hold.state,
    reason: hold.reason,
    expiresAt: hold.expiresAt?.toISOString() ?? null,
    blocksAccess: hold.blocksAccess,
    legacyFlagKey: hold.legacyFlagKey,
  };
}

function holdNoticeBody(hold: WorkspaceHold): string {
  const until = hold.expiresAt
    ? ` Until ${hold.expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`
    : '';
  return `Reason: ${hold.reason}.${until} Manual and automatic work of this kind is refused until the platform releases it.`;
}

async function notifyTenant(
  workspaceId: bigint,
  input: { title: string; body: string },
): Promise<void> {
  const { notifyWorkspaceAdmins } = await import('./notifications');
  await notifyWorkspaceAdmins(workspaceId, {
    kind: 'automation.hold',
    title: input.title,
    body: input.body,
    href: null,
  });
}

async function assertWorkspaceExists(workspaceId: bigint): Promise<void> {
  const [ws] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!ws) throw new HoldServiceError('workspace not found', 'not_found');
}

// ---- platform-wide outbound stop ---------------------------------------

export function getPlatformOutboundStop(): Promise<PlatformOutboundStop | null> {
  return loadPlatformOutboundStop();
}

/** Super-admin: stop every tenant's outbound email, manual sends too. */
export async function setPlatformOutboundStop(
  pctx: PlatformContext,
  reason: string,
): Promise<PlatformOutboundStop> {
  assertPlatform(pctx, 'platform.outbound_stop.set');
  const why = parseReason(reason);
  const existing = await loadPlatformOutboundStop();
  if (existing) throw conflict('outbound email is already stopped for every workspace');
  await db
    .insert(platformSettings)
    .values({ key: PLATFORM_OUTBOUND_STOP_KEY, value: why, updatedByUserId: pctx.actorUserId })
    .onConflictDoNothing();
  const stop = await loadPlatformOutboundStop();
  if (!stop) throw new HoldServiceError('outbound stop was not stored', 'invariant_violation');
  await recordPlatformAuditEvent(pctx.actorUserId, {
    kind: 'platform.outbound_stop.set',
    entityType: 'platform_settings',
    entityId: PLATFORM_OUTBOUND_STOP_KEY,
    payload: { reason: why },
  });
  notifyControlChange({ control: 'platform_outbound_stop', action: 'set', reason: why });
  return stop;
}

/** Super-admin: lift the platform-wide outbound stop. */
export async function clearPlatformOutboundStop(
  pctx: PlatformContext,
  reason: string,
): Promise<void> {
  assertPlatform(pctx, 'platform.outbound_stop.clear');
  const why = parseReason(reason);
  const removed = await db
    .delete(platformSettings)
    .where(eq(platformSettings.key, PLATFORM_OUTBOUND_STOP_KEY))
    .returning();
  if (removed.length === 0) throw conflict('outbound email is not stopped');
  await recordPlatformAuditEvent(pctx.actorUserId, {
    kind: 'platform.outbound_stop.clear',
    entityType: 'platform_settings',
    entityId: PLATFORM_OUTBOUND_STOP_KEY,
    payload: {
      reason: why,
      stoppedSince: removed[0]!.updatedAt.toISOString(),
      stoppedReason: removed[0]!.value,
    },
  });
  notifyControlChange({ control: 'platform_outbound_stop', action: 'cleared', reason: why });
}

export { CAPABILITY_LABELS };
