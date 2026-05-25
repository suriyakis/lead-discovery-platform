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
  deleteConnectorRuns,
  getConnectorRow,
  listRecipes,
  listRuns,
} from '@/lib/services/connector-run';
import {
  ConnectorRunsList,
  type RunRow,
} from '@/components/ConnectorRunsList';
import { isNextRedirectError } from '@/lib/server-redirect';

export default async function ConnectorDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ message?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { id: idStr } = await params;
  if (!/^\d+$/.test(idStr)) redirect('/connectors');
  const id = BigInt(idStr);
  const sp = await searchParams;

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
    if (err instanceof ConnectorServiceError && err.code === 'not_found')
      redirect('/connectors');
    throw err;
  }

  const canRun = canWrite(ctx);

  async function deleteRunsAction(formData: FormData): Promise<void> {
    'use server';
    const c = await getWorkspaceContext();
    const ids: bigint[] = [];
    for (const raw of formData.getAll('ids')) {
      const s = String(raw);
      if (!/^\d+$/.test(s)) continue;
      try {
        ids.push(BigInt(s));
      } catch {
        // skip
      }
    }
    if (ids.length === 0) {
      redirect(`/connectors/${id}?error=Nothing+selected`);
    }
    try {
      const r = await deleteConnectorRuns(c, ids);
      redirect(
        `/connectors/${id}?message=${encodeURIComponent(
          `${r.affected} run${r.affected === 1 ? '' : 's'} deleted.`,
        )}`,
      );
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      redirect(
        `/connectors/${id}?error=${encodeURIComponent(
          err instanceof Error ? err.message : 'delete failed',
        )}`,
      );
    }
  }

  const runRows: RunRow[] = runs.slice(0, 100).map((r) => ({
    id: r.id.toString(),
    status: r.status,
    recordCount: r.recordCount,
    createdAtIso: r.createdAt.toISOString(),
  }));

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

      {sp.message ? <p className="mail-flash info">{sp.message}</p> : null}
      {sp.error ? <p className="mail-flash error">{sp.error}</p> : null}

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
            <code>searchQueries</code> for internet_search, <code>seed/count</code>{' '}
            for mock.
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

      <ConnectorRunsList
        connectorId={id.toString()}
        rows={runRows}
        canEdit={canRun}
        onDelete={deleteRunsAction}
      />
    </AppShell>
  );
}
