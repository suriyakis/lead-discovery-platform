import { redirect } from 'next/navigation';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import type { WorkspaceContext } from '@/lib/services/context';

/**
 * Resolve the WorkspaceContext at the top of a server action.
 *
 * A form can outlive the session that rendered it (signed out in another
 * tab, account suspended, last workspace removed). Those are expected
 * states, not crashes, so they redirect where the page itself would send
 * the user instead of escaping to the error boundary.
 *
 * Call it OUTSIDE the action's try/catch — redirect() throws.
 */
export async function requireActionContext(
  noWorkspacePath = '/dashboard',
): Promise<WorkspaceContext> {
  try {
    return await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) redirect(noWorkspacePath);
    throw err;
  }
}
