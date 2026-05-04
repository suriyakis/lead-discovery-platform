import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { SettingsNav } from '@/components/SettingsNav';
import { auth } from '@/lib/auth';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace } from '@/lib/services/context';
import {
  UserServiceError,
  addMember,
  listWorkspaceMembers,
  removeMember,
  setMemberRole,
} from '@/lib/services/users';

const ROLES = ['owner', 'admin', 'manager', 'member', 'viewer'] as const;

export default async function MembersPage({
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
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) redirect('/');
    throw err;
  }

  if (!canAdminWorkspace(ctx)) {
    return (
      <AppShell

        isSuperAdmin={session.user.role === 'super_admin'}
      >
        <SettingsNav />
        <h1>Members</h1>
        <p className="form-error">Workspace admin access required.</p>
      </AppShell>
    );
  }

  const members = await listWorkspaceMembers(ctx);

  async function changeRole(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const targetUserId = String(formData.get('userId') ?? '');
    const role = String(formData.get('role') ?? 'member') as (typeof ROLES)[number];
    try {
      await setMemberRole(c, targetUserId, role);
      redirect('/settings/members?message=Role+updated');
    } catch (err) {
      const m = err instanceof UserServiceError ? err.message : 'failed';
      redirect(`/settings/members?error=${encodeURIComponent(m)}`);
    }
  }

  async function remove(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const targetUserId = String(formData.get('userId') ?? '');
    try {
      await removeMember(c, targetUserId);
      redirect('/settings/members?message=Removed');
    } catch (err) {
      const m = err instanceof UserServiceError ? err.message : 'failed';
      redirect(`/settings/members?error=${encodeURIComponent(m)}`);
    }
  }

  async function add(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const targetUserId = String(formData.get('userId') ?? '').trim();
    const role = String(formData.get('role') ?? 'member') as (typeof ROLES)[number];
    try {
      await addMember(c, targetUserId, role);
      redirect('/settings/members?message=Member+added');
    } catch (err) {
      const m = err instanceof UserServiceError ? err.message : 'failed';
      redirect(`/settings/members?error=${encodeURIComponent(m)}`);
    }
  }

  return (
    <AppShell>
      <p className="muted">
        <Link href="/dashboard">Dashboard</Link> /{' '}
        <Link href="/settings/integrations">Settings</Link> / Members
      </p>
      <SettingsNav />
      <h1>Workspace members</h1>
      {sp.message ? <p className="form-message">{sp.message}</p> : null}
      {sp.error ? <p className="form-error">{sp.error}</p> : null}

      <section>
        <h2>Add existing user by id</h2>
        <p className="muted">
          For most cases use{' '}
          <Link href="/admin/users">Admin → pre-authorize</Link> instead — it
          handles the OAuth-first-time flow. This form is for users who are
          already in the platform but not yet in this workspace.
        </p>
        <form action={add} className="inline-form">
          <label>
            <span>User id</span>
            <input type="text" name="userId" required maxLength={120} />
          </label>
          <label>
            <span>Role</span>
            <select name="role" defaultValue="member">
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="primary-btn">
            Add
          </button>
        </form>
      </section>

      <section>
        <h2>Members ({members.length})</h2>
        <ul className="profile-list">
          {members.map(({ member, user }) => (
            <li key={member.id.toString()}>
              <div className="lead-row">
                <strong>{user.name ?? user.email}</strong>
                <span className="muted">{user.email}</span>
                <span className="badge">{member.role}</span>
              </div>
              {user.id === session.user.id ? (
                <p className="muted">— this is you</p>
              ) : (
                <div className="action-row" style={{ marginTop: '0.5rem' }}>
                  <form action={changeRole} className="inline-form">
                    <input type="hidden" name="userId" value={user.id} />
                    <label>
                      <span>Role</span>
                      <select name="role" defaultValue={member.role}>
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="submit">Update</button>
                  </form>
                  <form action={remove}>
                    <input type="hidden" name="userId" value={user.id} />
                    <button type="submit" className="ghost-btn">
                      Remove
                    </button>
                  </form>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </AppShell>
  );
}
