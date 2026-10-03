'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { HOME_PATH } from './nav/registry';
import { auth } from './auth';
import { isNextRedirectError } from './server-redirect';
import { readRequestSession } from './session-token';
import { WorkspaceServiceError, setActiveWorkspace } from './services/workspace';
import { createFirstWorkspace } from './services/workspace-provisioning';

/**
 * Server action used by the header workspace switcher. Verifies the user
 * actually owns a session and is a member (or super-admin) of the target
 * workspace, then revalidates every server-rendered surface so the next
 * navigation reads from the new active workspace.
 *
 * MOB-06: it moves THIS browser session (and the last-used value a new
 * sign-in starts in); the user's other sessions stay where they are. Tabs
 * of this browser share the session: their guarded forms answer
 * workspace_changed until reloaded.
 */
export async function setActiveWorkspaceAction(workspaceIdRaw: string): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) return;
  if (!/^\d{1,19}$/.test(workspaceIdRaw)) return;
  const workspaceId = BigInt(workspaceIdRaw);
  const isSa = session.user.role === 'super_admin';
  const { token } = await readRequestSession();
  await setActiveWorkspace(session.user.id, workspaceId, {
    allowAnyAsSuperAdmin: isSa,
    sessionToken: token,
  });
  // Force every cached server component to re-render with the new
  // workspace context. The "layout" scope catches the (app) layout's
  // workspace frame (DS-07: its assistant and palette are keyed by the
  // workspace, so they start afresh) as well as every page below it.
  revalidatePath('/', 'layout');
}

/**
 * "Create your workspace" on the no-workspace screen (/today,
 * ia:F-07). The service allows it once, for an active user who belongs
 * to no workspace, and validates the name. On success the new owner goes
 * straight into the setup wizard; a refusal comes back to the screen as
 * a readable message.
 */
export async function createFirstWorkspaceAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  if (session.user.accountStatus !== 'active' && session.user.role !== 'super_admin') {
    redirect('/pending');
  }
  const name = formData.get('name');
  try {
    await createFirstWorkspace(session.user.id, {
      name: typeof name === 'string' ? name : '',
    });
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof WorkspaceServiceError) {
      redirect(`${HOME_PATH}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  redirect('/onboarding');
}
