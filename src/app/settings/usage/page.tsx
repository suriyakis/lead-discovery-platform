import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace, isSuperAdmin } from '@/lib/services/context';
import {
  summarizeTokenDebits,
  summarizeUsage,
  summarizeUsageByKeySource,
} from '@/lib/services/usage';
import { TableScroll } from '@/components/TableScroll';
import { StatusBadge } from '@/components/Badge';
import { usageKindLabel } from '@/lib/ui/labels';

const RANGES = [
  { key: 'today' as const, label: 'Today', ms: 24 * 60 * 60 * 1000 },
  { key: '7d' as const, label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '30d' as const, label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
  { key: 'all' as const, label: 'All time', ms: Infinity },
];

// Who sees which money column (audit I173, deliverable ia:F-02):
//   - every member: events and units only;
//   - workspace admins (owner, admin): the tokens their wallet was
//     charged, which is what the workspace pays;
//   - super-admins: also the estimated provider cost in dollars. That is
//     the platform's cost basis behind the token price, not a customer
//     figure.

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

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) redirect('/today');
    throw err;
  }

  const showTokens = canAdminWorkspace(ctx);
  const showProviderCost = isSuperAdmin(ctx);
  const range = since ? { since } : {};
  const [totals, byKey, debits] = await Promise.all([
    summarizeUsage(ctx, range),
    summarizeUsageByKeySource(ctx, range),
    showTokens ? summarizeTokenDebits(ctx, range) : Promise.resolve([]),
  ]);

  const tokensByKind = new Map<string, bigint>();
  const tokensByKeySource = new Map<string, bigint>();
  let totalTokens = 0n;
  for (const d of debits) {
    const kindKey = rowKey(d.kind, d.provider);
    tokensByKind.set(kindKey, (tokensByKind.get(kindKey) ?? 0n) + d.tokens);
    tokensByKeySource.set(rowKey(d.kind, d.provider, d.keySource), d.tokens);
    totalTokens += d.tokens;
  }

  const totalCents = totals.reduce((acc, r) => acc + r.totalCostCents, 0);
  const totalEvents = totals.reduce((acc, r) => acc + r.eventCount, 0);

  return (
    <AppShell>
        <p className="muted">
          <Link href="/today">Today</Link> / Settings
        </p>
        <h1>Settings</h1>

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
              <dt>Total events</dt>
              <dd>{totalEvents.toLocaleString()}</dd>
              {showTokens ? (
                <>
                  <dt>Tokens charged</dt>
                  <dd>{totalTokens.toLocaleString()}</dd>
                </>
              ) : null}
              {showProviderCost ? (
                <>
                  <dt>Est. provider cost (super-admin only)</dt>
                  <dd>${(totalCents / 100).toFixed(2)}</dd>
                </>
              ) : null}
            </dl>
          )}
          {showTokens ? null : (
            <p className="muted small">
              Token charges are visible to workspace admins on this page and under
              Billing.
            </p>
          )}
        </section>

        {totals.length > 0 ? (
          <section>
            <h2>By kind / provider</h2>
            <TableScroll label="Usage by kind and provider">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Provider</th>
                    <th className="num">Events</th>
                    <th className="num">Units</th>
                    {showTokens ? <th className="num">Tokens charged</th> : null}
                    {showProviderCost ? <th className="num">Est. provider cost</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {totals.map((row, i) => (
                    <tr key={i}>
                      <td title={row.kind}>{usageKindLabel(row.kind)}</td>
                      <td>{row.provider}</td>
                      <td className="num">{row.eventCount.toLocaleString()}</td>
                      <td className="num">{row.totalUnits.toString()}</td>
                      {showTokens ? (
                        <td className="num">
                          {(tokensByKind.get(rowKey(row.kind, row.provider)) ?? 0n).toLocaleString()}
                        </td>
                      ) : null}
                      {showProviderCost ? (
                        <td className="num">${(row.totalCostCents / 100).toFixed(2)}</td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </section>
        ) : null}

        {byKey.length > 0 ? (
          <section>
            <h2>By key source</h2>
            <p className="muted">
              <StatusBadge set="usage_key_source" value="workspace" />: the provider
              bills you directly and no tokens are charged.{' '}
              <StatusBadge set="usage_key_source" value="platform" />: usage is charged
              in tokens. <StatusBadge set="usage_key_source" value="mock" />: no cost.
            </p>
            <TableScroll label="Usage by key source">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Provider</th>
                    <th>Key source</th>
                    <th className="num">Events</th>
                    {showTokens ? <th className="num">Tokens charged</th> : null}
                    {showProviderCost ? <th className="num">Est. provider cost</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {byKey.map((row, i) => (
                    <tr key={i}>
                      <td title={row.kind}>{usageKindLabel(row.kind)}</td>
                      <td>{row.provider}</td>
                      <td>
                        <StatusBadge set="usage_key_source" value={row.keySource} />
                      </td>
                      <td className="num">{row.eventCount.toLocaleString()}</td>
                      {showTokens ? (
                        <td className="num">
                          {(
                            tokensByKeySource.get(rowKey(row.kind, row.provider, row.keySource)) ?? 0n
                          ).toLocaleString()}
                        </td>
                      ) : null}
                      {showProviderCost ? (
                        <td className="num">${(row.totalCostCents / 100).toFixed(2)}</td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </section>
        ) : null}
      </AppShell>
  );
}

/** Map key for joining token debits onto the usage rows. */
function rowKey(...parts: string[]): string {
  return parts.join('\u0000');
}
