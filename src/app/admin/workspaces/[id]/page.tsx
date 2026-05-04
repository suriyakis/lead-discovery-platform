import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { isSuperAdmin } from '@/lib/services/context';
import {
  AdminServiceError,
  adminAddUserToWorkspace,
  adminRemoveUserFromWorkspace,
  adminSetMemberRole,
  archiveWorkspace,
  deleteWorkspace,
  endImpersonation,
  listFeatureFlags,
  listImpersonationSessions,
  restoreWorkspace,
  setFeatureFlag,
  setWorkspaceDefault,
  startImpersonation,
  updateWorkspaceProfile,
} from '@/lib/services/admin';
import type { WorkspaceMemberRole } from '@/lib/db/schema/workspaces';
import { db } from '@/lib/db/client';
import { workspaces, workspaceMembers } from '@/lib/db/schema/workspaces';
import { users } from '@/lib/db/schema/auth';

const KNOWN_FEATURE_KEYS = [
  'crm.hubspot',
  'rag.openai',
  'outreach.send',
  'mailbox.imap_sync',
  'connector.serpapi',
] as const;

export default async function AdminWorkspaceDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ message?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { id: idStr } = await params;
  if (!/^\d+$/.test(idStr)) redirect('/admin');
  const targetWorkspaceId = BigInt(idStr);
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/admin');
    throw err;
  }
  if (!isSuperAdmin(ctx)) {
    return (
      <AppShell>
          <h1>Admin</h1>
          <p className="form-error">Super-admin only.</p>
        </AppShell>
    );
  }

  const wsRows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, targetWorkspaceId))
    .limit(1);
  if (!wsRows[0]) redirect('/admin');
  const ws = wsRows[0];

  const members = await db
    .select({ member: workspaceMembers, user: users })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, targetWorkspaceId));

  const flags = await listFeatureFlags(ctx, targetWorkspaceId);
  const flagByKey = new Map(flags.map((f) => [f.key, f]));

  const myImps = await listImpersonationSessions(ctx, { activeOnly: false });
  const activeMine = myImps.find(
    (s) => s.actorUserId === ctx.userId && s.endedAt === null,
  );

  async function startImp(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const targetUserId = String(formData.get('targetUserId') ?? '');
    const reason = String(formData.get('reason') ?? '');
    try {
      await startImpersonation(c, {
        targetUserId,
        targetWorkspaceId,
        reason,
      });
      redirect(`/admin/workspaces/${idStr}?message=Impersonation+started`);
    } catch (err) {
      const m =
        err instanceof AdminServiceError ? err.message : err instanceof Error ? err.message : 'failed';
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(m)}`);
    }
  }

  async function endImp(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const sessionId = BigInt(String(formData.get('sessionId')));
    await endImpersonation(c, sessionId);
    redirect(`/admin/workspaces/${idStr}?message=Impersonation+ended`);
  }

  async function toggleFlag(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const key = String(formData.get('key') ?? '');
    const enabled = formData.get('enabled') === 'on';
    await setFeatureFlag(c, {
      workspaceId: targetWorkspaceId,
      key,
      enabled,
    });
    redirect(`/admin/workspaces/${idStr}?message=Flag+${key}+${enabled ? 'enabled' : 'disabled'}`);
  }

  async function saveProfile(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const name = String(formData.get('name') ?? '').trim();
    const slug = String(formData.get('slug') ?? '').trim().toLowerCase();
    try {
      await updateWorkspaceProfile(c, targetWorkspaceId, {
        name: name || undefined,
        slug: slug || undefined,
      });
      redirect(`/admin/workspaces/${idStr}?message=Profile+saved`);
    } catch (err) {
      const m = err instanceof AdminServiceError ? err.message : 'failed';
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(m)}`);
    }
  }

  async function archive(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const reason = String(formData.get('reason') ?? '').trim() || null;
    try {
      await archiveWorkspace(c, targetWorkspaceId, reason);
      redirect(`/admin/workspaces/${idStr}?message=Workspace+archived`);
    } catch (err) {
      const m = err instanceof AdminServiceError ? err.message : 'failed';
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(m)}`);
    }
  }

  async function restore() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      await restoreWorkspace(c, targetWorkspaceId);
      redirect(`/admin/workspaces/${idStr}?message=Workspace+restored`);
    } catch (err) {
      const m = err instanceof AdminServiceError ? err.message : 'failed';
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(m)}`);
    }
  }

  async function toggleDefault(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const isDefault = formData.get('isDefault') === 'on';
    try {
      await setWorkspaceDefault(c, targetWorkspaceId, isDefault);
      redirect(
        `/admin/workspaces/${idStr}?message=${
          isDefault ? 'Marked+as+default' : 'Unmarked+default'
        }`,
      );
    } catch (err) {
      const m = err instanceof AdminServiceError ? err.message : 'failed';
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(m)}`);
    }
  }

  async function destroy(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const confirm = String(formData.get('confirm') ?? '').trim();
    if (confirm !== ws.slug) {
      redirect(
        `/admin/workspaces/${idStr}?error=${encodeURIComponent(
          `Type the slug "${ws.slug}" to confirm`,
        )}`,
      );
    }
    try {
      await deleteWorkspace(c, targetWorkspaceId);
      redirect('/admin/workspaces?message=Workspace+deleted');
    } catch (err) {
      const m = err instanceof AdminServiceError ? err.message : 'failed';
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(m)}`);
    }
  }

  async function addUser(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const targetUserId = String(formData.get('targetUserId') ?? '');
    const role = String(formData.get('role') ?? 'member') as WorkspaceMemberRole;
    try {
      await adminAddUserToWorkspace(c, targetUserId, targetWorkspaceId, role);
      redirect(`/admin/workspaces/${idStr}?message=Member+added`);
    } catch (err) {
      const m = err instanceof AdminServiceError ? err.message : 'failed';
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(m)}`);
    }
  }

  async function removeUser(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const targetUserId = String(formData.get('targetUserId') ?? '');
    try {
      await adminRemoveUserFromWorkspace(c, targetUserId, targetWorkspaceId);
      redirect(`/admin/workspaces/${idStr}?message=Member+removed`);
    } catch (err) {
      const m = err instanceof AdminServiceError ? err.message : 'failed';
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(m)}`);
    }
  }

  async function changeRole(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const targetUserId = String(formData.get('targetUserId') ?? '');
    const role = String(formData.get('role') ?? 'member') as WorkspaceMemberRole;
    try {
      await adminSetMemberRole(c, targetWorkspaceId, targetUserId, role);
      redirect(`/admin/workspaces/${idStr}?message=Role+updated`);
    } catch (err) {
      const m = err instanceof AdminServiceError ? err.message : 'failed';
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(m)}`);
    }
  }

  // Users not yet in this workspace, for the add-member dropdown.
  const memberIds = new Set(members.map((m) => m.user.id));
  const candidateUsers = (
    await db.select().from(users).where(eq(users.accountStatus, 'active'))
  ).filter((u) => !memberIds.has(u.id));

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/admin">Admin</Link> /{' '}
          <Link href="/admin/workspaces">Workspaces</Link> / {ws.name}
        </p>
        <h1>
          {ws.name}{' '}
          <span className={ws.status === 'active' ? 'badge badge-good' : 'badge badge-bad'}>
            {ws.status}
          </span>
          {ws.isDefault ? <span className="badge"> 🔒 default</span> : null}
        </h1>
        <p className="muted">
          /{ws.slug} · created {ws.createdAt.toLocaleString()}
          {ws.archivedAt
            ? ` · archived ${ws.archivedAt.toLocaleString()}${ws.archivedReason ? ` (${ws.archivedReason})` : ''}`
            : ''}
        </p>
        {sp.message ? <p className="form-message">{sp.message}</p> : null}
        {sp.error ? <p className="form-error">{sp.error}</p> : null}

        <section>
          <h2>Profile</h2>
          <form action={saveProfile} className="inline-form">
            <label>
              <span>Name</span>
              <input type="text" name="name" defaultValue={ws.name} maxLength={120} />
            </label>
            <label>
              <span>Slug</span>
              <input
                type="text"
                name="slug"
                defaultValue={ws.slug}
                maxLength={64}
                pattern="[a-z0-9][a-z0-9-]{0,62}[a-z0-9]"
                title="lowercase letters, numbers, hyphens"
              />
            </label>
            <button type="submit" className="primary-btn">
              Save
            </button>
          </form>
        </section>

        <section>
          <h2>Lifecycle</h2>
          <p className="muted">
            Archiving the workspace turns it &ldquo;off&rdquo; — its members
            lose access on next sign-in. Super-admins can still see and
            restore it.
          </p>
          <form action={toggleDefault} className="inline-form">
            <label className="checkbox-row">
              <input
                type="checkbox"
                name="isDefault"
                defaultChecked={ws.isDefault}
              />
              <span>
                🔒 Mark as default — protects from archive + delete
              </span>
            </label>
            <button type="submit">Save</button>
          </form>
          {ws.isDefault ? (
            <p className="muted">
              This workspace is the default — archive and delete are
              disabled. Unmark it first to remove either.
            </p>
          ) : ws.status === 'active' ? (
            <form action={archive} className="inline-form">
              <label>
                <span>Reason (optional)</span>
                <input type="text" name="reason" maxLength={200} />
              </label>
              <button type="submit" className="ghost-btn">
                Archive workspace
              </button>
            </form>
          ) : (
            <>
              <form action={restore}>
                <button type="submit" className="primary-btn">
                  Restore workspace
                </button>
              </form>
              <p
                className="muted"
                style={{ marginTop: '1.5rem', borderTop: '1px solid var(--brand-border)', paddingTop: '1rem' }}
              >
                <strong>Danger zone.</strong> Permanent delete cascades
                across every workspace-scoped table — leads, drafts,
                threads, contacts, knowledge, etc. This cannot be undone.
                Type the workspace slug to confirm.
              </p>
              <form action={destroy} className="inline-form">
                <label>
                  <span>Confirm slug</span>
                  <input
                    type="text"
                    name="confirm"
                    placeholder={ws.slug}
                    autoComplete="off"
                    required
                  />
                </label>
                <button type="submit" className="ghost-btn">
                  Permanently delete
                </button>
              </form>
            </>
          )}
        </section>

        <section>
          <h2>Members ({members.length})</h2>
          <ul className="profile-list">
            {members.map(({ member, user }) => (
              <li key={member.id.toString()}>
                <div className="lead-row">
                  <strong>
                    <Link href={`/admin/users/${user.id}`}>
                      {user.name ?? user.email ?? user.id}
                    </Link>
                  </strong>
                  <span className="badge">
                    {roleIcon(member.role)} {member.role}
                  </span>
                </div>
                <div className="meta">
                  <span>{user.email}</span>
                  <span>added {member.createdAt.toLocaleDateString()}</span>
                </div>
                <div
                  style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}
                >
                  <form action={changeRole} className="inline-form">
                    <input type="hidden" name="targetUserId" value={user.id} />
                    <label>
                      <span>Role</span>
                      <select name="role" defaultValue={member.role}>
                        <option value="owner">👑 owner</option>
                        <option value="admin">🛡 admin</option>
                        <option value="manager">⭐ manager</option>
                        <option value="member">👤 member</option>
                        <option value="viewer">👁 viewer</option>
                      </select>
                    </label>
                    <button type="submit">Apply</button>
                  </form>
                  {!activeMine ? (
                    <form action={startImp} className="inline-form">
                      <input type="hidden" name="targetUserId" value={user.id} />
                      <input
                        type="text"
                        name="reason"
                        placeholder="Reason (audit trail)"
                        required
                        maxLength={200}
                      />
                      <button type="submit">Impersonate</button>
                    </form>
                  ) : null}
                  {member.role !== 'owner' || members.filter((m) => m.member.role === 'owner').length > 1 ? (
                    <form action={removeUser}>
                      <input type="hidden" name="targetUserId" value={user.id} />
                      <button type="submit" className="ghost-btn">
                        Remove from workspace
                      </button>
                    </form>
                  ) : (
                    <span className="muted">last owner — cannot remove</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {candidateUsers.length > 0 ? (
            <form action={addUser} className="inline-form" style={{ marginTop: '1rem' }}>
              <label>
                <span>Add user</span>
                <select name="targetUserId" required>
                  {candidateUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name ? `${u.name} <${u.email}>` : u.email}
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
                Add member
              </button>
            </form>
          ) : (
            <p className="muted">All active users are already members.</p>
          )}
        </section>

        {activeMine ? (
          <section>
            <h2>Your active impersonation</h2>
            <p>
              You are impersonating user{' '}
              <code>{activeMine.targetUserId.slice(0, 12)}…</code> in workspace{' '}
              {activeMine.targetWorkspaceId.toString()} · {activeMine.reason}
            </p>
            <form action={endImp}>
              <input type="hidden" name="sessionId" value={activeMine.id.toString()} />
              <button type="submit" className="ghost-btn">
                End impersonation
              </button>
            </form>
          </section>
        ) : null}

        <section>
          <h2>Feature flags</h2>
          <p className="muted">
            Per-workspace toggles for premium modules. The application reads
            these via <code>feature_flags</code>; non-set keys default to
            disabled.
          </p>
          <ul className="profile-list">
            {KNOWN_FEATURE_KEYS.map((k) => {
              const existing = flagByKey.get(k);
              const enabled = existing?.enabled ?? false;
              return (
                <li key={k}>
                  <div className="lead-row">
                    <code>{k}</code>
                    <span className={enabled ? 'badge badge-good' : 'badge'}>
                      {enabled ? 'enabled' : 'disabled'}
                    </span>
                  </div>
                  <form
                    action={toggleFlag}
                    className="inline-form"
                    style={{ marginTop: '0.5rem' }}
                  >
                    <input type="hidden" name="key" value={k} />
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        name="enabled"
                        defaultChecked={enabled}
                      />
                      <span>{enabled ? 'On' : 'Off'}</span>
                    </label>
                    <button type="submit">Save</button>
                  </form>
                </li>
              );
            })}
          </ul>
        </section>
      </AppShell>
  );
}

function roleIcon(role: string): string {
  switch (role) {
    case 'owner':
      return '👑';
    case 'admin':
      return '🛡';
    case 'manager':
      return '⭐';
    case 'member':
      return '👤';
    case 'viewer':
      return '👁';
    default:
      return '';
  }
}
