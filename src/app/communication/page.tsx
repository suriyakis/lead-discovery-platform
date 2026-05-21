import Link from 'next/link';
import { redirect } from 'next/navigation';
import { MessagesSquare, Search } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { CommunicationTabs } from '@/components/CommunicationTabs';
import {
  CommunicationFolderView,
  FolderIcon,
  type FolderViewRow,
} from '@/components/CommunicationFolderView';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { listMailboxes } from '@/lib/services/mailbox';
import {
  countMessagesByFolder,
  isHardBounce,
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

const FOLDER_LABELS: Record<MailFolder, string> = {
  inbox: 'Inbox',
  sent: 'Sent',
  queued: 'Queued',
  errors: 'Errors',
  spam: 'Spam',
  trash: 'Trash',
};

function emptyFolderTitle(f: MailFolder): string {
  switch (f) {
    case 'inbox':
      return 'Inbox is clear';
    case 'sent':
      return 'No sent messages';
    case 'queued':
      return 'Nothing in the queue';
    case 'errors':
      return 'No errors';
    case 'spam':
      return 'No spam';
    case 'trash':
      return 'Trash is empty';
  }
}
function emptyFolderHint(f: MailFolder): string {
  switch (f) {
    case 'inbox':
      return 'Inbound mail across every mailbox will land here.';
    case 'sent':
      return 'Sent + delivered messages will collect here.';
    case 'queued':
      return 'Outreach drafts waiting to send sit here briefly.';
    case 'errors':
      return 'Failed sends + bounces show up here. We surface a Retry button for soft errors.';
    case 'spam':
      return 'Manual + auto-flagged spam lives here. Use Not spam to reverse.';
    case 'trash':
      return 'Soft-deleted messages. Auto-purges after the workspace retention window.';
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

function snippetOf(body: string | null): string {
  if (!body) return '';
  return body
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

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

  const mailboxNameById = new Map(
    mailboxes.map((mb) => [mb.id.toString(), mb.name]),
  );
  const serialisedRows: FolderViewRow[] = messageRows.map(
    ({ message, thread }) => ({
      id: message.id.toString(),
      threadId: thread?.id?.toString() ?? null,
      subject: message.subject || thread?.subject || '(no subject)',
      snippet: snippetOf(message.bodyText),
      direction: message.direction as 'inbound' | 'outbound',
      peer: derivePeer(message),
      whenIso: (
        message.sentAt ??
        message.receivedAt ??
        message.createdAt
      ).toISOString(),
      status: message.status,
      failureReason: message.failureReason,
      spamReason: message.spamReason,
      mailboxName: mailboxNameById.get(message.mailboxId.toString()) ?? null,
      isHardBounce: isHardBounce({
        status: message.status,
        failureReason: message.failureReason,
      }),
    }),
  );

  // Server actions (one per bulk op). Each parses ids[] from the
  // posted FormData and bounces back to the same folder + search.
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
            Unified message view across every mailbox in this workspace.
            Folders are derived from message state — Inbox &amp; Sent are
            the day-to-day surface; Errors, Spam, and Trash collect anything
            that needs attention.
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

      {/* Folder strip */}
      <nav className="mail-folder-strip" aria-label="Mail folders">
        {MAIL_FOLDERS.map((f) => {
          const params = new URLSearchParams({ folder: f });
          if (search) params.set('q', search);
          if (mailboxIdFilter !== undefined)
            params.set('mailboxId', mailboxIdFilter.toString());
          const isActive = f === activeFolder;
          return (
            <Link
              key={f}
              href={`/communication?${params.toString()}`}
              className={`mail-folder-tab${isActive ? ' is-active' : ''}`}
              aria-current={isActive ? 'page' : undefined}
            >
              <FolderIcon folder={f} />
              <span>{FOLDER_LABELS[f]}</span>
              <span className="mail-folder-tab-count">{folderCounts[f]}</span>
            </Link>
          );
        })}
      </nav>

      {/* Filter row */}
      <form
        method="get"
        action="/communication"
        className="mail-filter-row"
        role="search"
      >
        <input type="hidden" name="folder" value={activeFolder} />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            flex: '1 1 280px',
            minWidth: 240,
          }}
        >
          <Search className="lucide" style={{ opacity: 0.6 }} />
          <input
            type="search"
            name="q"
            defaultValue={search}
            placeholder={`Search ${FOLDER_LABELS[activeFolder]} — subject, from, to…`}
            style={{ flex: 1 }}
          />
        </div>
        <select
          name="mailboxId"
          defaultValue={mailboxIdFilter?.toString() ?? ''}
          aria-label="Filter by mailbox"
        >
          <option value="">All mailboxes</option>
          {mailboxes.map((m) => (
            <option key={m.id.toString()} value={m.id.toString()}>
              {m.name}
            </option>
          ))}
        </select>
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
      </form>

      {/* Message list (client component owns selection state) */}
      {serialisedRows.length === 0 ? (
        <div className="mail-empty">
          <div className="mail-empty-icon">
            <FolderIcon folder={activeFolder} />
          </div>
          <p className="mail-empty-title">
            {search
              ? `No messages match "${search}" in ${FOLDER_LABELS[activeFolder]}`
              : emptyFolderTitle(activeFolder)}
          </p>
          <p style={{ margin: 0 }}>
            {search
              ? 'Try a broader search term, switch mailbox, or clear filters.'
              : emptyFolderHint(activeFolder)}
          </p>
        </div>
      ) : (
        <CommunicationFolderView
          folder={activeFolder}
          hiddenInputs={{
            folder: activeFolder,
            q: search,
            mailboxId: mailboxIdFilter?.toString() ?? '',
          }}
          rows={serialisedRows}
          actions={{
            trash: trashSelected,
            spam: spamSelected,
            unspam: unspamSelected,
            restore: restoreSelected,
            delete: deleteSelected,
            retry: retrySelected,
          }}
        />
      )}
    </AppShell>
  );
}
