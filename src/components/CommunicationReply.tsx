'use client';

// Phase 57 — reply composer inside the communication detail page.
// Submits a server action (defined alongside the parent server
// component) that calls mail.sendMessage. Carries an inline signature
// picker — defaults to the mailbox default, operator can pick a
// different one or "no signature" as a one-shot for this reply
// without touching the workspace default.

import { useState, useTransition } from 'react';
import { Languages } from 'lucide-react';

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
  /** Language the operator writes in. */
  nativeLanguage: string;
  /** Recipient's resolved language, or null when it matches native / no lead. */
  targetLanguage: string | null;
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
  nativeLanguage,
  targetLanguage,
}: CommunicationReplyProps) {
  const [to, setTo] = useState(defaultTo);
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState('');
  const [signaturePick, setSignaturePick] = useState<'__default__' | '__none__' | string>(
    '__default__',
  );
  const [tSubject, setTSubject] = useState('');
  const [tBody, setTBody] = useState('');
  const [shown, setShown] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const canTranslate = Boolean(targetLanguage) && targetLanguage !== nativeLanguage;
  const isRtl = targetLanguage === 'he' || targetLanguage === 'ar';

  async function showTranslation() {
    if (!targetLanguage) return;
    setTranslating(true);
    setError(null);
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, body, targetLanguage }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        subject?: string;
        body?: string;
        detail?: string;
        error?: string;
      };
      if (!res.ok || !j.ok) {
        setError(j.detail || j.error || `translate failed (${res.status})`);
        return;
      }
      setTSubject(j.subject ?? subject);
      setTBody(j.body ?? body);
      setShown(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTranslating(false);
    }
  }

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
            // When a translation is shown, send it (with the native body kept
            // as the thread reference); otherwise send the body as written.
            ...(shown && canTranslate
              ? {
                  targetLanguage,
                  translatedSubject: tSubject,
                  translatedBody: tBody,
                }
              : {}),
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
        gap: '0.75rem',
        borderTop: '1px solid var(--brand-border)',
        paddingTop: '1rem',
        marginTop: '0.5rem',
      }}
    >
      <h3 style={{ margin: 0, fontSize: '0.95rem' }}>Reply</h3>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '0.5rem',
        }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
          <span style={{ fontSize: '0.72rem' }} className="muted">
            To
          </span>
          <input
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            required
            style={{ width: '100%' }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
          <span style={{ fontSize: '0.72rem' }} className="muted">
            Signature
            <span style={{ color: 'var(--brand-muted)', fontWeight: 'normal' }}>
              {' · '}
              {defaultLabel}
            </span>
          </span>
          <select
            value={signaturePick}
            onChange={(e) =>
              setSignaturePick(
                e.target.value as '__default__' | '__none__' | string,
              )
            }
            style={{ width: '100%' }}
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
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
        <span style={{ fontSize: '0.72rem' }} className="muted">
          Subject
        </span>
        <input
          type="text"
          value={subject}
          onChange={(e) => {
            setSubject(e.target.value);
            if (shown) setShown(false);
          }}
          required
          style={{ width: '100%' }}
        />
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
        <span style={{ fontSize: '0.72rem' }} className="muted">
          Body — signature appended automatically on send
        </span>
        <textarea
          rows={14}
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            if (shown) setShown(false);
          }}
          required
          placeholder="Write your reply here…"
          style={{
            width: '100%',
            minHeight: '22ch',
            resize: 'vertical',
            fontFamily: 'inherit',
            fontSize: '0.92rem',
            lineHeight: 1.55,
            padding: '0.75rem',
          }}
        />
      </label>

      {canTranslate ? (
        <div className="action-row" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="ghost-btn"
            onClick={showTranslation}
            disabled={translating || !body || !subject}
          >
            <Languages className="primary-btn-icon" aria-hidden="true" />{' '}
            {translating
              ? 'Translating…'
              : shown
                ? 'Re-translate'
                : `Show translation (${targetLanguage})`}
          </button>
          {!shown ? (
            <span className="muted" style={{ fontSize: '0.72rem', alignSelf: 'center' }}>
              Recipient&rsquo;s language is {targetLanguage} — translate to send in their language.
            </span>
          ) : null}
        </div>
      ) : null}

      {canTranslate && shown ? (
        <section>
          <p className="muted" style={{ fontSize: '0.72rem' }}>
            This is the exact email the recipient receives ({targetLanguage}).
            Your reply above is kept as the thread reference — edit if needed.
          </p>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
            <span style={{ fontSize: '0.72rem' }} className="muted">
              Subject ({targetLanguage})
            </span>
            <input
              type="text"
              value={tSubject}
              onChange={(e) => setTSubject(e.target.value)}
              dir={isRtl ? 'rtl' : 'ltr'}
              style={{ width: '100%' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
            <span style={{ fontSize: '0.72rem' }} className="muted">
              Message ({targetLanguage})
            </span>
            <textarea
              rows={14}
              value={tBody}
              onChange={(e) => setTBody(e.target.value)}
              dir={isRtl ? 'rtl' : 'ltr'}
              style={{
                width: '100%',
                minHeight: '22ch',
                resize: 'vertical',
                fontFamily: 'inherit',
                fontSize: '0.92rem',
                lineHeight: 1.55,
                padding: '0.75rem',
              }}
            />
          </label>
        </section>
      ) : null}

      <div
        className="action-row"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          flexWrap: 'wrap',
        }}
      >
        <button
          type="button"
          onClick={send}
          disabled={
            isPending ||
            !to ||
            !subject ||
            !body ||
            (canTranslate && shown && !tBody.trim())
          }
          className="primary-btn"
        >
          {isPending
            ? 'Sending…'
            : canTranslate && shown
              ? `Send translated (${targetLanguage})`
              : 'Send reply'}
        </button>
        {info ? (
          <span className="form-info" style={{ margin: 0, fontSize: '0.82rem' }}>
            {info}
          </span>
        ) : null}
        {error ? (
          <span className="form-error" style={{ margin: 0, fontSize: '0.82rem' }}>
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}
