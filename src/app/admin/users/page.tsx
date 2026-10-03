// Phase 23: super-admin user list. Each row links to /admin/users/[id]
// for full editing (name, email, status, workspace memberships). The
// list itself focuses on quick visibility + status updates + the
// pre-authorize flow.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { UserAvatar } from '@/components/UserAvatar';
import { requirePlatformAdmin } from '@/lib/services/auth-context';
import {
  UserServiceError,
  createPasswordUser,
  listAllUsers,
  listPreauthorizedEmails,
  preauthorizeEmail,
  setAccountStatus,
} from '@/lib/services/users';
import { db } from '@/lib/db/client';
import { workspaces } from '@/lib/db/schema/workspaces';
import type { AccountStatus } from '@/lib/db/schema/auth';
import type { WorkspaceMemberRole } from '@/lib/db/schema/workspaces';
import { isNextRedirectError } from '@/lib/server-redirect';
import { ConfirmFormButton } from '@/components/ConfirmFormButton';
import { accountStatusConfirms, revokePreauthConfirm } from '@/lib/confirm-copy';
import { revokePreauthorizationAction } from './actions';

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; error?: string }>;
}) {
  const pctx = await requirePlatformAdmin();
  const sp = await searchParams;

  const [allUsers, preauths, allWorkspaces] = await Promise.all([
    listAllUsers(pctx, { limit: 500 }),
    listPreauthorizedEmails(pctx),
    db.select().from(workspaces).orderBy(workspaces.name),
  ]);
  const workspaceById = new Map(allWorkspaces.map((w) => [w.id.toString(), w]));
  // PC-06: the active workspaces each user is the accountable owner of —
  // suspending them stops those workspaces' automatic work.
  const ownedByUser = new Map<string, { name: string; slug: string }[]>();
  for (const w of allWorkspaces) {
    if (w.status !== 'active') continue;
    const list = ownedByUser.get(w.ownerUserId) ?? [];
    list.push({ name: w.name, slug: w.slug });
    ownedByUser.set(w.ownerUserId, list);
  }
  const withOwned = <T extends { id: string }>(list: T[]) =>
    list.map((u) => ({ ...u, ownedWorkspaces: ownedByUser.get(u.id) ?? [] }));

  async function setStatus(formData: FormData) {
    'use server';
    const c = await requirePlatformAdmin();
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
    const c = await requirePlatformAdmin();
    const email = String(formData.get('email') ?? '').trim();
    // An explicit choice (audit I117): 'own' = their own new workspace,
    // or the id of an existing one. A blank choice used to mean "no
    // workspace", which left the user with none.
    const destination = parsePreauthDestination(formData.get('workspaceChoice'));
    if (destination === undefined) {
      redirect(
        `/admin/users?error=${encodeURIComponent('Choose where they will work: their own new workspace or an existing one.')}`,
      );
    }
    const workspaceId = destination;
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

  async function createPwUser(formData: FormData) {
    'use server';
    const c = await requirePlatformAdmin();
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
        <Link href="/admin">Platform console</Link> / Users
      </p>
      <h1>Users</h1>
      {sp.message ? <p className="form-message">{sp.message}</p> : null}
      {sp.error ? <p className="form-error">{sp.error}</p> : null}
      <p className="muted">
        Suspending, rejecting or un-approving a user stops their sign-in. If
        they own a workspace, it also stops all of that workspace&apos;s
        automatic work (sending, inbox sync, discovery, autopilot, CRM sync
        and background AI): automation only ever acts as an active owner,
        and there is no fallback to another member. Members can still work
        by hand. Set the owner back to active, or move ownership, to resume.
      </p>

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
          Drop an email into the allow-list. They skip the pending state and
          get either a workspace of their own (as its owner) or a seat in an
          existing workspace at the chosen role. Someone who already has an
          account gets it straight away; anyone else at their first sign-in.
        </p>
        <form action={preauth} className="inline-form">
          <label>
            <span>Email</span>
            <input type="email" name="email" required />
          </label>
          <label>
            <span>Workspace</span>
            <select name="workspaceChoice" defaultValue="" required>
              <option value="" disabled>
                Choose…
              </option>
              <option value={OWN_WORKSPACE}>Their own new workspace</option>
              <optgroup label="Existing workspace">
                {allWorkspaces
                  .filter((w) => w.status === 'active')
                  .map((w) => (
                    <option key={w.id.toString()} value={w.id.toString()}>
                      {w.name}
                    </option>
                  ))}
              </optgroup>
            </select>
          </label>
          <label>
            <span>Role (existing workspace)</span>
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
                  <span className="muted">
                    {p.workspaceId === null
                      ? 'own new workspace'
                      : (workspaceById.get(p.workspaceId)?.name ?? 'a deleted workspace')}
                  </span>
                  <span className="badge">{p.role}</span>
                  {p.consumedAt ? (
                    <span className="muted">
                      consumed {p.consumedAt.toLocaleString()}
                    </span>
                  ) : null}
                </div>
                {!p.consumedAt ? (
                  <form action={revokePreauthorizationAction} style={{ marginTop: '0.5rem' }}>
                    <input type="hidden" name="id" value={p.id} />
                    <ConfirmFormButton
                      className="ghost-btn"
                      message={revokePreauthConfirm({
                        email: p.email,
                        role: p.role,
                        workspaceName: p.workspaceId
                          ? (workspaceById.get(p.workspaceId)?.name ?? `workspace #${p.workspaceId}`)
                          : null,
                        workspaceSlug: p.workspaceId
                          ? workspaceById.get(p.workspaceId)?.slug
                          : null,
                      })}
                    >
                      Revoke
                    </ConfirmFormButton>
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
        users={withOwned(allUsers.filter((u) => u.accountStatus === 'pending'))}
        sessionUserId={pctx.actorUserId}
        setStatus={setStatus}
        emptyText="No pending users."
      />

      <UserSection
        title="Active"
        users={withOwned(allUsers.filter((u) => u.accountStatus === 'active'))}
        sessionUserId={pctx.actorUserId}
        setStatus={setStatus}
        emptyText="No active users."
      />

      <UserSection
        title="Suspended / rejected"
        users={withOwned(
          allUsers.filter(
            (u) => u.accountStatus === 'suspended' || u.accountStatus === 'rejected',
          ),
        )}
        sessionUserId={pctx.actorUserId}
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
    /** PC-06: active workspaces they are the accountable owner of. */
    ownedWorkspaces: ReadonlyArray<{ name: string; slug: string }>;
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
              {u.ownedWorkspaces.length > 0 ? (
                <p className="muted">
                  Owner of {u.ownedWorkspaces.map((w) => w.name).join(', ')}
                  {u.accountStatus === 'active'
                    ? ''
                    : ' — automatic work there is stopped while this account is not active.'}
                </p>
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
                  <ConfirmFormButton
                    messageByValue={{
                      field: 'status',
                      messages: accountStatusConfirms(u, u.ownedWorkspaces),
                    }}
                  >
                    Apply
                  </ConfirmFormButton>
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

/** The pre-authorize form's value for "Their own new workspace". */
const OWN_WORKSPACE = 'own';

/**
 * The pre-authorize form's workspace choice: null for their own new
 * workspace, the id of an existing one, or undefined when nothing valid
 * was chosen.
 */
function parsePreauthDestination(raw: FormDataEntryValue | null): bigint | null | undefined {
  if (raw === OWN_WORKSPACE) return null;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return BigInt(raw);
  return undefined;
}

function statusBadge(s: string): string {
  if (s === 'active') return 'badge badge-good';
  if (s === 'suspended' || s === 'rejected') return 'badge badge-bad';
  return 'badge';
}
