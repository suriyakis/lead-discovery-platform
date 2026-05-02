import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BrandHeader } from '@/components/BrandHeader';
import { auth, signOut } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { listCrmConnections } from '@/lib/services/crm';
import { exportLeadsToCsv } from '@/lib/services/crm';
import { SettingsNav } from '@/components/SettingsNav';
import type { CrmConnection } from '@/lib/db/schema/crm';

export default async function CrmSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; error?: string; download?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let connections: CrmConnection[] = [];
  try {
    const ctx = await getWorkspaceContext();
    connections = await listCrmConnections(ctx);
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <>
          <BrandHeader />
          <main>
            <h1>CRM</h1>
            <p>You don&apos;t belong to a workspace yet.</p>
          </main>
        </>
      );
    }
    throw err;
  }

  async function exportNow() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      const result = await exportLeadsToCsv(c, {});
      const params = new URLSearchParams({
        message: `Exported ${result.rowCount} leads`,
        download: result.url,
      });
      redirect(`/settings/crm?${params.toString()}`);
    } catch (err) {
      const m = err instanceof Error ? err.message : 'export failed';
      redirect(`/settings/crm?error=${encodeURIComponent(m)}`);
    }
  }

  return (
    <>
      <BrandHeader
        rightSlot={
          <>
            <span className="who">{session.user.email}</span>
            <form
              action={async () => {
                'use server';
                await signOut({ redirectTo: '/' });
              }}
            >
              <button type="submit" className="ghost-btn">
                Sign out
              </button>
            </form>
          </>
        }
      />
      <main>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/settings/integrations">Settings</Link> / CRM
        </p>
        <SettingsNav active="crm" />
        <div className="page-header">
          <h1>CRM &amp; Export</h1>
          <Link href="/settings/crm/new" className="primary-btn">
            Add CRM connection
          </Link>
        </div>

        {sp.message ? (
          <p className="form-message">
            {sp.message}
            {sp.download ? (
              <>
                {' '}
                <a href={sp.download} target="_blank" rel="noreferrer">
                  Download CSV
                </a>
              </>
            ) : null}
          </p>
        ) : null}
        {sp.error ? <p className="form-error">{sp.error}</p> : null}

        <section>
          <h2>Quick CSV export</h2>
          <p className="muted">
            Export every qualified lead in this workspace as a CSV. The file
            is written to storage and the download link below is presigned (or
            file:// in dev).
          </p>
          <form action={exportNow}>
            <button type="submit">Export all leads as CSV</button>
          </form>
        </section>

        <section>
          <h2>CRM connections</h2>
          {connections.length === 0 ? (
            <p className="muted">
              No CRM connections yet. Add one to push approved leads.
            </p>
          ) : (
            <ul className="profile-list">
              {connections.map((c) => (
                <li
                  key={c.id.toString()}
                  className={c.status === 'archived' ? 'archived' : undefined}
                >
                  <div className="lead-row">
                    <Link href={`/settings/crm/${c.id}`}>{c.name}</Link>
                    <span className="badge">{c.system}</span>
                    <span className={statusBadge(c.status)}>{c.status}</span>
                  </div>
                  <div className="meta">
                    {c.lastSyncedAt ? (
                      <span>last sync {c.lastSyncedAt.toLocaleString()}</span>
                    ) : (
                      <span className="muted">never synced</span>
                    )}
                    {c.lastError ? (
                      <span style={{ color: 'var(--brand-status-rejected)' }}>
                        error: {c.lastError}
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}

function statusBadge(status: string): string {
  if (status === 'active') return 'badge badge-good';
  if (status === 'failing' || status === 'archived') return 'badge badge-bad';
  return 'badge';
}
