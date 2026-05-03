import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db/client';
import { workspaceMembers } from '@/lib/db/schema/workspaces';
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

  const memberships = await db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, session.user.id));

  const first = memberships[0];
  if (!first) throw new NoWorkspaceError();

  const role: WorkspaceRole =
    session.user.role === 'super_admin' ? 'super_admin' : first.role;

  return makeWorkspaceContext({
    workspaceId: first.workspaceId,
    userId: session.user.id,
    role,
  });
}
