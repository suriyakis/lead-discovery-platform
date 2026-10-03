import { redirect } from 'next/navigation';
import { HOME_PATH } from '@/lib/nav/registry';
import { auth } from '@/lib/auth';
import { readRequestSession } from '@/lib/session-token';
import { type WorkspaceContext } from './context';
import { pinnedWorkspaceContext } from './pinned-workspace';
import { makePlatformContext, type PlatformContext } from './platform-context';
import {
  NoWorkspaceError,
  resolveWorkspaceContextForUser,
} from './workspace-resolution';

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

/** Thrown when a signed-in user who is not a platform super-admin asks for
 *  a PlatformContext. */
export class PlatformAdminRequiredError extends Error {
  constructor() {
    super('Platform super-admin required');
    this.name = 'PlatformAdminRequiredError';
  }
}

// Re-exported so existing `catch (err instanceof NoWorkspaceError)` call
// sites keep working — the class itself lives in workspace-resolution.ts
// (session-free, testable without next-auth).
export { NoWorkspaceError, resolveWorkspaceContextForUser };

/**
 * Resolve the active WorkspaceContext for the currently signed-in user.
 *
 * Throws:
 *   - AuthRequiredError when no session
 *   - NoWorkspaceError when authenticated but no resolvable workspace
 *
 * Selection logic (incl. the god-mode branch for super-admins) lives in
 * resolveWorkspaceContextForUser — see workspace-resolution.ts. MOB-06:
 * the workspace is this SESSION's (the request cookie names the session
 * row), so two browsers signed in as one user each keep their own.
 *
 * Inside a guarded action (withWorkspaceGuard) it returns the context the
 * guard checked and pinned, without resolving again.
 */
export async function getWorkspaceContext(): Promise<WorkspaceContext> {
  const pinned = pinnedWorkspaceContext();
  if (pinned) return pinned;
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
  return resolveSessionWorkspaceContext(session.user);
}

/**
 * The workspace of THIS request's session for an already-loaded user,
 * without the accountStatus gate — for the app shell, which renders its
 * chrome for every signed-in user and gates nothing itself. Pages and
 * actions use getWorkspaceContext().
 */
export async function resolveSessionWorkspaceContext(user: {
  id: string;
  role: 'member' | 'super_admin';
}): Promise<WorkspaceContext> {
  const { token, userAgent } = await readRequestSession();
  return resolveWorkspaceContextForUser(user.id, user.role === 'super_admin', {
    sessionToken: token,
    userAgent,
  });
}

/**
 * Resolve the PlatformContext for the signed-in super-admin.
 *
 * Deliberately independent of workspaces: it never reads
 * users.activeWorkspaceId, so the god-mode switcher cannot leak into
 * platform actions, and a super-admin without any membership can still
 * use the console. Sessions are database sessions, so the role checked
 * here is the current users.role, not a cached token claim.
 *
 * Throws:
 *   - AuthRequiredError when no session
 *   - PlatformAdminRequiredError when the user is not a super_admin
 */
export async function getPlatformContext(): Promise<PlatformContext> {
  const session = await auth();
  if (!session?.user?.id) throw new AuthRequiredError();
  if (session.user.role !== 'super_admin') throw new PlatformAdminRequiredError();
  return makePlatformContext(session.user.id);
}

/**
 * Guard for every /admin page and every server action they define: returns
 * the PlatformContext, or redirects — signed-out users to `/`, signed-in
 * users who are not super-admins to Today (HOME_PATH).
 *
 * Call it at the top of the page AND inside each server action (actions
 * are separately reachable POST endpoints, so the page guard alone does
 * not protect them).
 */
export async function requirePlatformAdmin(): Promise<PlatformContext> {
  try {
    return await getPlatformContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof PlatformAdminRequiredError) redirect(HOME_PATH);
    throw err;
  }
}
