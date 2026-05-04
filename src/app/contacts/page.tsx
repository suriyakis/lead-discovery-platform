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
import {
  ContactServiceError,
  listContacts,
  upsertContact,
} from '@/lib/services/contacts';
import type { Contact } from '@/lib/db/schema/contacts';

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    company?: string;
    status?: 'active' | 'archived';
    error?: string;
    message?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let contacts: Contact[] = [];
  try {
    const ctx = await getWorkspaceContext();
    contacts = await listContacts(ctx, {
      q: sp.q?.trim() || undefined,
      companyDomain: sp.company?.trim() || undefined,
      status: sp.status,
      limit: 500,
    });
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) {
      return (
        <AppShell >
          <h1>Contacts</h1>
          <p>You don&apos;t belong to a workspace yet.</p>
        </AppShell>
      );
    }
    throw err;
  }

  async function quickCreate(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const email = String(formData.get('email') ?? '').trim();
    const name = String(formData.get('name') ?? '').trim() || null;
    const companyName = String(formData.get('companyName') ?? '').trim() || null;
    try {
      const created = await upsertContact(c, { email, name, companyName });
      redirect(`/contacts/${created.id}`);
    } catch (err) {
      const m =
        err instanceof ContactServiceError ? err.message : err instanceof Error ? err.message : 'failed';
      redirect(`/contacts?error=${encodeURIComponent(m)}`);
    }
  }

  return (
    <AppShell>
      <p className="muted">
        <Link href="/dashboard">Dashboard</Link> / Contacts
      </p>
      <h1>Contacts</h1>
      <p className="muted">
        First-class contact records, deduplicated per workspace by lowercased
        email. Outbound and inbound mail attach contacts automatically.
      </p>
      {sp.message ? <p className="form-message">{sp.message}</p> : null}
      {sp.error ? <p className="form-error">{sp.error}</p> : null}

      <section>
        <h2>Add contact</h2>
        <form action={quickCreate} className="inline-form">
          <label>
            <span>Email</span>
            <input type="email" name="email" required />
          </label>
          <label>
            <span>Name</span>
            <input type="text" name="name" maxLength={200} />
          </label>
          <label>
            <span>Company</span>
            <input type="text" name="companyName" maxLength={200} />
          </label>
          <button type="submit" className="primary-btn">
            Save
          </button>
        </form>
      </section>

      <section>
        <h2>Search</h2>
        <form className="leads-controls" method="get">
          <label>
            Find
            <input type="text" name="q" defaultValue={sp.q ?? ''} placeholder="name, email, company" />
          </label>
          <label>
            Company domain
            <input type="text" name="company" defaultValue={sp.company ?? ''} placeholder="acme.com" />
          </label>
          <label>
            Status
            <select name="status" defaultValue={sp.status ?? ''}>
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <button type="submit">Apply</button>
        </form>
      </section>

      <section>
        <h2>List ({contacts.length})</h2>
        {contacts.length === 0 ? (
          <p className="muted">No contacts match this view.</p>
        ) : (
          <ul className="lead-list">
            {contacts.map((c) => (
              <li key={c.id.toString()}>
                <div className="lead-row">
                  <Link href={`/contacts/${c.id}`}>
                    {c.name ?? c.email}
                  </Link>
                  {c.role ? <span className="muted">· {c.role}</span> : null}
                  {c.status === 'archived' ? (
                    <span className="badge badge-bad">archived</span>
                  ) : null}
                </div>
                <div className="lead-meta">
                  <span>{c.email}</span>
                  {c.companyName ? <span>{c.companyName}</span> : null}
                  {c.companyDomain ? <span>@{c.companyDomain}</span> : null}
                  {c.tags.length > 0 ? <span>tags: {c.tags.join(', ')}</span> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}
