import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { SignatureForm } from '@/components/SignatureForm';
import { SignatureHtmlEditor } from '@/components/SignatureHtmlEditor';
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
      logoUrl: String(formData.get('logoUrl') ?? '').trim() || null,
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

  async function updateLogoUrl(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const id = BigInt(String(formData.get('id')));
    const logoUrl = String(formData.get('logoUrl') ?? '').trim();
    await updateSignature(c, id, { logoUrl: logoUrl || null });
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
          <SignatureForm
            action={create}
            mailboxes={mailboxes.map((m) => ({
              id: m.id.toString(),
              name: m.name,
              fromAddress: m.fromAddress,
            }))}
          />
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
                updateLogoUrl={updateLogoUrl}
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
                  updateLogoUrl={updateLogoUrl}
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
  updateLogoUrl,
}: {
  items: Signature[];
  setDefault: (formData: FormData) => Promise<void>;
  destroy: (formData: FormData) => Promise<void>;
  updateHtml: (formData: FormData) => Promise<void>;
  updateLogoUrl: (formData: FormData) => Promise<void>;
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
            {s.logoUrl ? (
              <span className="badge" title={s.logoUrl}>logo URL</span>
            ) : null}
          </div>
          <pre className="draft-body" style={{ marginTop: '0.5rem' }}>{s.bodyText}</pre>

          <details style={{ marginTop: '0.5rem' }}>
            <summary className="muted" style={{ cursor: 'pointer' }}>
              Logo URL {s.logoUrl ? `(${truncate(s.logoUrl, 50)})` : '(none)'}
            </summary>
            <form
              action={updateLogoUrl}
              className="inline-form"
              style={{ marginTop: '0.5rem' }}
            >
              <input type="hidden" name="id" value={s.id.toString()} />
              <label>
                <span>Externally hosted logo URL</span>
                <input
                  type="url"
                  name="logoUrl"
                  defaultValue={s.logoUrl ?? ''}
                  placeholder="https://cdn.example.com/logo.png"
                  maxLength={2048}
                />
                <small className="muted" style={{ fontSize: '0.75rem' }}>
                  HTTPS recommended. ~96 px wide renders best in most mail
                  clients. Leave blank to remove.
                </small>
              </label>
              <button type="submit" className="primary-btn">
                Save logo
              </button>
            </form>
          </details>

          <details style={{ marginTop: '0.5rem' }}>
            <summary className="muted" style={{ cursor: 'pointer' }}>
              {s.bodyHtml ? 'Edit / replace custom HTML' : 'Paste custom HTML'}
              {s.bodyHtml ? null : (
                <span className="muted" style={{ fontSize: '0.78rem' }}>
                  {' '}— with live preview
                </span>
              )}
            </summary>
            <SignatureHtmlEditor
              action={updateHtml}
              signatureId={s.id.toString()}
              initialHtml={s.bodyHtml ?? ''}
              fieldsSnapshot={{
                fullName: s.fullName,
                title: s.title,
                company: s.company,
                tagline: s.tagline,
                website: s.website,
                email: s.email,
                phones: coercePhonesForUi(s.phones),
                logoUrl: s.logoUrl,
                bodyText: s.bodyText,
              }}
            />
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

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** signatures.phones is `unknown` (jsonb); cast safely to the UI shape
 *  used by AISignatureRedesigner. Same shape coercion the server-side
 *  renderer does, just trimmed-down for the snapshot pass-through. */
function coercePhonesForUi(
  raw: unknown,
): Array<{ label: string; number: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ label: string; number: string }> = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as { label?: unknown; number?: unknown };
    const number = (typeof o.number === 'string' ? o.number : '').trim();
    if (!number) continue;
    out.push({
      label: (typeof o.label === 'string' ? o.label : '').trim(),
      number,
    });
    if (out.length >= 6) break;
  }
  return out;
}
