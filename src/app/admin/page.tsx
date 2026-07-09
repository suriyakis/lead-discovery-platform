import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { isSuperAdmin } from '@/lib/services/context';
import {
  listAllWorkspaces,
  listImpersonationSessions,
  platformTotals,
  platformWorkspaceStats,
  recentAuditAcrossWorkspaces,
} from '@/lib/services/admin';

export default async function AdminPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <div className="dashboard-wrap">
            <h1>Admin (god mode)</h1>
            <p>You don&apos;t belong to a workspace yet.</p>
          </div>
      );
    }
    throw err;
  }

  if (!isSuperAdmin(ctx)) {
    return (
      <div className="dashboard-wrap">
          <p className="muted">
            <Link href="/dashboard">Dashboard</Link>
          </p>
          <h1>Admin (god mode)</h1>
          <p className="form-error">
            This area is for platform super-admins only.
          </p>
        </div>
    );
  }

  const [workspaces, activeSessions, recentAudit, billingStats, totals] = await Promise.all([
    listAllWorkspaces(ctx),
    listImpersonationSessions(ctx, { activeOnly: true }),
    recentAuditAcrossWorkspaces(ctx, 25),
    platformWorkspaceStats(ctx),
    platformTotals(ctx),
  ]);

  return (
    <div className="dashboard-wrap">
        <h1>Platform overview</h1>
        <p className="muted">
          Platform-wide views. Every action you take here is audit-logged
          with your user id, regardless of which workspace it lands in.
        </p>

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
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            Token grants, deductions and billing exemption live on each
            workspace&apos;s admin page. User blocking is under{' '}
            <Link href="/admin/users">Users</Link> (set status to
            &ldquo;suspended&rdquo;).
          </p>
        </section>

        <section>
          <h2>Active impersonation sessions ({activeSessions.length})</h2>
          {activeSessions.length === 0 ? (
            <p className="muted">No active sessions.</p>
          ) : (
            <ul className="timeline">
              {activeSessions.map((s) => (
                <li key={s.id.toString()}>
                  <span className="muted">started {s.startedAt.toLocaleString()}</span>{' '}
                  <strong>actor</strong> {s.actorUserId.slice(0, 12)}…{' '}
                  → <strong>target</strong> {s.targetUserId.slice(0, 12)}…{' '}
                  in workspace {s.targetWorkspaceId.toString()} · {s.reason}
                </li>
              ))}
            </ul>
          )}
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
                  <code>ws:{a.workspaceId?.toString() ?? '—'}</code>{' '}
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
