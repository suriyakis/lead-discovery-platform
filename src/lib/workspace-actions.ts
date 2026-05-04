'use server';

import { revalidatePath } from 'next/cache';
import { auth } from './auth';
import { setActiveWorkspace } from './services/workspace';
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
