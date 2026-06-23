'use client';

// Editable approval form for an awaiting-approval follow-up, with the same
// "show + edit translation before sending" flow as drafts / compose / reply.
// The AI-composed body is in the workspace native language; the operator can
// translate it to the recipient's language, edit it, and approve — the
// reviewed translation is sent verbatim. Submits to the parent server action.

import { useState, type CSSProperties } from 'react';
import { Languages } from 'lucide-react';

interface Props {
  id: string;
  stagedSubject: string;
  stagedBody: string;
  /** Recipient's resolved language, or null when it matches native / no lead. */
  targetLanguage: string | null;
  approveAction: (formData: FormData) => void | Promise<void>;
}

export function FollowUpApprovalRow({
  id,
  stagedSubject,
  stagedBody,
  targetLanguage,
  approveAction,
}: Props) {
  const [subject, setSubject] = useState(stagedSubject);
  const [body, setBody] = useState(stagedBody);
  const [tSubject, setTSubject] = useState('');
  const [tBody, setTBody] = useState('');
  const [shown, setShown] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [error, setError] = useState('');

  const canTranslate = Boolean(targetLanguage);
  const isRtl = targetLanguage === 'he' || targetLanguage === 'ar';

  async function showTranslation() {
    if (!targetLanguage) return;
    setTranslating(true);
    setError('');
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

  const col: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.2rem',
  };
  const lbl: CSSProperties = { fontSize: '0.72em' };

  return (
    <form
      action={approveAction}
      style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}
    >
      <input type="hidden" name="id" value={id} />
      <label style={col}>
        <span style={lbl} className="muted">
          Subject
        </span>
        <input
          type="text"
          name="subject"
          value={subject}
          onChange={(e) => {
            setSubject(e.target.value);
            if (shown) setShown(false);
          }}
          required
        />
      </label>
      <label style={col}>
        <span style={lbl} className="muted">
          Body — what gets sent (signature auto-appended)
        </span>
        <textarea
          name="body"
          rows={10}
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            if (shown) setShown(false);
          }}
          required
          style={{ width: '100%', fontSize: '0.88rem', lineHeight: 1.55, padding: '0.5rem', resize: 'vertical' }}
        />
      </label>

      {canTranslate ? (
        <div className="action-row" style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="ghost-btn"
            onClick={showTranslation}
            disabled={translating || !subject || !body}
            style={{ fontSize: '0.85em' }}
          >
            <Languages className="primary-btn-icon" aria-hidden="true" />{' '}
            {translating
              ? 'Translating…'
              : shown
                ? 'Re-translate'
                : `Show translation (${targetLanguage})`}
          </button>
          {!shown ? (
            <span className="muted" style={{ fontSize: '0.72em', alignSelf: 'center' }}>
              Recipient&rsquo;s language is {targetLanguage} — translate to review what gets sent.
            </span>
          ) : null}
        </div>
      ) : null}

      {canTranslate && shown ? (
        <>
          <input type="hidden" name="targetLanguage" value={targetLanguage ?? ''} />
          <label style={col}>
            <span style={lbl} className="muted">
              Subject ({targetLanguage}) — sent to the recipient
            </span>
            <input
              type="text"
              name="translatedSubject"
              value={tSubject}
              onChange={(e) => setTSubject(e.target.value)}
              dir={isRtl ? 'rtl' : 'ltr'}
            />
          </label>
          <label style={col}>
            <span style={lbl} className="muted">
              Body ({targetLanguage}) — sent to the recipient
            </span>
            <textarea
              name="translatedBody"
              rows={10}
              value={tBody}
              onChange={(e) => setTBody(e.target.value)}
              dir={isRtl ? 'rtl' : 'ltr'}
              style={{ width: '100%', fontSize: '0.88rem', lineHeight: 1.55, padding: '0.5rem', resize: 'vertical' }}
            />
          </label>
        </>
      ) : null}

      {error ? (
        <span className="form-error" style={{ fontSize: '0.8em' }}>
          {error}
        </span>
      ) : null}

      <div className="action-row" style={{ display: 'flex', gap: '0.4rem' }}>
        <button type="submit" className="primary-btn" style={{ fontSize: '0.85em' }}>
          {canTranslate && shown ? `Approve & send (${targetLanguage})` : 'Approve & send'}
        </button>
      </div>
    </form>
  );
}
