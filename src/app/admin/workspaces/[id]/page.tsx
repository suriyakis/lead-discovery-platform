import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { BrandHeader } from '@/components/BrandHeader';
import { auth, signOut } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { isSuperAdmin } from '@/lib/services/context';
import {
  AdminServiceError,
  endImpersonation,
  listFeatureFlags,
  listImpersonationSessions,
  setFeatureFlag,
  startImpersonation,
} from '@/lib/services/admin';
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
      <>
        <BrandHeader />
        <main>
          <h1>Admin</h1>
          <p className="form-error">Super-admin only.</p>
        </main>
      </>
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
          <Link href="/admin">Admin</Link> / {ws.name}
        </p>
        <h1>{ws.name}</h1>
        <p className="muted">
          /{ws.slug} · created {ws.createdAt.toLocaleString()}
        </p>
        {sp.message ? <p className="form-message">{sp.message}</p> : null}
        {sp.error ? <p className="form-error">{sp.error}</p> : null}

        <section>
          <h2>Members ({members.length})</h2>
          <ul className="profile-list">
            {members.map(({ member, user }) => (
              <li key={member.id.toString()}>
                <div className="lead-row">
                  <strong>{user.name ?? user.email ?? user.id}</strong>
                  <span className="badge">{member.role}</span>
                </div>
                <div className="meta">
                  <span>{user.email}</span>
                  <span>added {member.createdAt.toLocaleDateString()}</span>
                </div>
                {!activeMine ? (
                  <form
                    action={startImp}
                    style={{ marginTop: '0.5rem' }}
                    className="inline-form"
                  >
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
              </li>
            ))}
          </ul>
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
      </main>
    </>
  );
}
