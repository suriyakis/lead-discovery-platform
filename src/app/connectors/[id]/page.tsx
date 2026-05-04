import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canWrite } from '@/lib/services/context';
import {
  ConnectorServiceError,
  getConnectorRow,
  listRecipes,
  listRuns,
} from '@/lib/services/connector-run';

export default async function ConnectorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { id: idStr } = await params;
  if (!/^\d+$/.test(idStr)) redirect('/connectors');
  const id = BigInt(idStr);

  let ctx;
  let connector;
  let recipes;
  let runs;
  try {
    ctx = await getWorkspaceContext();
    connector = await getConnectorRow(ctx, id);
    recipes = await listRecipes(ctx, id);
    runs = (await listRuns(ctx)).filter((r) => r.connectorId === id);
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/connectors');
    if (err instanceof ConnectorServiceError && err.code === 'not_found') redirect('/connectors');
    throw err;
  }

  const canRun = canWrite(ctx);

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/connectors">Connectors</Link> / {connector.name}
        </p>
        <h1>{connector.name}</h1>
        <p>
          <span className="badge">{connector.templateType}</span>{' '}
          <span className={connector.active ? 'badge badge-good' : 'badge badge-bad'}>
            {connector.active ? 'active' : 'inactive'}
          </span>
        </p>

        <section>
          <div className="page-header">
            <h2>Recipes ({recipes.length})</h2>
            {canRun ? (
              <Link href={`/connectors/${id}/recipes/new`} className="primary-btn">
                + New recipe
              </Link>
            ) : null}
          </div>
          {recipes.length === 0 ? (
            <p className="muted">
              No recipes yet. Recipes hold the per-search configuration —{' '}
              <code>searchQueries</code> for internet_search, <code>seed/count</code> for mock.
            </p>
          ) : (
            <ul className="profile-list">
              {recipes.map((r) => (
                <li key={r.id.toString()} className={r.active ? '' : 'archived'}>
                  <Link href={`/connectors/${id}/recipes/${r.id}`}>{r.name}</Link>
                  <div className="meta">
                    <span>{r.searchQueries.length} query(s)</span>
                    <span>updated {r.updatedAt.toLocaleString()}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2>Recent runs ({runs.length})</h2>
          {runs.length === 0 ? (
            <p className="muted">No runs yet.</p>
          ) : (
            <ul className="profile-list">
              {runs.slice(0, 20).map((r) => (
                <li key={r.id.toString()}>
                  <Link href={`/connectors/${id}/runs/${r.id}`}>
                    Run #{r.id.toString()}
                  </Link>
                  <div className="meta">
                    <span>state: {r.status}</span>
                    <span>{r.recordCount} record(s)</span>
                    <span>{r.createdAt.toLocaleString()}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </AppShell>
  );
}
