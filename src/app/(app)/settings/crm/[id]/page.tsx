import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ConfirmFormButton } from '@/components/ConfirmFormButton';
import { Field, Input } from '@/components/ui';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace, canWrite } from '@/lib/services/context';
import {
  CrmServiceError,
  getCrmConnection,
  listSyncEntries,
} from '@/lib/services/crm';
import { isNextRedirectError } from '@/lib/server-redirect';
import {
  archiveCrmConnectionAction,
  restoreCrmConnectionAction,
  saveCrmConnectionAction,
  testCrmConnectionAction,
} from './actions';
import { archiveCrmConnectionConfirm } from '@/lib/confirm-copy';

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
    if (isNextRedirectError(err)) throw err;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/settings/crm');
    throw err;
  }

  let conn;
  try {
    conn = await getCrmConnection(ctx, id);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof CrmServiceError && err.code === 'not_found') {
      redirect('/settings/crm');
    }
    throw err;
  }

  const recentSyncs = await listSyncEntries(ctx, { connectionId: id, limit: 20 });

  // Module-scope actions bound to this connection (see ./actions.ts).
  const connectionId = conn.id.toString();
  const save = saveCrmConnectionAction.bind(null, connectionId);
  const test = testCrmConnectionAction.bind(null, connectionId);
  const archive = archiveCrmConnectionAction.bind(null, connectionId);
  const restore = restoreCrmConnectionAction.bind(null, connectionId);
  const isArchived = conn.status === 'archived';

  return (
    <>
        <p className="muted">
          <Link href="/today">Today</Link> /{' '}
          <Link href="/settings/crm">CRM</Link> / {conn.name}
        </p>
        <h1>{conn.name}</h1>
        <p>
          <span className="badge">{conn.system}</span>{' '}
          <span className={statusBadge(conn.status)}>{conn.status}</span>
        </p>

        {sp.message ? <p className="form-message">{sp.message}</p> : null}
        {sp.error ? <p className="form-error">{sp.error}</p> : null}
        {isArchived ? (
          <p className="form-info">
            This connection is archived: leads are not pushed to it and it
            cannot be tested.
            {canAdminWorkspace(ctx) ? ' Restore it below to use it again.' : null}
          </p>
        ) : null}

        <section>
          <h2>Settings</h2>
          {/* One form. Save submits it; Test connection posts the same
              form to the test action (formAction) and skips validation,
              because it tests the saved settings, not the typed ones. A
              nested <form> here broke hydration and the Test button
              (I115). */}
          <form action={save} className="edit-draft-form">
            <Field label="Display name">
              <Input name="name" defaultValue={conn.name} required maxLength={120} />
            </Field>
            <Field label="Credential" hint="Leave blank to keep the current one." optional>
              <Input type="password" name="credential" autoComplete="new-password" />
            </Field>
            <Field label="Base URL override" hint="Leave blank for the default." optional>
              <Input
                name="baseUrl"
                maxLength={500}
                defaultValue={
                  ((conn.config as Record<string, unknown>).baseUrl as string | undefined) ?? ''
                }
              />
            </Field>
            <div className="action-row">
              <button type="submit" className="primary-btn">
                Save
              </button>
              {!isArchived && canWrite(ctx) ? (
                <button type="submit" formAction={test} formNoValidate className="ghost-btn">
                  Test connection
                </button>
              ) : null}
            </div>
            {!isArchived && canWrite(ctx) ? (
              <p className="muted small">
                Test connection checks the saved settings. Save your changes first.
              </p>
            ) : null}
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

        {canAdminWorkspace(ctx) ? (
          <section>
            <h2>Admin</h2>
            {isArchived ? (
              <form action={restore}>
                <button type="submit" className="primary-btn">
                  Restore connection
                </button>
              </form>
            ) : (
              <form action={archive}>
                <ConfirmFormButton
                  className="ghost-btn"
                  message={archiveCrmConnectionConfirm({ name: conn.name, system: conn.system })}
                >
                  Archive connection
                </ConfirmFormButton>
              </form>
            )}
          </section>
        ) : null}
      </>
  );
}

function statusBadge(status: string): string {
  if (status === 'active') return 'badge badge-good';
  if (status === 'failing' || status === 'archived') return 'badge badge-bad';
  return 'badge';
}
