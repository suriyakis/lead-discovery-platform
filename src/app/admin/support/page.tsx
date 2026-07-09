import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { isSuperAdmin } from '@/lib/services/context';
import { adminListSupportThreads } from '@/lib/services/support';

export default async function AdminSupportPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/');
    throw err;
  }
  if (!isSuperAdmin(ctx)) redirect('/dashboard');

  const statusFilter =
    sp.status === 'open' || sp.status === 'closed' ? sp.status : undefined;
  const threads = await adminListSupportThreads(ctx, { status: statusFilter });

  return (
    <div className="dashboard-wrap">
      <h1>Support inbox</h1>
      <p className="muted">
        Customer conversations across every workspace. Unread first.
      </p>

      <div className="state-tabs">
        {[
          { key: undefined, label: 'All' },
          { key: 'open', label: 'Open' },
          { key: 'closed', label: 'Closed' },
        ].map((f) => (
          <Link
            key={f.label}
            href={f.key ? `/admin/support?status=${f.key}` : '/admin/support'}
            className={statusFilter === f.key ? 'tab active' : 'tab'}
          >
            {f.label}
          </Link>
        ))}
      </div>

      {threads.length === 0 ? (
        <p className="muted" style={{ marginTop: '1rem' }}>
          No support threads{statusFilter ? ` with status ${statusFilter}` : ''}.
        </p>
      ) : (
        <table className="data-table" style={{ marginTop: '1rem' }}>
          <thead>
            <tr>
              <th>Subject</th>
              <th>Workspace</th>
              <th>Status</th>
              <th>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {threads.map((t) => (
              <tr key={t.id.toString()}>
                <td>
                  <Link href={`/admin/support/${t.id}`}>{t.subject}</Link>
                  {t.adminUnread ? (
                    <span className="admin-nav-badge" style={{ marginLeft: '0.5rem' }}>
                      new
                    </span>
                  ) : null}
                </td>
                <td>
                  {t.workspaceName} <span className="muted">/{t.workspaceSlug}</span>
                </td>
                <td>
                  <span className={t.status === 'open' ? 'badge' : 'badge muted'}>
                    {t.status}
                  </span>
                </td>
                <td>{t.lastMessageAt.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
