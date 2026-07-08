import { auth } from '@/lib/auth';
import { type WorkspaceContext } from './context';
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
 * resolveWorkspaceContextForUser — see workspace-resolution.ts.
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
  return resolveWorkspaceContextForUser(
    session.user.id,
    session.user.role === 'super_admin',
  );
}
