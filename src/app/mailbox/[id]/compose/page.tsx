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
import { defaultSignature, listSignatures } from '@/lib/services/signatures';
import { getWorkspaceNativeLanguage } from '@/lib/services/workspace';
import { ENABLED_LANGUAGE_OPTIONS } from '@/lib/i18n/language';
import { ComposeForm } from './ComposeForm';

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
  const nativeLanguage = await getWorkspaceNativeLanguage(ctx);

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

        <ComposeForm
          mailboxId={id.toString()}
          initialTo={sp.to ?? ''}
          initialSubject={sp.subject ?? ''}
          initialBody={initialBody}
          languageOptions={ENABLED_LANGUAGE_OPTIONS}
          nativeLanguage={nativeLanguage}
          cancelHref={`/mailbox/${id}`}
          draftId={sp.draftId}
        />
      </AppShell>
  );
}
