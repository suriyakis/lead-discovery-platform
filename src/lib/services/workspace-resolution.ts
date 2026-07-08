// Session-free workspace-context resolution. Split out of auth-context.ts
// so tests (and any non-request code path) can exercise the selection
// logic without importing next-auth.

import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/auth';
import { workspaceMembers, workspaces } from '@/lib/db/schema/workspaces';
import { makeWorkspaceContext, type WorkspaceContext } from './context';

export class NoWorkspaceError extends Error {
  constructor() {
    super('No workspace membership');
    this.name = 'NoWorkspaceError';
  }
}

/**
 * Resolve which workspace a user's requests operate in.
 *
 * Selection order:
 *   1. `users.activeWorkspaceId` matching one of the user's memberships.
 *   2. SUPER-ADMIN ONLY: `activeWorkspaceId` pointing at ANY existing
 *      workspace — this is god mode. setActiveWorkspace(allowAnyAsSuperAdmin)
 *      wrote that pointer and audit-logged the switch; honoring it here is
 *      what makes the switch REAL: every workspace-scoped query in the app
 *      then reads the TARGET tenant's data, not the admin's own. (The old
 *      resolver silently fell back to the admin's own workspace, so god
 *      mode showed the admin's products/leads while claiming to be in the
 *      target — a cross-tenant confusion bug.) A stale pointer to a
 *      deleted workspace is cleared and falls through.
 *   3. First membership.
 *
 * Normal users NEVER get branch 2 — a non-member activeWorkspaceId is
 * ignored, preserving the tenant-isolation invariant.
 */
export async function resolveWorkspaceContextForUser(
  userId: string,
  isSuperAdminUser: boolean,
): Promise<WorkspaceContext> {
  // Phase 23: filter out archived workspaces — they're "off" until a
  // super-admin restores them. super_admin sees archived ones too so the
  // restore action is reachable.
  const memberships = isSuperAdminUser
    ? await db
        .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId))
    : await db
        .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .where(
          and(
            eq(workspaceMembers.userId, userId),
            eq(workspaces.status, 'active'),
          ),
        );

  const userRows = await db
    .select({ activeWorkspaceId: users.activeWorkspaceId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const activeId = userRows[0]?.activeWorkspaceId ?? null;

  // 1. Active pointer at a workspace the user is a member of.
  const memberMatch =
    activeId !== null
      ? memberships.find((m) => m.workspaceId === activeId)
      : undefined;
  if (memberMatch) {
    return makeWorkspaceContext({
      workspaceId: memberMatch.workspaceId,
      userId,
      role: isSuperAdminUser ? 'super_admin' : memberMatch.role,
    });
  }

  // 2. God mode: super-admin pointer at a workspace they're NOT a member
  //    of. Honor it when the workspace still exists (any status — god
  //    mode must be able to inspect archived tenants too).
  if (isSuperAdminUser && activeId !== null) {
    const target = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, activeId))
      .limit(1);
    if (target[0]) {
      return makeWorkspaceContext({
        workspaceId: target[0].id,
        userId,
        role: 'super_admin',
      });
    }
    // Stale pointer (workspace hard-deleted) — clear it so the switcher
    // and this resolver agree, then fall through to memberships.
    await db
      .update(users)
      .set({ activeWorkspaceId: null })
      .where(eq(users.id, userId));
  }

  // 3. First membership.
  if (memberships.length === 0) throw new NoWorkspaceError();
  const first = memberships[0]!;
  return makeWorkspaceContext({
    workspaceId: first.workspaceId,
    userId,
    role: isSuperAdminUser ? 'super_admin' : first.role,
  });
}
