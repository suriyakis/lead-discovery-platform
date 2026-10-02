// The one screen for a signed-in user who belongs to no workspace
// (audit I117, deliverable ia:F-07). /today renders it, and
// /onboarding and the settings pages send such users there. It replaces
// the old dashboard card, which told them to check OWNER_EMAIL in the
// server config. (The module pages' inline "You don't belong to a
// workspace yet" branches go when the app layout takes over that state,
// F-09.)
//
// Two ways forward: create a workspace of their own (allowed once, see
// createFirstWorkspace) or ask a team admin to add them. Pending
// invitations will be listed here once invitations exist (F-25).
//
// Rendered without the app shell: every module in the sidebar needs a
// workspace, so a user without one gets only the header and sign-out.

import Link from 'next/link';
import { BrandHeader } from './BrandHeader';
import { signOutAction } from '@/lib/auth-actions';
import { BRAND_NAME } from '@/lib/brand';
import {
  WORKSPACE_NAME_MAX,
  type WorkspaceStartState,
} from '@/lib/services/workspace-provisioning';
import { createFirstWorkspaceAction } from '@/lib/workspace-actions';

export interface NoWorkspaceScreenProps {
  userId: string;
  email: string;
  isSuperAdmin: boolean;
  start: WorkspaceStartState;
  /** Message from a refused "Create workspace" submit. */
  error?: string | null;
}

export function NoWorkspaceScreen({
  userId,
  email,
  isSuperAdmin,
  start,
  error,
}: Readonly<NoWorkspaceScreenProps>) {
  return (
    <>
      <BrandHeader
        rightSlot={
          <>
            <span className="muted">{email}</span>
            <form action={signOutAction}>
              <button type="submit" className="ghost-btn">
                Sign out
              </button>
            </form>
          </>
        }
      />
      <main className="dashboard-wrap">
        <header className="page-intro">
          <p className="page-eyebrow">Get started</p>
          <h1 className="page-title">You&apos;re not in a workspace yet</h1>
          <p className="page-lede">
            Products, discovery, review and outreach all live inside a
            workspace. Create your own, or ask an admin to add you to your
            team&apos;s.
          </p>
        </header>

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        <section className="profile-cards" aria-label="Ways to get a workspace">
          <article className="profile-card">
            <span className="profile-card-eyebrow">Start fresh</span>
            <h2 className="profile-card-title">Create your workspace</h2>
            {start.canCreate ? (
              <>
                <p className="profile-card-meta">
                  You&apos;ll be its owner and can invite teammates later. A
                  short setup guide follows.
                </p>
                <form action={createFirstWorkspaceAction} className="inline-form">
                  <label>
                    <span>Workspace name</span>
                    <input
                      type="text"
                      name="name"
                      required
                      maxLength={WORKSPACE_NAME_MAX}
                      placeholder="Your company or team"
                      autoComplete="organization"
                    />
                  </label>
                  <button type="submit" className="primary-btn">
                    Create workspace
                  </button>
                </form>
              </>
            ) : (
              <p className="profile-card-meta">{blockedCopy(start)}</p>
            )}
          </article>

          <article className="profile-card">
            <span className="profile-card-eyebrow">Join your team</span>
            <h2 className="profile-card-title">Ask your admin to invite you</h2>
            <p className="profile-card-meta">
              If your team already uses {BRAND_NAME}, ask one of its admins to
              add you under Settings › Members. They will need your account
              ID:
            </p>
            <p className="profile-card-meta">
              <code>{userId}</code>
            </p>
            <p className="profile-card-meta">
              You are signed in as {email}. Once they have added you,{' '}
              <Link href="/today">reload this page</Link>.
            </p>
          </article>
        </section>

        {isSuperAdmin ? (
          <p className="muted">
            As a platform admin you can still use the{' '}
            <Link href="/admin">platform console</Link> without a workspace.
          </p>
        ) : null}
      </main>
    </>
  );
}

function blockedCopy(start: WorkspaceStartState): string {
  if (start.archivedWorkspaces.length > 0) {
    const names = start.archivedWorkspaces.join(', ');
    const one = start.archivedWorkspaces.length === 1;
    const subject = one
      ? `Your workspace ${names} is archived.`
      : `Your workspaces ${names} are archived.`;
    return `${subject} Ask a platform admin to restore ${one ? 'it' : 'them'}, or ask a team admin to add you to theirs.`;
  }
  if (start.blockedBy === 'owned_workspace') {
    return 'You have already created a workspace, but you are no longer a member of it. Ask a platform admin to restore your access.';
  }
  return 'You already belong to a workspace. Reload this page to open it.';
}
