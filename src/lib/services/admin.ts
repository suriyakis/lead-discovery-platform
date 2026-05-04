// Platform-admin (god-mode) service. All operations check
// canSuperAdmin(ctx) before doing anything; failure to do so is the same
// security mistake as forgetting workspace_id in a query.

import { and, count, desc, eq, isNull, sql, sum, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users, type User } from '@/lib/db/schema/auth';
import {
  workspaceMembers,
  workspaces,
  type Workspace,
  type WorkspaceMember,
  type WorkspaceMemberRole,
  type WorkspaceStatus,
} from '@/lib/db/schema/workspaces';
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
  status: WorkspaceStatus;
  archivedAt: Date | null;
  archivedReason: string | null;
  memberCount: number;
  leadCount: number;
  totalUsageCost: number;
  createdAt: Date;
}

export async function listAllWorkspaces(
  ctx: WorkspaceContext,
  filter: { includeArchived?: boolean } = {},
): Promise<WorkspaceOverviewRow[]> {
  assertSuperAdmin(ctx, 'admin.list_workspaces');
  const wsRows = filter.includeArchived
    ? await db
        .select()
        .from(workspaces)
        .orderBy(desc(workspaces.createdAt))
    : await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.status, 'active'))
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
      status: w.status,
      archivedAt: w.archivedAt ?? null,
      archivedReason: w.archivedReason ?? null,
      memberCount: Number(members?.c ?? 0),
      leadCount: Number(leads?.c ?? 0),
      totalUsageCost: Number(usageTotal?.s ?? 0),
      createdAt: w.createdAt,
    });
  }
  return out;
}

// ---- workspace lifecycle (super-admin) -----------------------------

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export interface UpdateWorkspaceProfileInput {
  name?: string;
  slug?: string;
}

export async function updateWorkspaceProfile(
  ctx: WorkspaceContext,
  workspaceId: bigint,
  input: UpdateWorkspaceProfileInput,
): Promise<Workspace> {
  assertSuperAdmin(ctx, 'admin.workspace.update');
  const updates: Partial<Workspace> & { updatedAt: Date } = { updatedAt: new Date() };
  if (input.name !== undefined) {
    const n = input.name.trim();
    if (!n) throw invalid('name cannot be empty');
    updates.name = n;
  }
  if (input.slug !== undefined) {
    const s = input.slug.trim().toLowerCase();
    if (!SLUG_RE.test(s)) throw invalid('slug must be lowercase a-z0-9-');
    // Reject conflict with another workspace's slug.
    const dup = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.slug, s))
      .limit(1);
    if (dup[0] && dup[0].id !== workspaceId) throw conflict('slug already in use');
    updates.slug = s;
  }
  const [updated] = await db
    .update(workspaces)
    .set(updates)
    .where(eq(workspaces.id, workspaceId))
    .returning();
  if (!updated) throw notFound('workspace');
  await recordAuditEvent(
    { workspaceId, userId: ctx.userId },
    {
      kind: 'admin.workspace.update',
      entityType: 'workspace',
      entityId: workspaceId,
      payload: { name: updates.name ?? null, slug: updates.slug ?? null },
    },
  );
  return updated;
}

export async function archiveWorkspace(
  ctx: WorkspaceContext,
  workspaceId: bigint,
  reason: string | null = null,
): Promise<Workspace> {
  assertSuperAdmin(ctx, 'admin.workspace.archive');
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!rows[0]) throw notFound('workspace');
  if (rows[0].status === 'archived') throw conflict('already archived');
  const [updated] = await db
    .update(workspaces)
    .set({
      status: 'archived',
      archivedAt: new Date(),
      archivedBy: ctx.userId,
      archivedReason: reason?.trim() || null,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId))
    .returning();
  if (!updated) throw notFound('workspace');
  await recordAuditEvent(
    { workspaceId, userId: ctx.userId },
    {
      kind: 'admin.workspace.archive',
      entityType: 'workspace',
      entityId: workspaceId,
      payload: { reason: reason ?? null },
    },
  );
  return updated;
}

export async function restoreWorkspace(
  ctx: WorkspaceContext,
  workspaceId: bigint,
): Promise<Workspace> {
  assertSuperAdmin(ctx, 'admin.workspace.restore');
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!rows[0]) throw notFound('workspace');
  if (rows[0].status === 'active') throw conflict('not archived');
  const [updated] = await db
    .update(workspaces)
    .set({
      status: 'active',
      archivedAt: null,
      archivedBy: null,
      archivedReason: null,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId))
    .returning();
  if (!updated) throw notFound('workspace');
  await recordAuditEvent(
    { workspaceId, userId: ctx.userId },
    {
      kind: 'admin.workspace.restore',
      entityType: 'workspace',
      entityId: workspaceId,
    },
  );
  return updated;
}

// ---- user profile + cross-workspace membership (super-admin) -------

export interface UpdateUserProfileInput {
  name?: string | null;
  email?: string;
}

export async function updateUserProfile(
  ctx: WorkspaceContext,
  targetUserId: string,
  input: UpdateUserProfileInput,
): Promise<User> {
  assertSuperAdmin(ctx, 'admin.user.update_profile');
  const updates: Partial<User> = {};
  if (input.name !== undefined) {
    updates.name = input.name === null ? null : input.name.trim() || null;
  }
  if (input.email !== undefined) {
    const e = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw invalid('invalid email');
    // Case-insensitive collision check — historical user rows may have
    // mixed-case emails on disk.
    const dup = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${e}`)
      .limit(1);
    if (dup[0] && dup[0].id !== targetUserId) throw conflict('email already in use');
    updates.email = e;
  }
  if (Object.keys(updates).length === 0) {
    const rows = await db.select().from(users).where(eq(users.id, targetUserId)).limit(1);
    if (!rows[0]) throw notFound('user');
    return rows[0];
  }
  const [updated] = await db
    .update(users)
    .set(updates)
    .where(eq(users.id, targetUserId))
    .returning();
  if (!updated) throw notFound('user');
  await recordAuditEvent(
    { workspaceId: ctx.workspaceId, userId: ctx.userId },
    {
      kind: 'admin.user.update_profile',
      entityType: 'user',
      entityId: targetUserId,
      payload: {
        name: updates.name === undefined ? null : (updates.name ?? ''),
        email: updates.email ?? null,
      },
    },
  );
  return updated;
}

/**
 * Super-admin add: drop a user into any workspace at any role. Bypasses
 * the workspace-admin gate that the regular `users.addMember` enforces,
 * and accepts `owner` as a role (the regular path doesn't).
 */
export async function adminAddUserToWorkspace(
  ctx: WorkspaceContext,
  targetUserId: string,
  workspaceId: bigint,
  role: WorkspaceMemberRole = 'member',
): Promise<WorkspaceMember> {
  assertSuperAdmin(ctx, 'admin.user.add_to_workspace');
  const userRows = await db.select().from(users).where(eq(users.id, targetUserId)).limit(1);
  if (!userRows[0]) throw notFound('user');
  const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!wsRows[0]) throw notFound('workspace');
  const existing = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, targetUserId),
      ),
    )
    .limit(1);
  if (existing[0]) throw conflict('already a member');
  const [created] = await db
    .insert(workspaceMembers)
    .values({ workspaceId, userId: targetUserId, role })
    .returning();
  if (!created) {
    throw new AdminServiceError(
      'workspace_members insert returned no row',
      'invariant_violation',
    );
  }
  await recordAuditEvent(
    { workspaceId, userId: ctx.userId },
    {
      kind: 'admin.user.add_to_workspace',
      entityType: 'workspace_member',
      entityId: created.id,
      payload: { targetUserId, role },
    },
  );
  return created;
}

export async function adminRemoveUserFromWorkspace(
  ctx: WorkspaceContext,
  targetUserId: string,
  workspaceId: bigint,
): Promise<void> {
  assertSuperAdmin(ctx, 'admin.user.remove_from_workspace');
  const existing = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, targetUserId),
      ),
    )
    .limit(1);
  if (!existing[0]) throw notFound('workspace_member');
  if (existing[0].role === 'owner') {
    const owners = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.role, 'owner'),
        ),
      );
    if (owners.length <= 1) throw conflict('cannot remove the last owner');
  }
  await db
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, targetUserId),
      ),
    );
  await recordAuditEvent(
    { workspaceId, userId: ctx.userId },
    {
      kind: 'admin.user.remove_from_workspace',
      entityType: 'workspace_member',
      entityId: existing[0].id,
      payload: { targetUserId, formerRole: existing[0].role },
    },
  );
}

export async function listMembershipsForUser(
  ctx: WorkspaceContext,
  targetUserId: string,
): Promise<Array<{ workspace: Workspace; role: WorkspaceMemberRole }>> {
  assertSuperAdmin(ctx, 'admin.user.list_memberships');
  const rows = await db
    .select({
      workspace: workspaces,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, targetUserId))
    .orderBy(workspaces.name);
  return rows;
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

export interface AuditAcrossWorkspacesFilter {
  workspaceId?: bigint;
  kind?: string;
  since?: Date;
  until?: Date;
  limit?: number;
}

export async function listAuditAcrossWorkspaces(
  ctx: WorkspaceContext,
  filter: AuditAcrossWorkspacesFilter = {},
) {
  assertSuperAdmin(ctx, 'admin.list_audit_across');
  const conds: SQL[] = [];
  if (filter.workspaceId !== undefined) {
    conds.push(eq(auditLog.workspaceId, filter.workspaceId));
  }
  if (filter.kind) conds.push(eq(auditLog.kind, filter.kind));
  if (filter.since) {
    conds.push(sql`${auditLog.createdAt} >= ${filter.since}`);
  }
  if (filter.until) {
    conds.push(sql`${auditLog.createdAt} <= ${filter.until}`);
  }
  const limit = Math.min(filter.limit ?? 100, 1000);
  return db
    .select()
    .from(auditLog)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
}

export async function distinctAuditKindsAcross(
  ctx: WorkspaceContext,
): Promise<string[]> {
  assertSuperAdmin(ctx, 'admin.distinct_audit_kinds');
  const rows = await db
    .selectDistinct({ kind: auditLog.kind })
    .from(auditLog)
    .orderBy(auditLog.kind);
  return rows.map((r) => r.kind);
}
