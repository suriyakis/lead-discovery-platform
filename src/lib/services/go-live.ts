// flow:F-07: the per-workspace go-live hold. Every workspace starts not
// live (workspaces.outreach_live_at NULL): the automation gate holds
// automatic outreach — cold first touches, follow-ups and AI reply drafts
// — as queued (never failed), while manual mail (compose, thread replies)
// sends normally. Until the F-40 go-live checklist exists, only a
// super-admin releases a workspace, with a reason that is audited against
// the tenant; the same super-admin can take it back to not live.
//
// Audit: outreach.go_live.release / outreach.go_live.revoke, filed against
// the target workspace with the super-admin as the actor (a tenant effect,
// like a platform hold). The tenant's owners and admins are notified.

import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import { workspaces } from '@/lib/db/schema/workspaces';
import { recordAuditEvent } from './audit';
import { isPlatformContext, type PlatformContext } from './platform-context';

export class GoLiveError extends Error {
  public readonly code: 'permission_denied' | 'invalid_input' | 'not_found' | 'conflict';
  constructor(message: string, code: GoLiveError['code']) {
    super(message);
    this.name = 'GoLiveError';
    this.code = code;
  }
}

export const GO_LIVE_REASON_MAX = 500;

const ReasonSchema = z
  .string()
  .trim()
  .min(3, 'a reason is required (at least 3 characters)')
  .max(GO_LIVE_REASON_MAX, `reason is too long (${GO_LIVE_REASON_MAX} characters max)`);

function parseReason(reason: string): string {
  const parsed = ReasonSchema.safeParse(reason);
  if (!parsed.success) {
    throw new GoLiveError(parsed.error.issues.map((i) => i.message).join('; '), 'invalid_input');
  }
  return parsed.data;
}

function assertPlatform(pctx: PlatformContext, op: string): void {
  if (!isPlatformContext(pctx)) throw new GoLiveError(`Permission denied: ${op}`, 'permission_denied');
}

export interface GoLiveStatus {
  live: boolean;
  since: Date | null;
  byUserId: string | null;
}

export async function getGoLiveStatus(workspaceId: bigint): Promise<GoLiveStatus> {
  const [ws] = await db
    .select({ at: workspaces.outreachLiveAt, by: workspaces.outreachLiveByUserId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!ws) throw new GoLiveError('workspace not found', 'not_found');
  return { live: ws.at !== null, since: ws.at, byUserId: ws.by };
}

/** Super-admin: release a workspace for automatic outreach. */
export async function releaseOutreachLive(
  pctx: PlatformContext,
  workspaceId: bigint,
  reason: string,
): Promise<GoLiveStatus> {
  assertPlatform(pctx, 'outreach.go_live.release');
  const why = parseReason(reason);
  const now = new Date();
  const [row] = await db
    .update(workspaces)
    .set({ outreachLiveAt: now, outreachLiveByUserId: pctx.actorUserId, updatedAt: now })
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.outreachLiveAt)))
    .returning({ at: workspaces.outreachLiveAt, by: workspaces.outreachLiveByUserId });
  if (!row) {
    await getGoLiveStatus(workspaceId); // not_found when it does not exist
    throw new GoLiveError('this workspace is already live', 'conflict');
  }
  await recordAuditEvent(
    { workspaceId, userId: pctx.actorUserId },
    {
      kind: 'outreach.go_live.release',
      entityType: 'workspace',
      entityId: workspaceId,
      payload: { reason: why, liveAt: now.toISOString() },
    },
  );
  const { notifyWorkspaceAdmins } = await import('./notifications');
  await notifyWorkspaceAdmins(workspaceId, {
    kind: 'outreach.go_live',
    title: 'Your workspace is live for outreach',
    body: `Cold emails, follow-ups and AI reply drafts now send on their schedule. Reason: ${why}`,
    href: '/mailbox/queue',
  });
  return { live: true, since: row.at, byUserId: row.by };
}

/** Super-admin: put a live workspace back on the go-live hold. */
export async function revokeOutreachLive(
  pctx: PlatformContext,
  workspaceId: bigint,
  reason: string,
): Promise<GoLiveStatus> {
  assertPlatform(pctx, 'outreach.go_live.revoke');
  const why = parseReason(reason);
  const [before] = await db
    .select({ at: workspaces.outreachLiveAt })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!before) throw new GoLiveError('workspace not found', 'not_found');
  const [row] = await db
    .update(workspaces)
    .set({ outreachLiveAt: null, outreachLiveByUserId: null, updatedAt: new Date() })
    .where(and(eq(workspaces.id, workspaceId), isNotNull(workspaces.outreachLiveAt)))
    .returning({ id: workspaces.id });
  if (!row) throw new GoLiveError('this workspace is not live', 'conflict');
  await recordAuditEvent(
    { workspaceId, userId: pctx.actorUserId },
    {
      kind: 'outreach.go_live.revoke',
      entityType: 'workspace',
      entityId: workspaceId,
      payload: { reason: why, wasLiveSince: before.at?.toISOString() ?? null },
    },
  );
  const { notifyWorkspaceAdmins } = await import('./notifications');
  await notifyWorkspaceAdmins(workspaceId, {
    kind: 'outreach.go_live',
    title: 'Automatic outreach is on hold again',
    body: `The platform put this workspace back on the go-live hold: cold emails, follow-ups and AI reply drafts wait (queued, not failed); manual email still sends. Reason: ${why}`,
    href: '/mailbox/queue',
  });
  return { live: false, since: null, byUserId: null };
}
