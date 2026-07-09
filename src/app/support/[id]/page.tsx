import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { isNextRedirectError } from '@/lib/server-redirect';
import {
  SupportServiceError,
  getSupportThread,
  replyToSupportThread,
} from '@/lib/services/support';

export default async function SupportThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ msg?: string; err?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { id: idStr } = await params;
  if (!/^\d+$/.test(idStr)) redirect('/support');
  const id = BigInt(idStr);
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

  let data;
  try {
    data = await getSupportThread(ctx, id);
  } catch (err) {
    if (err instanceof SupportServiceError && err.code === 'not_found') {
      redirect('/support');
    }
    throw err;
  }
  const { thread, messages } = data;

  async function reply(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const body = String(formData.get('body') ?? '');
    try {
      await replyToSupportThread(c, id, body);
      redirect(`/support/${id}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof SupportServiceError ? err.message : 'failed to send';
      redirect(`/support/${id}?err=${encodeURIComponent(m)}`);
    }
  }

  return (
    <AppShell>
      <div className="dashboard-wrap">
        <p className="muted">
          <Link href="/support">Support</Link> / conversation
        </p>
        <header className="page-intro">
          <h1 className="page-title">{thread.subject}</h1>
          <p className="page-lede">
            Started {thread.createdAt.toLocaleString()} ·{' '}
            <span className={thread.status === 'open' ? 'badge' : 'badge muted'}>
              {thread.status}
            </span>
          </p>
        </header>

        {sp.msg ? <p className="form-info">{sp.msg}</p> : null}
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
                  <strong>{m.senderKind === 'admin' ? 'Platform support' : 'You'}</strong>
                  <span className="muted small">{m.createdAt.toLocaleString()}</span>
                </div>
                <p className="support-msg-body">{m.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section>
          {thread.status === 'closed' ? (
            <p className="muted small">
              This conversation was closed by support. Replying reopens it.
            </p>
          ) : null}
          <form action={reply} className="form-grid" style={{ maxWidth: '40rem' }}>
            <label>
              <span>Reply</span>
              <textarea name="body" rows={4} maxLength={10000} required />
            </label>
            <div className="action-row">
              <button type="submit" className="primary-btn">Send</button>
            </div>
          </form>
        </section>
      </div>
    </AppShell>
  );
}
