import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Languages } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { MailServiceError, getThread, sendMessage } from '@/lib/services/mail';
import { getMailbox } from '@/lib/services/mailbox';
import {
  ReplyAssistantError,
  suggestReply,
} from '@/lib/services/reply-assistant';
import {
  TranslationError,
  translateFromEnglish,
  translateInboundToEnglish,
} from '@/lib/services/translation';
import { getLanguageName } from '@/lib/i18n/language';
import { isNextRedirectError } from '@/lib/server-redirect';

export default async function ThreadDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    error?: string;
    suggestion?: string;
    /** When set, the reply textarea pre-fills with the translated text. */
    translatedReply?: string;
    /** Target language used for the most recent reply translation. */
    translatedTo?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { id: idStr } = await params;
  if (!/^\d+$/.test(idStr)) redirect('/mailbox');
  const id = BigInt(idStr);
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/mailbox');
    throw err;
  }

  let detail;
  try {
    detail = await getThread(ctx, id);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof MailServiceError && err.code === 'not_found') {
      redirect('/mailbox');
    }
    throw err;
  }

  const { thread, messages } = detail;
  const mailbox = await getMailbox(ctx, thread.mailboxId);
  const lastMessage = messages[messages.length - 1] ?? null;

  // Build a sensible "Reply" address: pick the OTHER side of the last message.
  const replyTo =
    lastMessage && lastMessage.direction === 'inbound'
      ? lastMessage.fromAddress
      : lastMessage?.toAddresses[0] ?? '';

  async function suggest() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      const result = await suggestReply(c, { threadId: id });
      const params = new URLSearchParams({ suggestion: result.text });
      redirect(`/mailbox/threads/${id}?${params.toString()}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m =
        err instanceof ReplyAssistantError ? err.message :
        err instanceof Error ? err.message : 'suggest failed';
      redirect(`/mailbox/threads/${id}?error=${encodeURIComponent(m)}`);
    }
  }

  async function translateMessage(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const midRaw = String(formData.get('messageId') ?? '');
    if (!/^\d+$/.test(midRaw)) return;
    try {
      await translateInboundToEnglish(c, BigInt(midRaw));
      redirect(`/mailbox/threads/${id}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m =
        err instanceof TranslationError ? err.message :
        err instanceof Error ? err.message : 'translate failed';
      redirect(`/mailbox/threads/${id}?error=${encodeURIComponent(m)}`);
    }
  }

  async function translateReply(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const text = String(formData.get('body') ?? '').trim();
    const target = String(formData.get('targetLanguage') ?? '').trim();
    if (!text || !target) return;
    try {
      const result = await translateFromEnglish(c, {
        text,
        targetLanguage: target,
      });
      const params = new URLSearchParams({
        translatedReply: result.translatedText,
        translatedTo: result.targetLanguage,
      });
      redirect(`/mailbox/threads/${id}?${params.toString()}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m =
        err instanceof TranslationError ? err.message :
        err instanceof Error ? err.message : 'translate failed';
      redirect(`/mailbox/threads/${id}?error=${encodeURIComponent(m)}`);
    }
  }

  async function reply(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const toRaw = String(formData.get('to') ?? '').trim();
    const text = String(formData.get('body') ?? '').trim();
    const subject = String(formData.get('subject') ?? '').trim();
    if (!toRaw || !text) return;

    const inReplyTo = lastMessage?.messageId;
    const refs = lastMessage
      ? [...lastMessage.references, lastMessage.messageId]
      : [];

    try {
      await sendMessage(c, {
        mailboxId: thread.mailboxId,
        to: toRaw.split(/[,\n]+/).map((p) => ({ address: p.trim() })).filter((a) => a.address),
        subject,
        text,
        inReplyTo,
        references: refs,
      });
      redirect(`/mailbox/threads/${id}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      if (err instanceof MailServiceError) {
        redirect(`/mailbox/threads/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
  }

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/mailbox">Mailbox</Link> /{' '}
          <Link href={`/mailbox/${mailbox.id}`}>{mailbox.name}</Link> / Thread {thread.id.toString()}
        </p>
        <h1>{thread.subject || '(no subject)'}</h1>
        <p className="muted">
          {thread.messageCount} messages · {thread.participants.join(', ')}
        </p>

        {sp.error ? <p className="form-error">{sp.error}</p> : null}

        <section>
          <ul className="thread-list">
            {messages.map((m) => (
              <li
                key={m.id.toString()}
                className={m.direction === 'inbound' ? 'msg-inbound' : 'msg-outbound'}
              >
                <div className="msg-head">
                  <strong>{m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress}</strong>
                  <span className="muted"> → {m.toAddresses.join(', ')}</span>
                  <span className="muted"> · {(m.sentAt ?? m.receivedAt ?? m.createdAt).toLocaleString()}</span>
                  <span className={`badge ${m.direction === 'inbound' ? 'badge-good' : ''}`}>
                    {m.direction}
                  </span>
                </div>
                {m.subject && m.subject !== thread.subject ? (
                  <p className="muted">Subject: {m.subject}</p>
                ) : null}
                <pre className="draft-body">{m.bodyText ?? '(no plain-text body)'}</pre>

                {m.direction === 'inbound' && m.bodyText ? (
                  m.bodyTextEn ? (
                    <details className="msg-translation" open>
                      <summary>
                        <Languages className="msg-translation-icon" aria-hidden="true" />
                        <span>
                          English translation
                          {m.translatedFromLanguage
                            ? ` from ${getLanguageName(m.translatedFromLanguage)}`
                            : ''}
                        </span>
                      </summary>
                      <pre className="draft-body draft-body-translated">
                        {m.bodyTextEn}
                      </pre>
                    </details>
                  ) : (
                    <form action={translateMessage} className="msg-translate-form">
                      <input type="hidden" name="messageId" value={m.id.toString()} />
                      <button type="submit" className="ghost-btn">
                        <Languages className="msg-translation-icon" aria-hidden="true" />
                        <span>Translate to English</span>
                      </button>
                    </form>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        </section>

        {mailbox.status !== 'archived' ? (
          <section>
            <h2>Reply</h2>
            <div className="action-row" style={{ marginBottom: '0.75rem' }}>
              <form action={suggest}>
                <button type="submit">Suggest reply (RAG)</button>
              </form>
              <span className="muted" style={{ alignSelf: 'center' }}>
                Uses indexed documents + lessons to draft a grounded response.
              </span>
            </div>
            <form action={reply} className="edit-draft-form">
              <label>
                <span>To</span>
                <input type="text" name="to" defaultValue={replyTo} required />
              </label>
              <label>
                <span>Subject</span>
                <input
                  type="text"
                  name="subject"
                  defaultValue={
                    thread.subject.toLowerCase().startsWith('re:')
                      ? thread.subject
                      : `Re: ${thread.subject}`
                  }
                  required
                />
              </label>
              <label>
                <span>Message</span>
                <textarea
                  name="body"
                  rows={10}
                  required
                  maxLength={50000}
                  defaultValue={sp.translatedReply ?? sp.suggestion ?? ''}
                />
              </label>
              {sp.translatedTo ? (
                <p className="muted small">
                  Translated to {getLanguageName(sp.translatedTo)} (
                  {sp.translatedTo}). Review before sending.
                </p>
              ) : null}
              <div className="action-row">
                <button type="submit" className="primary-btn">
                  Send reply
                </button>
                {/* Same form, second action via formAction. Operator
                    picks the target language; clicking Translate
                    submits the form to translateReply, which redirects
                    back with ?translatedReply=... pre-filled. */}
                <span className="translate-inline">
                  <select name="targetLanguage" defaultValue="pl" aria-label="Target language">
                    <option value="pl">Polish</option>
                    <option value="de">German</option>
                    <option value="fr">French</option>
                    <option value="es">Spanish</option>
                    <option value="it">Italian</option>
                    <option value="ro">Romanian</option>
                    <option value="cs">Czech</option>
                    <option value="uk">Ukrainian</option>
                    <option value="nl">Dutch</option>
                    <option value="pt">Portuguese</option>
                  </select>
                  <button type="submit" formAction={translateReply} className="ghost-btn">
                    <Languages className="msg-translation-icon" aria-hidden="true" />
                    <span>Translate before send</span>
                  </button>
                </span>
              </div>
            </form>
          </section>
        ) : null}
      </AppShell>
  );
}
