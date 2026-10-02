// /health (Workspace › Settings › Health checks; the navigation registry's
// settings.health). AP-06: three parts, all from the one diagnostics engine.
//
//   Right now      the live findings (fresh on every visit) and the score
//                  without the AI review; problems first, context after.
//   Scheduled      the weekly report: on/off and its interval (owners and
//   check          admins, I069 — off means its AI review spends nothing),
//                  Run now, and when it runs next. The free 6-hourly sweep
//                  that notifies about new problems runs either way.
//   Reports        the saved reports: findings, the AI conversation review,
//                  advice, and the history.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Activity, Play } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { FindingList } from '@/components/FindingList';
import { ScoreChip } from '@/components/Badge';
import { TableScroll } from '@/components/TableScroll';
import { Field, Select, Switch } from '@/components/ui';
import { getWorkspaceDiagnostics } from '@/lib/diagnostics/engine';
import { isProblem } from '@/lib/diagnostics/types';
import { formatUtc } from '@/lib/format-utc';
import { isNextRedirectError } from '@/lib/server-redirect';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace } from '@/lib/services/context';
import {
  HEALTH_CHECK_INTERVAL_CHOICES,
  getHealthCheckSettings,
  listHealthReports,
  readStoredFindings,
  type ThreadReview,
} from '@/lib/services/health-check';
import { healthScoreTone } from '@/lib/ui/tone';
import { runHealthCheckNowAction, saveHealthCheckSettingsAction } from './actions';
import styles from './health.module.css';
import { NoWorkspaceState } from '@/components/NoWorkspaceState';

export default async function HealthPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; err?: string }>;
}) {
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) return <NoWorkspaceState />;
    throw err;
  }

  const [diagnostics, settings, reports] = await Promise.all([
    getWorkspaceDiagnostics(ctx, { fresh: true }),
    getHealthCheckSettings(ctx),
    listHealthReports(ctx, { limit: 10 }),
  ]);
  const latest = reports[0] ?? null;
  const latestFindings = latest ? readStoredFindings(latest.findings) : [];
  const isAdmin = canAdminWorkspace(ctx);
  const problems = diagnostics.findings.filter(isProblem);
  const context = diagnostics.findings.filter((f) => !isProblem(f));
  const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

  return (
    <>
      <div className="dashboard-wrap">
        <header className="page-intro">
          <p className="page-eyebrow">Workspace</p>
          <h1 className="page-title">
            <Activity className="lucide" aria-hidden="true" /> Health checks
          </h1>
          <p className="page-lede">
            Live checks of this workspace: what is broken, what is stopped and why, each
            with the page that fixes it. Every 6 hours a free sweep (no AI, no tokens)
            notifies owners and admins when a new problem appears. The scheduled report
            adds an AI review of recent conversations.
          </p>
        </header>

        {sp.msg ? <p className="form-info">{sp.msg.slice(0, 300)}</p> : null}
        {sp.err ? <p className="form-error">{sp.err.slice(0, 300)}</p> : null}

        <section className={styles.section} aria-labelledby="health-now">
          <div className={styles.heading}>
            <h2 id="health-now">Right now</h2>
            <ScoreChip
              value={diagnostics.score}
              max={100}
              label="Score"
              tone={healthScoreTone(diagnostics.score)}
            />
            <span className="muted small">Checked {formatUtc(diagnostics.evaluatedAt)}</span>
          </div>
          {diagnostics.partial ? (
            <Alert tone="warning" title="Some checks could not run">
              {diagnostics.failedRules.join(', ')} failed this time; the list below is missing
              whatever they would report.
            </Alert>
          ) : null}
          {problems.length > 0 ? (
            <FindingList findings={problems} label="Problems" />
          ) : (
            <p className="muted">No problems found: every check passes.</p>
          )}
          {context.length > 0 ? (
            <>
              <h3>For context</h3>
              <FindingList findings={context} label="Context" />
            </>
          ) : null}
        </section>

        <section className={styles.section} aria-labelledby="health-schedule">
          <h2 id="health-schedule">Scheduled check</h2>
          <p className="muted">
            {settings.enabled
              ? `On: every ${days(settings.intervalDays)}, ${
                  settings.lastAt && settings.nextDueAt
                    ? `next from ${formatUtc(settings.nextDueAt)}`
                    : 'the first one within 6 hours'
                }. It saves a report and has AI read up to 3 recent conversations (uses tokens).`
              : 'Off: no scheduled report and no AI review, so it spends no tokens. The 6-hourly problem sweep still runs.'}
            {settings.lastAt ? ` Last run ${formatUtc(settings.lastAt)}.` : ''}
          </p>
          {isAdmin ? (
            <div className={styles.controls}>
              <form action={saveHealthCheckSettingsAction} className={styles.settings}>
                <Switch
                  name="enabled"
                  label="Scheduled check with AI review"
                  description="Off stops its AI spend. Run check now still works."
                  position="end"
                  defaultChecked={settings.enabled}
                />
                <Field label="Every" width="auto" layout="inline">
                  <Select name="intervalDays" defaultValue={String(settings.intervalDays)}>
                    {HEALTH_CHECK_INTERVAL_CHOICES.map((d) => (
                      <option key={d} value={d}>
                        {days(d)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <button type="submit" className="primary-btn">
                  Save
                </button>
              </form>
              <form action={runHealthCheckNowAction}>
                <button type="submit" className="ghost-btn">
                  <Play className="lucide" aria-hidden="true" /> Run check now
                </button>
              </form>
            </div>
          ) : (
            <p className="muted small">Owners and admins change the schedule and run a check now.</p>
          )}
        </section>

        <section className={styles.section} aria-labelledby="health-reports">
          <h2 id="health-reports">Reports</h2>
          {!latest ? (
            <p className="muted">
              No saved report yet: the first scheduled check will appear here
              {isAdmin ? ', or run one now' : ''}.
            </p>
          ) : (
            <>
              <div className={styles.heading}>
                <h3>Latest report</h3>
                <ScoreChip
                  value={latest.score}
                  max={100}
                  label="Score"
                  tone={healthScoreTone(latest.score)}
                />
                <span className="muted small">{formatUtc(latest.createdAt)}</span>
              </div>
              {latestFindings.length > 0 ? (
                <FindingList
                  findings={latestFindings}
                  label="Findings of the latest report"
                  compact
                />
              ) : (
                <p className="muted">No configuration or operations problems found.</p>
              )}

              {(latest.commReview as ThreadReview[]).length > 0 ? (
                <>
                  <h3>Conversation review</h3>
                  <ul className="profile-list">
                    {(latest.commReview as ThreadReview[]).map((r) => (
                      <li key={r.threadId}>
                        <div className="lead-row">
                          <Link href={`/communication/${r.threadId}`}>{r.subject}</Link>{' '}
                          <ScoreChip
                            value={r.naturalness}
                            max={100}
                            label="Naturalness"
                            tone={healthScoreTone(r.naturalness)}
                          />
                        </div>
                        {r.issues.length > 0 ? (
                          <ul className={styles.issues}>
                            {r.issues.map((iss, i) => (
                              <li key={i} className="muted">
                                {iss}
                              </li>
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
            </>
          )}

          {reports.length > 1 ? (
            <>
              <h3>History</h3>
              <TableScroll label="Health report history">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Score</th>
                      <th>Problems</th>
                      <th>Conversation issues</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reports.slice(1).map((r) => (
                      <tr key={r.id.toString()}>
                        <td>{formatUtc(r.createdAt)}</td>
                        <td>
                          <ScoreChip value={r.score} tone={healthScoreTone(r.score)} />
                        </td>
                        <td>{readStoredFindings(r.findings).filter(isProblem).length}</td>
                        <td>
                          {(r.commReview as ThreadReview[]).reduce((a, t) => a + t.issues.length, 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </>
          ) : null}
        </section>
      </div>
    </>
  );
}
