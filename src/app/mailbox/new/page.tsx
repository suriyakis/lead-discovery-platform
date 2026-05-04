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
  createMailbox,
} from '@/lib/services/mailbox';

export default async function NewMailboxPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  try {
    await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <AppShell>
            <h1>New mailbox</h1>
            <p>You don&apos;t belong to a workspace yet.</p>
          </AppShell>
      );
    }
    throw err;
  }

  async function create(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const name = String(formData.get('name') ?? '').trim();
    const fromAddress = String(formData.get('fromAddress') ?? '').trim();
    const fromName = String(formData.get('fromName') ?? '').trim() || null;
    const replyTo = String(formData.get('replyTo') ?? '').trim() || null;
    const smtpHost = String(formData.get('smtpHost') ?? '').trim();
    const smtpPortRaw = String(formData.get('smtpPort') ?? '587');
    const smtpPort = /^\d+$/.test(smtpPortRaw) ? Number(smtpPortRaw) : 587;
    const smtpSecure = formData.get('smtpSecure') === 'on';
    const smtpUser = String(formData.get('smtpUser') ?? '').trim();
    const smtpPassword = String(formData.get('smtpPassword') ?? '');
    const useImap = formData.get('useImap') === 'on';
    const isDefault = formData.get('isDefault') === 'on';

    let imap: Parameters<typeof createMailbox>[1]['imap'] = null;
    if (useImap) {
      const imapPortRaw = String(formData.get('imapPort') ?? '993');
      imap = {
        host: String(formData.get('imapHost') ?? '').trim(),
        port: /^\d+$/.test(imapPortRaw) ? Number(imapPortRaw) : 993,
        secure: formData.get('imapSecure') !== 'off',
        user: String(formData.get('imapUser') ?? '').trim(),
        password: String(formData.get('imapPassword') ?? ''),
        folder: String(formData.get('imapFolder') ?? 'INBOX').trim() || 'INBOX',
      };
    }

    try {
      const created = await createMailbox(c, {
        name,
        fromAddress,
        fromName,
        replyTo,
        smtpHost,
        smtpPort,
        smtpSecure,
        smtpUser,
        smtpPassword,
        imap,
        isDefault,
      });
      redirect(`/mailbox/${created.id}`);
    } catch (err) {
      if (err instanceof MailboxServiceError) {
        redirect(`/mailbox/new?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
  }

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/mailbox">Mailbox</Link> / New
        </p>
        <h1>New mailbox</h1>
        {sp.error ? <p className="form-error">{sp.error}</p> : null}

        <form action={create} className="edit-draft-form">
          <label>
            <span>Display name</span>
            <input type="text" name="name" placeholder="Sales — jb@nulife.pl" required />
          </label>

          <fieldset className="ks-kind-fields">
            <legend className="muted">Identity</legend>
            <label>
              <span>From address</span>
              <input type="email" name="fromAddress" required />
            </label>
            <label>
              <span>From name (optional)</span>
              <input type="text" name="fromName" />
            </label>
            <label>
              <span>Reply-To (optional, defaults to From)</span>
              <input type="email" name="replyTo" />
            </label>
          </fieldset>

          <fieldset className="ks-kind-fields">
            <legend className="muted">SMTP (outbound)</legend>
            <label>
              <span>Host</span>
              <input type="text" name="smtpHost" required placeholder="smtp.example.com" />
            </label>
            <label>
              <span>Port</span>
              <input type="number" name="smtpPort" defaultValue="587" min={1} max={65535} />
            </label>
            <label className="checkbox-row">
              <input type="checkbox" name="smtpSecure" />
              <span>SSL/TLS on connect (typical for port 465)</span>
            </label>
            <label>
              <span>User</span>
              <input type="text" name="smtpUser" required />
            </label>
            <label>
              <span>Password</span>
              <input type="password" name="smtpPassword" required autoComplete="new-password" />
            </label>
          </fieldset>

          <fieldset className="ks-kind-fields">
            <legend className="muted">IMAP (inbound — optional)</legend>
            <label className="checkbox-row">
              <input type="checkbox" name="useImap" defaultChecked />
              <span>Enable IMAP</span>
            </label>
            <label>
              <span>Host</span>
              <input type="text" name="imapHost" placeholder="imap.example.com" />
            </label>
            <label>
              <span>Port</span>
              <input type="number" name="imapPort" defaultValue="993" min={1} max={65535} />
            </label>
            <label className="checkbox-row">
              <input type="checkbox" name="imapSecure" defaultChecked />
              <span>SSL/TLS on connect (typical for port 993)</span>
            </label>
            <label>
              <span>User</span>
              <input type="text" name="imapUser" />
            </label>
            <label>
              <span>Password</span>
              <input type="password" name="imapPassword" autoComplete="new-password" />
            </label>
            <label>
              <span>Folder</span>
              <input type="text" name="imapFolder" defaultValue="INBOX" />
            </label>
          </fieldset>

          <label className="checkbox-row">
            <input type="checkbox" name="isDefault" />
            <span>Set as default mailbox for this workspace</span>
          </label>

          <div className="action-row">
            <button type="submit" className="primary-btn">
              Create mailbox
            </button>
            <Link href="/mailbox" className="ghost-btn">
              Cancel
            </Link>
          </div>
        </form>
      </AppShell>
  );
}
