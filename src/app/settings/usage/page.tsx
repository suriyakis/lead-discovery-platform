import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { SettingsNav } from '@/components/SettingsNav';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { summarizeUsage, summarizeUsageByKeySource } from '@/lib/services/usage';

const RANGES = [
  { key: 'today' as const, label: 'Today', ms: 24 * 60 * 60 * 1000 },
  { key: '7d' as const, label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '30d' as const, label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
  { key: 'all' as const, label: 'All time', ms: Infinity },
];

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;
  const rangeKey = (RANGES.find((r) => r.key === sp.range)?.key ?? '30d') as (typeof RANGES)[number]['key'];
  const rangeDef = RANGES.find((r) => r.key === rangeKey)!;
  const since = Number.isFinite(rangeDef.ms)
    ? new Date(Date.now() - rangeDef.ms)
    : undefined;

  let totals;
  let byKey;
  try {
    const ctx = await getWorkspaceContext();
    totals = await summarizeUsage(ctx, since ? { since } : {});
    byKey = await summarizeUsageByKeySource(ctx, since ? { since } : {});
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <AppShell>
            <h1>Usage</h1>
            <section>
              <p>You don&apos;t belong to a workspace yet.</p>
            </section>
          </AppShell>
      );
    }
    throw err;
  }

  const totalCents = totals.reduce((acc, r) => acc + r.totalCostCents, 0);
  const totalEvents = totals.reduce((acc, r) => acc + r.eventCount, 0);

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> / Settings
        </p>
        <h1>Settings</h1>
        <SettingsNav />

        <div className="state-tabs">
          {RANGES.map((r) => (
            <Link
              key={r.key}
              href={r.key === '30d' ? '/settings/usage' : `/settings/usage?range=${r.key}`}
              className={r.key === rangeKey ? 'tab active' : 'tab'}
            >
              {r.label}
            </Link>
          ))}
        </div>

        <section>
          <h2>Totals</h2>
          {totalEvents === 0 ? (
            <p className="muted">No usage in this range.</p>
          ) : (
            <dl>
              <dt>Estimated cost</dt>
              <dd>${(totalCents / 100).toFixed(2)}</dd>
              <dt>Total events</dt>
              <dd>{totalEvents.toLocaleString()}</dd>
            </dl>
          )}
        </section>

        {totals.length > 0 ? (
          <section>
            <h2>By kind / provider</h2>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Provider</th>
                  <th className="num">Events</th>
                  <th className="num">Units</th>
                  <th className="num">Est. cost</th>
                </tr>
              </thead>
              <tbody>
                {totals.map((row, i) => (
                  <tr key={i}>
                    <td>
                      <code>{row.kind}</code>
                    </td>
                    <td>{row.provider}</td>
                    <td className="num">{row.eventCount.toLocaleString()}</td>
                    <td className="num">{row.totalUnits.toString()}</td>
                    <td className="num">${(row.totalCostCents / 100).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        {byKey.length > 0 ? (
          <section>
            <h2>By key source</h2>
            <p className="muted">
              <span className="badge badge-good">Workspace</span> = your account is charged.{' '}
              <span className="badge">Platform</span> = the platform owner&apos;s account is
              charged. <code>mock</code> = no real cost.
            </p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Provider</th>
                  <th>Key source</th>
                  <th className="num">Events</th>
                  <th className="num">Est. cost</th>
                </tr>
              </thead>
              <tbody>
                {byKey.map((row, i) => (
                  <tr key={i}>
                    <td>
                      <code>{row.kind}</code>
                    </td>
                    <td>{row.provider}</td>
                    <td>
                      <span
                        className={
                          row.keySource === 'workspace'
                            ? 'badge badge-good'
                            : row.keySource === 'platform'
                              ? 'badge'
                              : 'badge badge-bad'
                        }
                      >
                        {row.keySource}
                      </span>
                    </td>
                    <td className="num">{row.eventCount.toLocaleString()}</td>
                    <td className="num">${(row.totalCostCents / 100).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
      </AppShell>
  );
}

