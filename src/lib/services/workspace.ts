import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/auth';
import {
  workspaceMembers,
  workspaceSettings,
  workspaces,
  type NewWorkspace,
  type Workspace,
  type WorkspaceMember,
  type WorkspaceMemberRole,
} from '@/lib/db/schema/workspaces';
import { recordAuditEvent } from './audit';
import { canAdminWorkspace, canOwnWorkspace, type WorkspaceContext } from './context';

export class WorkspaceServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'WorkspaceServiceError';
    this.code = code;
  }
}

const permissionDenied = (op: string) =>
  new WorkspaceServiceError(`Permission denied: ${op}`, 'permission_denied');
const notFound = (kind: string) => new WorkspaceServiceError(`${kind} not found`, 'not_found');
const conflict = (msg: string) => new WorkspaceServiceError(msg, 'conflict');
const invariant = (msg: string) => new WorkspaceServiceError(msg, 'invariant_violation');

// ---- creation -----------------------------------------------------------

export interface CreateWorkspaceInput {
  name: string;
  slug: string;
  ownerUserId: string;
}

/**
 * Create a fresh workspace and seat its owner as the first member. Also
 * provisions an empty `workspace_settings` row.
 *
 * Not workspace-scoped (the caller doesn't have a workspaceId yet). The
 * authorization gate is "you must be authenticated"; that's enforced at
 * the route handler.
 */
export async function createWorkspace(
  input: CreateWorkspaceInput,
): Promise<{ workspace: Workspace; member: WorkspaceMember }> {
  if (!input.name.trim()) throw conflict('name is required');
  if (!input.slug.trim()) throw conflict('slug is required');

  return db.transaction(async (tx) => {
    // Verify the owner exists. Don't surface the user table in errors.
    const ownerRows = await tx.select().from(users).where(eq(users.id, input.ownerUserId));
    if (!ownerRows[0]) throw notFound('user');

    const newWs: NewWorkspace = {
      name: input.name.trim(),
      slug: input.slug.trim(),
      ownerUserId: input.ownerUserId,
    };
    const insertedWs = await tx.insert(workspaces).values(newWs).returning();
    const ws = insertedWs[0];
    if (!ws) throw invariant('workspace insert returned no row');

    const insertedMember = await tx
      .insert(workspaceMembers)
      .values({
        workspaceId: ws.id,
        userId: input.ownerUserId,
        role: 'owner',
      })
      .returning();
    const member = insertedMember[0];
    if (!member) throw invariant('workspace_members insert returned no row');

    await tx.insert(workspaceSettings).values({ workspaceId: ws.id });

    return { workspace: ws, member };
  });
}

// ---- read --------------------------------------------------------------

export async function getWorkspace(ctx: WorkspaceContext): Promise<Workspace> {
  const rows = await db.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId));
  const ws = rows[0];
  if (!ws) throw notFound('workspace');
  return ws;
}

export interface MemberWithUser {
  member: WorkspaceMember;
  user: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
  };
}

export async function listMembers(ctx: WorkspaceContext): Promise<MemberWithUser[]> {
  const rows = await db
    .select({
      member: workspaceMembers,
      user: {
        id: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
      },
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(eq(workspaceMembers.workspaceId, ctx.workspaceId));
  return rows.map((r) => ({ member: r.member, user: r.user }));
}

// ---- mutations ---------------------------------------------------------

export interface AddMemberInput {
  userId: string;
  role: WorkspaceMemberRole;
}

export async function addMember(
  ctx: WorkspaceContext,
  input: AddMemberInput,
): Promise<WorkspaceMember> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('add member');
  if (input.role === 'owner') {
    throw conflict('cannot add a member as owner directly; transfer ownership instead');
  }

  return db.transaction(async (tx) => {
    const userRows = await tx.select().from(users).where(eq(users.id, input.userId));
    if (!userRows[0]) throw notFound('user');

    const existing = await tx
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, ctx.workspaceId),
          eq(workspaceMembers.userId, input.userId),
        ),
      );
    if (existing[0]) throw conflict('user is already a member of this workspace');

    const inserted = await tx
      .insert(workspaceMembers)
      .values({
        workspaceId: ctx.workspaceId,
        userId: input.userId,
        role: input.role,
      })
      .returning();
    const member = inserted[0];
    if (!member) throw invariant('workspace_members insert returned no row');

    await recordAuditEvent(ctx, {
      kind: 'workspace.member.add',
      entityType: 'workspace_member',
      entityId: member.id,
      payload: { addedUserId: input.userId, role: input.role },
    });

    return member;
  });
}

export async function removeMember(ctx: WorkspaceContext, userId: string): Promise<void> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('remove member');

  return db.transaction(async (tx) => {
    const targetRows = await tx
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, ctx.workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      );
    const target = targetRows[0];
    if (!target) throw notFound('workspace member');
    if (target.role === 'owner') {
      throw conflict('cannot remove the workspace owner; transfer ownership first');
    }

    await tx
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, ctx.workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      );

    await recordAuditEvent(ctx, {
      kind: 'workspace.member.remove',
      entityType: 'workspace_member',
      entityId: target.id,
      payload: { removedUserId: userId, formerRole: target.role },
    });
  });
}

export async function setMemberRole(
  ctx: WorkspaceContext,
  userId: string,
  role: WorkspaceMemberRole,
): Promise<WorkspaceMember> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('set member role');
  // Promoting someone to owner is a separate, ownership-transferring operation
  // (not implemented in Phase 1). Demoting the owner needs canOwnWorkspace.
  if (role === 'owner' && !canOwnWorkspace(ctx)) {
    throw permissionDenied('promote to owner (only owner/super_admin can transfer)');
  }

  return db.transaction(async (tx) => {
    const targetRows = await tx
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, ctx.workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      );
    const target = targetRows[0];
    if (!target) throw notFound('workspace member');

    // Don't let the last owner be demoted.
    if (target.role === 'owner' && role !== 'owner') {
      const owners = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, ctx.workspaceId),
            eq(workspaceMembers.role, 'owner'),
          ),
        );
      if (owners.length <= 1) {
        throw conflict('cannot demote the only owner; assign another owner first');
      }
    }

    const updated = await tx
      .update(workspaceMembers)
      .set({ role, updatedAt: new Date() })
      .where(
        and(
          eq(workspaceMembers.workspaceId, ctx.workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .returning();
    const member = updated[0];
    if (!member) throw invariant('workspace_members update returned no row');

    await recordAuditEvent(ctx, {
      kind: 'workspace.member.role_change',
      entityType: 'workspace_member',
      entityId: member.id,
      payload: { userId, previousRole: target.role, newRole: role },
    });

    return member;
  });
}
