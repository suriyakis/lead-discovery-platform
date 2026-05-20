import Link from 'next/link';
import { redirect } from 'next/navigation';
import { MessagesSquare, Search } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { CommunicationTabs } from '@/components/CommunicationTabs';
import { ConfirmFormButton } from '@/components/ConfirmFormButton';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { listMailboxes } from '@/lib/services/mailbox';
import {
  countMessagesByFolder,
  listMessages,
  markAsSpam,
  moveToTrash,
  permanentlyDelete,
  restoreFromTrash,
  retrySend,
  unmarkSpam,
} from '@/lib/services/mail';
import { MAIL_FOLDERS, type MailFolder } from '@/lib/services/mail-folders';
import { countFollowUpsByStatus } from '@/lib/services/follow-up';
import { isNextRedirectError } from '@/lib/server-redirect';

export default async function CommunicationPage({
  searchParams,
}: {
  searchParams: Promise<{
    folder?: string;
    mailboxId?: string;
    q?: string;
    message?: string;
    error?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <AppShell>
          <h1>Communication</h1>
          <p>You don&apos;t belong to a workspace yet.</p>
        </AppShell>
      );
    }
    throw err;
  }

  const folderParam = sp.folder ?? '';
  const activeFolder: MailFolder = (MAIL_FOLDERS as readonly string[]).includes(
    folderParam,
  )
    ? (folderParam as MailFolder)
    : 'inbox';
  const search = sp.q?.trim() ?? '';
  const mailboxIdFilter =
    sp.mailboxId && /^\d+$/.test(sp.mailboxId) ? BigInt(sp.mailboxId) : undefined;

  const [messageRows, folderCounts, mailboxes, followUpCounts] =
    await Promise.all([
      listMessages(ctx, {
        folder: activeFolder,
        mailboxId: mailboxIdFilter,
        limit: 200,
        search: search || undefined,
      }),
      countMessagesByFolder(ctx, mailboxIdFilter),
      listMailboxes(ctx),
      countFollowUpsByStatus(ctx),
    ]);

  // Server actions — bulk per-folder operations. Each parses ids[] from
  // FormData, calls the matching helper, and redirects back to the
  // same folder + search + mailbox filter.
  function backToFolder(formData: FormData, msg: string) {
    const params = makeRedirectParams(formData);
    params.set('message', msg);
    redirect(`/communication?${params.toString()}`);
  }
  function backToFolderError(formData: FormData, msg: string) {
    const params = makeRedirectParams(formData);
    params.set('error', msg);
    redirect(`/communication?${params.toString()}`);
  }
  function makeRedirectParams(formData: FormData): URLSearchParams {
    const folder = String(formData.get('folder') ?? 'inbox');
    const q = String(formData.get('q') ?? '');
    const mailboxId = String(formData.get('mailboxId') ?? '');
    const params = new URLSearchParams({ folder });
    if (q) params.set('q', q);
    if (mailboxId) params.set('mailboxId', mailboxId);
    return params;
  }
  function parseIds(formData: FormData): bigint[] {
    const out: bigint[] = [];
    for (const raw of formData.getAll('ids')) {
      const s = String(raw);
      if (!/^\d+$/.test(s)) continue;
      try {
        out.push(BigInt(s));
      } catch {
        // skip
      }
    }
    return out;
  }
  function affectedNote(verb: string, n: number): string {
    if (n === 0) return `No messages ${verb} (nothing was selected or eligible).`;
    if (n === 1) return `1 message ${verb}.`;
    return `${n} messages ${verb}.`;
  }

  async function trashSelected(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const ids = parseIds(formData);
    try {
      const r = await moveToTrash(c, ids);
      backToFolder(formData, affectedNote('moved to trash', r.affected));
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      backToFolderError(formData, err instanceof Error ? err.message : 'trash failed');
    }
  }
  async function restoreSelected(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const ids = parseIds(formData);
    try {
      const r = await restoreFromTrash(c, ids);
      backToFolder(formData, affectedNote('restored', r.affected));
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      backToFolderError(formData, err instanceof Error ? err.message : 'restore failed');
    }
  }
  async function spamSelected(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const ids = parseIds(formData);
    try {
      const r = await markAsSpam(c, ids, 'manual');
      backToFolder(formData, affectedNote('flagged as spam', r.affected));
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      backToFolderError(formData, err instanceof Error ? err.message : 'mark-spam failed');
    }
  }
  async function unspamSelected(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const ids = parseIds(formData);
    try {
      const r = await unmarkSpam(c, ids);
      backToFolder(formData, affectedNote('un-flagged', r.affected));
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      backToFolderError(formData, err instanceof Error ? err.message : 'unmark failed');
    }
  }
  async function deleteSelected(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const ids = parseIds(formData);
    try {
      const r = await permanentlyDelete(c, ids);
      backToFolder(formData, affectedNote('permanently deleted', r.affected));
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      backToFolderError(formData, err instanceof Error ? err.message : 'delete failed');
    }
  }
  async function retrySelected(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const ids = parseIds(formData);
    try {
      const r = await retrySend(c, ids);
      const parts: string[] = [];
      if (r.retried.length > 0)
        parts.push(
          r.retried.length === 1
            ? '1 message resent'
            : `${r.retried.length} messages resent`,
        );
      if (r.skippedHardBounce.length > 0)
        parts.push(`${r.skippedHardBounce.length} hard-bounced (skipped)`);
      if (r.skippedIneligible.length > 0)
        parts.push(`${r.skippedIneligible.length} ineligible`);
      if (r.errors.length > 0) parts.push(`${r.errors.length} failed`);
      backToFolder(
        formData,
        parts.length > 0 ? parts.join(', ') + '.' : 'Nothing to retry.',
      );
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      backToFolderError(formData, err instanceof Error ? err.message : 'retry failed');
    }
  }

  return (
    <AppShell>
      <div className="page-header">
        <div className="page-intro">
          <p className="page-eyebrow">Outreach</p>
          <h1 className="page-title">
            <MessagesSquare className="lucide" /> Communication
          </h1>
          <p className="page-lede">
            Every message across every mailbox in this workspace. Folders are
            derived from message state — a message moves from{' '}
            <strong>Queued → Sent</strong>, or gets pulled into{' '}
            <strong>Errors</strong> / <strong>Spam</strong> /{' '}
            <strong>Trash</strong>. Trash auto-purges after the workspace
            retention window.
          </p>
        </div>
      </div>

      <CommunicationTabs
        active="conversations"
        conversationsCount={folderCounts.inbox + folderCounts.sent}
        followUpsPendingCount={followUpCounts.pending}
      />

      {sp.message ? <p className="form-info">{sp.message}</p> : null}
      {sp.error ? <p className="form-error">{sp.error}</p> : null}

      {/* Folder tabs */}
      <div className="window-tabs" style={{ marginBottom: '0.75rem' }}>
        {MAIL_FOLDERS.map((f) => {
          const params = new URLSearchParams({ folder: f });
          if (search) params.set('q', search);
          if (mailboxIdFilter !== undefined)
            params.set('mailboxId', mailboxIdFilter.toString());
          return (
            <Link
              key={f}
              href={`/communication?${params.toString()}`}
              className={`window-tab${activeFolder === f ? ' window-tab-active' : ''}`}
            >
              {folderLabel(f)} <span className="badge">{folderCounts[f]}</span>
            </Link>
          );
        })}
      </div>

      {/* Search + mailbox filter */}
      <form
        method="get"
        action="/communication"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.5rem',
          alignItems: 'flex-end',
          marginBottom: '0.75rem',
        }}
      >
        <input type="hidden" name="folder" value={activeFolder} />
        <label style={{ flex: '2 1 280px', minWidth: 220 }}>
          <span className="muted" style={{ fontSize: '0.75rem' }}>
            Search (subject, from, to)
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Search
              className="lucide"
              style={{ width: 16, height: 16, color: 'var(--brand-muted)' }}
            />
            <input
              type="search"
              name="q"
              defaultValue={search}
              placeholder={`Search ${folderLabel(activeFolder)}…`}
              style={{ flex: 1 }}
            />
          </div>
        </label>
        <label style={{ flex: '1 1 180px', minWidth: 160 }}>
          <span className="muted" style={{ fontSize: '0.75rem' }}>
            Mailbox
          </span>
          <select
            name="mailboxId"
            defaultValue={mailboxIdFilter?.toString() ?? ''}
          >
            <option value="">— all mailboxes —</option>
            {mailboxes.map((m) => (
              <option key={m.id.toString()} value={m.id.toString()}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <button type="submit" className="primary-btn">
            Apply
          </button>
          {search || mailboxIdFilter !== undefined ? (
            <Link
              href={`/communication?folder=${activeFolder}`}
              className="ghost-btn"
            >
              Clear
            </Link>
          ) : null}
        </div>
      </form>

      {/* Message list with bulk-action bar */}
      {messageRows.length === 0 ? (
        <div className="empty-state">
          <p style={{ margin: 0, fontWeight: 600 }}>
            {search
              ? `No messages match "${search}" in ${folderLabel(activeFolder)}.`
              : emptyFolderHint(activeFolder)}
          </p>
        </div>
      ) : (
        <form>
          {/* Carry the active folder + search + mailbox forward so the
              post-action redirect lands on the same view. */}
          <input type="hidden" name="folder" value={activeFolder} />
          <input type="hidden" name="q" value={search} />
          <input
            type="hidden"
            name="mailboxId"
            value={mailboxIdFilter?.toString() ?? ''}
          />

          <div
            className="action-row"
            style={{
              marginBottom: '0.5rem',
              flexWrap: 'wrap',
              gap: '0.4rem',
              alignItems: 'center',
            }}
          >
            <span className="muted small">
              Select message(s) then choose an action:
            </span>
            {activeFolder === 'errors' ? (
              <button
                type="submit"
                formAction={retrySelected}
                className="primary-btn"
              >
                Retry selected
              </button>
            ) : null}
            {activeFolder !== 'trash' ? (
              <button type="submit" formAction={trashSelected}>
                Move to trash
              </button>
            ) : null}
            {activeFolder !== 'spam' && activeFolder !== 'trash' ? (
              <button type="submit" formAction={spamSelected}>
                Mark as spam
              </button>
            ) : null}
            {activeFolder === 'spam' ? (
              <button type="submit" formAction={unspamSelected}>
                Not spam
              </button>
            ) : null}
            {activeFolder === 'trash' ? (
              <button type="submit" formAction={restoreSelected}>
                Restore
              </button>
            ) : null}
            {activeFolder === 'trash' ? (
              <ConfirmFormButton
                formAction={deleteSelected}
                message="Permanently delete the selected message(s)? This cannot be undone."
                className="ghost-btn"
              >
                Delete permanently
              </ConfirmFormButton>
            ) : null}
          </div>

          <ul
            className="profile-list"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.4rem',
              margin: 0,
              padding: 0,
              listStyle: 'none',
            }}
          >
            {messageRows.map(({ message, thread }) => {
              const peer = derivePeer(message);
              const subject =
                message.subject || thread?.subject || '(no subject)';
              const when =
                message.sentAt ?? message.receivedAt ?? message.createdAt;
              const mailboxName =
                mailboxes.find((mb) => mb.id === message.mailboxId)?.name ?? null;
              return (
                <li key={message.id.toString()}>
                  <div
                    className="lead-row"
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.6rem',
                    }}
                  >
                    <input
                      type="checkbox"
                      name="ids"
                      value={message.id.toString()}
                      style={{ marginTop: '0.35rem' }}
                      aria-label={`Select message ${subject}`}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          flexWrap: 'wrap',
                        }}
                      >
                        {thread ? (
                          <Link
                            href={`/communication/${thread.id}`}
                            style={{ fontSize: '0.95em', fontWeight: 600 }}
                          >
                            {subject}
                          </Link>
                        ) : (
                          <strong style={{ fontSize: '0.95em' }}>
                            {subject}
                          </strong>
                        )}
                        <span className={statusBadgeClass(message.status)}>
                          {message.status}
                        </span>
                        {mailboxName ? (
                          <span className="badge">{mailboxName}</span>
                        ) : null}
                      </div>
                      <div
                        className="muted"
                        style={{ fontSize: '0.78em', marginTop: '0.2rem' }}
                      >
                        <span>
                          {message.direction === 'outbound' ? '→ ' : '← '}
                          {peer || '(unknown)'}
                        </span>
                        <span> · {when.toLocaleString()}</span>
                        {activeFolder === 'errors' && message.failureReason ? (
                          <span className="warn">
                            {' · '}
                            {message.failureReason}
                          </span>
                        ) : null}
                        {activeFolder === 'spam' && message.spamReason ? (
                          <span> · flag: {message.spamReason}</span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </form>
      )}
    </AppShell>
  );
}

function folderLabel(f: MailFolder): string {
  switch (f) {
    case 'inbox':
      return 'Inbox';
    case 'sent':
      return 'Sent';
    case 'queued':
      return 'Queued';
    case 'errors':
      return 'Errors';
    case 'spam':
      return 'Spam';
    case 'trash':
      return 'Trash';
  }
}

function emptyFolderHint(f: MailFolder): string {
  switch (f) {
    case 'inbox':
      return 'Inbox is empty. Inbound mail across all mailboxes will land here as it arrives.';
    case 'sent':
      return 'Nothing sent yet across any mailbox. Compose a message or let the outreach engine generate one.';
    case 'queued':
      return 'No queued sends. Drafts the outreach engine schedules will sit here briefly before going out.';
    case 'errors':
      return 'No send failures. If a send bounces or fails, it will surface here with a retry option.';
    case 'spam':
      return 'Nothing flagged as spam.';
    case 'trash':
      return 'Trash is empty.';
  }
}

function derivePeer(msg: {
  direction: 'outbound' | 'inbound';
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
}): string {
  if (msg.direction === 'outbound') {
    return msg.toAddresses[0] ?? '';
  }
  return msg.fromName ? `${msg.fromName} <${msg.fromAddress}>` : msg.fromAddress;
}

function statusBadgeClass(status: string): string {
  if (status === 'sent' || status === 'delivered' || status === 'received')
    return 'badge';
  if (status === 'queued' || status === 'sending') return 'badge';
  if (status === 'failed' || status === 'bounced') return 'badge badge-bad';
  return 'badge';
}
