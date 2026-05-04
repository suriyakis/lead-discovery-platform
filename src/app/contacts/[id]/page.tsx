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
import { canAdminWorkspace } from '@/lib/services/context';
import {
  ContactServiceError,
  archiveContact,
  getContactDetail,
  updateContact,
} from '@/lib/services/contacts';

export default async function ContactDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ message?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { id: idStr } = await params;
  if (!/^\d+$/.test(idStr)) redirect('/contacts');
  const id = BigInt(idStr);
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) redirect('/contacts');
    throw err;
  }

  let detail;
  try {
    detail = await getContactDetail(ctx, id);
  } catch (err) {
    if (err instanceof ContactServiceError && err.code === 'not_found') {
      redirect('/contacts');
    }
    throw err;
  }

  const { contact, leads, threads, recentMessages } = detail;

  async function save(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    await updateContact(c, id, {
      name: String(formData.get('name') ?? '').trim() || null,
      role: String(formData.get('role') ?? '').trim() || null,
      phone: String(formData.get('phone') ?? '').trim() || null,
      companyName: String(formData.get('companyName') ?? '').trim() || null,
      notes: String(formData.get('notes') ?? '').trim() || null,
      tags: String(formData.get('tags') ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    });
    redirect(`/contacts/${id}?message=Saved`);
  }

  async function archive() {
    'use server';
    const c = await getWorkspaceContext();
    await archiveContact(c, id);
    redirect('/contacts');
  }

  return (
    <AppShell>
      <p className="muted">
        <Link href="/dashboard">Dashboard</Link> /{' '}
        <Link href="/contacts">Contacts</Link> /{' '}
        {contact.name ?? contact.email}
      </p>
      <h1>{contact.name ?? contact.email}</h1>
      <p>
        <code>{contact.email}</code>
        {contact.companyName ? <span className="muted"> · {contact.companyName}</span> : null}
        {contact.role ? <span className="muted"> · {contact.role}</span> : null}
        {contact.status === 'archived' ? (
          <span className="badge badge-bad" style={{ marginLeft: '0.5rem' }}>
            archived
          </span>
        ) : null}
      </p>
      {sp.message ? <p className="form-message">{sp.message}</p> : null}
      {sp.error ? <p className="form-error">{sp.error}</p> : null}

      <section>
        <h2>Edit</h2>
        <form action={save} className="edit-draft-form">
          <label>
            <span>Name</span>
            <input type="text" name="name" defaultValue={contact.name ?? ''} />
          </label>
          <label>
            <span>Role</span>
            <input type="text" name="role" defaultValue={contact.role ?? ''} />
          </label>
          <label>
            <span>Phone</span>
            <input type="text" name="phone" defaultValue={contact.phone ?? ''} />
          </label>
          <label>
            <span>Company</span>
            <input
              type="text"
              name="companyName"
              defaultValue={contact.companyName ?? ''}
            />
          </label>
          <label>
            <span>Notes</span>
            <textarea name="notes" rows={4} defaultValue={contact.notes ?? ''} />
          </label>
          <label>
            <span>Tags (comma-separated)</span>
            <input type="text" name="tags" defaultValue={contact.tags.join(', ')} />
          </label>
          <div className="action-row">
            <button type="submit" className="primary-btn">
              Save
            </button>
          </div>
        </form>
      </section>

      <section>
        <h2>Linked leads ({leads.length})</h2>
        {leads.length === 0 ? (
          <p className="muted">No pipeline leads attached yet.</p>
        ) : (
          <ul className="profile-list">
            {leads.map((l) => (
              <li key={l.id.toString()}>
                <div className="lead-row">
                  <Link href={`/pipeline/${l.id}`}>
                    Lead {l.id.toString()}
                  </Link>
                  <span className="badge">{l.state.replace(/_/g, ' ')}</span>
                </div>
                <div className="meta">
                  <span>updated {l.updatedAt.toLocaleString()}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Email threads ({threads.length})</h2>
        {threads.length === 0 ? (
          <p className="muted">No threads attached yet.</p>
        ) : (
          <ul className="profile-list">
            {threads.map((t) => (
              <li key={t.id.toString()}>
                <Link href={`/mailbox/threads/${t.id}`}>
                  {t.subject || '(no subject)'}
                </Link>
                <div className="meta">
                  <span>{t.messageCount} msg</span>
                  {t.lastMessageAt ? (
                    <span>{t.lastMessageAt.toLocaleString()}</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Recent messages ({recentMessages.length})</h2>
        {recentMessages.length === 0 ? (
          <p className="muted">No mail yet.</p>
        ) : (
          <ul className="timeline">
            {recentMessages.map((m) => (
              <li key={m.id.toString()}>
                <span className="muted">
                  {(m.sentAt ?? m.receivedAt ?? m.createdAt).toLocaleString()}
                </span>{' '}
                <strong>{m.direction}</strong> ·{' '}
                {m.direction === 'inbound' ? m.fromAddress : m.toAddresses.join(', ')}
                {' · '}
                <Link href={`/mailbox/threads/${m.threadId ?? ''}`}>{m.subject}</Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canAdminWorkspace(ctx) && contact.status !== 'archived' ? (
        <section>
          <h2>Admin</h2>
          <form action={archive}>
            <button type="submit" className="ghost-btn">
              Archive contact
            </button>
          </form>
        </section>
      ) : null}
    </AppShell>
  );
}
