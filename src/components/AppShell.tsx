// Shared app shell: BrandHeader at the top + Sidebar + main content.
// AppShell is a server component that pulls the current session itself
// so pages can render <AppShell>{...}</AppShell> without boilerplate.
//
// Sidebar auto-detects the active route via usePathname() — no `active`
// prop needed. Public pages (signed-out landing, /pending) bypass the
// shell and render BrandHeader on their own.

import { UserCircle } from 'lucide-react';
import { AssistantPanel } from './AssistantPanel';
import { AutomationHoldBanner } from './AutomationHoldBanner';
import { BrandHeader } from './BrandHeader';
import { CommandPalette } from './CommandPalette';
import { fetchCommandPaletteEntities } from './command-palette-action';
import { Sidebar } from './Sidebar';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { auth } from '@/lib/auth';
import { signOutAction } from '@/lib/auth-actions';
import { setActiveWorkspaceAction } from '@/lib/workspace-actions';
import { listMyWorkspaces } from '@/lib/services/workspace';
import { getNavCounts, type NavCounts } from '@/lib/services/nav-counts';
import type { WorkspaceAutomationNotice } from '@/lib/services/automation-gate';

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
  // Resolve the workspace THE SAME WAY pages do (incl. the god-mode
  // branch and the ignore-foreign-pointer rule for normal users) so the
  // shell's badges never show a different tenant than the page content.
  let navCounts: NavCounts = {
    draftsPending: 0,
    reviewPending: 0,
    leadsOpen: 0,
    supportUnread: 0,
  };
  let unreadNotifications = 0;
  // PC-06: holds, the platform outbound stop and a missing accountable
  // owner, shown to every member of the active workspace.
  let automationNotice: WorkspaceAutomationNotice | null = null;
  if (session?.user?.id) {
    try {
      const { resolveWorkspaceContextForUser } = await import(
        '@/lib/services/workspace-resolution'
      );
      const shellCtx = await resolveWorkspaceContextForUser(
        session.user.id,
        session.user.role === 'super_admin',
      );
      navCounts = await getNavCounts({ workspaceId: shellCtx.workspaceId });
      const { unreadNotificationCount } = await import(
        '@/lib/services/notifications'
      );
      unreadNotifications = await unreadNotificationCount(shellCtx);
      const { getWorkspaceAutomationNotice } = await import(
        '@/lib/services/automation-gate'
      );
      automationNotice = await getWorkspaceAutomationNotice(shellCtx);
    } catch {
      // No resolvable workspace yet — badges stay at zero.
    }
  }

  const slot =
    rightSlot ??
    (session?.user?.email ? (
      <DefaultRightSlot
        email={session.user.email}
        unreadNotifications={unreadNotifications}
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

  // God-mode indicator: the active workspace is one the super-admin is
  // NOT a member of. Every page below renders the TARGET tenant's data,
  // so make that unmissable and offer a one-click way home.
  const godModeRow = myWorkspaces.find((m) => m.isGodMode && m.isActive);
  const homeWorkspace = myWorkspaces.find((m) => !m.isGodMode);
  const returnHome = homeWorkspace
    ? setActiveWorkspaceAction.bind(null, homeWorkspace.workspace.id.toString())
    : null;

  return (
    <div className="app-shell">
      <BrandHeader rightSlot={slot} />
      {godModeRow ? (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '1rem',
            padding: '0.5rem 1rem',
            background: 'oklch(0.45 0.16 25)',
            color: 'oklch(0.98 0.01 25)',
            fontWeight: 600,
          }}
        >
          <span>
            👑 GOD MODE — you are inside workspace “{godModeRow.workspace.name}”.
            Every page shows that tenant&apos;s data and your actions apply to it.
          </span>
          {returnHome ? (
            <form action={returnHome}>
              <button
                type="submit"
                className="ghost-btn"
                style={{ borderColor: 'currentColor', color: 'inherit' }}
              >
                Return to my workspace
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
      {automationNotice ? <AutomationHoldBanner notice={automationNotice} /> : null}
      <div className="app-body">
        <Sidebar isSuperAdmin={showAdmin} navCounts={navCounts} />
        <main className="app-main">{children}</main>
      </div>
      {session?.user?.id ? (
        <>
          <CommandPalette
            fetchEntities={fetchCommandPaletteEntities}
            isSuperAdmin={showAdmin}
          />
          <AssistantPanel />
        </>
      ) : null}
    </div>
  );
}

function DefaultRightSlot({
  email,
  unreadNotifications,
  myWorkspaces,
}: Readonly<{
  email: string;
  unreadNotifications: number;
  myWorkspaces: React.ComponentProps<typeof WorkspaceSwitcher>['workspaces'];
}>) {
  return (
    <>
      <a
        href="/notifications"
        title="Notifications"
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          textDecoration: 'none',
          fontSize: '1.1rem',
          lineHeight: 1,
          padding: '0.3rem',
        }}
      >
        🔔
        {unreadNotifications > 0 ? (
          <span
            style={{
              position: 'absolute',
              top: '-0.25rem',
              right: '-0.45rem',
              background: 'oklch(0.62 0.22 25)',
              color: 'white',
              borderRadius: '999px',
              fontSize: '0.68rem',
              fontWeight: 700,
              minWidth: '1.1rem',
              textAlign: 'center',
              padding: '0.05rem 0.25rem',
            }}
          >
            {unreadNotifications > 99 ? '99+' : unreadNotifications}
          </span>
        ) : null}
      </a>
      {myWorkspaces.length > 1 ? (
        <WorkspaceSwitcher workspaces={myWorkspaces} />
      ) : null}
      {/* Desktop: e-mail + Sign out inline. Below 800px CSS hides these
          and shows the compact menu instead — the full e-mail and a
          button would not fit a phone-width header (I144). Plain
          <details>, so it works before hydration and without JS. */}
      <span className="who header-account-inline">{email}</span>
      <form action={signOutAction} className="header-account-inline">
        <button type="submit" className="ghost-btn">
          Sign out
        </button>
      </form>
      <details className="header-account-menu">
        <summary className="ghost-btn" aria-label="Account menu" title={email}>
          <UserCircle className="lucide" aria-hidden="true" />
        </summary>
        <div className="header-account-menu-panel">
          <span className="who">{email}</span>
          <form action={signOutAction}>
            <button type="submit" className="ghost-btn">
              Sign out
            </button>
          </form>
        </div>
      </details>
    </>
  );
}
