// Platform-admin (god-mode) service. All operations check
// canSuperAdmin(ctx) before doing anything; failure to do so is the same
// security mistake as forgetting workspace_id in a query.

import { and, count, desc, eq, isNull, sum, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users, type User } from '@/lib/db/schema/auth';
import { workspaceMembers, workspaces } from '@/lib/db/schema/workspaces';
import { auditLog, usageLog } from '@/lib/db/schema/audit';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import {
  featureFlags,
  impersonationSessions,
  type FeatureFlag,
  type ImpersonationSession,
  type NewFeatureFlag,
  type NewImpersonationSession,
} from '@/lib/db/schema/admin';
import { recordAuditEvent } from './audit';
import { isSuperAdmin, type WorkspaceContext } from './context';

export class AdminServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'AdminServiceError';
    this.code = code;
  }
}

const denied = (op: string) =>
  new AdminServiceError(`Permission denied: ${op}`, 'permission_denied');
const notFound = (kind: string) =>
  new AdminServiceError(`${kind} not found`, 'not_found');
const conflict = (msg: string) =>
  new AdminServiceError(msg, 'conflict');
const invalid = (msg: string) =>
  new AdminServiceError(msg, 'invalid_input');

function assertSuperAdmin(ctx: WorkspaceContext, op: string): void {
  if (!isSuperAdmin(ctx)) throw denied(op);
}

// ---- workspace overview ---------------------------------------------

export interface WorkspaceOverviewRow {
  workspaceId: bigint;
  name: string;
  slug: string;
  memberCount: number;
  leadCount: number;
  totalUsageCost: number;
  createdAt: Date;
}

export async function listAllWorkspaces(
  ctx: WorkspaceContext,
): Promise<WorkspaceOverviewRow[]> {
  assertSuperAdmin(ctx, 'admin.list_workspaces');
  const wsRows = await db
    .select()
    .from(workspaces)
    .orderBy(desc(workspaces.createdAt));

  // Cheap parallel counts. For large deployments we'd switch to a single
  // aggregating query, but Phase 14 is admin-only and infrequent.
  const out: WorkspaceOverviewRow[] = [];
  for (const w of wsRows) {
    const [members] = await db
      .select({ c: count() })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, w.id));
    const [leads] = await db
      .select({ c: count() })
      .from(qualifiedLeads)
      .where(eq(qualifiedLeads.workspaceId, w.id));
    const [usageTotal] = await db
      .select({ s: sum(usageLog.costEstimateCents) })
      .from(usageLog)
      .where(eq(usageLog.workspaceId, w.id));
    out.push({
      workspaceId: w.id,
      name: w.name,
      slug: w.slug,
      memberCount: Number(members?.c ?? 0),
      leadCount: Number(leads?.c ?? 0),
      totalUsageCost: Number(usageTotal?.s ?? 0),
      createdAt: w.createdAt,
    });
  }
  return out;
}

// ---- impersonation --------------------------------------------------

export interface StartImpersonationInput {
  targetUserId: string;
  targetWorkspaceId: bigint;
  reason: string;
}

export async function startImpersonation(
  ctx: WorkspaceContext,
  input: StartImpersonationInput,
): Promise<ImpersonationSession> {
  assertSuperAdmin(ctx, 'admin.impersonate');
  const reason = input.reason.trim();
  if (!reason) throw invalid('reason required');

  const target = await db
    .select()
    .from(users)
    .where(eq(users.id, input.targetUserId))
    .limit(1);
  if (!target[0]) throw notFound('target user');

  const targetWs = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, input.targetWorkspaceId))
    .limit(1);
  if (!targetWs[0]) throw notFound('target workspace');

  // Verify the target user is a member of the target workspace.
  const member = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.userId, input.targetUserId),
        eq(workspaceMembers.workspaceId, input.targetWorkspaceId),
      ),
    )
    .limit(1);
  if (!member[0]) {
    throw invalid('target user is not a member of the target workspace');
  }

  // Close any existing active session by this actor.
  await db
    .update(impersonationSessions)
    .set({ endedAt: new Date(), endedByUserId: ctx.userId })
    .where(
      and(
        eq(impersonationSessions.actorUserId, ctx.userId),
        isNull(impersonationSessions.endedAt),
      ),
    );

  const row: NewImpersonationSession = {
    actorUserId: ctx.userId,
    targetUserId: input.targetUserId,
    targetWorkspaceId: input.targetWorkspaceId,
    reason,
  };
  const [created] = await db.insert(impersonationSessions).values(row).returning();
  if (!created) {
    throw new AdminServiceError(
      'impersonation session insert returned no row',
      'invariant_violation',
    );
  }

  // Audit on both sides — we log it as a workspace event in the target
  // workspace so the audit trail is visible from there too.
  await recordAuditEvent(
    { workspaceId: input.targetWorkspaceId, userId: ctx.userId },
    {
      kind: 'admin.impersonate.start',
      entityType: 'user',
      entityId: input.targetUserId,
      payload: {
        sessionId: created.id.toString(),
        actor: ctx.userId,
        target: input.targetUserId,
        reason,
      },
    },
  );

  return created;
}

export async function endImpersonation(
  ctx: WorkspaceContext,
  sessionId: bigint,
): Promise<ImpersonationSession> {
  // The actor or any super-admin may close the session (a super-admin
  // override is necessary for emergency revocation).
  if (!isSuperAdmin(ctx)) throw denied('admin.impersonate.end');
  const rows = await db
    .select()
    .from(impersonationSessions)
    .where(eq(impersonationSessions.id, sessionId))
    .limit(1);
  if (!rows[0]) throw notFound('impersonation_session');
  if (rows[0].endedAt !== null) throw conflict('session already ended');

  const [updated] = await db
    .update(impersonationSessions)
    .set({ endedAt: new Date(), endedByUserId: ctx.userId })
    .where(eq(impersonationSessions.id, sessionId))
    .returning();
  if (!updated) {
    throw new AdminServiceError(
      'impersonation end returned no row',
      'invariant_violation',
    );
  }

  await recordAuditEvent(
    { workspaceId: updated.targetWorkspaceId, userId: ctx.userId },
    {
      kind: 'admin.impersonate.end',
      entityType: 'user',
      entityId: updated.targetUserId,
      payload: {
        sessionId: updated.id.toString(),
        actor: updated.actorUserId,
        endedBy: ctx.userId,
      },
    },
  );

  return updated;
}

export async function listImpersonationSessions(
  ctx: WorkspaceContext,
  filter: { activeOnly?: boolean; limit?: number } = {},
): Promise<ImpersonationSession[]> {
  assertSuperAdmin(ctx, 'admin.list_impersonations');
  const conditions: SQL[] = [];
  if (filter.activeOnly) conditions.push(isNull(impersonationSessions.endedAt));
  return db
    .select()
    .from(impersonationSessions)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(impersonationSessions.startedAt))
    .limit(Math.min(filter.limit ?? 100, 1000));
}

export async function activeImpersonationFor(
  ctx: Pick<WorkspaceContext, 'userId'>,
): Promise<ImpersonationSession | null> {
  const rows = await db
    .select()
    .from(impersonationSessions)
    .where(
      and(
        eq(impersonationSessions.actorUserId, ctx.userId),
        isNull(impersonationSessions.endedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ---- feature flags ---------------------------------------------------

export interface SetFeatureFlagInput {
  workspaceId: bigint;
  key: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}

export async function setFeatureFlag(
  ctx: WorkspaceContext,
  input: SetFeatureFlagInput,
): Promise<FeatureFlag> {
  assertSuperAdmin(ctx, 'admin.feature_flag.set');
  const key = input.key.trim();
  if (!/^[a-z][a-z0-9_.]*$/.test(key)) {
    throw invalid('feature flag key must be lowercase a-z0-9_.');
  }
  const row: NewFeatureFlag = {
    workspaceId: input.workspaceId,
    key,
    enabled: input.enabled,
    config: input.config ?? {},
    setBy: ctx.userId,
  };
  await db
    .insert(featureFlags)
    .values(row)
    .onConflictDoUpdate({
      target: [featureFlags.workspaceId, featureFlags.key],
      set: {
        enabled: row.enabled,
        config: row.config,
        setBy: ctx.userId,
        setAt: new Date(),
      },
    });
  const reloaded = await db
    .select()
    .from(featureFlags)
    .where(
      and(
        eq(featureFlags.workspaceId, input.workspaceId),
        eq(featureFlags.key, key),
      ),
    )
    .limit(1);
  if (!reloaded[0]) {
    throw new AdminServiceError(
      'feature_flag upsert returned no row',
      'invariant_violation',
    );
  }
  await recordAuditEvent(
    { workspaceId: input.workspaceId, userId: ctx.userId },
    {
      kind: 'admin.feature_flag.set',
      entityType: 'feature_flag',
      entityId: reloaded[0].id,
      payload: { key, enabled: input.enabled },
    },
  );
  return reloaded[0];
}

export async function listFeatureFlags(
  ctx: WorkspaceContext,
  workspaceId: bigint,
): Promise<FeatureFlag[]> {
  assertSuperAdmin(ctx, 'admin.feature_flag.list');
  return db
    .select()
    .from(featureFlags)
    .where(eq(featureFlags.workspaceId, workspaceId))
    .orderBy(featureFlags.key);
}

// ---- platform users + recent audit -----------------------------------

export async function listAllUsers(
  ctx: WorkspaceContext,
  limit = 200,
): Promise<User[]> {
  assertSuperAdmin(ctx, 'admin.list_users');
  return db
    .select()
    .from(users)
    .orderBy(desc(users.id))
    .limit(Math.min(limit, 1000));
}

export async function recentAuditAcrossWorkspaces(
  ctx: WorkspaceContext,
  limit = 100,
) {
  assertSuperAdmin(ctx, 'admin.recent_audit');
  return db
    .select()
    .from(auditLog)
    .orderBy(desc(auditLog.createdAt))
    .limit(Math.min(limit, 1000));
}
