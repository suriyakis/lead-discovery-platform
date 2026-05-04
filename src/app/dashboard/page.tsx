import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db/client';
import { workspaceMembers, workspaces } from '@/lib/db/schema/workspaces';

export default async function Dashboard() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/');
  }
  // Phase 15: bounce non-active users to the pending wall.
  if (
    session.user.accountStatus !== 'active' &&
    session.user.role !== 'super_admin'
  ) {
    redirect('/pending');
  }

  const userId = session.user.id;

  const memberships = await db
    .select({
      workspace: workspaces,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId));

  const primary = memberships[0];

  return (
    <AppShell>
      <h1>Dashboard</h1>

        <section>
          <h2>You</h2>
          <dl>
            <dt>Name</dt>
            <dd>{session.user.name ?? '—'}</dd>
            <dt>Email</dt>
            <dd>{session.user.email}</dd>
            <dt>Platform role</dt>
            <dd>
              <code>{session.user.role}</code>
            </dd>
          </dl>
        </section>

        <section>
          <h2>Workspace</h2>
          {primary ? (
            <dl>
              <dt>Name</dt>
              <dd>{primary.workspace.name}</dd>
              <dt>Slug</dt>
              <dd>
                <code>{primary.workspace.slug}</code>
              </dd>
              <dt>Your role here</dt>
              <dd>
                <code>{primary.role}</code>
              </dd>
              <dt>All workspaces you belong to</dt>
              <dd>{memberships.length}</dd>
            </dl>
          ) : (
            <p>
              You don&apos;t belong to any workspace yet. If you expect to be the platform owner,
              check that your email matches <code>OWNER_EMAIL</code> in the server config.
            </p>
          )}
        </section>

        {primary ? (
          <section>
            <h2>Modules</h2>
            <ul className="module-list">
              <li>
                <Link href="/products">Product Profiles →</Link>
                <span className="muted">Define what you sell. Drives discovery and outreach.</span>
              </li>
              <li>
                <Link href="/review">Review queue →</Link>
                <span className="muted">Approve, reject, comment on harvested records.</span>
              </li>
              <li>
                <Link href="/leads">Leads →</Link>
                <span className="muted">Records the classification engine ranked as relevant.</span>
              </li>
              <li>
                <Link href="/pipeline">Pipeline →</Link>
                <span className="muted">Commercial pipeline: relevant → contacted → replied → qualified → closed.</span>
              </li>
              <li>
                <Link href="/drafts">Outreach drafts →</Link>
                <span className="muted">Generated drafts awaiting human review and approval.</span>
              </li>
              <li>
                <Link href="/documents">Documents →</Link>
                <span className="muted">Uploaded files: pricing, specs, case studies.</span>
              </li>
              <li>
                <Link href="/knowledge">Knowledge sources →</Link>
                <span className="muted">Documents, URLs, and text excerpts attached to products.</span>
              </li>
              <li>
                <Link href="/mailbox">Mailbox →</Link>
                <span className="muted">SMTP/IMAP accounts, threads, signatures, suppression.</span>
              </li>
              <li>
                <Link href="/learning">Learning memory →</Link>
                <span className="muted">Lessons distilled from review feedback.</span>
              </li>
              <li>
                <Link href="/connectors">Connectors →</Link>
                <span className="muted">Discovery sources, recipes, runs.</span>
              </li>
              <li>
                <Link href="/settings/integrations">Settings →</Link>
                <span className="muted">Integration keys, BYOK, workspace config.</span>
              </li>
              {session.user.role === 'super_admin' ? (
                <li>
                  <Link href="/admin">Admin (god mode) →</Link>
                  <span className="muted">Platform-wide views, impersonation, feature flags.</span>
                </li>
              ) : null}
            </ul>
          </section>
        ) : null}
    </AppShell>
  );
}
