// Phase 23: super-admin user list. Each row links to /admin/users/[id]
// for full editing (name, email, status, workspace memberships). The
// list itself focuses on quick visibility + status updates + the
// pre-authorize flow.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { UserAvatar } from '@/components/UserAvatar';
import { auth } from '@/lib/auth';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { isSuperAdmin } from '@/lib/services/context';
import {
  UserServiceError,
  createPasswordUser,
  listAllUsers,
  listPreauthorizedEmails,
  preauthorizeEmail,
  revokePreauthorize,
  setAccountStatus,
} from '@/lib/services/users';
import { db } from '@/lib/db/client';
import { workspaces } from '@/lib/db/schema/workspaces';
import type { AccountStatus } from '@/lib/db/schema/auth';
import type { WorkspaceMemberRole } from '@/lib/db/schema/workspaces';
import { isNextRedirectError } from '@/lib/server-redirect';

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) redirect('/');
    throw err;
  }
  if (!isSuperAdmin(ctx)) {
    return (
      <div className="dashboard-wrap">
        <h1>Users</h1>
        <p className="form-error">Super-admin only.</p>
      </div>
    );
  }

  const [allUsers, preauths, allWorkspaces] = await Promise.all([
    listAllUsers(ctx, { limit: 500 }),
    listPreauthorizedEmails(ctx),
    db.select().from(workspaces).orderBy(workspaces.name),
  ]);

  async function setStatus(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const targetUserId = String(formData.get('userId') ?? '');
    const status = String(formData.get('status') ?? '') as AccountStatus;
    const reason = String(formData.get('reason') ?? '').trim() || null;
    try {
      await setAccountStatus(c, targetUserId, status, reason);
      redirect(`/admin/users?message=${encodeURIComponent(`Set ${status}`)}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m =
        err instanceof UserServiceError ? err.message : err instanceof Error ? err.message : 'failed';
      redirect(`/admin/users?error=${encodeURIComponent(m)}`);
    }
  }

  async function preauth(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const email = String(formData.get('email') ?? '').trim();
    const wsRaw = String(formData.get('workspaceId') ?? '');
    const workspaceId = /^\d+$/.test(wsRaw) ? BigInt(wsRaw) : null;
    const role = (String(formData.get('role') ?? 'member') as 'owner' | 'admin' | 'manager' | 'member' | 'viewer');
    try {
      await preauthorizeEmail(c, { email, workspaceId, role });
      redirect(`/admin/users?message=${encodeURIComponent(`Pre-authorized ${email}`)}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof UserServiceError ? err.message : 'failed';
      redirect(`/admin/users?error=${encodeURIComponent(m)}`);
    }
  }

  async function revoke(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const id = String(formData.get('id') ?? '');
    await revokePreauthorize(c, id);
    redirect('/admin/users?message=Revoked');
  }

  async function createPwUser(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const email = String(formData.get('email') ?? '').trim();
    const password = String(formData.get('password') ?? '');
    const name = String(formData.get('name') ?? '').trim() || null;
    const wsRaw = String(formData.get('workspaceId') ?? '');
    const workspaceId = /^\d+$/.test(wsRaw) ? BigInt(wsRaw) : null;
    const workspaceRole = String(formData.get('workspaceRole') ?? 'member') as WorkspaceMemberRole;
    try {
      await createPasswordUser(c, {
        email,
        password,
        name,
        workspaceId,
        workspaceRole,
      });
      redirect(`/admin/users?message=${encodeURIComponent(`Created ${email}`)}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof UserServiceError ? err.message : 'failed';
      redirect(`/admin/users?error=${encodeURIComponent(m)}`);
    }
  }

  return (
    <div className="dashboard-wrap">
      <p className="muted">
        <Link href="/dashboard">Dashboard</Link> /{' '}
        <Link href="/admin">Admin</Link> / Users
      </p>
      <h1>Users</h1>
      {sp.message ? <p className="form-message">{sp.message}</p> : null}
      {sp.error ? <p className="form-error">{sp.error}</p> : null}

      <section>
        <h2>Create user with password</h2>
        <p className="muted">
          Provision a password-auth user immediately. They sign in via
          email + password on the / page; no OAuth round-trip needed.
          Useful for clients who don&apos;t have / don&apos;t want to use Google.
        </p>
        <form action={createPwUser} className="inline-form">
          <label>
            <span>Email</span>
            <input type="email" name="email" required />
          </label>
          <label>
            <span>Name</span>
            <input type="text" name="name" maxLength={120} />
          </label>
          <label>
            <span>Password</span>
            <input type="password" name="password" required minLength={8} />
          </label>
          <label>
            <span>Workspace</span>
            <select name="workspaceId" defaultValue="">
              <option value="">— none —</option>
              {allWorkspaces.map((w) => (
                <option key={w.id.toString()} value={w.id.toString()}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Workspace role</span>
            <select name="workspaceRole" defaultValue="member">
              <option value="owner">owner</option>
              <option value="admin">admin</option>
              <option value="manager">manager</option>
              <option value="member">member</option>
              <option value="viewer">viewer</option>
            </select>
          </label>
          <button type="submit" className="primary-btn">
            Create
          </button>
        </form>
      </section>

      <section>
        <h2>Pre-authorize</h2>
        <p className="muted">
          Drop an email into the allow-list before they sign in. On first
          OAuth round-trip they&apos;ll skip the pending state and join the
          named workspace at the named role.
        </p>
        <form action={preauth} className="inline-form">
          <label>
            <span>Email</span>
            <input type="email" name="email" required />
          </label>
          <label>
            <span>Workspace</span>
            <select name="workspaceId" defaultValue="">
              <option value="">— none —</option>
              {allWorkspaces.map((w) => (
                <option key={w.id.toString()} value={w.id.toString()}>
                  {w.name}
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
        {preauths.length > 0 ? (
          <ul className="profile-list">
            {preauths.map((p) => (
              <li key={p.id}>
                <div className="lead-row">
                  <code>{p.email}</code>
                  <span className="badge">{p.role}</span>
                  {p.consumedAt ? (
                    <span className="muted">
                      consumed {p.consumedAt.toLocaleString()}
                    </span>
                  ) : null}
                </div>
                {!p.consumedAt ? (
                  <form action={revoke} style={{ marginTop: '0.5rem' }}>
                    <input type="hidden" name="id" value={p.id} />
                    <button type="submit" className="ghost-btn">
                      Revoke
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <UserSection
        title="Pending review"
        emphasize
        users={allUsers.filter((u) => u.accountStatus === 'pending')}
        sessionUserId={session.user.id}
        setStatus={setStatus}
        emptyText="No pending users."
      />

      <UserSection
        title="Active"
        users={allUsers.filter((u) => u.accountStatus === 'active')}
        sessionUserId={session.user.id}
        setStatus={setStatus}
        emptyText="No active users."
      />

      <UserSection
        title="Suspended / rejected"
        users={allUsers.filter(
          (u) => u.accountStatus === 'suspended' || u.accountStatus === 'rejected',
        )}
        sessionUserId={session.user.id}
        setStatus={setStatus}
        emptyText="No suspended or rejected users."
      />
    </div>
  );
}

function UserSection({
  title,
  users,
  sessionUserId,
  setStatus,
  emphasize = false,
  emptyText,
}: Readonly<{
  title: string;
  users: ReadonlyArray<{
    id: string;
    name: string | null;
    email: string;
    role: string;
    accountStatus: 'pending' | 'active' | 'suspended' | 'rejected';
    accountStatusReason: string | null;
    passwordHash: string | null;
    lastSignedInAt: Date | null;
  }>;
  sessionUserId: string;
  setStatus: (formData: FormData) => Promise<void>;
  emphasize?: boolean;
  emptyText: string;
}>) {
  return (
    <section
      style={
        emphasize && users.length > 0
          ? {
              borderLeft: '3px solid oklch(0.82 0.16 75)',
              paddingLeft: '0.75rem',
            }
          : undefined
      }
    >
      <h2>
        {title} ({users.length})
      </h2>
      {users.length === 0 ? (
        <p className="muted">{emptyText}</p>
      ) : (
        <ul className="profile-list">
          {users.map((u) => (
            <li key={u.id}>
              <div className="lead-row">
                <UserAvatar name={u.name} email={u.email} />
                <Link href={`/admin/users/${u.id}`}>
                  <strong>{u.name ?? u.email}</strong>
                </Link>
                <span className="muted">{u.email}</span>
                <span className="badge">{u.role}</span>
                <span className={statusBadge(u.accountStatus)}>
                  {u.accountStatus}
                </span>
                <span className="badge">
                  {u.passwordHash ? '🔑 password' : '🔵 google'}
                </span>
              </div>
              <div className="meta">
                {u.lastSignedInAt ? (
                  <span>last sign-in {u.lastSignedInAt.toLocaleString()}</span>
                ) : (
                  <span className="muted">never signed in</span>
                )}
              </div>
              {u.accountStatusReason ? (
                <p className="muted">Reason: {u.accountStatusReason}</p>
              ) : null}
              {u.id === sessionUserId ? (
                <p className="muted">— this is you</p>
              ) : (
                <form
                  action={setStatus}
                  className="inline-form"
                  style={{ marginTop: '0.5rem' }}
                >
                  <input type="hidden" name="userId" value={u.id} />
                  <label>
                    <span>Status</span>
                    <select name="status" defaultValue={u.accountStatus}>
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
                  <Link href={`/admin/users/${u.id}`} className="ghost-btn">
                    Edit profile + memberships →
                  </Link>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function statusBadge(s: string): string {
  if (s === 'active') return 'badge badge-good';
  if (s === 'suspended' || s === 'rejected') return 'badge badge-bad';
  return 'badge';
}
