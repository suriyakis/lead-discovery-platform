// Phase 23: super-admin workspace list. Lists every workspace (active +
// archived) with quick actions: open detail, archive, or restore.

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
import { isSuperAdmin } from '@/lib/services/context';
import {
  AdminServiceError,
  archiveWorkspace,
  listAllWorkspaces,
  restoreWorkspace,
} from '@/lib/services/admin';

export default async function AdminWorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; error?: string; archived?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;
  const showArchived = sp.archived === '1';

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) redirect('/');
    throw err;
  }
  if (!isSuperAdmin(ctx)) {
    return (
      <AppShell>
        <h1>Workspaces</h1>
        <p className="form-error">Super-admin only.</p>
      </AppShell>
    );
  }

  const all = await listAllWorkspaces(ctx, { includeArchived: true });
  const filtered = showArchived ? all : all.filter((w) => w.status === 'active');

  async function archive(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const id = BigInt(String(formData.get('workspaceId')));
    const reason = String(formData.get('reason') ?? '').trim() || null;
    try {
      await archiveWorkspace(c, id, reason);
      redirect('/admin/workspaces?message=Workspace+archived');
    } catch (err) {
      const m = err instanceof AdminServiceError ? err.message : 'failed';
      redirect(`/admin/workspaces?error=${encodeURIComponent(m)}`);
    }
  }

  async function restore(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const id = BigInt(String(formData.get('workspaceId')));
    try {
      await restoreWorkspace(c, id);
      redirect('/admin/workspaces?message=Workspace+restored');
    } catch (err) {
      const m = err instanceof AdminServiceError ? err.message : 'failed';
      redirect(`/admin/workspaces?error=${encodeURIComponent(m)}`);
    }
  }

  return (
    <AppShell>
      <p className="muted">
        <Link href="/dashboard">Dashboard</Link> /{' '}
        <Link href="/admin">Admin</Link> / Workspaces
      </p>
      <h1>Workspaces</h1>
      <p className="muted">
        Every workspace on the platform. Archive turns a workspace
        &ldquo;off&rdquo;: members lose access until restored.
      </p>
      {sp.message ? <p className="form-message">{sp.message}</p> : null}
      {sp.error ? <p className="form-error">{sp.error}</p> : null}

      <p style={{ display: 'flex', gap: '0.5rem' }}>
        <Link href="/admin/workspaces/new" className="primary-btn">
          + New workspace
        </Link>
        {showArchived ? (
          <Link href="/admin/workspaces" className="ghost-btn">
            Hide archived
          </Link>
        ) : (
          <Link href="/admin/workspaces?archived=1" className="ghost-btn">
            Show archived
          </Link>
        )}
      </p>

      <section>
        {filtered.length === 0 ? (
          <p className="muted">No workspaces.</p>
        ) : (
          <ul className="profile-list">
            {filtered.map((w) => (
              <li key={w.workspaceId.toString()}>
                <div className="lead-row">
                  <Link href={`/admin/workspaces/${w.workspaceId}`}>
                    {w.name}
                  </Link>
                  <span className="muted">/{w.slug}</span>
                  <span
                    className={
                      w.status === 'active' ? 'badge badge-good' : 'badge badge-bad'
                    }
                  >
                    {w.status}
                  </span>
                  {w.isDefault ? <span className="badge">🔒 default</span> : null}
                </div>
                <div className="meta">
                  <span>{w.memberCount} members</span>
                  <span>{w.leadCount} leads</span>
                  <span>${(w.totalUsageCost / 100).toFixed(2)} usage</span>
                  <span>created {w.createdAt.toLocaleDateString()}</span>
                  {w.archivedAt ? (
                    <span>
                      archived {w.archivedAt.toLocaleDateString()}
                      {w.archivedReason ? ` (${w.archivedReason})` : ''}
                    </span>
                  ) : null}
                </div>
                <div
                  style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}
                >
                  {w.isDefault ? (
                    <span className="muted">protected — open detail to manage</span>
                  ) : w.status === 'active' ? (
                    <form action={archive} className="inline-form">
                      <input
                        type="hidden"
                        name="workspaceId"
                        value={w.workspaceId.toString()}
                      />
                      <input
                        type="text"
                        name="reason"
                        placeholder="Reason (optional)"
                        maxLength={200}
                      />
                      <button type="submit" className="ghost-btn">
                        Archive
                      </button>
                    </form>
                  ) : (
                    <form action={restore}>
                      <input
                        type="hidden"
                        name="workspaceId"
                        value={w.workspaceId.toString()}
                      />
                      <button type="submit" className="primary-btn">
                        Restore
                      </button>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}
