'use client';

// Phase 57 — reply composer inside the communication detail page.
// Submits a server action (defined alongside the parent server
// component) that calls mail.sendMessage. Carries an inline signature
// picker — defaults to the mailbox default, operator can pick a
// different one or "no signature" as a one-shot for this reply
// without touching the workspace default.

import { useState, useTransition } from 'react';

interface SignatureOption {
  id: string;
  name: string;
  isDefault: boolean;
}

interface CommunicationReplyProps {
  threadId: string;
  mailboxId: string;
  defaultTo: string;
  defaultSubject: string;
  inReplyTo: string | null;
  references: string[];
  signatures: ReadonlyArray<SignatureOption>;
  defaultSignatureId: string | null;
}

export function CommunicationReply({
  threadId,
  mailboxId,
  defaultTo,
  defaultSubject,
  inReplyTo,
  references,
  signatures,
  defaultSignatureId,
}: CommunicationReplyProps) {
  const [to, setTo] = useState(defaultTo);
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState('');
  const [signaturePick, setSignaturePick] = useState<'__default__' | '__none__' | string>(
    '__default__',
  );
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  function send() {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/communication/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            threadId,
            mailboxId,
            to,
            subject,
            body,
            inReplyTo,
            references,
            signatureId: signaturePick,
          }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          messageId?: string;
          error?: string;
          detail?: string;
        };
        if (!res.ok || !j.ok) {
          setError(j.detail || j.error || `request failed (${res.status})`);
          return;
        }
        setInfo(`Sent — message-id ${j.messageId ?? '?'}.`);
        setBody('');
        // Refresh the page so the new message appears in the thread.
        setTimeout(() => {
          window.location.reload();
        }, 800);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  const defaultLabel = (() => {
    if (!defaultSignatureId) return 'No default signature for this mailbox.';
    const def = signatures.find((s) => s.id === defaultSignatureId);
    return def ? `Default: ${def.name}` : `Default: id ${defaultSignatureId}`;
  })();

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        borderTop: '1px solid var(--brand-border)',
        paddingTop: '0.75rem',
      }}
    >
      <strong style={{ fontSize: '0.9em' }}>Reply</strong>

      <label>
        <span style={{ fontSize: '0.78em' }} className="muted">
          To
        </span>
        <input
          type="email"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          required
        />
      </label>

      <label>
        <span style={{ fontSize: '0.78em' }} className="muted">
          Subject
        </span>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          required
        />
      </label>

      <label>
        <span style={{ fontSize: '0.78em' }} className="muted">
          Body (signature appended automatically — pick below)
        </span>
        <textarea
          rows={8}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
          placeholder="Write your reply here. The selected signature is appended on send."
        />
      </label>

      <label>
        <span style={{ fontSize: '0.78em' }} className="muted">
          Signature{' '}
          <span style={{ fontWeight: 'normal' }}>· {defaultLabel}</span>
        </span>
        <select
          value={signaturePick}
          onChange={(e) =>
            setSignaturePick(
              e.target.value as '__default__' | '__none__' | string,
            )
          }
        >
          <option value="__default__">
            Use mailbox default {defaultSignatureId ? '(active)' : ''}
          </option>
          <option value="__none__">No signature (just the body)</option>
          {signatures.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.isDefault ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </label>

      <div className="action-row">
        <button
          type="button"
          onClick={send}
          disabled={isPending || !to || !subject || !body}
          className="primary-btn"
        >
          {isPending ? 'Sending…' : 'Send reply'}
        </button>
      </div>

      {info ? <p className="form-info">{info}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}
