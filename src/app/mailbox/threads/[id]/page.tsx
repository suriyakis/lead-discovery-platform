import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BrandHeader } from '@/components/BrandHeader';
import { auth, signOut } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { MailServiceError, getThread, sendMessage } from '@/lib/services/mail';
import { getMailbox } from '@/lib/services/mailbox';

export default async function ThreadDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
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
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/mailbox');
    throw err;
  }

  let detail;
  try {
    detail = await getThread(ctx, id);
  } catch (err) {
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
      if (err instanceof MailServiceError) {
        redirect(`/mailbox/threads/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
  }

  return (
    <>
      <BrandHeader
        rightSlot={
          <>
            <span className="who">{session.user.email}</span>
            <form
              action={async () => {
                'use server';
                await signOut({ redirectTo: '/' });
              }}
            >
              <button type="submit" className="ghost-btn">
                Sign out
              </button>
            </form>
          </>
        }
      />
      <main>
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
              </li>
            ))}
          </ul>
        </section>

        {mailbox.status !== 'archived' ? (
          <section>
            <h2>Reply</h2>
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
                <textarea name="body" rows={10} required maxLength={50000} />
              </label>
              <div className="action-row">
                <button type="submit" className="primary-btn">
                  Send reply
                </button>
              </div>
            </form>
          </section>
        ) : null}
      </main>
    </>
  );
}
