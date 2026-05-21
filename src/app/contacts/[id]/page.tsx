import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  Archive,
  ArrowLeft,
  Building2,
  Mail,
  MessagesSquare,
  PenSquare,
  Phone,
  Tag as TagIcon,
  User,
} from 'lucide-react';
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
import { listMailboxes } from '@/lib/services/mailbox';
import { isNextRedirectError } from '@/lib/server-redirect';

const AVATAR_PALETTE: ReadonlyArray<readonly [string, string]> = [
  ['oklch(0.72 0.17 240)', 'oklch(0.55 0.18 280)'],
  ['oklch(0.72 0.17 200)', 'oklch(0.55 0.18 160)'],
  ['oklch(0.78 0.16 100)', 'oklch(0.6 0.17 60)'],
  ['oklch(0.75 0.18 25)', 'oklch(0.55 0.18 350)'],
  ['oklch(0.75 0.16 320)', 'oklch(0.55 0.17 260)'],
  ['oklch(0.78 0.15 140)', 'oklch(0.55 0.17 190)'],
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function computeInitials(name: string | null, email: string): string {
  const src = (name && name.trim()) || email;
  const parts = src.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}
function gradientForKey(key: string): string {
  const [a, b] = AVATAR_PALETTE[hashString(key) % AVATAR_PALETTE.length]!;
  return `linear-gradient(135deg, ${a} 0%, ${b} 100%)`;
}

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
  const mailboxes = await listMailboxes(ctx);
  const composeMailbox =
    mailboxes.find((mb) => mb.isDefault && mb.status === 'active') ??
    mailboxes.find((mb) => mb.status === 'active') ??
    mailboxes[0] ??
    null;

  const display = contact.name?.trim() || contact.email;
  const initials = computeInitials(contact.name, contact.email);
  const gradient = gradientForKey(contact.email);

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
      <div className="contact-detail">
        {/* ============ Hero header ============ */}
        <header className="contact-hero">
          <Link
            href="/contacts"
            className="contact-hero-back"
            aria-label="Back to contacts"
          >
            <ArrowLeft className="lucide" /> Contacts
          </Link>
          <div className="contact-hero-card" style={{ background: gradient }}>
            <div className="contact-hero-avatar">{initials}</div>
            <div className="contact-hero-info">
              <h1 className="contact-hero-name">{display}</h1>
              <p className="contact-hero-sub">
                <Mail className="lucide" />
                <a href={`mailto:${contact.email}`}>{contact.email}</a>
                {contact.role ? (
                  <>
                    <span className="dot" />
                    <User className="lucide" /> {contact.role}
                  </>
                ) : null}
                {contact.companyName ? (
                  <>
                    <span className="dot" />
                    <Building2 className="lucide" />
                    {contact.companyName}
                  </>
                ) : null}
                {contact.phone ? (
                  <>
                    <span className="dot" />
                    <Phone className="lucide" /> {contact.phone}
                  </>
                ) : null}
              </p>
              {contact.tags.length > 0 ? (
                <div className="contact-hero-tags">
                  {contact.tags.map((t) => (
                    <span key={t} className="contact-tag">
                      <TagIcon className="lucide" /> {t}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="contact-hero-actions">
              {composeMailbox ? (
                <Link
                  href={`/mailbox/${composeMailbox.id}/compose?to=${encodeURIComponent(contact.email)}`}
                  className="primary-btn"
                >
                  <PenSquare className="lucide" /> Compose
                </Link>
              ) : null}
              {contact.status === 'archived' ? (
                <span className="badge badge-bad">archived</span>
              ) : null}
            </div>
          </div>
        </header>

        {sp.message ? <p className="mail-flash info">{sp.message}</p> : null}
        {sp.error ? <p className="mail-flash error">{sp.error}</p> : null}

        {/* ============ 2-col body ============ */}
        <div className="contact-detail-grid">
          {/* Left: profile editor */}
          <section className="contact-card-block">
            <h2 className="contact-card-title">Profile</h2>
            <form action={save} className="contact-form">
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
                <span>Tags (comma-separated)</span>
                <input
                  type="text"
                  name="tags"
                  defaultValue={contact.tags.join(', ')}
                />
              </label>
              <label>
                <span>Notes</span>
                <textarea
                  name="notes"
                  rows={5}
                  defaultValue={contact.notes ?? ''}
                />
              </label>
              <div className="contact-form-actions">
                <button type="submit" className="primary-btn">
                  Save profile
                </button>
                {canAdminWorkspace(ctx) && contact.status !== 'archived' ? (
                  <button
                    type="submit"
                    formAction={archive}
                    className="ghost-btn danger"
                  >
                    <Archive className="lucide" /> Archive
                  </button>
                ) : null}
              </div>
            </form>
          </section>

          {/* Right: activity */}
          <section className="contact-activity">
            <div className="contact-card-block">
              <h2 className="contact-card-title">
                <MessagesSquare className="lucide" /> Email threads (
                {threads.length})
              </h2>
              {threads.length === 0 ? (
                <p className="muted">No threads attached yet.</p>
              ) : (
                <ul className="contact-thread-list">
                  {threads.slice(0, 8).map((t) => (
                    <li key={t.id.toString()}>
                      <Link href={`/communication/${t.id}`}>
                        {t.subject || '(no subject)'}
                      </Link>
                      <div className="contact-thread-meta">
                        <span>{t.messageCount} msg</span>
                        {t.lastMessageAt ? (
                          <span>{t.lastMessageAt.toLocaleString()}</span>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="contact-card-block">
              <h2 className="contact-card-title">
                <User className="lucide" /> Linked leads ({leads.length})
              </h2>
              {leads.length === 0 ? (
                <p className="muted">No pipeline leads attached yet.</p>
              ) : (
                <ul className="contact-thread-list">
                  {leads.map((l) => (
                    <li key={l.id.toString()}>
                      <Link href={`/pipeline/${l.id}`}>
                        Lead {l.id.toString()}
                      </Link>
                      <div className="contact-thread-meta">
                        <span className="badge">
                          {l.state.replace(/_/g, ' ')}
                        </span>
                        <span>updated {l.updatedAt.toLocaleString()}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="contact-card-block">
              <h2 className="contact-card-title">
                <Mail className="lucide" /> Recent messages (
                {recentMessages.length})
              </h2>
              {recentMessages.length === 0 ? (
                <p className="muted">No mail yet.</p>
              ) : (
                <ul className="contact-message-timeline">
                  {recentMessages.map((m) => (
                    <li
                      key={m.id.toString()}
                      data-direction={m.direction}
                    >
                      <span className="contact-message-arrow" aria-hidden="true">
                        {m.direction === 'outbound' ? '→' : '←'}
                      </span>
                      <div className="contact-message-body">
                        <Link href={`/communication/${m.threadId ?? ''}`}>
                          {m.subject || '(no subject)'}
                        </Link>
                        <span className="muted">
                          {(m.sentAt ?? m.receivedAt ?? m.createdAt).toLocaleString()}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      </div>
    </AppShell>
  );
}
