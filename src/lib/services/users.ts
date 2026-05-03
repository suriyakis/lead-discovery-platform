// User & membership management. Covers super-admin platform-wide ops
// (account lifecycle, pre-authorize) and workspace-admin per-workspace
// ops (add/remove member, change role). Every mutation is audit-logged.

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  preauthorizedEmails,
  users,
  type AccountStatus,
  type PreauthorizedEmail,
  type User,
} from '@/lib/db/schema/auth';
import {
  workspaceMembers,
  type WorkspaceMember,
  type WorkspaceMemberRole,
} from '@/lib/db/schema/workspaces';
import { recordAuditEvent } from './audit';
import {
  canAdminWorkspace,
  isSuperAdmin,
  type WorkspaceContext,
} from './context';

export class UserServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'UserServiceError';
    this.code = code;
  }
}

const denied = (op: string) =>
  new UserServiceError(`Permission denied: ${op}`, 'permission_denied');
const notFound = (kind: string) =>
  new UserServiceError(`${kind} not found`, 'not_found');
const invalid = (msg: string) =>
  new UserServiceError(msg, 'invalid_input');
const conflict = (msg: string) =>
  new UserServiceError(msg, 'conflict');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

// ---- account lifecycle (super_admin) -------------------------------

export async function setAccountStatus(
  ctx: WorkspaceContext,
  targetUserId: string,
  status: AccountStatus,
  reason: string | null = null,
): Promise<User> {
  if (!isSuperAdmin(ctx)) throw denied('users.set_account_status');
  const target = await loadUser(targetUserId);
  if (target.id === ctx.userId && status !== 'active') {
    // Don't let a super-admin lock themselves out.
    throw conflict('cannot change your own account status');
  }
  const [updated] = await db
    .update(users)
    .set({
      accountStatus: status,
      accountStatusReason: reason?.trim() || null,
      accountStatusUpdatedAt: new Date(),
      accountStatusUpdatedBy: ctx.userId,
    })
    .where(eq(users.id, targetUserId))
    .returning();
  if (!updated) {
    throw new UserServiceError(
      'account status update returned no row',
      'invariant_violation',
    );
  }
  await recordAuditEvent(
    { workspaceId: ctx.workspaceId, userId: ctx.userId },
    {
      kind: 'user.set_account_status',
      entityType: 'user',
      entityId: targetUserId,
      payload: { status, reason: reason ?? null, prior: target.accountStatus },
    },
  );
  return updated;
}

export async function listAllUsers(
  ctx: WorkspaceContext,
  filter: { status?: AccountStatus; limit?: number } = {},
): Promise<User[]> {
  if (!isSuperAdmin(ctx)) throw denied('users.list_all');
  const rows = filter.status
    ? await db
        .select()
        .from(users)
        .where(eq(users.accountStatus, filter.status))
        .limit(Math.min(filter.limit ?? 500, 5000))
    : await db.select().from(users).limit(Math.min(filter.limit ?? 500, 5000));
  return rows;
}

// ---- pre-authorize (super_admin) -----------------------------------

export interface PreauthorizeInput {
  email: string;
  /** Workspace to drop the user into on first signin. Optional. */
  workspaceId?: bigint | null;
  /** Role they should land at. Defaults to 'member'. */
  role?: WorkspaceMemberRole;
}

export async function preauthorizeEmail(
  ctx: WorkspaceContext,
  input: PreauthorizeInput,
): Promise<PreauthorizedEmail> {
  if (!isSuperAdmin(ctx)) throw denied('users.preauthorize');
  const email = normalizeEmail(input.email);
  if (!EMAIL_RE.test(email)) throw invalid('invalid email');

  // Idempotent: re-preauthorizing the same email replaces the prior
  // unconsumed entry.
  await db
    .delete(preauthorizedEmails)
    .where(
      and(
        eq(preauthorizedEmails.email, email),
        isNull(preauthorizedEmails.consumedAt),
      ),
    );

  const [created] = await db
    .insert(preauthorizedEmails)
    .values({
      email,
      workspaceId: input.workspaceId ? input.workspaceId.toString() : null,
      role: input.role ?? 'member',
      createdBy: ctx.userId,
    })
    .returning();
  if (!created) {
    throw new UserServiceError(
      'preauthorize insert returned no row',
      'invariant_violation',
    );
  }
  await recordAuditEvent(
    { workspaceId: ctx.workspaceId, userId: ctx.userId },
    {
      kind: 'user.preauthorize',
      entityType: 'preauthorized_email',
      entityId: created.id,
      payload: {
        email,
        workspaceId: input.workspaceId?.toString() ?? null,
        role: input.role ?? 'member',
      },
    },
  );

  // If the user already exists (and signed in before being pre-approved),
  // lift them to active right away.
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing[0] && existing[0].accountStatus !== 'active') {
    await db
      .update(users)
      .set({
        accountStatus: 'active',
        accountStatusUpdatedAt: new Date(),
        accountStatusUpdatedBy: ctx.userId,
      })
      .where(eq(users.id, existing[0].id));
  }

  return created;
}

export async function listPreauthorizedEmails(
  ctx: WorkspaceContext,
  filter: { activeOnly?: boolean } = {},
): Promise<PreauthorizedEmail[]> {
  if (!isSuperAdmin(ctx)) throw denied('users.list_preauthorized');
  if (filter.activeOnly) {
    return db
      .select()
      .from(preauthorizedEmails)
      .where(isNull(preauthorizedEmails.consumedAt));
  }
  return db.select().from(preauthorizedEmails);
}

export async function revokePreauthorize(
  ctx: WorkspaceContext,
  id: string,
): Promise<void> {
  if (!isSuperAdmin(ctx)) throw denied('users.revoke_preauthorize');
  const existing = await db
    .select()
    .from(preauthorizedEmails)
    .where(eq(preauthorizedEmails.id, id))
    .limit(1);
  if (!existing[0]) throw notFound('preauthorized_email');
  if (existing[0].consumedAt !== null) {
    throw conflict('already consumed');
  }
  await db.delete(preauthorizedEmails).where(eq(preauthorizedEmails.id, id));
  await recordAuditEvent(
    { workspaceId: ctx.workspaceId, userId: ctx.userId },
    {
      kind: 'user.revoke_preauthorize',
      entityType: 'preauthorized_email',
      entityId: id,
    },
  );
}

// ---- workspace membership (workspace-admin) ------------------------

export async function listWorkspaceMembers(
  ctx: WorkspaceContext,
): Promise<Array<{ member: WorkspaceMember; user: User }>> {
  if (!canAdminWorkspace(ctx)) throw denied('users.list_workspace_members');
  return db
    .select({ member: workspaceMembers, user: users })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, ctx.workspaceId));
}

export async function setMemberRole(
  ctx: WorkspaceContext,
  targetUserId: string,
  role: WorkspaceMemberRole,
): Promise<WorkspaceMember> {
  if (!canAdminWorkspace(ctx)) throw denied('users.set_member_role');
  const existing = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, ctx.workspaceId),
        eq(workspaceMembers.userId, targetUserId),
      ),
    )
    .limit(1);
  if (!existing[0]) throw notFound('workspace_member');
  // Don't let an admin demote the last owner.
  if (existing[0].role === 'owner' && role !== 'owner') {
    const owners = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, ctx.workspaceId),
          eq(workspaceMembers.role, 'owner'),
        ),
      );
    if (owners.length <= 1) {
      throw conflict('cannot demote the last owner');
    }
  }
  const [updated] = await db
    .update(workspaceMembers)
    .set({ role, updatedAt: new Date() })
    .where(
      and(
        eq(workspaceMembers.workspaceId, ctx.workspaceId),
        eq(workspaceMembers.userId, targetUserId),
      ),
    )
    .returning();
  if (!updated) {
    throw new UserServiceError(
      'member role update returned no row',
      'invariant_violation',
    );
  }
  await recordAuditEvent(ctx, {
    kind: 'user.set_member_role',
    entityType: 'workspace_member',
    entityId: updated.id,
    payload: { targetUserId, role, prior: existing[0].role },
  });
  return updated;
}

export async function removeMember(
  ctx: WorkspaceContext,
  targetUserId: string,
): Promise<void> {
  if (!canAdminWorkspace(ctx)) throw denied('users.remove_member');
  const existing = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, ctx.workspaceId),
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
          eq(workspaceMembers.workspaceId, ctx.workspaceId),
          eq(workspaceMembers.role, 'owner'),
        ),
      );
    if (owners.length <= 1) {
      throw conflict('cannot remove the last owner');
    }
  }
  await db
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, ctx.workspaceId),
        eq(workspaceMembers.userId, targetUserId),
      ),
    );
  await recordAuditEvent(ctx, {
    kind: 'user.remove_member',
    entityType: 'workspace_member',
    entityId: existing[0].id,
    payload: { targetUserId, role: existing[0].role },
  });
}

export async function addMember(
  ctx: WorkspaceContext,
  targetUserId: string,
  role: WorkspaceMemberRole = 'member',
): Promise<WorkspaceMember> {
  if (!canAdminWorkspace(ctx)) throw denied('users.add_member');
  const existing = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, ctx.workspaceId),
        eq(workspaceMembers.userId, targetUserId),
      ),
    )
    .limit(1);
  if (existing[0]) throw conflict('already a member');
  const target = await loadUser(targetUserId);
  if (target.accountStatus !== 'active') {
    throw conflict(`target user account is ${target.accountStatus}`);
  }
  const [created] = await db
    .insert(workspaceMembers)
    .values({
      workspaceId: ctx.workspaceId,
      userId: targetUserId,
      role,
    })
    .returning();
  if (!created) {
    throw new UserServiceError(
      'member insert returned no row',
      'invariant_violation',
    );
  }
  await recordAuditEvent(ctx, {
    kind: 'user.add_member',
    entityType: 'workspace_member',
    entityId: created.id,
    payload: { targetUserId, role },
  });
  return created;
}

// ---- internals -----------------------------------------------------

async function loadUser(id: string): Promise<User> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!rows[0]) throw notFound('user');
  return rows[0];
}
