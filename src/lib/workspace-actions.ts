'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { auth } from './auth';
import { isNextRedirectError } from './server-redirect';
import { WorkspaceServiceError, setActiveWorkspace } from './services/workspace';
import { createFirstWorkspace } from './services/workspace-provisioning';
import { isSuperAdmin } from './services/context';

/**
 * Server action used by the header workspace switcher. Verifies the user
 * actually owns a session and is a member (or super-admin) of the target
 * workspace, then revalidates every server-rendered surface so the next
 * navigation reads from the new active workspace.
 */
export async function setActiveWorkspaceAction(workspaceIdRaw: string): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) return;
  if (!/^\d+$/.test(workspaceIdRaw)) return;
  const workspaceId = BigInt(workspaceIdRaw);
  const isSa = session.user.role === 'super_admin';
  await setActiveWorkspace(session.user.id, workspaceId, {
    allowAnyAsSuperAdmin: isSa,
  });
  // Force every cached server component to re-render with the new
  // workspace context. The "layout" scope catches the AppShell layout
  // shell as well as every page below it.
  revalidatePath('/', 'layout');
  void isSuperAdmin;
}

/**
 * "Create your workspace" on the no-workspace screen (/dashboard,
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
      redirect(`/dashboard?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  redirect('/onboarding');
}
