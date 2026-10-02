import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { AutoRefresh } from '@/components/AutoRefresh';
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
  getRun,
  listRunLogs,
  listSourceRecords,
} from '@/lib/services/connector-run';
import type { ConnectorRunStatus } from '@/lib/db/schema/connectors';
import { formatUtc } from '@/lib/format-utc';
import { cancelRunAction } from './actions';

/** PC-10: the badge per run status ('partial' = some steps failed). */
function statusBadgeClass(status: ConnectorRunStatus): string {
  switch (status) {
    case 'succeeded':
      return 'badge badge-good';
    case 'partial':
      return 'badge badge-warn';
    case 'failed':
    case 'cancelled':
      return 'badge badge-bad';
    default:
      return 'badge';
  }
}

export default async function RunDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; runId: string }>;
  searchParams?: Promise<{ message?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = (await searchParams) ?? {};
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

  // PC-10 (I074): while the run is in flight the page refreshes itself
  // and offers Cancel (any write role; it works from any worker process).
  const inFlight = run.status === 'pending' || run.status === 'running';
  const canCancel = inFlight && canWrite(ctx) && run.cancelRequestedAt === null;

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/connectors">Connectors</Link> /{' '}
          <Link href={`/connectors/${connectorId}`}>{connector.name}</Link> / Run #{run.id.toString()}
        </p>
        <h1>Run #{run.id.toString()}</h1>
        {sp.message ? <p className="form-message">{sp.message}</p> : null}
        {sp.error ? <p className="form-error">{sp.error}</p> : null}
        <p>
          <span className={statusBadgeClass(run.status)}>
            {run.status === 'partial' ? 'partial — some steps failed' : run.status}
          </span>
        </p>
        {inFlight ? (
          <>
            <AutoRefresh />
            <p className="muted small">
              {run.cancelRequestedAt
                ? `Cancel requested ${formatUtc(run.cancelRequestedAt)}; the run stops after its current step.`
                : 'This page refreshes every few seconds while the run is in progress.'}
            </p>
          </>
        ) : null}
        {canCancel ? (
          <form action={cancelRunAction}>
            <input type="hidden" name="connectorId" value={connectorId.toString()} />
            <input type="hidden" name="runId" value={run.id.toString()} />
            <button type="submit" className="ghost-btn">
              Cancel run
            </button>
          </form>
        ) : null}

        <section>
          <h2>Summary</h2>
          <dl>
            <dt>Started</dt>
            <dd>{run.startedAt ? run.startedAt.toLocaleString() : '—'}</dd>
            <dt>Completed</dt>
            <dd>{run.completedAt ? run.completedAt.toLocaleString() : '—'}</dd>
            {inFlight && run.lastProgressAt ? (
              <>
                <dt>Last progress</dt>
                <dd>{formatUtc(run.lastProgressAt)}</dd>
              </>
            ) : null}
            <dt>Records</dt>
            <dd>{run.recordCount}</dd>
            <dt>Recipe ID</dt>
            <dd>{run.recipeId ? <code>{run.recipeId.toString()}</code> : '—'}</dd>
            {run.errorPayload ? (
              <>
                <dt>{run.status === 'partial' ? 'Problems' : 'Error'}</dt>
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
