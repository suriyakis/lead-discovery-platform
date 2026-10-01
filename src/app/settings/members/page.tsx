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
  assignableMemberRoles,
  canManageMemberWithRole,
  listWorkspaceMembers,
} from '@/lib/services/users';
import { isNextRedirectError } from '@/lib/server-redirect';
import { addMemberAction, changeMemberRoleAction, removeMemberAction } from './actions';

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
    if (isNextRedirectError(err)) throw err;
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

  // Only owners (and super-admins) are offered 'owner', and only they get
  // controls on an owner's row. users.ts enforces the same rules for a
  // hand-crafted POST (audit I043, deliverable ia:F-04).
  const roles = assignableMemberRoles(ctx);
  const canGrantOwner = roles.includes('owner');

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
        {canGrantOwner ? null : (
          <p className="muted">Only a workspace owner can grant the owner role.</p>
        )}
        <form action={addMemberAction} className="inline-form">
          <label>
            <span>User id</span>
            <input type="text" name="userId" required maxLength={120} />
          </label>
          <label>
            <span>Role</span>
            <select name="role" defaultValue="member">
              {roles.map((r) => (
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
              ) : !canManageMemberWithRole(ctx, member.role) ? (
                <p className="muted">Only an owner can change or remove an owner.</p>
              ) : (
                <div className="action-row" style={{ marginTop: '0.5rem' }}>
                  <form action={changeMemberRoleAction} className="inline-form">
                    <input type="hidden" name="userId" value={user.id} />
                    <label>
                      <span>Role</span>
                      <select name="role" defaultValue={member.role}>
                        {roles.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="submit">Update</button>
                  </form>
                  <form action={removeMemberAction}>
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
