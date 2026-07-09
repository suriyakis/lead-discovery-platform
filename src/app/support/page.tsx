import Link from 'next/link';
import { redirect } from 'next/navigation';
import { LifeBuoy } from 'lucide-react';
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
  createSupportThread,
  listSupportThreads,
} from '@/lib/services/support';

export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; err?: string }>;
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

  const threads = await listSupportThreads(ctx);

  async function openThread(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const subject = String(formData.get('subject') ?? '');
    const body = String(formData.get('body') ?? '');
    try {
      const t = await createSupportThread(c, { subject, body });
      redirect(`/support/${t.id}?msg=${encodeURIComponent('Message sent — we usually reply within one business day.')}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof SupportServiceError ? err.message : 'failed to send';
      redirect(`/support?err=${encodeURIComponent(m)}`);
    }
  }

  return (
    <AppShell>
      <div className="dashboard-wrap">
        <header className="page-intro">
          <p className="page-eyebrow">Help</p>
          <h1 className="page-title">
            <LifeBuoy className="lucide" aria-hidden="true" /> Support
          </h1>
          <p className="page-lede">
            Message the platform team directly — billing questions, bugs,
            feature requests, anything. Replies land here and in your
            notification bell.
          </p>
        </header>

        {sp.msg ? <p className="form-info">{sp.msg}</p> : null}
        {sp.err ? <p className="form-error">{sp.err}</p> : null}

        <section>
          <h2>New message</h2>
          <form action={openThread} className="form-grid" style={{ maxWidth: '40rem' }}>
            <label>
              <span>Subject</span>
              <input name="subject" type="text" maxLength={200} required placeholder="Short summary" />
            </label>
            <label>
              <span>Message</span>
              <textarea name="body" rows={5} maxLength={10000} required placeholder="What can we help with?" />
            </label>
            <div className="action-row">
              <button type="submit" className="primary-btn">Send to support</button>
            </div>
          </form>
        </section>

        <section>
          <h2>Your conversations ({threads.length})</h2>
          {threads.length === 0 ? (
            <p className="muted">No conversations yet.</p>
          ) : (
            <ul className="profile-list">
              {threads.map((t) => (
                <li key={t.id.toString()}>
                  <div className="lead-row">
                    <Link href={`/support/${t.id}`}>{t.subject}</Link>
                    {t.customerUnread ? (
                      <span className="badge badge-good">new reply</span>
                    ) : null}
                  </div>
                  <div className="meta">
                    <span className={t.status === 'open' ? 'badge' : 'badge muted'}>
                      {t.status}
                    </span>
                    <span>last activity {t.lastMessageAt.toLocaleString()}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AppShell>
  );
}
