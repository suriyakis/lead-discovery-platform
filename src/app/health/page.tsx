import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Activity, Play } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import {
  HealthCheckError,
  listHealthReports,
  runHealthCheckNow,
  type HealthFinding,
  type ThreadReview,
} from '@/lib/services/health-check';
import { canAdminWorkspace } from '@/lib/services/context';
import { isNextRedirectError } from '@/lib/server-redirect';

function scoreBadge(score: number): string {
  if (score >= 80) return 'badge badge-good';
  if (score >= 50) return 'badge badge-warn';
  return 'badge badge-bad';
}

export default async function HealthPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; err?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) redirect('/');
    throw err;
  }

  const reports = await listHealthReports(ctx, { limit: 10 });
  const latest = reports[0] ?? null;
  const isAdmin = canAdminWorkspace(ctx);

  async function runNow() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      await runHealthCheckNow(c);
      redirect('/health?msg=Health+check+completed');
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof HealthCheckError ? err.message : err instanceof Error ? err.message : 'failed';
      redirect(`/health?err=${encodeURIComponent(m)}`);
    }
  }

  return (
    <AppShell>
      <div className="dashboard-wrap">
        <header className="page-intro">
          <p className="page-eyebrow">Workspace</p>
          <h1 className="page-title">
            <Activity className="lucide" aria-hidden="true" /> Health
          </h1>
          <p className="page-lede">
            A scheduled AI review of this workspace: configuration and
            operations problems, plus a read of your recent conversations —
            flow, repetition, tone — with advice on getting more out of the
            system. Runs weekly by default; warnings land in your
            notifications.
          </p>
        </header>

        {sp.msg ? <p className="form-info">{sp.msg}</p> : null}
        {sp.err ? <p className="form-error">{sp.err}</p> : null}

        {isAdmin ? (
          <form action={runNow} className="action-row" style={{ marginBottom: '1.25rem' }}>
            <button type="submit" className="primary-btn">
              <Play className="lucide" aria-hidden="true" /> Run check now
            </button>
            <span className="muted small" style={{ alignSelf: 'center' }}>
              Reads up to 3 recent conversations (uses tokens) + audits configuration.
            </span>
          </form>
        ) : null}

        {!latest ? (
          <p className="muted">
            No health reports yet — the first scheduled check will appear here,
            or run one now.
          </p>
        ) : (
          <section>
            <h2>
              Latest report{' '}
              <span className={scoreBadge(latest.score)}>score {latest.score}/100</span>{' '}
              <span className="muted" style={{ fontWeight: 'normal', fontSize: '0.85rem' }}>
                {latest.createdAt.toLocaleString()}
              </span>
            </h2>

            {(latest.findings as HealthFinding[]).length > 0 ? (
              <>
                <h3>Findings</h3>
                <ul className="profile-list">
                  {(latest.findings as HealthFinding[]).map((f, i) => (
                    <li key={i}>
                      <span className={f.severity === 'warning' ? 'badge badge-bad' : 'badge'}>
                        {f.severity}
                      </span>{' '}
                      {f.message}{' '}
                      {f.href ? <Link href={f.href}>fix →</Link> : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="muted">No configuration or operations problems found. ✓</p>
            )}

            {(latest.commReview as ThreadReview[]).length > 0 ? (
              <>
                <h3>Conversation review</h3>
                <ul className="profile-list">
                  {(latest.commReview as ThreadReview[]).map((r) => (
                    <li key={r.threadId}>
                      <div className="lead-row">
                        <Link href={`/communication/${r.threadId}`}>{r.subject}</Link>{' '}
                        <span className={scoreBadge(r.naturalness)}>
                          naturalness {r.naturalness}/100
                        </span>
                      </div>
                      {r.issues.length > 0 ? (
                        <ul style={{ margin: '0.25rem 0 0 1rem' }}>
                          {r.issues.map((iss, i) => (
                            <li key={i} className="muted">⚠ {iss}</li>
                          ))}
                        </ul>
                      ) : (
                        <span className="muted">Reads naturally — no issues.</span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {(latest.advice as string[]).length > 0 ? (
              <>
                <h3>Advice</h3>
                <ol>
                  {(latest.advice as string[]).map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ol>
              </>
            ) : null}
          </section>
        )}

        {reports.length > 1 ? (
          <section>
            <h2>History</h2>
            <table className="data-table">
              <thead>
                <tr><th>When</th><th>Score</th><th>Warnings</th><th>Conversation issues</th></tr>
              </thead>
              <tbody>
                {reports.slice(1).map((r) => (
                  <tr key={r.id.toString()}>
                    <td>{r.createdAt.toLocaleString()}</td>
                    <td><span className={scoreBadge(r.score)}>{r.score}</span></td>
                    <td>
                      {(r.findings as HealthFinding[]).filter((f) => f.severity === 'warning').length}
                    </td>
                    <td>
                      {(r.commReview as ThreadReview[]).reduce((a, t) => a + t.issues.length, 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}
