import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { auth, signOut } from '@/lib/auth';
import { db } from '@/lib/db/client';
import { workspaceMembers, workspaces } from '@/lib/db/schema/workspaces';

export default async function Dashboard() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/');
  }

  const userId = session.user.id;

  // Find workspaces the user is a member of (Phase 1 dashboard shows the
  // first one — workspace switching arrives in a later phase).
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
    <main>
      <header>
        <h1>Dashboard</h1>
        <form
          action={async () => {
            'use server';
            await signOut({ redirectTo: '/' });
          }}
        >
          <button type="submit">Sign out</button>
        </form>
      </header>

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
    </main>
  );
}
