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
  pauseMailbox,
  reactivateMailbox,
  updateMailbox,
} from '@/lib/services/mailbox';
import { isNextRedirectError } from '@/lib/server-redirect';

export default async function EditMailboxPage({
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

  async function save(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const smtpPortRaw = String(formData.get('smtpPort') ?? '');
    const smtpPort = /^\d+$/.test(smtpPortRaw) ? Number(smtpPortRaw) : undefined;
    const useImap = formData.get('useImap') === 'on';
    const imapPortRaw = String(formData.get('imapPort') ?? '');
    const newSmtpPassword = String(formData.get('smtpPassword') ?? '');
    const newImapPassword = String(formData.get('imapPassword') ?? '');

    const wantEnabled = formData.get('enabled') === 'on';

    try {
      await updateMailbox(c, id, {
        name: String(formData.get('name') ?? '').trim() || undefined,
        fromName: String(formData.get('fromName') ?? '').trim() || null,
        replyTo: String(formData.get('replyTo') ?? '').trim() || null,
        smtpHost: String(formData.get('smtpHost') ?? '').trim() || undefined,
        smtpPort,
        smtpSecure: formData.get('smtpSecure') === 'on',
        smtpUser: String(formData.get('smtpUser') ?? '').trim() || undefined,
        smtpPassword: newSmtpPassword || undefined,
        imap: useImap
          ? {
              host: String(formData.get('imapHost') ?? '').trim(),
              port: /^\d+$/.test(imapPortRaw) ? Number(imapPortRaw) : 993,
              secure: formData.get('imapSecure') === 'on',
              user: String(formData.get('imapUser') ?? '').trim(),
              password: newImapPassword || undefined,
              folder: String(formData.get('imapFolder') ?? 'INBOX').trim() || 'INBOX',
            }
          : null,
        isDefault: formData.get('isDefault') === 'on',
      });
      // Enabled toggle. Re-read the current status (could have
      // changed between render and submit) and route through the
      // helper that matches the transition: failing→active resets
      // counters via reactivateMailbox (admin-gated); paused→active
      // is a cheap status flip; active/failing→paused is sticky.
      const current = await getMailbox(c, id);
      if (current.status !== 'archived') {
        if (wantEnabled && current.status === 'paused') {
          await updateMailbox(c, id, { status: 'active' });
        } else if (wantEnabled && current.status === 'failing') {
          await reactivateMailbox(c, id);
        } else if (!wantEnabled && current.status !== 'paused') {
          await pauseMailbox(c, id);
        }
      }
      redirect(`/mailbox/${id}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      if (err instanceof MailboxServiceError) {
        redirect(`/mailbox/${id}/edit?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
  }

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/mailbox">Mailbox</Link> /{' '}
          <Link href={`/mailbox/${id}`}>{mailbox.name}</Link> / Edit
        </p>
        <h1>Edit mailbox</h1>
        {sp.error ? <p className="form-error">{sp.error}</p> : null}

        <p className="muted">
          Cannot change the From address after creation — create a new mailbox
          for that. Passwords stay encrypted; leave password fields blank to
          keep the existing values.
        </p>

        <form action={save} className="edit-draft-form">
          <fieldset className="ks-kind-fields">
            <legend className="muted">Mailbox status</legend>
            <label className="checkbox-row">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={mailbox.status !== 'paused'}
                disabled={mailbox.status === 'archived'}
              />
              <span>
                Enabled
                {mailbox.status === 'paused' ? (
                  <em className="muted"> — currently paused (no sends, no IMAP sync)</em>
                ) : mailbox.status === 'failing' ? (
                  <em className="muted"> — currently failing; un-checking pauses it, saving with this checked re-activates and resets the failure counter</em>
                ) : mailbox.status === 'archived' ? (
                  <em className="muted"> — archived mailboxes cannot be toggled here</em>
                ) : (
                  <em className="muted"> — un-check to pause sends and stop IMAP sync</em>
                )}
              </span>
            </label>
          </fieldset>

          <label>
            <span>Display name</span>
            <input type="text" name="name" defaultValue={mailbox.name} required />
          </label>

          <fieldset className="ks-kind-fields">
            <legend className="muted">Identity</legend>
            <dl>
              <dt>From address</dt>
              <dd>
                <code>{mailbox.fromAddress}</code>
              </dd>
            </dl>
            <label>
              <span>From name</span>
              <input type="text" name="fromName" defaultValue={mailbox.fromName ?? ''} />
            </label>
            <label>
              <span>Reply-To</span>
              <input type="email" name="replyTo" defaultValue={mailbox.replyTo ?? ''} />
            </label>
          </fieldset>

          <fieldset className="ks-kind-fields">
            <legend className="muted">SMTP</legend>
            <label>
              <span>Host</span>
              <input type="text" name="smtpHost" defaultValue={mailbox.smtpHost} required />
            </label>
            <label>
              <span>Port</span>
              <input type="number" name="smtpPort" defaultValue={mailbox.smtpPort} min={1} max={65535} />
            </label>
            <label className="checkbox-row">
              <input type="checkbox" name="smtpSecure" defaultChecked={mailbox.smtpSecure} />
              <span>SSL/TLS on connect</span>
            </label>
            <label>
              <span>User</span>
              <input type="text" name="smtpUser" defaultValue={mailbox.smtpUser} required />
            </label>
            <label>
              <span>Password (leave blank to keep current)</span>
              <input type="password" name="smtpPassword" autoComplete="new-password" />
            </label>
          </fieldset>

          <fieldset className="ks-kind-fields">
            <legend className="muted">IMAP</legend>
            <label className="checkbox-row">
              <input type="checkbox" name="useImap" defaultChecked={Boolean(mailbox.imapHost)} />
              <span>Enable IMAP</span>
            </label>
            <label>
              <span>Host</span>
              <input type="text" name="imapHost" defaultValue={mailbox.imapHost ?? ''} />
            </label>
            <label>
              <span>Port</span>
              <input type="number" name="imapPort" defaultValue={mailbox.imapPort ?? 993} min={1} max={65535} />
            </label>
            <label className="checkbox-row">
              <input type="checkbox" name="imapSecure" defaultChecked={mailbox.imapSecure} />
              <span>SSL/TLS</span>
            </label>
            <label>
              <span>User</span>
              <input type="text" name="imapUser" defaultValue={mailbox.imapUser ?? ''} />
            </label>
            <label>
              <span>Password (leave blank to keep current)</span>
              <input type="password" name="imapPassword" autoComplete="new-password" />
            </label>
            <label>
              <span>Folder</span>
              <input type="text" name="imapFolder" defaultValue={mailbox.imapFolder} />
            </label>
          </fieldset>

          <label className="checkbox-row">
            <input type="checkbox" name="isDefault" defaultChecked={mailbox.isDefault} />
            <span>Default mailbox for this workspace</span>
          </label>

          <div className="action-row">
            <button type="submit" className="primary-btn">
              Save changes
            </button>
            <Link href={`/mailbox/${id}`} className="ghost-btn">
              Cancel
            </Link>
          </div>
        </form>
      </AppShell>
  );
}
