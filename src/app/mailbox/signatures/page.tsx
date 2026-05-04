import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { listMailboxes } from '@/lib/services/mailbox';
import {
  createSignature,
  deleteSignature,
  listSignatures,
  updateSignature,
} from '@/lib/services/signatures';
import type { Mailbox, Signature } from '@/lib/db/schema/mailing';

export default async function SignaturesPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  let mailboxes: Mailbox[] = [];
  let signatures: Signature[] = [];
  try {
    const ctx = await getWorkspaceContext();
    mailboxes = await listMailboxes(ctx);
    signatures = await listSignatures(ctx);
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <AppShell>
            <h1>Signatures</h1>
            <p>You don&apos;t belong to a workspace yet.</p>
          </AppShell>
      );
    }
    throw err;
  }

  const byMailbox = (id: bigint | null) =>
    signatures.filter((s) =>
      id === null ? s.mailboxId === null : s.mailboxId === id,
    );

  async function create(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const mailboxIdRaw = String(formData.get('mailboxId') ?? '');
    const phonesRaw = String(formData.get('phones') ?? '').trim();
    const phones = phonesRaw
      ? phonesRaw
          .split('\n')
          .map((line) => {
            const idx = line.indexOf(':');
            if (idx < 0) return { label: '', number: line.trim() };
            return {
              label: line.slice(0, idx).trim(),
              number: line.slice(idx + 1).trim(),
            };
          })
          .filter((p) => p.number)
      : [];
    await createSignature(c, {
      name: String(formData.get('name') ?? '').trim(),
      bodyText: String(formData.get('bodyText') ?? ''),
      bodyHtml: String(formData.get('bodyHtml') ?? '').trim() || null,
      mailboxId: /^\d+$/.test(mailboxIdRaw) ? BigInt(mailboxIdRaw) : null,
      isDefault: formData.get('isDefault') === 'on',
      greeting: String(formData.get('greeting') ?? '').trim() || null,
      fullName: String(formData.get('fullName') ?? '').trim() || null,
      title: String(formData.get('title') ?? '').trim() || null,
      company: String(formData.get('company') ?? '').trim() || null,
      tagline: String(formData.get('tagline') ?? '').trim() || null,
      website: String(formData.get('website') ?? '').trim() || null,
      email: String(formData.get('email') ?? '').trim() || null,
      phones,
    });
    redirect('/mailbox/signatures');
  }

  async function updateHtml(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const id = BigInt(String(formData.get('id')));
    const bodyHtml = String(formData.get('bodyHtml') ?? '').trim();
    await updateSignature(c, id, { bodyHtml: bodyHtml || null });
    redirect('/mailbox/signatures');
  }

  async function setDefault(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const id = BigInt(String(formData.get('id')));
    await updateSignature(c, id, { isDefault: true });
    redirect('/mailbox/signatures');
  }

  async function destroy(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const id = BigInt(String(formData.get('id')));
    await deleteSignature(c, id);
    redirect('/mailbox/signatures');
  }

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/mailbox">Mailbox</Link> / Signatures
        </p>
        <h1>Signatures</h1>
        <p className="muted">
          A signature can be workspace-wide (default for any compose) or
          mailbox-scoped. The compose form auto-appends the default for the
          target mailbox.
        </p>

        <section>
          <h2>New signature</h2>
          <form action={create} className="edit-draft-form">
            <label>
              <span>Name</span>
              <input type="text" name="name" required maxLength={120} />
            </label>
            <label>
              <span>Mailbox (leave unset for workspace-wide)</span>
              <select name="mailboxId" defaultValue="">
                <option value="">— workspace-wide —</option>
                {mailboxes.map((m) => (
                  <option key={m.id.toString()} value={m.id.toString()}>
                    {m.name} ({m.fromAddress})
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="ks-kind-fields">
              <legend className="muted">Structured fields (drive the HTML renderer)</legend>
              <label>
                <span>Greeting</span>
                <input type="text" name="greeting" placeholder="Pozdrawiam / Kind regards" maxLength={120} />
              </label>
              <label>
                <span>Full name</span>
                <input type="text" name="fullName" maxLength={120} />
              </label>
              <label>
                <span>Title</span>
                <input type="text" name="title" maxLength={120} />
              </label>
              <label>
                <span>Company</span>
                <input type="text" name="company" maxLength={120} />
              </label>
              <label>
                <span>Tagline</span>
                <input type="text" name="tagline" maxLength={200} />
              </label>
              <label>
                <span>Website</span>
                <input type="url" name="website" placeholder="https://..." />
              </label>
              <label>
                <span>Email</span>
                <input type="email" name="email" />
              </label>
              <label>
                <span>Phones (one per line, &quot;label: number&quot;)</span>
                <textarea
                  name="phones"
                  rows={3}
                  placeholder={'mob: +48 555 123 456\noffice: +48 22 555 1234'}
                />
              </label>
            </fieldset>
            <label>
              <span>Plain-text fallback body (required)</span>
              <textarea name="bodyText" rows={4} required maxLength={4000} />
            </label>
            <fieldset className="ks-kind-fields">
              <legend className="muted">
                Custom HTML signature (optional — overrides the structured renderer)
              </legend>
              <p className="muted" style={{ fontSize: '0.825rem', marginTop: 0 }}>
                Paste an existing HTML signature (e.g. from your current
                mail client). When set, this exact markup is used in
                outbound HTML and the structured fields above are
                ignored. Leave blank to use the auto-rendered version.
              </p>
              <label>
                <span>HTML</span>
                <textarea
                  name="bodyHtml"
                  rows={6}
                  maxLength={20000}
                  placeholder={'<table>\n  <tr><td>...</td></tr>\n</table>'}
                  spellCheck={false}
                  style={{ fontFamily: 'var(--brand-mono)', fontSize: '0.825rem' }}
                />
              </label>
            </fieldset>
            <label className="checkbox-row">
              <input type="checkbox" name="isDefault" />
              <span>Set as default at this scope</span>
            </label>
            <div className="action-row">
              <button type="submit" className="primary-btn">
                Create
              </button>
            </div>
          </form>
        </section>

        {signatures.length === 0 ? (
          <p className="muted">No signatures yet.</p>
        ) : (
          <>
            <section>
              <h2>Workspace-wide</h2>
              <SignatureList
                items={byMailbox(null)}
                setDefault={setDefault}
                destroy={destroy}
                updateHtml={updateHtml}
              />
            </section>
            {mailboxes.map((m) => (
              <section key={m.id.toString()}>
                <h2>
                  Mailbox: {m.name}{' '}
                  <span className="muted" style={{ fontWeight: 400, fontSize: '0.875rem' }}>
                    ({m.fromAddress})
                  </span>
                </h2>
                <SignatureList
                  items={byMailbox(m.id)}
                  setDefault={setDefault}
                  destroy={destroy}
                  updateHtml={updateHtml}
                />
              </section>
            ))}
          </>
        )}
      </AppShell>
  );
}

function SignatureList({
  items,
  setDefault,
  destroy,
  updateHtml,
}: {
  items: Signature[];
  setDefault: (formData: FormData) => Promise<void>;
  destroy: (formData: FormData) => Promise<void>;
  updateHtml: (formData: FormData) => Promise<void>;
}) {
  if (items.length === 0) return <p className="muted">None at this scope.</p>;
  return (
    <ul className="profile-list">
      {items.map((s) => (
        <li key={s.id.toString()}>
          <div className="lead-row">
            <strong>{s.name}</strong>
            {s.isDefault ? <span className="badge badge-good">default</span> : null}
            {s.bodyHtml ? (
              <span className="badge" title="Outbound HTML uses this exact markup">
                custom HTML
              </span>
            ) : null}
          </div>
          <pre className="draft-body" style={{ marginTop: '0.5rem' }}>{s.bodyText}</pre>

          <details style={{ marginTop: '0.5rem' }}>
            <summary className="muted" style={{ cursor: 'pointer' }}>
              {s.bodyHtml ? 'Edit / replace custom HTML' : 'Paste custom HTML'}
            </summary>
            <form
              action={updateHtml}
              style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
            >
              <input type="hidden" name="id" value={s.id.toString()} />
              <textarea
                name="bodyHtml"
                rows={8}
                maxLength={20000}
                defaultValue={s.bodyHtml ?? ''}
                placeholder={'<table>\n  <tr><td>...</td></tr>\n</table>'}
                spellCheck={false}
                style={{
                  fontFamily: 'var(--brand-mono)',
                  fontSize: '0.825rem',
                  width: '100%',
                }}
              />
              <p className="muted" style={{ fontSize: '0.75rem', margin: 0 }}>
                Leave blank and save to revert to the auto-rendered HTML
                from the structured fields.
              </p>
              <div>
                <button type="submit" className="primary-btn">
                  Save HTML
                </button>
              </div>
            </form>
          </details>

          <div className="action-row" style={{ marginTop: '0.5rem' }}>
            {!s.isDefault ? (
              <form action={setDefault}>
                <input type="hidden" name="id" value={s.id.toString()} />
                <button type="submit">Make default</button>
              </form>
            ) : null}
            <form action={destroy}>
              <input type="hidden" name="id" value={s.id.toString()} />
              <button type="submit" className="ghost-btn">
                Delete
              </button>
            </form>
          </div>
        </li>
      ))}
    </ul>
  );
}
