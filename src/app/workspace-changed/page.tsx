// /workspace-changed (MOB-06): where a guarded form action lands when it
// was refused because this browser's session moved to another workspace
// after the page rendered (a switch in another tab). Nothing was written.
// It names both workspaces and offers the two ways on: switch back (a /go
// link, which returns to the page the form was on) or carry on in the
// workspace the session is in now.
//
//   ?ws=<id>  the workspace the refused page was rendered for (named only
//             when the user is a member of it)
//   ?to=<path> the page the form was posted from (a safe in-app path)

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import { HOME_PATH } from '@/lib/nav/registry';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { listMyWorkspaces } from '@/lib/services/workspace';
import { goHref, parseWorkspaceIdParam, safeInAppPath } from '@/lib/workspace-guard/shared';

export default async function WorkspaceChangedPage({
  searchParams,
}: {
  searchParams: Promise<{ ws?: string; to?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) redirect(HOME_PATH);
    throw err;
  }
  const sp = await searchParams;
  const expectedId = parseWorkspaceIdParam(sp.ws);
  const returnTo = safeInAppPath(sp.to);

  const rows = await listMyWorkspaces(ctx.userId, {
    includeAllForSuperAdmin: ctx.role === 'super_admin',
    activeWorkspaceId: ctx.workspaceId,
  });
  const activeName =
    rows.find((r) => r.workspace.id === ctx.workspaceId)?.workspace.name ?? 'another workspace';
  // Only a workspace the user is a member of is named or offered: /go
  // switches into memberships only.
  const expected =
    expectedId !== null
      ? rows.find((r) => r.workspace.id === expectedId && !r.isGodMode)
      : undefined;
  const sameAgain = expectedId !== null && expectedId === ctx.workspaceId;
  const switchBack =
    expected && !sameAgain ? goHref(expected.workspace.id, returnTo ?? HOME_PATH) : null;

  // Whole sentences as single strings, so a name never splits into
  // separate text nodes.
  const active = `“${activeName}”`;
  let lede: string;
  if (sameAgain) {
    lede = `This browser is back in ${active}. Reload the page you came from before you try again.`;
  } else if (expected) {
    lede = `That page was opened in “${expected.workspace.name}”, but this browser has since switched to ${active} in another tab. So that nothing lands in the wrong workspace, the action was stopped before it did anything.`;
  } else {
    lede = `That page belongs to another workspace than the one this browser is in now (${active}), or it was opened before an update. The action was stopped before it did anything — reload the page and try again.`;
  }

  return (
    <AppShell>
      <div className="status-card">
        <p className="status-eyebrow">Nothing was changed</p>
        <h1>This browser switched workspace</h1>
        <p className="status-lede">{lede}</p>
        <div className="status-actions">
          {switchBack && expected ? (
            // A plain link: /go switches the session, so it must never be prefetched.
            <a href={switchBack} className="primary-btn">
              {`Switch back to “${expected.workspace.name}”`}
            </a>
          ) : null}
          {sameAgain && returnTo ? (
            <Link href={returnTo} className="primary-btn">
              Reload the page
            </Link>
          ) : null}
          <Link
            href={HOME_PATH}
            className={switchBack || (sameAgain && returnTo) ? 'ghost-btn' : 'primary-btn'}
          >
            {`Continue in ${active}`}
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
