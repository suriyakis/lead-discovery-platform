// Phase 23: super-admin per-user detail. Edit name + email, manage
// account status + reason, add/remove from workspaces.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
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
  adminAddUserToWorkspace,
  adminRemoveUserFromWorkspace,
  listMembershipsForUser,
  updateUserProfile,
} from '@/lib/services/admin';
import {
  UserServiceError,
  setAccountStatus,
} from '@/lib/services/users';
import { db } from '@/lib/db/client';
import { users, type AccountStatus } from '@/lib/db/schema/auth';
import { workspaces, type WorkspaceMemberRole } from '@/lib/db/schema/workspaces';

export default async function AdminUserDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ message?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { id: targetUserId } = await params;
  const sp = await searchParams;

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
        <h1>Users</h1>
        <p className="form-error">Super-admin only.</p>
      </AppShell>
    );
  }

  const userRows = await db.select().from(users).where(eq(users.id, targetUserId)).limit(1);
  if (!userRows[0]) redirect('/admin/users');
  const user = userRows[0];

  const [memberships, allWorkspaces] = await Promise.all([
    listMembershipsForUser(ctx, targetUserId),
    db.select().from(workspaces).orderBy(workspaces.name),
  ]);

  const memberWsIds = new Set(memberships.map((m) => m.workspace.id.toString()));
  const candidateWorkspaces = allWorkspaces.filter(
    (w) => !memberWsIds.has(w.id.toString()),
  );

  const isSelf = user.id === session.user.id;

  async function saveProfile(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const name = String(formData.get('name') ?? '').trim() || null;
    const email = String(formData.get('email') ?? '').trim();
    try {
      await updateUserProfile(c, targetUserId, {
        name,
        email: email || undefined,
      });
      redirect(`/admin/users/${targetUserId}?message=Profile+saved`);
    } catch (err) {
      const m = err instanceof AdminServiceError ? err.message : 'failed';
      redirect(`/admin/users/${targetUserId}?error=${encodeURIComponent(m)}`);
    }
  }

  async function changeStatus(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const status = String(formData.get('status') ?? '') as AccountStatus;
    const reason = String(formData.get('reason') ?? '').trim() || null;
    try {
      await setAccountStatus(c, targetUserId, status, reason);
      redirect(`/admin/users/${targetUserId}?message=Status+set+to+${status}`);
    } catch (err) {
      const m = err instanceof UserServiceError ? err.message : 'failed';
      redirect(`/admin/users/${targetUserId}?error=${encodeURIComponent(m)}`);
    }
  }

  async function addToWorkspace(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const workspaceId = BigInt(String(formData.get('workspaceId')));
    const role = String(formData.get('role') ?? 'member') as WorkspaceMemberRole;
    try {
      await adminAddUserToWorkspace(c, targetUserId, workspaceId, role);
      redirect(`/admin/users/${targetUserId}?message=Added+to+workspace`);
    } catch (err) {
      const m = err instanceof AdminServiceError ? err.message : 'failed';
      redirect(`/admin/users/${targetUserId}?error=${encodeURIComponent(m)}`);
    }
  }

  async function removeFromWorkspace(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const workspaceId = BigInt(String(formData.get('workspaceId')));
    try {
      await adminRemoveUserFromWorkspace(c, targetUserId, workspaceId);
      redirect(`/admin/users/${targetUserId}?message=Removed+from+workspace`);
    } catch (err) {
      const m = err instanceof AdminServiceError ? err.message : 'failed';
      redirect(`/admin/users/${targetUserId}?error=${encodeURIComponent(m)}`);
    }
  }

  return (
    <AppShell>
      <p className="muted">
        <Link href="/dashboard">Dashboard</Link> /{' '}
        <Link href="/admin">Admin</Link> /{' '}
        <Link href="/admin/users">Users</Link> / {user.name ?? user.email}
      </p>
      <h1>{user.name ?? user.email}</h1>
      <p className="muted">
        <code>{user.id.slice(0, 12)}…</code> · platform role{' '}
        <code>{user.role}</code> · created {user.createdAt.toLocaleString()}
        {user.lastSignedInAt
          ? ` · last sign-in ${user.lastSignedInAt.toLocaleString()}`
          : ' · never signed in'}
      </p>
      {sp.message ? <p className="form-message">{sp.message}</p> : null}
      {sp.error ? <p className="form-error">{sp.error}</p> : null}

      <section>
        <h2>Profile</h2>
        <form action={saveProfile} className="inline-form">
          <label>
            <span>Name</span>
            <input
              type="text"
              name="name"
              defaultValue={user.name ?? ''}
              maxLength={120}
            />
          </label>
          <label>
            <span>Email</span>
            <input
              type="email"
              name="email"
              defaultValue={user.email}
              required
            />
          </label>
          <button type="submit" className="primary-btn">
            Save
          </button>
        </form>
        {isSelf ? (
          <p className="muted">
            Editing your own email here will change your sign-in identity.
            Make sure you can still sign in afterwards.
          </p>
        ) : null}
      </section>

      <section>
        <h2>
          Account status{' '}
          <span className={statusBadge(user.accountStatus)}>
            {user.accountStatus}
          </span>
        </h2>
        {user.accountStatusReason ? (
          <p className="muted">Reason: {user.accountStatusReason}</p>
        ) : null}
        {isSelf ? (
          <p className="muted">You can&apos;t change your own account status here.</p>
        ) : (
          <form action={changeStatus} className="inline-form">
            <label>
              <span>Status</span>
              <select name="status" defaultValue={user.accountStatus}>
                <option value="active">active</option>
                <option value="pending">pending</option>
                <option value="suspended">suspended</option>
                <option value="rejected">rejected</option>
              </select>
            </label>
            <label>
              <span>Reason</span>
              <input type="text" name="reason" maxLength={200} />
            </label>
            <button type="submit">Apply</button>
          </form>
        )}
      </section>

      <section>
        <h2>Workspace memberships ({memberships.length})</h2>
        {memberships.length === 0 ? (
          <p className="muted">Not a member of any workspace.</p>
        ) : (
          <ul className="profile-list">
            {memberships.map((m) => (
              <li key={m.workspace.id.toString()}>
                <div className="lead-row">
                  <Link href={`/admin/workspaces/${m.workspace.id}`}>
                    {m.workspace.name}
                  </Link>
                  <span className="muted">/{m.workspace.slug}</span>
                  <span className="badge">{m.role}</span>
                  {m.workspace.status === 'archived' ? (
                    <span className="badge badge-bad">archived</span>
                  ) : null}
                </div>
                <form action={removeFromWorkspace} style={{ marginTop: '0.5rem' }}>
                  <input
                    type="hidden"
                    name="workspaceId"
                    value={m.workspace.id.toString()}
                  />
                  <button type="submit" className="ghost-btn">
                    Remove from this workspace
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
        {candidateWorkspaces.length > 0 ? (
          <form action={addToWorkspace} className="inline-form" style={{ marginTop: '1rem' }}>
            <label>
              <span>Add to workspace</span>
              <select name="workspaceId" required>
                {candidateWorkspaces.map((w) => (
                  <option key={w.id.toString()} value={w.id.toString()}>
                    {w.name} (/{w.slug})
                    {w.status === 'archived' ? ' — archived' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Role</span>
              <select name="role" defaultValue="member">
                <option value="owner">owner</option>
                <option value="admin">admin</option>
                <option value="manager">manager</option>
                <option value="member">member</option>
                <option value="viewer">viewer</option>
              </select>
            </label>
            <button type="submit" className="primary-btn">
              Add
            </button>
          </form>
        ) : null}
      </section>
    </AppShell>
  );
}

function statusBadge(s: string): string {
  if (s === 'active') return 'badge badge-good';
  if (s === 'suspended' || s === 'rejected') return 'badge badge-bad';
  return 'badge';
}
