import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requirePlatformAdmin } from '@/lib/services/auth-context';
import {
  listAllWorkspaces,
  platformTotals,
  platformWorkspaceStats,
  recentAuditAcrossWorkspaces,
} from '@/lib/services/admin';
import { TokenError, adjustTokens } from '@/lib/services/token-ledger';
import { isNextRedirectError } from '@/lib/server-redirect';

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; err?: string }>;
}) {
  const pctx = await requirePlatformAdmin();
  const sp = await searchParams;

  const [workspaces, recentAudit, billingStats, totals] = await Promise.all([
    listAllWorkspaces(pctx),
    recentAuditAcrossWorkspaces(pctx, 25),
    platformWorkspaceStats(pctx),
    platformTotals(pctx),
  ]);

  async function quickGrantTokens(formData: FormData) {
    'use server';
    const c = await requirePlatformAdmin();
    const wsIdRaw = String(formData.get('workspaceId') ?? '');
    const raw = String(formData.get('tokens') ?? '').trim();
    const reason = String(formData.get('reason') ?? '').trim() || 'manual grant (console overview)';
    if (!/^\d+$/.test(wsIdRaw)) redirect('/admin?err=bad+workspace');
    const tokens = Number(raw);
    if (!Number.isFinite(tokens) || !Number.isInteger(tokens) || tokens === 0) {
      redirect(
        `/admin?err=${encodeURIComponent('Tokens must be a non-zero integer (negative = deduct).')}`,
      );
    }
    try {
      const tx = await adjustTokens(c, BigInt(wsIdRaw), tokens, reason);
      redirect(
        `/admin?msg=${encodeURIComponent(
          `${tokens > 0 ? '+' : ''}${tokens.toLocaleString()} tokens applied — new balance ${tx.balanceAfter.toLocaleString()}.`,
        )}`,
      );
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof TokenError ? err.message : 'token adjustment failed';
      redirect(`/admin?err=${encodeURIComponent(m)}`);
    }
  }

  return (
    <div className="dashboard-wrap">
        <h1>Platform overview</h1>
        <p className="muted">
          Platform-wide views. Every action you take in this console is
          audit-logged with your user id. Actions on a workspace (tokens,
          billing exemption, members, support replies) are filed in that
          workspace&apos;s own log; actions on users, pre-authorisations,
          platform roles and provider keys are filed at platform level, in{' '}
          <Link href="/admin/audit?workspace=platform">the platform audit log</Link>.
          Nothing is filed in a workspace just because your workspace
          switcher points at it.
        </p>

        {sp.msg ? <p className="form-info">{sp.msg}</p> : null}
        {sp.err ? <p className="form-error">{sp.err}</p> : null}

        <div className="admin-totals">
          <div className="admin-total-card">
            <strong>{totals.workspacesActive}</strong>
            <span>active workspaces</span>
          </div>
          <div className="admin-total-card">
            <strong>{totals.usersTotal}</strong>
            <span>users</span>
          </div>
          <div className="admin-total-card">
            <strong>{totals.subscriptionsActive}</strong>
            <span>paid subscriptions</span>
          </div>
          <div className="admin-total-card">
            <strong>{totals.tokenBalanceTotal.toLocaleString()}</strong>
            <span>tokens in wallets</span>
          </div>
          <div className="admin-total-card">
            <strong>€{(totals.usageCostCents30d / 100).toFixed(2)}</strong>
            <span>provider cost, 30d</span>
          </div>
          <div className="admin-total-card">
            <strong>
              {totals.supportOpen}
              {totals.supportUnread > 0 ? (
                <span className="admin-nav-badge" style={{ marginLeft: '0.5rem', verticalAlign: 'middle' }}>
                  {totals.supportUnread} unread
                </span>
              ) : null}
            </strong>
            <span><Link href="/admin/support">open support threads</Link></span>
          </div>
        </div>

        <section>
          <h2>Workspaces ({workspaces.length})</h2>
          {workspaces.length === 0 ? (
            <p className="muted">No workspaces yet.</p>
          ) : (
            <ul className="profile-list">
              {workspaces.map((w) => (
                <li key={w.workspaceId.toString()}>
                  <div className="lead-row">
                    <Link href={`/admin/workspaces/${w.workspaceId}`}>{w.name}</Link>
                    <span className="muted">/{w.slug}</span>
                  </div>
                  <div className="meta">
                    <span>{w.memberCount} members</span>
                    <span>{w.leadCount} leads</span>
                    <span>${(w.totalUsageCost / 100).toFixed(2)} usage cost</span>
                    <span>created {w.createdAt.toLocaleDateString()}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2>Billing &amp; usage by workspace</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>Workspace</th>
                <th>Plan / status</th>
                <th>Token balance</th>
                <th>Purchased</th>
                <th>Spent</th>
                <th>Cost 30d</th>
                <th>Events 30d</th>
                <th>Grant tokens</th>
              </tr>
            </thead>
            <tbody>
              {billingStats.map((s) => (
                <tr key={s.workspaceId.toString()}>
                  <td>
                    <Link href={`/admin/workspaces/${s.workspaceId}`}>{s.name}</Link>
                    {s.billingExempt ? <span className="badge" style={{ marginLeft: '0.4rem' }}>exempt</span> : null}
                  </td>
                  <td>
                    {s.plan}{' '}
                    <span className={s.subscriptionStatus === 'active' ? 'badge badge-good' : 'badge'}>
                      {s.subscriptionStatus}
                    </span>
                  </td>
                  <td className={!s.billingExempt && s.tokenBalance <= 0n ? 'delta-bad' : ''}>
                    {s.tokenBalance.toLocaleString()}
                  </td>
                  <td>{s.tokensPurchased.toLocaleString()}</td>
                  <td>{s.tokensSpent.toLocaleString()}</td>
                  <td>€{(s.usageCostCents30d / 100).toFixed(2)}</td>
                  <td>{s.usageEvents30d}</td>
                  <td>
                    <form
                      action={quickGrantTokens}
                      style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}
                    >
                      <input type="hidden" name="workspaceId" value={s.workspaceId.toString()} />
                      <input
                        type="number"
                        name="tokens"
                        step={1}
                        required
                        placeholder="±tokens"
                        style={{ width: '6.5rem' }}
                        aria-label={`Tokens to grant to ${s.name}`}
                      />
                      <input
                        type="text"
                        name="reason"
                        placeholder="reason"
                        maxLength={200}
                        style={{ width: '8rem' }}
                        aria-label="Reason"
                      />
                      <button type="submit" className="ghost-btn">
                        Apply
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            Positive adds, negative deducts; every adjustment lands in the
            workspace&apos;s token ledger with your user id and the reason.
            Full billing controls (exemption, ledger, usage breakdown) are on
            each workspace&apos;s page. User blocking is under{' '}
            <Link href="/admin/users">Users</Link> (set status to
            &ldquo;suspended&rdquo;).
          </p>
        </section>

        <section>
          <h2>Recent audit across workspaces</h2>
          {recentAudit.length === 0 ? (
            <p className="muted">No audit events.</p>
          ) : (
            <ul className="timeline">
              {recentAudit.map((a) => (
                <li key={a.id.toString()}>
                  <span className="muted">{a.createdAt.toLocaleString()}</span>{' '}
                  <code>{a.workspaceId === null ? 'platform' : `ws:${a.workspaceId.toString()}`}</code>{' '}
                  <strong>{a.kind}</strong>
                  {a.entityType ? ` ${a.entityType}#${a.entityId ?? ''}` : ''}
                  {a.userId ? ` · by ${a.userId.slice(0, 12)}…` : ''}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
  );
}
