import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import {
  ConnectorServiceError,
  getConnectorRow,
  getRun,
  listRunLogs,
  listSourceRecords,
} from '@/lib/services/connector-run';

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { id: idStr, runId: runIdStr } = await params;
  if (!/^\d+$/.test(idStr) || !/^\d+$/.test(runIdStr)) redirect('/connectors');
  const connectorId = BigInt(idStr);
  const runId = BigInt(runIdStr);

  let ctx;
  let connector;
  let run;
  let logs;
  let records;
  try {
    ctx = await getWorkspaceContext();
    connector = await getConnectorRow(ctx, connectorId);
    run = await getRun(ctx, runId);
    if (run.connectorId !== connector.id) redirect(`/connectors/${connectorId}`);
    logs = await listRunLogs(ctx, runId);
    records = await listSourceRecords(ctx, runId);
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/connectors');
    if (err instanceof ConnectorServiceError && err.code === 'not_found')
      redirect(`/connectors/${connectorId}`);
    throw err;
  }

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/connectors">Connectors</Link> /{' '}
          <Link href={`/connectors/${connectorId}`}>{connector.name}</Link> / Run #{run.id.toString()}
        </p>
        <h1>Run #{run.id.toString()}</h1>
        <p>
          <span
            className={
              run.status === 'succeeded'
                ? 'badge badge-good'
                : run.status === 'failed' || run.status === 'cancelled'
                  ? 'badge badge-bad'
                  : 'badge'
            }
          >
            {run.status}
          </span>
        </p>

        <section>
          <h2>Summary</h2>
          <dl>
            <dt>Started</dt>
            <dd>{run.startedAt ? run.startedAt.toLocaleString() : '—'}</dd>
            <dt>Completed</dt>
            <dd>{run.completedAt ? run.completedAt.toLocaleString() : '—'}</dd>
            <dt>Records</dt>
            <dd>{run.recordCount}</dd>
            <dt>Recipe ID</dt>
            <dd>{run.recipeId ? <code>{run.recipeId.toString()}</code> : '—'}</dd>
            {run.errorPayload ? (
              <>
                <dt>Error</dt>
                <dd>
                  <code>
                    {(run.errorPayload as { message?: string }).message ?? 'unknown error'}
                  </code>
                </dd>
              </>
            ) : null}
          </dl>
        </section>

        <section>
          <h2>Logs ({logs.length})</h2>
          {logs.length === 0 ? (
            <p className="muted">No logs.</p>
          ) : (
            <ul className="log-list">
              {logs.map((l) => (
                <li key={l.id.toString()} className={`log-${l.level}`}>
                  <span className="log-time">{l.createdAt.toLocaleTimeString()}</span>
                  <span className="log-level">{l.level}</span>
                  <span className="log-msg">{l.message}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2>Records produced ({records.length})</h2>
          {records.length === 0 ? (
            <p className="muted">No records.</p>
          ) : (
            <ul className="profile-list">
              {records.slice(0, 100).map((r) => {
                const norm = r.normalizedData as Record<string, unknown>;
                const title = (norm.title as string | undefined) ?? r.sourceUrl ?? 'record';
                const snippet = norm.snippet as string | undefined;
                return (
                  <li key={r.id.toString()}>
                    <Link href={`/review`}>{title}</Link>
                    {snippet ? <p className="muted">{snippet}</p> : null}
                    <div className="meta">
                      <span>{(norm.domain as string) ?? '—'}</span>
                      <span>conf {r.confidence}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {records.length > 0 ? (
            <p className="muted">
              Records flow into the <Link href="/review">review queue</Link>.
            </p>
          ) : null}
        </section>
      </AppShell>
  );
}
