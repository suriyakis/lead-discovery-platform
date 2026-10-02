// Today (/today): the signed-in home of the decided IA (DS-05). It
// replaces /dashboard and /inbox, which now redirect here
// (src/lib/nav/redirects.ts). Until the real Today hub lands (ia:F-23) it
// carries both pages' content as the area's two views, picked by the
// tabs above the page (AreaNav, from the navigation registry):
//   - Needs you (default; ?tab=review|drafts|replies|followups) — the
//     approval inbox that was /inbox;
//   - Overview (?view=overview) — the workspace signals that were
//     /dashboard.
// It also keeps the dashboard's duties: the no-workspace screen, the
// pending-account wall and the one-time first-run redirect to the setup
// wizard. Above both views, "Needs fixing" lists the problems the
// diagnostics engine finds (AP-06), the same list /health shows.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { NoWorkspaceScreen } from '@/components/NoWorkspaceScreen';
import { auth } from '@/lib/auth';
import { isNextRedirectError } from '@/lib/server-redirect';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace, type WorkspaceContext } from '@/lib/services/context';
import { getDashboardSignals } from '@/lib/services/dashboard-signals';
import { claimOnboardingStart } from '@/lib/services/onboarding';
import { getActiveWorkspaceSummary } from '@/lib/services/workspace';
import { getWorkspaceStartState } from '@/lib/services/workspace-provisioning';
import { TodayAttention } from './_attention';
import { NeedsYou, parseNeedsYouTab } from './_needs-you';
import { TodayOverview } from './_overview';

export interface TodaySearchParams {
  /** 'overview' = the Overview view; anything else = Needs you. */
  view?: string;
  /** Needs-you section. */
  tab?: string;
  /** Error from the no-workspace screen's create form. */
  error?: string;
}

/**
 * The signed-in user's active workspace context, or null when they have
 * no workspace yet (the page then shows the no-workspace screen).
 */
async function resolveTodayContext(): Promise<WorkspaceContext | null> {
  try {
    return await getWorkspaceContext();
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof NoWorkspaceError) return null;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    throw err;
  }
}

export default async function TodayPage({
  searchParams,
}: {
  searchParams?: Promise<TodaySearchParams>;
} = {}) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/');
  }
  // Phase 15: bounce non-active users to the pending wall.
  if (session.user.accountStatus !== 'active' && session.user.role !== 'super_admin') {
    redirect('/pending');
  }

  const isSuperAdmin = session.user.role === 'super_admin';
  const sp = (await searchParams) ?? {};

  // One workspace for the whole page: the context every other page and
  // the header switcher resolve (god mode included), not an unordered
  // memberships[0] (audit I042, deliverables ia:F-05 / PC-04).
  const ctx = await resolveTodayContext();

  // No workspace: one screen to create their own or ask to be added
  // (ia:F-07). Server actions and the settings pages send such users here.
  if (!ctx) {
    const start = await getWorkspaceStartState(session.user.id);
    return (
      <NoWorkspaceScreen
        userId={session.user.id}
        email={session.user.email ?? ''}
        isSuperAdmin={isSuperAdmin}
        start={start}
        error={sp.error?.slice(0, 300) ?? null}
      />
    );
  }

  const active = await getActiveWorkspaceSummary(ctx);

  // Phase 47 first-run redirect, at most once per workspace: only while
  // the active workspace is still 'pending', only for someone who can
  // run the wizard, and claiming the redirect moves it to 'in_progress'.
  // Non-admins and god-mode visits are never redirected.
  if (active.workspace.onboardingStatus === 'pending' && (await claimOnboardingStart(ctx))) {
    redirect('/onboarding');
  }

  const view = sp.view === 'overview' ? 'overview' : 'needs';
  const showSetupLink =
    !active.isGodMode &&
    active.workspace.onboardingStatus !== 'completed' &&
    canAdminWorkspace(ctx);
  const firstName = session.user.name ? session.user.name.split(' ')[0] : null;

  return (
    <AppShell>
      <div className="dashboard-wrap">
        <header className="page-intro">
          <p className="page-eyebrow">Today</p>
          <h1 className="page-title">Welcome back{firstName ? `, ${firstName}` : ''}.</h1>
          <p className="page-lede">
            {view === 'overview'
              ? 'How the workspace is doing: review, drafts, replies, the send queue and the pipeline.'
              : 'Everything that needs your attention right now — review picks, drafts ready to approve, fresh replies, follow-ups awaiting send.'}
          </p>
          {/* On Overview the Active workspace card carries this link. */}
          {showSetupLink && view === 'needs' ? (
            <p className="page-lede">
              <Link href="/onboarding">Continue workspace setup</Link>
            </p>
          ) : null}
        </header>

        {/* AP-06: the problems the workspace checks find, on both views. */}
        <TodayAttention ctx={ctx} />

        {view === 'overview' ? (
          <TodayOverview
            user={{
              name: session.user.name ?? null,
              email: session.user.email ?? null,
              role: session.user.role,
            }}
            active={active}
            signals={await getDashboardSignals(ctx)}
            showSetupLink={showSetupLink}
            viewer={{ role: ctx.role, isSuperAdmin }}
          />
        ) : (
          <NeedsYou ctx={ctx} tab={parseNeedsYouTab(sp.tab)} />
        )}
      </div>
    </AppShell>
  );
}
