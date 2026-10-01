// The workspace context for a server action, or the redirect a page
// would give the same visitor.
//
// A session can go stale between rendering a form and submitting it: the
// user signs out in another tab, an admin deactivates the account, or the
// user loses their last workspace. getWorkspaceContext() then throws, and
// an action that calls it bare sends the user to Next's generic error
// page. This helper sends them where the app's pages would instead.
//
// A plain module, deliberately NOT 'use server': every export of a
// 'use server' file becomes a client-callable endpoint, and this one
// returns the caller's context.

import { redirect } from 'next/navigation';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import type { WorkspaceContext } from '@/lib/services/context';

/** Where a stale session lands, by why it no longer resolves. */
export const STALE_SESSION_REDIRECTS = {
  /** Signed out: the sign-in page. */
  authRequired: '/',
  /** Pending, suspended or rejected account. */
  accountInactive: '/pending',
  /** No workspace any more: the no-workspace screen (ia:F-07). */
  noWorkspace: '/dashboard',
} as const;

/**
 * Resolve the signed-in user's workspace for a server action. Redirects
 * (never returns) when the session is signed out, the account is
 * inactive, or the user has no workspace; any other error propagates.
 */
export async function requireActionContext(): Promise<WorkspaceContext> {
  try {
    return await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect(STALE_SESSION_REDIRECTS.authRequired);
    if (err instanceof AccountInactiveError) redirect(STALE_SESSION_REDIRECTS.accountInactive);
    if (err instanceof NoWorkspaceError) redirect(STALE_SESSION_REDIRECTS.noWorkspace);
    throw err;
  }
}
