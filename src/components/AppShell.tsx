// Shared app shell: BrandHeader at the top + Sidebar + main content.
// AppShell is a server component that pulls the current session itself
// so pages can render <AppShell>{...}</AppShell> without boilerplate.
//
// Sidebar auto-detects the active route via usePathname() — no `active`
// prop needed. Public pages (signed-out landing, /pending) bypass the
// shell and render BrandHeader on their own.

import { BrandHeader } from './BrandHeader';
import { CommandPalette } from './CommandPalette';
import { fetchCommandPaletteEntities } from './command-palette-action';
import { Sidebar } from './Sidebar';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { auth } from '@/lib/auth';
import { signOutAction } from '@/lib/auth-actions';
import { listMyWorkspaces } from '@/lib/services/workspace';
import { getNavCounts, type NavCounts } from '@/lib/services/nav-counts';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/auth';
import { eq } from 'drizzle-orm';

export interface AppShellProps {
  children: React.ReactNode;
  /**
   * Override `isSuperAdmin`. By default the shell reads `session.user.role`
   * and shows the Platform section only when role is `super_admin`.
   */
  isSuperAdmin?: boolean;
  /**
   * Override the header's right slot. Defaults to: workspace switcher
   * (if user has 2+ workspaces) + email + sign-out button.
   */
  rightSlot?: React.ReactNode;
}

export async function AppShell({
  children,
  isSuperAdmin,
  rightSlot,
}: Readonly<AppShellProps>) {
  const session = await auth();
  const showAdmin =
    isSuperAdmin ?? session?.user?.role === 'super_admin';

  // Phase 28+29: pull the user's workspaces so the header can render a
  // switcher when they belong to more than one. Super-admins also see
  // every other workspace as a god-mode option for support.
  const myWorkspaces = session?.user?.id
    ? await listMyWorkspaces(session.user.id, {
        includeAllForSuperAdmin: session.user.role === 'super_admin',
      })
    : [];

  // Sidebar count badges: pending drafts / review items / open leads
  // for the user's active workspace. Best-effort — degrades to all
  // zeros when the user has no active workspace yet.
  let navCounts: NavCounts = { draftsPending: 0, reviewPending: 0, leadsOpen: 0 };
  if (session?.user?.id) {
    const userRows = await db
      .select({ activeWorkspaceId: users.activeWorkspaceId })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);
    const activeId = userRows[0]?.activeWorkspaceId ?? null;
    const fallback =
      activeId ?? myWorkspaces[0]?.workspace.id ?? null;
    if (fallback !== null) {
      navCounts = await getNavCounts({ workspaceId: BigInt(fallback) });
    }
  }

  const slot =
    rightSlot ??
    (session?.user?.email ? (
      <DefaultRightSlot
        email={session.user.email}
        myWorkspaces={myWorkspaces.map((m) => ({
          id: m.workspace.id.toString(),
          name: m.workspace.name,
          slug: m.workspace.slug,
          role: m.role,
          isActive: m.isActive,
          isArchived: m.workspace.status === 'archived',
          isDefault: m.workspace.isDefault,
          isGodMode: m.isGodMode,
        }))}
      />
    ) : null);

  return (
    <div className="app-shell">
      <BrandHeader rightSlot={slot} />
      <div className="app-body">
        <Sidebar isSuperAdmin={showAdmin} navCounts={navCounts} />
        <main className="app-main">{children}</main>
      </div>
      {session?.user?.id ? (
        <CommandPalette
          fetchEntities={fetchCommandPaletteEntities}
          isSuperAdmin={showAdmin}
        />
      ) : null}
    </div>
  );
}

function DefaultRightSlot({
  email,
  myWorkspaces,
}: Readonly<{
  email: string;
  myWorkspaces: React.ComponentProps<typeof WorkspaceSwitcher>['workspaces'];
}>) {
  return (
    <>
      {myWorkspaces.length > 1 ? (
        <WorkspaceSwitcher workspaces={myWorkspaces} />
      ) : null}
      <span className="who">{email}</span>
      <form action={signOutAction}>
        <button type="submit" className="ghost-btn">
          Sign out
        </button>
      </form>
    </>
  );
}
