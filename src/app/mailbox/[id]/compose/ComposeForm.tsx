'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Languages } from 'lucide-react';
import { translateComposeAction, sendComposeAction } from './actions';

interface Props {
  mailboxId: string;
  initialTo: string;
  initialSubject: string;
  initialBody: string;
  languageOptions: ReadonlyArray<{ code: string; name: string }>;
  /** Language the operator writes in; translating to it is a no-op. */
  nativeLanguage: string;
  cancelHref: string;
  draftId?: string;
}

export function ComposeForm({
  mailboxId,
  initialTo,
  initialSubject,
  initialBody,
  languageOptions,
  nativeLanguage,
  cancelHref,
  draftId,
}: Props) {
  const router = useRouter();
  const [to, setTo] = useState(initialTo);
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [target, setTarget] = useState('');
  const [tSubject, setTSubject] = useState('');
  const [tBody, setTBody] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const willTranslate = Boolean(target && target !== nativeLanguage);
  const isRtl = target === 'he' || target === 'ar';

  // Editing the native body invalidates a stale translation.
  function onNativeChange(setter: (v: string) => void, v: string) {
    setter(v);
    if (shown) setShown(false);
  }

  async function onShowTranslation() {
    setBusy(true);
    setError('');
    try {
      const r = await translateComposeAction({ subject, body, targetLanguage: target });
      setTSubject(r.subject);
      setTBody(r.body);
      setShown(true);
    } catch {
      setError('Translation failed — try again.');
    } finally {
      setBusy(false);
    }
  }

  async function onSend() {
    setBusy(true);
    setError('');
    const res = await sendComposeAction({
      mailboxId,
      to,
      cc,
      bcc,
      subject,
      body,
      targetLanguage: willTranslate && shown ? target : '',
      translatedSubject: shown ? tSubject : '',
      translatedBody: shown ? tBody : '',
      draftId,
    });
    if (res.ok) {
      router.push(res.threadId ? `/communication/${res.threadId}` : '/mailbox');
    } else {
      setError(res.error);
      setBusy(false);
    }
  }

  return (
    <div className="edit-draft-form">
      {error ? <p className="form-error">{error}</p> : null}
      <label>
        <span>To (comma or newline separated)</span>
        <input type="text" value={to} onChange={(e) => setTo(e.target.value)} required />
      </label>
      <label>
        <span>Cc (optional)</span>
        <input type="text" value={cc} onChange={(e) => setCc(e.target.value)} />
      </label>
      <label>
        <span>Bcc (optional)</span>
        <input type="text" value={bcc} onChange={(e) => setBcc(e.target.value)} />
      </label>
      <label>
        <span>Subject</span>
        <input
          type="text"
          value={subject}
          onChange={(e) => onNativeChange(setSubject, e.target.value)}
          maxLength={300}
          required
        />
      </label>
      <label>
        <span>Message</span>
        <textarea
          value={body}
          onChange={(e) => onNativeChange(setBody, e.target.value)}
          rows={16}
          maxLength={50000}
          required
        />
      </label>

      <label>
        <span>Recipient language</span>
        <select value={target} onChange={(e) => { setTarget(e.target.value); setShown(false); }}>
          <option value="">Don&rsquo;t translate — send as written</option>
          {languageOptions.map((o) => (
            <option key={o.code} value={o.code}>
              {o.name}
            </option>
          ))}
        </select>
      </label>

      {willTranslate ? (
        <div className="action-row">
          <button
            type="button"
            className="ghost-btn"
            onClick={onShowTranslation}
            disabled={busy}
          >
            <Languages className="primary-btn-icon" aria-hidden="true" />{' '}
            {shown ? 'Re-translate' : 'Show translation'}
          </button>
        </div>
      ) : null}

      {willTranslate && shown ? (
        <section style={{ marginTop: '0.5rem' }}>
          <p className="muted">
            This exact text is what the recipient receives (your draft above is
            kept as the reference). Edit it if you like.
          </p>
          <label>
            <span>Subject ({target})</span>
            <input
              type="text"
              value={tSubject}
              onChange={(e) => setTSubject(e.target.value)}
              maxLength={300}
              dir={isRtl ? 'rtl' : 'ltr'}
            />
          </label>
          <label>
            <span>Message ({target})</span>
            <textarea
              value={tBody}
              onChange={(e) => setTBody(e.target.value)}
              rows={16}
              maxLength={50000}
              dir={isRtl ? 'rtl' : 'ltr'}
            />
          </label>
        </section>
      ) : null}

      <div className="action-row">
        <button type="button" className="primary-btn" onClick={onSend} disabled={busy}>
          {busy ? 'Working…' : willTranslate && shown ? 'Send translated' : 'Send'}
        </button>
        <Link href={cancelHref} className="ghost-btn">
          Cancel
        </Link>
      </div>
    </div>
  );
}
