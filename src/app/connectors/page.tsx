import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq, desc } from 'drizzle-orm';
import { BrandHeader } from '@/components/BrandHeader';
import { auth, signOut } from '@/lib/auth';
import { db } from '@/lib/db/client';
import { connectorRuns } from '@/lib/db/schema/connectors';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace } from '@/lib/services/context';
import { listConnectors } from '@/lib/services/connector-run';

export default async function ConnectorsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  let ctx;
  let connectors;
  const lastRunByConnector = new Map<string, { status: string; createdAt: Date }>();
  try {
    ctx = await getWorkspaceContext();
    connectors = await listConnectors(ctx);
    if (connectors.length > 0) {
      const allRuns = await db
        .select({
          connectorId: connectorRuns.connectorId,
          status: connectorRuns.status,
          createdAt: connectorRuns.createdAt,
        })
        .from(connectorRuns)
        .where(eq(connectorRuns.workspaceId, ctx.workspaceId))
        .orderBy(desc(connectorRuns.createdAt));
      for (const r of allRuns) {
        const key = r.connectorId.toString();
        if (!lastRunByConnector.has(key)) {
          lastRunByConnector.set(key, { status: r.status, createdAt: r.createdAt });
        }
      }
    }
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <>
          <BrandHeader />
          <main>
            <h1>Connectors</h1>
            <section>
              <p>You don&apos;t belong to a workspace yet.</p>
            </section>
          </main>
        </>
      );
    }
    throw err;
  }

  const isAdmin = canAdminWorkspace(ctx);

  return (
    <>
      <BrandHeader
        rightSlot={
          <>
            <span className="who">{session.user.email}</span>
            <form
              action={async () => {
                'use server';
                await signOut({ redirectTo: '/' });
              }}
            >
              <button type="submit" className="ghost-btn">
                Sign out
              </button>
            </form>
          </>
        }
      />
      <main>
        <div className="page-header">
          <div>
            <p className="muted">
              <Link href="/dashboard">Dashboard</Link> / Connectors
            </p>
            <h1>Connectors</h1>
            <p className="muted">
              Configure discovery sources. Each connector is an instance of a template
              (internet_search, mock, …). Recipes hold the per-search settings.
            </p>
          </div>
          {isAdmin ? (
            <Link href="/connectors/new" className="primary-btn">
              + New connector
            </Link>
          ) : null}
        </div>

        <section>
          {connectors.length === 0 ? (
            <p className="muted">
              No connectors yet.{' '}
              {isAdmin ? (
                <Link href="/connectors/new">Create one</Link>
              ) : (
                <>An admin needs to create the first connector.</>
              )}
            </p>
          ) : (
            <ul className="profile-list">
              {connectors.map((c) => {
                const last = lastRunByConnector.get(c.id.toString());
                return (
                  <li key={c.id.toString()} className={c.active ? '' : 'archived'}>
                    <Link href={`/connectors/${c.id}`}>{c.name}</Link>
                    <div className="meta">
                      <span>template: {c.templateType}</span>
                      <span>{c.active ? 'active' : 'inactive'}</span>
                      {last ? (
                        <span>
                          last run: {last.status} · {last.createdAt.toLocaleString()}
                        </span>
                      ) : (
                        <span>never run</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
