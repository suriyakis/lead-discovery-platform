import { and, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/auth';
import { workspaceMembers, workspaces } from '@/lib/db/schema/workspaces';
import {
  type WorkspaceContext,
  type WorkspaceRole,
  makeWorkspaceContext,
} from './context';

/** Thrown when the signed-in user's accountStatus is not 'active'. */
export class AccountInactiveError extends Error {
  public readonly accountStatus: string;
  constructor(status: string) {
    super(`account status is ${status}`);
    this.name = 'AccountInactiveError';
    this.accountStatus = status;
  }
}

export class AuthRequiredError extends Error {
  constructor() {
    super('Authentication required');
    this.name = 'AuthRequiredError';
  }
}

export class NoWorkspaceError extends Error {
  constructor() {
    super('No workspace membership');
    this.name = 'NoWorkspaceError';
  }
}

/**
 * Resolve the active WorkspaceContext for the currently signed-in user.
 *
 * Phase 1 picks the user's *first* workspace_members row. Phase 2+ workspace
 * switching reads the active workspace from session metadata; the helper's
 * signature stays the same.
 *
 * Throws:
 *   - AuthRequiredError when no session
 *   - NoWorkspaceError when authenticated but no workspace membership
 *
 * `super_admin` users get their platform role surfaced on the context's
 * `role` field even when their `workspace_members.role` is something else.
 */
export async function getWorkspaceContext(): Promise<WorkspaceContext> {
  const session = await auth();
  if (!session?.user?.id) throw new AuthRequiredError();
  // Phase 15: every authenticated user passes the accountStatus gate
  // before any workspace data is read. super_admin always passes (the
  // bootstrap super_admin was lifted to active during sign-in).
  if (
    session.user.accountStatus !== 'active' &&
    session.user.role !== 'super_admin'
  ) {
    throw new AccountInactiveError(session.user.accountStatus);
  }

  // Phase 23: filter out archived workspaces — they're "off" until a
  // super-admin restores them. super_admin sees archived ones too so the
  // restore action is reachable.
  const memberships =
    session.user.role === 'super_admin'
      ? await db
          .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.userId, session.user.id))
      : await db
          .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
          .from(workspaceMembers)
          .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
          .where(
            and(
              eq(workspaceMembers.userId, session.user.id),
              eq(workspaces.status, 'active'),
            ),
          );

  if (memberships.length === 0) throw new NoWorkspaceError();

  // Phase 28: prefer the user's activeWorkspaceId when it points at a
  // workspace they're still a member of. Otherwise fall back to the
  // first membership.
  const userRows = await db
    .select({ activeWorkspaceId: users.activeWorkspaceId })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  const activeId = userRows[0]?.activeWorkspaceId ?? null;
  const selected =
    (activeId !== null
      ? memberships.find((m) => m.workspaceId === activeId)
      : null) ?? memberships[0]!;

  const role: WorkspaceRole =
    session.user.role === 'super_admin' ? 'super_admin' : selected.role;

  return makeWorkspaceContext({
    workspaceId: selected.workspaceId,
    userId: session.user.id,
    role,
  });
}
