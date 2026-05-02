import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BrandHeader } from '@/components/BrandHeader';
import { SettingsNav } from '@/components/SettingsNav';
import { auth, signOut } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace } from '@/lib/services/context';
import {
  CrmServiceError,
  archiveCrmConnection,
  getCrmConnection,
  listSyncEntries,
  testCrmConnection,
  updateCrmConnection,
} from '@/lib/services/crm';

export default async function CrmConnectionDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ message?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { id: idStr } = await params;
  if (!/^\d+$/.test(idStr)) redirect('/settings/crm');
  const id = BigInt(idStr);
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/settings/crm');
    throw err;
  }

  let conn;
  try {
    conn = await getCrmConnection(ctx, id);
  } catch (err) {
    if (err instanceof CrmServiceError && err.code === 'not_found') {
      redirect('/settings/crm');
    }
    throw err;
  }

  const recentSyncs = await listSyncEntries(ctx, { connectionId: id, limit: 20 });

  async function save(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const credential = String(formData.get('credential') ?? '');
    const baseUrl = String(formData.get('baseUrl') ?? '').trim();
    try {
      await updateCrmConnection(c, id, {
        name: String(formData.get('name') ?? '').trim() || undefined,
        credential: credential || undefined,
        config: baseUrl
          ? { ...(conn!.config as Record<string, unknown>), baseUrl }
          : (conn!.config as Record<string, unknown>),
      });
      redirect(`/settings/crm/${id}?message=Saved`);
    } catch (err) {
      if (err instanceof CrmServiceError) {
        redirect(`/settings/crm/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
  }

  async function testNow() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      const result = await testCrmConnection(c, id);
      const m = result.ok
        ? 'Connection OK'
        : `Failed: ${result.detail ?? 'unknown'}`;
      redirect(`/settings/crm/${id}?message=${encodeURIComponent(m)}`);
    } catch (err) {
      const m = err instanceof Error ? err.message : 'test failed';
      redirect(`/settings/crm/${id}?error=${encodeURIComponent(m)}`);
    }
  }

  async function archive() {
    'use server';
    const c = await getWorkspaceContext();
    await archiveCrmConnection(c, id);
    redirect('/settings/crm');
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
          <Link href="/settings/crm">CRM</Link> / {conn.name}
        </p>
        <SettingsNav active="crm" />
        <h1>{conn.name}</h1>
        <p>
          <span className="badge">{conn.system}</span>{' '}
          <span className={statusBadge(conn.status)}>{conn.status}</span>
        </p>

        {sp.message ? <p className="form-message">{sp.message}</p> : null}
        {sp.error ? <p className="form-error">{sp.error}</p> : null}

        <section>
          <h2>Settings</h2>
          <form action={save} className="edit-draft-form">
            <label>
              <span>Display name</span>
              <input type="text" name="name" defaultValue={conn.name} required maxLength={120} />
            </label>
            <label>
              <span>Credential (leave blank to keep current)</span>
              <input type="password" name="credential" autoComplete="new-password" />
            </label>
            <label>
              <span>Base URL override</span>
              <input
                type="text"
                name="baseUrl"
                defaultValue={
                  ((conn.config as Record<string, unknown>).baseUrl as string | undefined) ?? ''
                }
              />
            </label>
            <div className="action-row">
              <button type="submit" className="primary-btn">
                Save
              </button>
              <form action={testNow}>
                <button type="submit">Test connection</button>
              </form>
            </div>
          </form>
        </section>

        <section>
          <h2>Recent syncs</h2>
          {recentSyncs.length === 0 ? (
            <p className="muted">No sync attempts yet.</p>
          ) : (
            <ul className="timeline">
              {recentSyncs.map((s) => (
                <li key={s.id.toString()}>
                  <span className="muted">{s.createdAt.toLocaleString()}</span>{' '}
                  <strong>{s.outcome}</strong>
                  {s.statusCode ? ` · HTTP ${s.statusCode}` : ''}
                  {s.externalId ? ` · ext ${s.externalId}` : ''}
                  {s.error ? ` · ${s.error.slice(0, 200)}` : ''}
                </li>
              ))}
            </ul>
          )}
        </section>

        {canAdminWorkspace(ctx) && conn.status !== 'archived' ? (
          <section>
            <h2>Admin</h2>
            <form action={archive}>
              <button type="submit" className="ghost-btn">
                Archive connection
              </button>
            </form>
          </section>
        ) : null}
      </main>
    </>
  );
}

function statusBadge(status: string): string {
  if (status === 'active') return 'badge badge-good';
  if (status === 'failing' || status === 'archived') return 'badge badge-bad';
  return 'badge';
}
