'use client';

// Phase 56 — signatures workspace.
//
// Replaces the old vertical stack on /mailbox/signatures with a clean
// two-column layout inspired by Wandizz's signature manager:
//   - Left:  card list of existing signatures (or the create/edit form
//            when the operator clicks New / Pencil).
//   - Right: live preview of the active signature (eye-selected or
//            being-edited) with a "Send Test" button, plus a separate
//            Raw HTML card with Copy button.

import { useMemo, useState } from 'react';
import {
  Code,
  Copy,
  Eye,
  PenLine,
  Plus,
  Send,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import {
  renderSignatureHtml,
  renderSignatureText,
} from '@/lib/signature-render';
import { SignatureForm, type SignatureFormInitial } from './SignatureForm';

interface MailboxOption {
  id: string;
  name: string;
  fromAddress: string;
}

interface SignatureRow {
  id: string;
  name: string;
  mailboxId: string | null;
  mailboxName: string | null;
  isDefault: boolean;
  greeting: string | null;
  fullName: string | null;
  title: string | null;
  company: string | null;
  tagline: string | null;
  website: string | null;
  email: string | null;
  phones: Array<{ label: string; number: string }>;
  bodyText: string;
  bodyHtml: string | null;
  logoUrl: string | null;
}

interface SignaturesWorkspaceProps {
  signatures: ReadonlyArray<SignatureRow>;
  mailboxes: ReadonlyArray<MailboxOption>;
  defaultTestRecipient: string;
  /** Server actions — page-level wrappers. */
  createAction: (formData: FormData) => Promise<void>;
  updateAction: (formData: FormData) => Promise<void>;
  deleteAction: (formData: FormData) => Promise<void>;
  setDefaultAction: (formData: FormData) => Promise<void>;
}

type Mode =
  | { kind: 'browsing'; selectedId: string | null }
  | { kind: 'creating' }
  | { kind: 'editing'; signatureId: string };

export function SignaturesWorkspace({
  signatures,
  mailboxes,
  defaultTestRecipient,
  createAction,
  updateAction,
  deleteAction,
  setDefaultAction,
}: SignaturesWorkspaceProps) {
  const [mode, setMode] = useState<Mode>(() => ({
    kind: 'browsing',
    selectedId: signatures[0]?.id ?? null,
  }));

  const selectedId =
    mode.kind === 'browsing'
      ? mode.selectedId
      : mode.kind === 'editing'
        ? mode.signatureId
        : null;

  const selected = useMemo(
    () => signatures.find((s) => s.id === selectedId) ?? null,
    [signatures, selectedId],
  );

  const renderedHtml = useMemo(() => {
    if (!selected) return '';
    return renderSignatureHtml({
      bodyText: selected.bodyText,
      bodyHtml: selected.bodyHtml,
      greeting: selected.greeting,
      fullName: selected.fullName,
      title: selected.title,
      company: selected.company,
      tagline: selected.tagline,
      website: selected.website,
      email: selected.email,
      phones: selected.phones,
      logoUrl: selected.logoUrl,
    });
  }, [selected]);

  const renderedText = useMemo(() => {
    if (!selected) return '';
    return renderSignatureText({
      bodyText: selected.bodyText,
      greeting: selected.greeting,
      fullName: selected.fullName,
      title: selected.title,
      company: selected.company,
      tagline: selected.tagline,
      website: selected.website,
      email: selected.email,
      phones: selected.phones,
    });
  }, [selected]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div className="page-header">
        <div className="page-intro">
          <p className="page-eyebrow">Outreach</p>
          <h1 className="page-title">Email signatures</h1>
          <p className="page-lede">
            One workspace can carry multiple signatures — pick one as the
            default for outbound mail, scope others to specific mailboxes.
            The compose form auto-appends the default for the target mailbox.
          </p>
        </div>
        <div className="action-row">
          <button
            type="button"
            className="primary-btn"
            onClick={() => setMode({ kind: 'creating' })}
            disabled={mode.kind !== 'browsing'}
          >
            <Plus className="lucide" /> New signature
          </button>
        </div>
      </div>

      {mode.kind === 'browsing' ? (
        // Browsing: two-column workspace (list left, preview + raw right).
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
            gap: '1rem',
            alignItems: 'flex-start',
          }}
        >
          <div>
            <SignatureList
              signatures={signatures}
              selectedId={mode.selectedId}
              onSelect={(id) =>
                setMode({ kind: 'browsing', selectedId: id })
              }
              onEdit={(id) => setMode({ kind: 'editing', signatureId: id })}
              deleteAction={deleteAction}
              setDefaultAction={setDefaultAction}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <PreviewPanel
              signature={selected}
              renderedHtml={renderedHtml}
              renderedText={renderedText}
              defaultTestRecipient={defaultTestRecipient}
            />
            <RawHtmlPanel renderedHtml={renderedHtml} />
          </div>
        </div>
      ) : mode.kind === 'creating' ? (
        // Creating: SignatureForm has its own internal 2-col grid (fields
        // left, live preview right). Render it full-width — the outer
        // right column would collide with the form's internal preview.
        <section className="profile-list-card" style={{ padding: '1rem' }}>
          <h2 style={{ marginTop: 0 }}>New signature</h2>
          <SignatureForm
            action={createAction}
            mailboxes={mailboxes}
            onCancel={() =>
              setMode({
                kind: 'browsing',
                selectedId: signatures[0]?.id ?? null,
              })
            }
          />
        </section>
      ) : (
        <EditForm
          signature={signatures.find((s) => s.id === mode.signatureId)!}
          mailboxes={mailboxes}
          updateAction={updateAction}
          onCancel={() =>
            setMode({ kind: 'browsing', selectedId: mode.signatureId })
          }
        />
      )}
    </div>
  );
}

function SignatureList({
  signatures,
  selectedId,
  onSelect,
  onEdit,
  deleteAction,
  setDefaultAction,
}: {
  signatures: ReadonlyArray<SignatureRow>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  deleteAction: (formData: FormData) => Promise<void>;
  setDefaultAction: (formData: FormData) => Promise<void>;
}) {
  if (signatures.length === 0) {
    return (
      <div
        className="empty-state"
        style={{ padding: '2rem 1rem', textAlign: 'center' }}
      >
        <p style={{ margin: 0, fontWeight: 600 }}>No signatures yet</p>
        <p className="muted" style={{ margin: '0.5rem 0 0', fontSize: '0.85em' }}>
          Click <strong>New signature</strong> to create your first one.
        </p>
      </div>
    );
  }
  return (
    <ul
      className="profile-list"
      style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
    >
      {signatures.map((s) => {
        const isSelected = s.id === selectedId;
        return (
          <li
            key={s.id}
            onClick={() => onSelect(s.id)}
            style={{
              cursor: 'pointer',
              outline: isSelected ? '2px solid var(--brand-accent, #e87b1f)' : 'none',
              outlineOffset: '-2px',
            }}
          >
            <div
              className="lead-row"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.5rem',
                width: '100%',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                  {s.isDefault ? (
                    <Star
                      className="lucide"
                      style={{
                        width: 14,
                        height: 14,
                        color: '#eab308',
                        fill: '#eab308',
                      }}
                    />
                  ) : null}
                  <strong style={{ fontSize: '0.95em' }}>{s.name}</strong>
                  {s.bodyHtml ? <span className="badge">HTML</span> : null}
                  {s.logoUrl ? <span className="badge">logo</span> : null}
                  <span className="badge" title="scope">
                    {s.mailboxName ? `mailbox: ${s.mailboxName}` : 'workspace'}
                  </span>
                </div>
                <span
                  className="muted"
                  style={{
                    fontSize: '0.78em',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {(s.fullName || '').trim()}
                  {s.fullName && s.company ? ' — ' : ''}
                  {(s.company || '').trim() || (s.fullName ? '' : '(no contact info)')}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '0.25rem', flexShrink: 0 }}>
                <button
                  type="button"
                  className="ghost-btn icon-btn"
                  title="Preview"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(s.id);
                  }}
                >
                  <Eye className="lucide" />
                </button>
                <button
                  type="button"
                  className="ghost-btn icon-btn"
                  title="Edit"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(s.id);
                  }}
                >
                  <PenLine className="lucide" />
                </button>
                {!s.isDefault ? (
                  <form
                    action={setDefaultAction}
                    onClick={(e) => e.stopPropagation()}
                    style={{ display: 'inline' }}
                  >
                    <input type="hidden" name="id" value={s.id} />
                    <button
                      type="submit"
                      className="ghost-btn icon-btn"
                      title="Make default"
                    >
                      <Star className="lucide" />
                    </button>
                  </form>
                ) : null}
                <form
                  action={deleteAction}
                  onClick={(e) => e.stopPropagation()}
                  onSubmit={(e) => {
                    if (!confirm(`Delete signature "${s.name}"?`)) {
                      e.preventDefault();
                    }
                  }}
                  style={{ display: 'inline' }}
                >
                  <input type="hidden" name="id" value={s.id} />
                  <button
                    type="submit"
                    className="ghost-btn icon-btn"
                    title="Delete"
                    style={{ color: '#dc2626' }}
                  >
                    <Trash2 className="lucide" />
                  </button>
                </form>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function EditForm({
  signature,
  mailboxes,
  updateAction,
  onCancel,
}: {
  signature: SignatureRow;
  mailboxes: ReadonlyArray<MailboxOption>;
  updateAction: (formData: FormData) => Promise<void>;
  onCancel: () => void;
}) {
  const initial: SignatureFormInitial = {
    id: signature.id,
    name: signature.name,
    mailboxId: signature.mailboxId ?? '',
    greeting: signature.greeting,
    fullName: signature.fullName,
    title: signature.title,
    company: signature.company,
    tagline: signature.tagline,
    website: signature.website,
    email: signature.email,
    phonesRaw: signature.phones
      .map((p) => (p.label ? `${p.label}: ${p.number}` : p.number))
      .join('\n'),
    bodyText: signature.bodyText,
    bodyHtml: signature.bodyHtml,
    logoUrl: signature.logoUrl,
    isDefault: signature.isDefault,
  };
  return (
    <section className="profile-list-card" style={{ padding: '1rem' }}>
      <h2 style={{ marginTop: 0 }}>
        <PenLine className="lucide" /> Edit signature
      </h2>
      <SignatureForm
        action={updateAction}
        mailboxes={mailboxes}
        initial={initial}
        onCancel={onCancel}
      />
    </section>
  );
}

function PreviewPanel({
  signature,
  renderedHtml,
  renderedText,
  defaultTestRecipient,
}: {
  signature: SignatureRow | null;
  renderedHtml: string;
  renderedText: string;
  defaultTestRecipient: string;
}) {
  const [tab, setTab] = useState<'html' | 'text'>('html');
  const [testOpen, setTestOpen] = useState(false);
  if (!signature) {
    return (
      <aside className="signature-preview">
        <div className="signature-preview-header">
          <strong>
            <Eye className="lucide" /> Live preview
          </strong>
        </div>
        <div className="signature-preview-empty">
          Select a signature on the left to see it render here.
        </div>
      </aside>
    );
  }
  return (
    <aside className="signature-preview">
      <div className="signature-preview-header">
        <strong>
          <Eye className="lucide" /> Live preview · {signature.name}
        </strong>
        <div className="signature-preview-tabs">
          <button
            type="button"
            className={tab === 'html' ? 'active' : ''}
            onClick={() => setTab('html')}
          >
            HTML
          </button>
          <button
            type="button"
            className={tab === 'text' ? 'active' : ''}
            onClick={() => setTab('text')}
          >
            Plain text
          </button>
          <button
            type="button"
            className="ghost-btn icon-btn"
            title="Send test email with this signature"
            onClick={() => setTestOpen(true)}
            style={{ marginLeft: '0.4rem' }}
          >
            <Send className="lucide" />
          </button>
        </div>
      </div>
      {tab === 'html' ? (
        <div
          className="signature-preview-frame"
          // The HTML comes from our own renderer (or operator-saved
          // bodyHtml). Same trust boundary as mail.sendMessage.
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />
      ) : (
        <pre className="signature-preview-text">{renderedText}</pre>
      )}
      {testOpen ? (
        <SendTestDialog
          signature={signature}
          defaultRecipient={defaultTestRecipient}
          onClose={() => setTestOpen(false)}
        />
      ) : null}
    </aside>
  );
}

function RawHtmlPanel({ renderedHtml }: { renderedHtml: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(renderedHtml);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // best-effort; clipboard API may be blocked
    }
  }
  return (
    <aside className="signature-preview">
      <div className="signature-preview-header">
        <strong>
          <Code className="lucide" /> Raw HTML
        </strong>
        <button
          type="button"
          className="ghost-btn icon-btn"
          onClick={copy}
          disabled={!renderedHtml}
          title="Copy HTML to clipboard"
          style={{ fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
        >
          <Copy className="lucide" />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {renderedHtml ? (
        <pre
          className="signature-preview-text"
          style={{
            fontSize: '0.72rem',
            wordBreak: 'break-word',
            maxHeight: '320px',
          }}
        >
          {renderedHtml}
        </pre>
      ) : (
        <div className="signature-preview-empty">
          Select a signature on the left to inspect its rendered HTML.
        </div>
      )}
    </aside>
  );
}

function SendTestDialog({
  signature,
  defaultRecipient,
  onClose,
}: {
  signature: SignatureRow;
  defaultRecipient: string;
  onClose: () => void;
}) {
  const [recipient, setRecipient] = useState(defaultRecipient);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function send() {
    setError(null);
    setInfo(null);
    if (!recipient.trim()) {
      setError('Recipient required.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/signatures/send-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signatureId: signature.id,
          to: recipient.trim(),
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        messageId?: string;
        smtpResponse?: string;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !j.ok) {
        setError(j.detail || j.error || `request failed (${res.status})`);
      } else {
        setInfo(
          `Sent — message-id ${j.messageId ?? '?'}. Check the recipient inbox.`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white',
          color: '#111',
          padding: '1.25rem',
          borderRadius: '0.5rem',
          maxWidth: '480px',
          width: '100%',
          boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '0.5rem',
          }}
        >
          <h3 style={{ margin: 0 }}>
            <Send className="lucide" /> Send signature test
          </h3>
          <button
            type="button"
            className="ghost-btn icon-btn"
            onClick={onClose}
          >
            <X className="lucide" />
          </button>
        </div>
        <p className="muted" style={{ marginTop: 0, fontSize: '0.85em' }}>
          Sends a real email using <strong>{signature.name}</strong> through
          the workspace&apos;s active mailbox. Verify the rendering in your
          mail client (Gmail / Outlook handle inline CSS differently).
        </p>
        <label>
          <span>Recipient</span>
          <input
            type="email"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="me@example.com"
            disabled={busy}
            autoFocus
            style={{ width: '100%' }}
          />
        </label>
        <div className="action-row" style={{ marginTop: '0.75rem' }}>
          <button
            type="button"
            onClick={send}
            disabled={busy}
            className="primary-btn"
          >
            {busy ? 'Sending…' : 'Send test'}
          </button>
          <button type="button" onClick={onClose} className="ghost-btn">
            Cancel
          </button>
        </div>
        {info ? <p className="form-info">{info}</p> : null}
        {error ? <p className="form-error">{error}</p> : null}
      </div>
    </div>
  );
}
