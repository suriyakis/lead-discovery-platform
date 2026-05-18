import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Inbox, Plus } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import {
  MailboxServiceError,
  getMailbox,
  listMailboxes,
  pauseMailbox,
  reactivateMailbox,
  updateMailbox,
} from '@/lib/services/mailbox';
import { isNextRedirectError } from '@/lib/server-redirect';
import type { Mailbox } from '@/lib/db/schema/mailing';

async function toggleMailboxEnabled(formData: FormData) {
  'use server';
  const idStr = String(formData.get('id') ?? '');
  if (!/^\d+$/.test(idStr)) return;
  const id = BigInt(idStr);
  const desired = String(formData.get('target') ?? '');

  try {
    const ctx = await getWorkspaceContext();
    const current = await getMailbox(ctx, id);
    if (current.status === 'archived') return;

    if (desired === 'on') {
      if (current.status === 'paused') {
        await updateMailbox(ctx, id, { status: 'active' });
      } else if (current.status === 'failing') {
        await reactivateMailbox(ctx, id);
      }
    } else if (desired === 'off' && current.status !== 'paused') {
      await pauseMailbox(ctx, id);
    }
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof MailboxServiceError) {
      // Best-effort UX: surface via query param so the page can render
      // a banner. Quick path — the toggle is best-effort and the next
      // render will reflect the truth either way.
      redirect(`/mailbox?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  revalidatePath('/mailbox');
}

export default async function MailboxIndex({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let mailboxes: Mailbox[] = [];
  try {
    const ctx = await getWorkspaceContext();
    mailboxes = await listMailboxes(ctx);
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <AppShell>
            <h1>Mailbox</h1>
            <p>You don&apos;t belong to a workspace yet.</p>
          </AppShell>
      );
    }
    throw err;
  }

  return (
    <AppShell>
        <div className="page-header">
          <div className="page-intro">
            <p className="page-eyebrow">Outreach</p>
            <h1 className="page-title">Mailbox</h1>
            <p className="page-lede">
              Configure SMTP/IMAP accounts for outbound + inbound mail.
              Sending is always manual; drafts go through human approval.
              Approved outreach drafts can be sent from here once a mailbox
              is configured.
            </p>
          </div>
          <Link href="/mailbox/new" className="primary-btn">
            <Plus className="primary-btn-icon" aria-hidden="true" />
            <span>Add mailbox</span>
          </Link>
        </div>

        {sp.error ? <p className="form-error">{sp.error}</p> : null}

        {mailboxes.length === 0 ? (
          <div className="empty-state">
            <Inbox className="empty-state-icon" aria-hidden="true" />
            <p>
              No mailboxes yet. <Link href="/mailbox/new">Add one</Link> to
              start sending and receiving mail.
            </p>
          </div>
        ) : (
          <section>
            <ul className="profile-list">
              {mailboxes.map((m) => {
                const enabled = m.status === 'active';
                const archived = m.status === 'archived';
                return (
                  <li
                    key={m.id.toString()}
                    className={archived ? 'archived' : undefined}
                  >
                    <div className="mailbox-row-head">
                      <div className="lead-row">
                        <Link href={`/mailbox/${m.id}`}>{m.name}</Link>
                        <span className={statusBadge(m.status)}>{m.status}</span>
                        {m.isDefault ? <span className="badge badge-good">default</span> : null}
                      </div>
                      {archived ? null : (
                        <form action={toggleMailboxEnabled} className="mailbox-toggle-form">
                          <input type="hidden" name="id" value={m.id.toString()} />
                          <input type="hidden" name="target" value={enabled ? 'off' : 'on'} />
                          <button
                            type="submit"
                            className={enabled ? 'mailbox-switch on' : 'mailbox-switch off'}
                            aria-label={enabled ? `Disable ${m.name}` : `Enable ${m.name}`}
                            title={
                              enabled
                                ? 'Click to pause: stops outbound sends and IMAP sync'
                                : m.status === 'failing'
                                ? 'Click to re-activate (resets failure counters)'
                                : 'Click to enable: resumes sends and IMAP sync'
                            }
                          >
                            <span className="mailbox-switch-label">
                              {enabled ? 'ON' : 'OFF'}
                            </span>
                            <span className="mailbox-switch-track">
                              <span className="mailbox-switch-thumb" />
                            </span>
                          </button>
                        </form>
                      )}
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
                );
              })}
            </ul>
          </section>
        )}
      </AppShell>
  );
}

function statusBadge(status: string): string {
  if (status === 'active') return 'badge badge-good';
  if (status === 'failing' || status === 'archived') return 'badge badge-bad';
  if (status === 'paused') return 'badge badge-warn';
  return 'badge';
}
