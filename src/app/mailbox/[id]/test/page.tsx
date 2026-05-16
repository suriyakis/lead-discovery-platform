import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import {
  MailboxServiceError,
  getMailbox,
} from '@/lib/services/mailbox';
import { listSignatures } from '@/lib/services/signatures';
import { sendTestEmail } from '@/lib/services/mail';
import { isNextRedirectError } from '@/lib/server-redirect';

const DEFAULT_BODY = `This is a test message from your Lead Discovery Platform mailbox.

If you are reading this, the SMTP transport worked end-to-end. Check that:
  - The From address is your mailbox identity.
  - The Reply-To header points where you expect.
  - The signature below renders the way it should in your mail client.
  - The message did NOT land in spam.

Send this test to yourself or to a Gmail/Outlook address you control so
you can inspect deliverability + signature rendering in real conditions.`;

export default async function TestEmailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    message?: string;
    error?: string;
    messageId?: string;
    smtpResponse?: string;
    signatureName?: string;
    appendedSignature?: string;
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

  let mailbox;
  try {
    mailbox = await getMailbox(ctx, id);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof MailboxServiceError && err.code === 'not_found') {
      redirect('/mailbox');
    }
    throw err;
  }

  // Signatures available for this mailbox (both mailbox-scoped + workspace-wide).
  const signatures = await listSignatures(ctx, { mailboxId: id });

  async function send(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const to = String(formData.get('to') ?? '').trim();
    const subject = String(formData.get('subject') ?? '').trim();
    const body = String(formData.get('body') ?? '');
    const signatureRaw = String(formData.get('signatureId') ?? '__default__');
    const signatureId: bigint | null | undefined =
      signatureRaw === '__default__'
        ? undefined
        : signatureRaw === '__none__'
          ? null
          : /^\d+$/.test(signatureRaw)
            ? BigInt(signatureRaw)
            : undefined;
    try {
      const result = await sendTestEmail(c, {
        mailboxId: id,
        to,
        subject,
        body,
        signatureId,
      });
      const params = new URLSearchParams({
        message: 'Test email sent. Check the recipient inbox.',
        messageId: result.messageId,
        smtpResponse: result.smtpResponse,
        signatureName: result.signatureName ?? '',
        appendedSignature: result.appendedSignature ? '1' : '0',
      });
      redirect(`/mailbox/${id}/test?${params.toString()}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof Error ? err.message : 'test send failed';
      redirect(`/mailbox/${id}/test?error=${encodeURIComponent(m)}`);
    }
  }

  return (
    <AppShell>
      <p className="muted">
        <Link href="/dashboard">Dashboard</Link> /{' '}
        <Link href="/mailbox">Mailbox</Link> /{' '}
        <Link href={`/mailbox/${id}`}>{mailbox.name}</Link> / Test email
      </p>
      <div className="page-header">
        <div className="page-intro">
          <p className="page-eyebrow">Diagnostics</p>
          <h1 className="page-title">Send a test email</h1>
          <p className="page-lede">
            Verifies SMTP delivery and signature rendering through{' '}
            <code>{mailbox.fromAddress}</code>. Test sends bypass the
            unsubscribe footer + tracking pixel + threads list, so they
            won&apos;t clutter your inbox view. An <code>audit_log</code>
            entry is written so the send is traceable.
          </p>
        </div>
      </div>

      {sp.message ? (
        <section className="form-info" style={{ marginBottom: '1rem' }}>
          <strong>{sp.message}</strong>
          <dl style={{ marginTop: '0.5rem' }}>
            {sp.messageId ? (
              <>
                <dt>Message-ID</dt>
                <dd>
                  <code>{sp.messageId}</code>
                </dd>
              </>
            ) : null}
            {sp.smtpResponse ? (
              <>
                <dt>SMTP response</dt>
                <dd>
                  <code>{sp.smtpResponse}</code>
                </dd>
              </>
            ) : null}
            <dt>Signature</dt>
            <dd>
              {sp.appendedSignature === '1' ? (
                <>appended ({sp.signatureName || 'default'})</>
              ) : (
                <>none</>
              )}
            </dd>
          </dl>
        </section>
      ) : null}
      {sp.error ? <p className="form-error">{sp.error}</p> : null}

      <form action={send} className="edit-draft-form">
        <label>
          <span>To</span>
          <input
            type="email"
            name="to"
            defaultValue={mailbox.fromAddress}
            required
          />
          <small className="muted">
            Defaults to your own address so the message loops back through
            IMAP — easiest way to confirm both directions work + see the
            signature in your mail client. Switch to a Gmail/Outlook
            address to test cross-provider deliverability.
          </small>
        </label>

        <label>
          <span>Subject</span>
          <input
            type="text"
            name="subject"
            defaultValue={`Deliverability test from ${mailbox.name}`}
            required
            maxLength={240}
          />
        </label>

        <label>
          <span>Body</span>
          <textarea name="body" rows={10} defaultValue={DEFAULT_BODY} required />
        </label>

        <label>
          <span>Signature</span>
          <select name="signatureId" defaultValue="__default__">
            <option value="__default__">
              Use mailbox default
            </option>
            <option value="__none__">No signature (plain body)</option>
            {signatures.map((s) => (
              <option key={s.id.toString()} value={s.id.toString()}>
                {s.name}
                {s.isDefault ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </label>

        <div className="action-row">
          <button type="submit" className="primary-btn">
            Send test
          </button>
          <Link href={`/mailbox/${id}`} className="ghost-btn">
            Cancel
          </Link>
        </div>
      </form>
    </AppShell>
  );
}
