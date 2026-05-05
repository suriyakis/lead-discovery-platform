'use client';

// Client-side signature form with a live preview pane. Mirrors the
// "New signature" form fields and re-renders the HTML / plain-text
// preview on every keystroke using the same pure renderer that
// mail.sendMessage uses on send. No server roundtrip per stroke.

import { useMemo, useState } from 'react';
import {
  renderSignatureHtml,
  renderSignatureText,
} from '@/lib/signature-render';

interface MailboxOption {
  id: string;
  name: string;
  fromAddress: string;
}

interface SignatureFormProps {
  /** Server action — receives the FormData on submit. */
  action: (formData: FormData) => Promise<void>;
  mailboxes: ReadonlyArray<MailboxOption>;
}

type PreviewTab = 'html' | 'text';

interface PhoneEntry {
  label: string;
  number: string;
}

function parsePhones(raw: string): PhoneEntry[] {
  if (!raw.trim()) return [];
  return raw
    .split('\n')
    .map((line) => {
      const idx = line.indexOf(':');
      if (idx < 0) return { label: '', number: line.trim() };
      return {
        label: line.slice(0, idx).trim(),
        number: line.slice(idx + 1).trim(),
      };
    })
    .filter((p) => p.number.length > 0);
}

export function SignatureForm({ action, mailboxes }: SignatureFormProps) {
  const [name, setName] = useState('');
  const [mailboxId, setMailboxId] = useState('');
  const [greeting, setGreeting] = useState('');
  const [fullName, setFullName] = useState('');
  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const [tagline, setTagline] = useState('');
  const [website, setWebsite] = useState('');
  const [email, setEmail] = useState('');
  const [phonesRaw, setPhonesRaw] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [previewTab, setPreviewTab] = useState<PreviewTab>('html');

  const previewInput = useMemo(
    () => ({
      bodyText,
      bodyHtml: bodyHtml.trim() || null,
      greeting: greeting || null,
      fullName: fullName || null,
      title: title || null,
      company: company || null,
      tagline: tagline || null,
      website: website || null,
      email: email || null,
      phones: parsePhones(phonesRaw),
    }),
    [
      bodyText,
      bodyHtml,
      greeting,
      fullName,
      title,
      company,
      tagline,
      website,
      email,
      phonesRaw,
    ],
  );

  const previewHtml = useMemo(
    () => renderSignatureHtml(previewInput),
    [previewInput],
  );
  const previewText = useMemo(
    () => renderSignatureText(previewInput),
    [previewInput],
  );

  const usingCustomHtml = bodyHtml.trim().length > 0;
  const hasAnyStructured =
    fullName || title || company || website || email || parsePhones(phonesRaw).length > 0;
  const previewIsEmpty = !usingCustomHtml && !hasAnyStructured && !bodyText.trim();

  return (
    <div className="signature-form-grid">
      <form action={action} className="edit-draft-form">
        <label>
          <span>Name</span>
          <input
            type="text"
            name="name"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          <span>Mailbox (leave unset for workspace-wide)</span>
          <select
            name="mailboxId"
            value={mailboxId}
            onChange={(e) => setMailboxId(e.target.value)}
          >
            <option value="">— workspace-wide —</option>
            {mailboxes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.fromAddress})
              </option>
            ))}
          </select>
        </label>
        <fieldset className="ks-kind-fields">
          <legend className="muted">Structured fields (drive the HTML renderer)</legend>
          <label>
            <span>Greeting</span>
            <input
              type="text"
              name="greeting"
              placeholder="Pozdrawiam / Kind regards"
              maxLength={120}
              value={greeting}
              onChange={(e) => setGreeting(e.target.value)}
            />
          </label>
          <label>
            <span>Full name</span>
            <input
              type="text"
              name="fullName"
              maxLength={120}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          </label>
          <label>
            <span>Title</span>
            <input
              type="text"
              name="title"
              maxLength={120}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            <span>Company</span>
            <input
              type="text"
              name="company"
              maxLength={120}
              value={company}
              onChange={(e) => setCompany(e.target.value)}
            />
          </label>
          <label>
            <span>Tagline</span>
            <input
              type="text"
              name="tagline"
              maxLength={200}
              value={tagline}
              onChange={(e) => setTagline(e.target.value)}
            />
          </label>
          <label>
            <span>Website</span>
            <input
              type="url"
              name="website"
              placeholder="https://..."
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </label>
          <label>
            <span>Email</span>
            <input
              type="email"
              name="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            <span>Phones (one per line, &quot;label: number&quot;)</span>
            <textarea
              name="phones"
              rows={3}
              placeholder={'mob: +48 555 123 456\noffice: +48 22 555 1234'}
              value={phonesRaw}
              onChange={(e) => setPhonesRaw(e.target.value)}
            />
          </label>
        </fieldset>
        <label>
          <span>Plain-text fallback body (required)</span>
          <textarea
            name="bodyText"
            rows={4}
            required
            maxLength={4000}
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
          />
        </label>
        <fieldset className="ks-kind-fields">
          <legend className="muted">
            Custom HTML signature (optional — overrides the structured renderer)
          </legend>
          <p className="muted" style={{ fontSize: '0.825rem', marginTop: 0 }}>
            Paste an existing HTML signature (e.g. from your current mail
            client). When set, this exact markup is used in outbound HTML and
            the structured fields above are ignored. Leave blank to use the
            auto-rendered version.
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
              value={bodyHtml}
              onChange={(e) => setBodyHtml(e.target.value)}
            />
          </label>
        </fieldset>
        <label className="checkbox-row">
          <input
            type="checkbox"
            name="isDefault"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
          />
          <span>Set as default at this scope</span>
        </label>
        <div className="action-row">
          <button type="submit" className="primary-btn">
            Create
          </button>
        </div>
      </form>

      <aside className="signature-preview">
        <div className="signature-preview-header">
          <strong>Live preview</strong>
          <div className="signature-preview-tabs">
            <button
              type="button"
              className={previewTab === 'html' ? 'active' : ''}
              onClick={() => setPreviewTab('html')}
            >
              HTML
            </button>
            <button
              type="button"
              className={previewTab === 'text' ? 'active' : ''}
              onClick={() => setPreviewTab('text')}
            >
              Plain text
            </button>
          </div>
        </div>
        {usingCustomHtml ? (
          <p className="muted" style={{ fontSize: '0.78rem', margin: '0 0 0.5rem' }}>
            Using your pasted HTML verbatim. Structured fields are ignored on send.
          </p>
        ) : null}
        {previewIsEmpty ? (
          <div className="signature-preview-empty">
            Start filling out the form — your signature will render here as you type.
          </div>
        ) : previewTab === 'html' ? (
          <div
            className="signature-preview-frame"
            // Same renderer mail.sendMessage uses; XSS-safe via the renderer's
            // escape() pass on every untrusted field. When custom HTML is
            // pasted, the user is explicitly authoring markup for their own
            // outbound mail — same trust boundary as the existing
            // `bodyHtml` save path.
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        ) : (
          <pre className="signature-preview-text">{previewText}</pre>
        )}
      </aside>
    </div>
  );
}
