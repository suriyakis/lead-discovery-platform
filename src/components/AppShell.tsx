// The workspace frame: BrandHeader at the top + Sidebar + main content,
// plus the banners, Cmd-K and the "Ask the platform" assistant.
//
// DS-07 (absorbs MOB-03, AP-05a, ia:F-09): src/app/(app)/layout.tsx renders
// it ONCE for every workspace page, and Next keeps the layout mounted
// across client-side navigation — so the assistant's conversation, the
// palette's entity cache and the sidebar survive moving between pages
// (I053). No page renders AppShell itself (src/tests/app-shell-ds07.test.ts
// fails if one does). What the frame shows is resolved once per layout
// render by getShellState() (src/lib/shell/state.ts), which also decides
// the frame's state:
//   - signed out          → the sign-in page;
//   - account not active  → /pending;
//   - no workspace yet    → a bare frame (brand header, account, Sign out):
//                           the page shows <NoWorkspaceState/>;
//   - a workspace         → the full frame below.
//
// Navigation comes from one registry (src/lib/nav/registry.ts): the
// Sidebar (areas), AreaFrame (the current area's tabs or the Settings
// sub-nav, around the page), the Cmd-K palette and its visible Search
// button, and the account menu (My account, Help & support). Each reads
// the viewer's role in the active workspace, so admin-only entries only
// show to admins. Public pages (signed-out landing, /pending) bypass the
// shell and render BrandHeader on their own; /admin has its own layout
// and AdminShell.
//
// The chrome draws its icons with Lucide, never emoji (DS-08; the bell,
// the god-mode crown, the account menu).
//
// MOB-02 + DS-07: every number in the frame (sidebar and tab badges, the
// bell, the account menu) comes from ONE attention summary (src/lib/
// attention), computed with the frame and shared with the page (Today asks
// for the same request-cached one). The layout is not re-rendered on
// client navigation, so the numbers are client islands fed by
// <ShellAttentionProvider>, which keeps the summary current with
// useAttention(); decisions re-render the frame in their own response
// (refreshChrome()), and <ShellRefresher/> refreshes the server-rendered
// rest (banners, chip) when the automation state moves or the tab comes
// back after 5 idle minutes. A number that failed to load prints "—".
//
// MOB-06: the frame resolves the workspace of THIS browser session (each
// session keeps its own) and provides it to every page as the expected
// workspace (WorkspaceGuardProvider): every guarded form and fetch posts
// it back, and the server refuses with workspace_changed when the session
// has moved since. The assistant and the palette are keyed by that
// workspace, so a switch (or entering god mode) starts them afresh.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Crown, UserCircle } from 'lucide-react';
import styles from './AppShell.module.css';
import { AreaFrame } from './AreaNav';
import { AssistantPanel } from './AssistantPanel';
import { AutomationHoldBanner } from './AutomationHoldBanner';
import { BrandHeader } from './BrandHeader';
import { CommandPalette } from './CommandPalette';
import { CommandPaletteTrigger } from './CommandPaletteTrigger';
import { fetchCommandPaletteEntities } from './command-palette-action';
import { ShellAttentionProvider } from './ShellAttention';
import {
  AccountMenuBadge,
  AccountMenuItemBadge,
  CloseMenusOnNavigate,
  NotificationBell,
} from './ShellHeaderCounts';
import { ShellRefresher } from './ShellRefresher';
import { Sidebar } from './Sidebar';
import {
  WorkspaceDriftNotice,
  WorkspaceGuardProvider,
  WorkspaceSwitchNotice,
  type PageWorkspace,
} from './WorkspaceGuard';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { signOutAction } from '@/lib/auth-actions';
import { navCountsFromAttention } from '@/lib/attention/project';
import { ACCOUNT_MENU } from '@/lib/nav/registry';
import { tabById, type NavViewer } from '@/lib/nav/resolve';
import { NO_NAV_COUNTS } from '@/lib/services/nav-counts';
import { chromeSignature } from '@/lib/shell/freshness';
import { getShellState, type ShellUser, type ShellWorkspaceRow } from '@/lib/shell/state';
import { cx } from '@/lib/ui/cx';
import { setActiveWorkspaceAction } from '@/lib/workspace-actions';

export interface AppShellProps {
  children: React.ReactNode;
}

export async function AppShell({ children }: Readonly<AppShellProps>) {
  const state = await getShellState();
  if (state.kind === 'signed_out') redirect('/');
  // Phase 15: accounts waiting for approval see the pending wall only.
  if (state.kind === 'inactive') redirect('/pending');
  if (state.kind === 'no_workspace' || state.kind === 'unavailable') {
    return <BareFrame user={state.user}>{children}</BareFrame>;
  }

  const { user, attention } = state;
  const viewer: NavViewer = { role: state.role, isSuperAdmin: user.isSuperAdmin };
  const pageWorkspace: PageWorkspace = state.workspace;
  // The server render's numbers; in the browser the islands follow the
  // provider's live summary.
  const nav = attention ? navCountsFromAttention(attention) : NO_NAV_COUNTS;

  // God-mode indicator: the active workspace is one the super-admin is
  // NOT a member of. Every page below renders the TARGET tenant's data,
  // so make that unmissable and offer a one-click way home.
  const returnHome =
    state.godMode && state.homeWorkspaceId
      ? setActiveWorkspaceAction.bind(null, state.homeWorkspaceId)
      : null;

  return (
    <WorkspaceGuardProvider workspace={pageWorkspace}>
      <ShellAttentionProvider seed={attention} workspaceId={pageWorkspace.id}>
        <div className="app-shell" data-shell-workspace={pageWorkspace.id}>
          <BrandHeader
            rightSlot={
              user.email ? <HeaderSlot email={user.email} workspaces={state.workspaces} /> : null
            }
          />
          <WorkspaceSwitchNotice />
          <WorkspaceDriftNotice />
          {state.godMode ? (
            <div role="alert" className={styles.godMode} data-god-mode="">
              <Crown className={`lucide ${styles.godModeIcon}`} aria-hidden="true" />
              <span className={styles.godModeText}>
                GOD MODE — you are inside workspace “{state.godMode.workspaceName}”. Every page
                shows that tenant&apos;s data and your actions apply to it.
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
          {state.automationNotice ? <AutomationHoldBanner notice={state.automationNotice} /> : null}
          <div className="app-body">
            <Sidebar
              isSuperAdmin={user.isSuperAdmin}
              role={state.role}
              attention={attention}
              navCounts={nav.values}
              unknownCounts={[...nav.unknown]}
            />
            <main className="app-main">
              <AreaFrame viewer={viewer} navCounts={nav.values} unknownCounts={nav.unknown}>
                {children}
              </AreaFrame>
            </main>
          </div>
          {/* Keyed by the workspace: a switch or god mode starts both afresh
              (no answer or cached entity of one tenant shows in another). */}
          <CommandPalette
            key={`palette:${pageWorkspace.id}`}
            fetchEntities={fetchCommandPaletteEntities}
            isSuperAdmin={user.isSuperAdmin}
            role={state.role}
          />
          <AssistantPanel key={pageWorkspace.id} />
          <ShellRefresher renderedSignature={chromeSignature(attention)} />
        </div>
      </ShellAttentionProvider>
    </WorkspaceGuardProvider>
  );
}

/**
 * The frame for a signed-in user without a workspace (or while it cannot
 * be resolved): the brand header with who they are and Sign out. Every
 * module needs a workspace, so there is no sidebar, palette or assistant;
 * the page shows <NoWorkspaceState/> (or its own error).
 */
function BareFrame({ user, children }: Readonly<{ user: ShellUser; children: React.ReactNode }>) {
  return (
    <>
      <BrandHeader
        rightSlot={
          <>
            {user.email ? <span className="muted">{user.email}</span> : null}
            <form action={signOutAction}>
              <button type="submit" className="ghost-btn">
                Sign out
              </button>
            </form>
          </>
        }
      />
      <main className="dashboard-wrap" data-shell-frame="no-workspace">
        {children}
      </main>
    </>
  );
}

/** The header's right slot: Search, the bell, the switcher, the account menu. */
function HeaderSlot({
  email,
  workspaces,
}: Readonly<{ email: string; workspaces: ShellWorkspaceRow[] }>) {
  return (
    <>
      <CommandPaletteTrigger />
      <NotificationBell />
      {workspaces.length > 1 ? <WorkspaceSwitcher workspaces={workspaces} /> : null}
      {/* The account menu (ia §4): who you are, My account, Help &
          support, Sign out — at every width. Plain <details>, so it
          works before hydration and without JS (I144). */}
      <details className={cx('header-account-menu', styles.accountMenu)}>
        <summary className="ghost-btn" aria-label="Account menu" title={email}>
          <UserCircle className="lucide" aria-hidden="true" />
          <AccountMenuBadge />
        </summary>
        <div className={cx('header-account-menu-panel', styles.accountPanel)}>
          <span className={cx('who', styles.accountWho)}>{email}</span>
          <ul className={cx('header-account-links', styles.accountLinks)}>
            {ACCOUNT_MENU.map((id) => {
              const { tab } = tabById(id);
              return (
                <li key={id}>
                  <Link href={tab.href} data-tab={tab.id}>
                    {tab.label}
                    <AccountMenuItemBadge tabId={id} />
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
      <CloseMenusOnNavigate />
    </>
  );
}
