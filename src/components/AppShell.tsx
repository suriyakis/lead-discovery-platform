// Shared app shell: BrandHeader at the top + Sidebar + main content.
// AppShell is a server component that pulls the current session itself
// so pages can render <AppShell>{...}</AppShell> without boilerplate.
//
// Navigation comes from one registry (src/lib/nav/registry.ts): the
// Sidebar (areas), AreaFrame (the current area's tabs or the Settings
// sub-nav, around the page), the Cmd-K palette and its visible Search
// button, and the account menu (My account, Help & support). Each reads
// the viewer's role in the active workspace, so admin-only entries only
// show to admins. Public pages (signed-out landing, /pending) bypass the
// shell and render BrandHeader on their own.
//
// The chrome draws its icons with Lucide, never emoji (DS-08; the bell,
// the god-mode crown, the account menu).

import { Bell, Crown, UserCircle } from 'lucide-react';
import Link from 'next/link';
import styles from './AppShell.module.css';
import { AreaFrame } from './AreaNav';
import { AssistantPanel } from './AssistantPanel';
import { AutomationHoldBanner } from './AutomationHoldBanner';
import { BrandHeader } from './BrandHeader';
import { CommandPalette } from './CommandPalette';
import { CommandPaletteTrigger } from './CommandPaletteTrigger';
import { fetchCommandPaletteEntities } from './command-palette-action';
import { NavCountBadge } from './NavCountBadge';
import { Sidebar } from './Sidebar';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { auth } from '@/lib/auth';
import { signOutAction } from '@/lib/auth-actions';
import { ACCOUNT_MENU, type NavCountValues } from '@/lib/nav/registry';
import { resolveNavCount, tabById, type NavViewer } from '@/lib/nav/resolve';
import { cx } from '@/lib/ui/cx';
import { setActiveWorkspaceAction } from '@/lib/workspace-actions';
import { listMyWorkspaces } from '@/lib/services/workspace';
import { getNavCounts, ZERO_NAV_COUNTS } from '@/lib/services/nav-counts';
import type { WorkspaceRole } from '@/lib/services/context';
import type { WorkspaceAutomationNotice } from '@/lib/services/automation-gate';

export interface AppShellProps {
  children: React.ReactNode;
  /**
   * Override `isSuperAdmin`. By default the shell reads `session.user.role`
   * and shows the Platform console only when role is `super_admin`.
   */
  isSuperAdmin?: boolean;
  /**
   * Override the header's right slot. Defaults to: Search, notifications,
   * workspace switcher (if user has 2+ workspaces) + the account menu.
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

  // Badges and the viewer's role for the active workspace. Resolve the
  // workspace THE SAME WAY pages do (incl. the god-mode branch and the
  // ignore-foreign-pointer rule for normal users) so the shell's badges
  // never show a different tenant than the page content. Best-effort —
  // degrades to zero badges and no role when there is no workspace yet.
  let navCounts: NavCountValues = ZERO_NAV_COUNTS;
  let role: WorkspaceRole | null = null;
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
      role = shellCtx.role;
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
  if (showAdmin) {
    try {
      const { adminSupportUnreadCount } = await import('@/lib/services/support');
      navCounts = { ...navCounts, adminSupportUnread: await adminSupportUnreadCount() };
    } catch {
      // Table not migrated yet — the console badge stays hidden.
    }
  }
  const viewer: NavViewer = { role, isSuperAdmin: showAdmin };

  const slot =
    rightSlot ??
    (session?.user?.email ? (
      <DefaultRightSlot
        email={session.user.email}
        unreadNotifications={unreadNotifications}
        navCounts={navCounts}
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
        <div role="alert" className={styles.godMode} data-god-mode="">
          <Crown className={`lucide ${styles.godModeIcon}`} aria-hidden="true" />
          <span className={styles.godModeText}>
            GOD MODE — you are inside workspace “{godModeRow.workspace.name}”.
            Every page shows that tenant&apos;s data and your actions apply to it.
          </span>
          {returnHome ? (
            <form action={returnHome}>
              <button type="submit" className={`ghost-btn ${styles.godModeExit}`}>
                Return to my workspace
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
      {automationNotice ? <AutomationHoldBanner notice={automationNotice} /> : null}
      <div className="app-body">
        <Sidebar isSuperAdmin={showAdmin} role={role} navCounts={navCounts} />
        <main className="app-main">
          <AreaFrame viewer={viewer} navCounts={navCounts}>
            {children}
          </AreaFrame>
        </main>
      </div>
      {session?.user?.id ? (
        <>
          <CommandPalette
            fetchEntities={fetchCommandPaletteEntities}
            isSuperAdmin={showAdmin}
            role={role}
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
  navCounts,
  myWorkspaces,
}: Readonly<{
  email: string;
  unreadNotifications: number;
  navCounts: NavCountValues;
  myWorkspaces: React.ComponentProps<typeof WorkspaceSwitcher>['workspaces'];
}>) {
  // Unread support replies also show on the closed menu, so they are not
  // hidden behind it.
  const menuCounts = ACCOUNT_MENU.map((id) => resolveNavCount(tabById(id).tab.count, navCounts));
  const menuCount = menuCounts.find((c) => c !== null) ?? null;
  return (
    <>
      <CommandPaletteTrigger />
      {/* The bell counts events; the count is neutral (DS-00 count policy). */}
      <Link
        href="/notifications"
        className={cx('header-bell', styles.bell)}
        aria-label={
          unreadNotifications > 0
            ? `Notifications, ${unreadNotifications} unread`
            : 'Notifications'
        }
      >
        <Bell className="lucide" aria-hidden="true" />
        {unreadNotifications > 0 ? (
          <span className={cx('header-bell-count', styles.bellCount)} aria-hidden="true">
            {unreadNotifications > 99 ? '99+' : unreadNotifications}
          </span>
        ) : null}
      </Link>
      {myWorkspaces.length > 1 ? (
        <WorkspaceSwitcher workspaces={myWorkspaces} />
      ) : null}
      {/* The account menu (ia §4): who you are, My account, Help &
          support, Sign out — at every width. Plain <details>, so it
          works before hydration and without JS (I144). */}
      <details className={cx('header-account-menu', styles.accountMenu)}>
        <summary className="ghost-btn" aria-label="Account menu" title={email}>
          <UserCircle className="lucide" aria-hidden="true" />
          {menuCount ? <NavCountBadge count={menuCount} /> : null}
        </summary>
        <div className={cx('header-account-menu-panel', styles.accountPanel)}>
          <span className={cx('who', styles.accountWho)}>{email}</span>
          <ul className={cx('header-account-links', styles.accountLinks)}>
            {ACCOUNT_MENU.map((id) => {
              const { tab } = tabById(id);
              const count = resolveNavCount(tab.count, navCounts);
              return (
                <li key={id}>
                  <Link href={tab.href} data-tab={tab.id}>
                    {tab.label}
                    {count ? <NavCountBadge count={count} /> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
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
