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
//
// MOB-02: every number in the chrome (sidebar badges, the bell, the
// account menu) comes from ONE attention summary (src/lib/attention),
// computed once per request and shared with the page (Today asks for the
// same one). The Sidebar receives it as a seed and keeps it current in the
// browser with useAttention(), because the shell does not re-render on
// every client-side change. A number that failed to load prints "—".
//
// MOB-06: the shell resolves the workspace of THIS browser session (each
// session keeps its own) and provides it to the page as the expected
// workspace (WorkspaceGuardProvider): every guarded form and fetch posts
// it back, and the server refuses with workspace_changed when the session
// has moved since. It also shows "Switched to …" after a /go link.

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
import {
  WorkspaceGuardProvider,
  WorkspaceSwitchNotice,
  type PageWorkspace,
} from './WorkspaceGuard';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { auth } from '@/lib/auth';
import { signOutAction } from '@/lib/auth-actions';
import { navCountsFromAttention, type ProjectedNavCounts } from '@/lib/attention/project';
import { getRequestAttentionSummary } from '@/lib/attention/service';
import type { AttentionSummary } from '@/lib/attention/types';
import { ACCOUNT_MENU } from '@/lib/nav/registry';
import { resolveNavCount, tabById, type NavViewer } from '@/lib/nav/resolve';
import { cx } from '@/lib/ui/cx';
import { setActiveWorkspaceAction } from '@/lib/workspace-actions';
import { listMyWorkspaces } from '@/lib/services/workspace';
import { NO_NAV_COUNTS } from '@/lib/services/nav-counts';
import type { WorkspaceContext, WorkspaceRole } from '@/lib/services/context';
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

  // Badges and the viewer's role for the active workspace. Resolve the
  // workspace THE SAME WAY pages do (this session's pointer, the god-mode
  // branch and the ignore-foreign-pointer rule for normal users) so the
  // shell's badges never show a different tenant than the page content.
  // With no workspace yet there are no numbers and no role (not zeros).
  let shellCtx: WorkspaceContext | null = null;
  let attention: AttentionSummary | null = null;
  let role: WorkspaceRole | null = null;
  // PC-06: holds, the platform outbound stop and a missing accountable
  // owner, shown to every member of the active workspace.
  let automationNotice: WorkspaceAutomationNotice | null = null;
  if (session?.user?.id) {
    try {
      const { resolveSessionWorkspaceContext } = await import('@/lib/services/auth-context');
      shellCtx = await resolveSessionWorkspaceContext(session.user);
      role = shellCtx.role;
      const { getWorkspaceAutomationNotice } = await import(
        '@/lib/services/automation-gate'
      );
      const [summary, notice] = await Promise.allSettled([
        getRequestAttentionSummary(shellCtx, { isSuperAdmin: showAdmin }),
        getWorkspaceAutomationNotice(shellCtx),
      ]);
      attention = summary.status === 'fulfilled' ? summary.value : null;
      automationNotice = notice.status === 'fulfilled' ? notice.value : null;
    } catch {
      // No resolvable workspace yet — no badges.
    }
  }

  // Phase 28+29: pull the user's workspaces so the header can render a
  // switcher when they belong to more than one. Super-admins also see
  // every other workspace as a god-mode option for support. The active
  // one is this session's (MOB-06).
  const myWorkspaces = session?.user?.id
    ? await listMyWorkspaces(session.user.id, {
        includeAllForSuperAdmin: session.user.role === 'super_admin',
        activeWorkspaceId: shellCtx?.workspaceId ?? null,
      })
    : [];
  const activeRow = shellCtx
    ? myWorkspaces.find((m) => m.workspace.id === shellCtx.workspaceId)
    : undefined;
  const pageWorkspace: PageWorkspace | null = shellCtx
    ? {
        id: shellCtx.workspaceId.toString(),
        name: activeRow?.workspace.name ?? `Workspace ${shellCtx.workspaceId.toString()}`,
      }
    : null;
  let nav: ProjectedNavCounts = attention ? navCountsFromAttention(attention) : NO_NAV_COUNTS;
  if (!attention && showAdmin) {
    // A super-admin with no workspace still runs the console: its support
    // badge does not depend on a tenant.
    try {
      const { adminSupportUnreadCount } = await import('@/lib/services/support');
      nav = { ...nav, values: { ...nav.values, adminSupportUnread: await adminSupportUnreadCount() } };
    } catch {
      nav = { ...nav, unknown: new Set([...nav.unknown, 'adminSupportUnread']) };
    }
  }
  const unreadNotifications = attention ? attention.counts['notifications.unread'] : 0;
  const viewer: NavViewer = { role, isSuperAdmin: showAdmin };

  const slot =
    rightSlot ??
    (session?.user?.email ? (
      <DefaultRightSlot
        email={session.user.email}
        unreadNotifications={unreadNotifications}
        nav={nav}
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
    <WorkspaceGuardProvider workspace={pageWorkspace}>
      <div className="app-shell">
        <BrandHeader rightSlot={slot} />
        <WorkspaceSwitchNotice />
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
          <Sidebar
            isSuperAdmin={showAdmin}
            role={role}
            attention={attention}
            navCounts={nav.values}
            unknownCounts={[...nav.unknown]}
          />
          <main className="app-main">
            <AreaFrame viewer={viewer} navCounts={nav.values}>
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
    </WorkspaceGuardProvider>
  );
}

function DefaultRightSlot({
  email,
  unreadNotifications,
  nav,
  myWorkspaces,
}: Readonly<{
  email: string;
  /** null: the number could not be loaded (the bell prints "—"). */
  unreadNotifications: number | null;
  nav: ProjectedNavCounts;
  myWorkspaces: React.ComponentProps<typeof WorkspaceSwitcher>['workspaces'];
}>) {
  const countOptions = { unknown: nav.unknown };
  // Unread support replies also show on the closed menu, so they are not
  // hidden behind it.
  const menuCounts = ACCOUNT_MENU.map((id) =>
    resolveNavCount(tabById(id).tab.count, nav.values, countOptions),
  );
  const menuCount = menuCounts.find((c) => c !== null) ?? null;
  let bellText: string | null = null;
  if (unreadNotifications === null) bellText = '—';
  else if (unreadNotifications > 99) bellText = '99+';
  else if (unreadNotifications > 0) bellText = String(unreadNotifications);
  let bellLabel = 'Notifications';
  if (unreadNotifications === null) bellLabel = 'Notifications, unread count unavailable';
  else if (unreadNotifications > 0) bellLabel = `Notifications, ${unreadNotifications} unread`;
  return (
    <>
      <CommandPaletteTrigger />
      {/* The bell counts events; the count is neutral (DS-00 count policy). */}
      <Link href="/notifications" className={cx('header-bell', styles.bell)} aria-label={bellLabel}>
        <Bell className="lucide" aria-hidden="true" />
        {bellText ? (
          <span className={cx('header-bell-count', styles.bellCount)} aria-hidden="true">
            {bellText}
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
              const count = resolveNavCount(tab.count, nav.values, countOptions);
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
