import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BrandHeader } from '@/components/BrandHeader';
import { auth, signOut } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { isSuperAdmin } from '@/lib/services/context';
import {
  listAllWorkspaces,
  listImpersonationSessions,
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
        <>
          <BrandHeader />
          <main>
            <h1>Admin (god mode)</h1>
            <p>You don&apos;t belong to a workspace yet.</p>
          </main>
        </>
      );
    }
    throw err;
  }

  if (!isSuperAdmin(ctx)) {
    return (
      <>
        <BrandHeader />
        <main>
          <p className="muted">
            <Link href="/dashboard">Dashboard</Link>
          </p>
          <h1>Admin (god mode)</h1>
          <p className="form-error">
            This area is for platform super-admins only.
          </p>
        </main>
      </>
    );
  }

  const [workspaces, activeSessions, recentAudit] = await Promise.all([
    listAllWorkspaces(ctx),
    listImpersonationSessions(ctx, { activeOnly: true }),
    recentAuditAcrossWorkspaces(ctx, 25),
  ]);

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
          <Link href="/dashboard">Dashboard</Link> / Admin
        </p>
        <h1>Admin (god mode)</h1>
        <p className="muted">
          Platform-wide views. Every action you take here is audit-logged
          with your user id, regardless of which workspace it lands in.
        </p>

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
      </main>
    </>
  );
}
