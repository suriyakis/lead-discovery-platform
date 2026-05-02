import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BrandHeader } from '@/components/BrandHeader';
import { auth, signOut } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace } from '@/lib/services/context';
import {
  MailboxServiceError,
  archiveMailbox,
  getMailbox,
  testMailboxConnection,
} from '@/lib/services/mailbox';
import { listThreads, syncInbound } from '@/lib/services/mail';

export default async function MailboxDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ message?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { id: idStr } = await params;
  if (!/^\d+$/.test(idStr)) redirect('/mailbox');
  const id = BigInt(idStr);
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/mailbox');
    throw err;
  }

  let mailbox;
  try {
    mailbox = await getMailbox(ctx, id);
  } catch (err) {
    if (err instanceof MailboxServiceError && err.code === 'not_found') {
      redirect('/mailbox');
    }
    throw err;
  }

  const threads = await listThreads(ctx, { mailboxId: id, limit: 100 });

  async function runSync() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      const result = await syncInbound(c, id);
      const msg = `Synced — fetched ${result.fetched}, new ${result.inserted}, deduped ${result.duplicates}.`;
      redirect(`/mailbox/${id}?message=${encodeURIComponent(msg)}`);
    } catch (err) {
      if (err instanceof MailboxServiceError || err instanceof Error) {
        const m = (err as { message?: string }).message ?? 'sync failed';
        redirect(`/mailbox/${id}?error=${encodeURIComponent(m)}`);
      }
      throw err;
    }
  }

  async function runTest() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      const result = await testMailboxConnection(c, id);
      const allOk = result.smtp.ok && (result.imap === null || result.imap.ok);
      const msg = allOk
        ? 'Connection OK — SMTP and IMAP reachable.'
        : `SMTP ${result.smtp.ok ? 'ok' : `failed: ${result.smtp.detail}`}; IMAP ${result.imap?.ok ? 'ok' : `failed: ${result.imap?.detail}`}`;
      redirect(`/mailbox/${id}?message=${encodeURIComponent(msg)}`);
    } catch (err) {
      const m = err instanceof Error ? err.message : 'test failed';
      redirect(`/mailbox/${id}?error=${encodeURIComponent(m)}`);
    }
  }

  async function archive() {
    'use server';
    const c = await getWorkspaceContext();
    await archiveMailbox(c, id);
    redirect('/mailbox');
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
          <Link href="/mailbox">Mailbox</Link> / {mailbox.name}
        </p>
        <div className="page-header">
          <h1>{mailbox.name}</h1>
          <div className="action-row">
            <Link href={`/mailbox/${id}/compose`} className="primary-btn">
              Compose
            </Link>
            <Link href={`/mailbox/${id}/edit`}>Edit settings</Link>
          </div>
        </div>
        <p>
          <span className={statusBadge(mailbox.status)}>{mailbox.status}</span>{' '}
          {mailbox.isDefault ? <span className="badge badge-good">default</span> : null}{' '}
          <span className="muted">{mailbox.fromAddress}</span>
        </p>

        {sp.message ? <p className="form-message">{sp.message}</p> : null}
        {sp.error ? <p className="form-error">{sp.error}</p> : null}

        <section>
          <h2>Connection</h2>
          <dl>
            <dt>SMTP</dt>
            <dd>
              <code>{mailbox.smtpHost}:{mailbox.smtpPort}</code>
              {mailbox.smtpSecure ? <span className="muted"> · SSL</span> : null}
              <span className="muted"> · {mailbox.smtpUser}</span>
            </dd>
            {mailbox.imapHost ? (
              <>
                <dt>IMAP</dt>
                <dd>
                  <code>{mailbox.imapHost}:{mailbox.imapPort}</code>
                  {mailbox.imapSecure ? <span className="muted"> · SSL</span> : null}
                  <span className="muted"> · {mailbox.imapUser} · {mailbox.imapFolder}</span>
                </dd>
                {mailbox.lastSyncedAt ? (
                  <>
                    <dt>Last sync</dt>
                    <dd>{mailbox.lastSyncedAt.toLocaleString()}</dd>
                  </>
                ) : null}
              </>
            ) : null}
            {mailbox.lastError ? (
              <>
                <dt>Last error</dt>
                <dd className="warn">{mailbox.lastError}</dd>
              </>
            ) : null}
          </dl>
          <div className="action-row">
            <form action={runTest}>
              <button type="submit">Test connection</button>
            </form>
            {mailbox.imapHost ? (
              <form action={runSync}>
                <button type="submit">Sync inbound</button>
              </form>
            ) : null}
          </div>
        </section>

        <section>
          <h2>Threads ({threads.length})</h2>
          {threads.length === 0 ? (
            <p className="muted">No conversations yet. Compose a message or run a sync.</p>
          ) : (
            <ul className="lead-list">
              {threads.map((t) => (
                <li key={t.id.toString()}>
                  <div className="lead-row">
                    <Link href={`/mailbox/threads/${t.id}`}>{t.subject || '(no subject)'}</Link>
                    <span className="muted">{t.messageCount} msg</span>
                  </div>
                  <div className="lead-meta">
                    {t.participants.length > 0 ? (
                      <span>{t.participants.slice(0, 4).join(', ')}{t.participants.length > 4 ? '…' : ''}</span>
                    ) : null}
                    {t.lastMessageAt ? <span>{t.lastMessageAt.toLocaleString()}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {canAdminWorkspace(ctx) && mailbox.status !== 'archived' ? (
          <section>
            <h2>Admin</h2>
            <form action={archive}>
              <button type="submit" className="ghost-btn">
                Archive mailbox
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
