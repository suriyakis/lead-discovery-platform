import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BrandHeader } from '@/components/BrandHeader';
import { auth, signOut } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { listMailboxes } from '@/lib/services/mailbox';
import type { Mailbox } from '@/lib/db/schema/mailing';

export default async function MailboxIndex() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  let mailboxes: Mailbox[] = [];
  try {
    const ctx = await getWorkspaceContext();
    mailboxes = await listMailboxes(ctx);
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <>
          <BrandHeader />
          <main>
            <h1>Mailbox</h1>
            <p>You don&apos;t belong to a workspace yet.</p>
          </main>
        </>
      );
    }
    throw err;
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
          <Link href="/dashboard">Dashboard</Link> / Mailbox
        </p>
        <div className="page-header">
          <h1>Mailbox</h1>
          <Link href="/mailbox/new" className="primary-btn">
            Add mailbox
          </Link>
        </div>
        <p className="muted">
          Configure SMTP/IMAP accounts for outbound + inbound mail. Sending is
          always manual; drafts go through human approval. Approved outreach
          drafts can be sent from here once a mailbox is configured.
        </p>

        <p className="muted" style={{ marginTop: '0.75rem' }}>
          <Link href="/mailbox/signatures">Signatures →</Link>
          {'  ·  '}
          <Link href="/mailbox/suppression">Suppression list →</Link>
        </p>

        {mailboxes.length === 0 ? (
          <section>
            <p className="muted">
              No mailboxes yet. <Link href="/mailbox/new">Add one</Link> to start
              sending and receiving mail.
            </p>
          </section>
        ) : (
          <section>
            <ul className="profile-list">
              {mailboxes.map((m) => (
                <li
                  key={m.id.toString()}
                  className={m.status === 'archived' ? 'archived' : undefined}
                >
                  <div className="lead-row">
                    <Link href={`/mailbox/${m.id}`}>{m.name}</Link>
                    <span className={statusBadge(m.status)}>{m.status}</span>
                    {m.isDefault ? <span className="badge badge-good">default</span> : null}
                  </div>
                  <div className="meta">
                    <span>{m.fromAddress}</span>
                    <span>SMTP {m.smtpHost}:{m.smtpPort}</span>
                    {m.imapHost ? (
                      <span>
                        IMAP {m.imapHost}:{m.imapPort} · {m.imapFolder}
                      </span>
                    ) : (
                      <span>(outbound only)</span>
                    )}
                    {m.lastSyncedAt ? (
                      <span>last sync {m.lastSyncedAt.toLocaleString()}</span>
                    ) : null}
                    {m.lastError ? (
                      <span style={{ color: 'var(--brand-status-rejected)' }}>
                        error: {m.lastError}
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}

function statusBadge(status: string): string {
  if (status === 'active') return 'badge badge-good';
  if (status === 'failing' || status === 'archived') return 'badge badge-bad';
  return 'badge';
}
