import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requirePlatformAdmin } from '@/lib/services/auth-context';
import { isNextRedirectError } from '@/lib/server-redirect';
import { ConfirmFormButton } from '@/components/ConfirmFormButton';
import { closeSupportThreadConfirm } from '@/lib/confirm-copy';
import {
  SupportServiceError,
  adminGetSupportThread,
  adminReplySupportThread,
  adminSetSupportThreadStatus,
} from '@/lib/services/support';

export default async function AdminSupportThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ err?: string }>;
}) {
  const pctx = await requirePlatformAdmin();
  const { id: idStr } = await params;
  if (!/^\d+$/.test(idStr)) redirect('/admin/support');
  const id = BigInt(idStr);
  const sp = await searchParams;

  let data;
  try {
    data = await adminGetSupportThread(pctx, id);
  } catch (err) {
    if (err instanceof SupportServiceError && err.code === 'not_found') {
      redirect('/admin/support');
    }
    throw err;
  }
  const { thread, messages, workspaceName, senderNames } = data;

  async function reply(formData: FormData) {
    'use server';
    const c = await requirePlatformAdmin();
    const body = String(formData.get('body') ?? '');
    try {
      await adminReplySupportThread(c, id, body);
      redirect(`/admin/support/${id}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof SupportServiceError ? err.message : 'failed to send';
      redirect(`/admin/support/${id}?err=${encodeURIComponent(m)}`);
    }
  }

  async function setStatus(formData: FormData) {
    'use server';
    const c = await requirePlatformAdmin();
    const status = String(formData.get('status')) === 'closed' ? 'closed' : 'open';
    await adminSetSupportThreadStatus(c, id, status);
    redirect(`/admin/support/${id}`);
  }

  return (
    <div className="dashboard-wrap">
      <p className="muted">
        <Link href="/admin/support">Support inbox</Link> / thread
      </p>
      <h1>{thread.subject}</h1>
      <p className="muted">
        Workspace{' '}
        <Link href={`/admin/workspaces/${thread.workspaceId}`}>{workspaceName}</Link>{' '}
        · started {thread.createdAt.toLocaleString()} ·{' '}
        <span className={thread.status === 'open' ? 'badge' : 'badge muted'}>
          {thread.status}
        </span>
      </p>

      {sp.err ? <p className="form-error">{sp.err}</p> : null}

      <section>
        <ul className="support-thread">
          {messages.map((m) => (
            <li
              key={m.id.toString()}
              className={
                m.senderKind === 'admin'
                  ? 'support-msg support-msg-admin'
                  : 'support-msg'
              }
            >
              <div className="support-msg-head">
                <strong>
                  {m.senderKind === 'admin'
                    ? `Support (${m.senderUserId ? senderNames.get(m.senderUserId) ?? 'admin' : 'admin'})`
                    : m.senderUserId
                      ? senderNames.get(m.senderUserId) ?? 'Customer'
                      : 'Customer'}
                </strong>
                <span className="muted small">{m.createdAt.toLocaleString()}</span>
              </div>
              <p className="support-msg-body">{m.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <form action={reply} className="form-grid" style={{ maxWidth: '40rem' }}>
          <label>
            <span>Reply as platform support</span>
            <textarea name="body" rows={4} maxLength={10000} required />
          </label>
          <div className="action-row" style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="submit" className="primary-btn">Send reply</button>
          </div>
        </form>
        <form action={setStatus} style={{ marginTop: '0.75rem' }}>
          <input
            type="hidden"
            name="status"
            value={thread.status === 'open' ? 'closed' : 'open'}
          />
          {/* Closing asks first; reopening is harmless and does not. */}
          <ConfirmFormButton
            className="ghost-btn"
            messageByValue={{
              field: 'status',
              messages: {
                closed: closeSupportThreadConfirm({ subject: thread.subject, workspaceName }),
              },
            }}
          >
            {thread.status === 'open' ? 'Close thread' : 'Reopen thread'}
          </ConfirmFormButton>
        </form>
      </section>
    </div>
  );
}
