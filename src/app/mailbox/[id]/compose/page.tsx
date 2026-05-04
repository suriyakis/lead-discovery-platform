import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { MailboxServiceError, getMailbox } from '@/lib/services/mailbox';
import { MailServiceError, sendMessage } from '@/lib/services/mail';
import { defaultSignature, listSignatures } from '@/lib/services/signatures';

export default async function ComposeMessagePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    to?: string;
    subject?: string;
    body?: string;
    error?: string;
    draftId?: string;
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
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/mailbox');
    throw err;
  }

  let mailbox;
  try {
    mailbox = await getMailbox(ctx, id);
  } catch (err) {
    if (err instanceof MailboxServiceError && err.code === 'not_found') {
      redirect('/mailbox');
    }
    throw err;
  }

  const sigs = await listSignatures(ctx, { mailboxId: id });
  const def = await defaultSignature(ctx, id);
  const initialBody =
    sp.body ?? (def ? `\n\n${def.bodyText}` : '');

  async function send(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const toRaw = String(formData.get('to') ?? '').trim();
    const ccRaw = String(formData.get('cc') ?? '').trim();
    const bccRaw = String(formData.get('bcc') ?? '').trim();
    const subject = String(formData.get('subject') ?? '').trim();
    const text = String(formData.get('body') ?? '');
    const draftIdRaw = String(formData.get('draftId') ?? '');

    const parseList = (s: string) =>
      s
        .split(/[,\n]+/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((address) => ({ address }));

    try {
      const created = await sendMessage(c, {
        mailboxId: id,
        to: parseList(toRaw),
        cc: ccRaw ? parseList(ccRaw) : undefined,
        bcc: bccRaw ? parseList(bccRaw) : undefined,
        subject,
        text,
        sourceDraftId: /^\d+$/.test(draftIdRaw) ? BigInt(draftIdRaw) : undefined,
      });
      redirect(`/mailbox/threads/${created.threadId}`);
    } catch (err) {
      if (err instanceof MailServiceError || err instanceof MailboxServiceError) {
        const params = new URLSearchParams({
          to: toRaw,
          subject,
          body: text,
          error: err.message,
        });
        redirect(`/mailbox/${id}/compose?${params.toString()}`);
      }
      throw err;
    }
  }

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/mailbox">Mailbox</Link> /{' '}
          <Link href={`/mailbox/${id}`}>{mailbox.name}</Link> / Compose
        </p>
        <h1>Compose</h1>
        <p className="muted">
          Sending from <code>{mailbox.fromAddress}</code>
          {mailbox.fromName ? <> · {mailbox.fromName}</> : null}
        </p>
        {sp.error ? <p className="form-error">{sp.error}</p> : null}
        {sigs.length > 1 ? (
          <p className="muted">
            {sigs.length} signatures available — paste manually if you want a different one. Default is auto-appended.
          </p>
        ) : null}

        <form action={send} className="edit-draft-form">
          {sp.draftId ? <input type="hidden" name="draftId" value={sp.draftId} /> : null}
          <label>
            <span>To (comma or newline separated)</span>
            <input type="text" name="to" defaultValue={sp.to ?? ''} required />
          </label>
          <label>
            <span>Cc (optional)</span>
            <input type="text" name="cc" />
          </label>
          <label>
            <span>Bcc (optional)</span>
            <input type="text" name="bcc" />
          </label>
          <label>
            <span>Subject</span>
            <input type="text" name="subject" defaultValue={sp.subject ?? ''} required maxLength={300} />
          </label>
          <label>
            <span>Message</span>
            <textarea name="body" defaultValue={initialBody} rows={16} required maxLength={50000} />
          </label>
          <div className="action-row">
            <button type="submit" className="primary-btn">
              Send
            </button>
            <Link href={`/mailbox/${id}`} className="ghost-btn">
              Cancel
            </Link>
          </div>
        </form>
      </AppShell>
  );
}
