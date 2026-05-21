import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  ChevronLeft,
  ChevronRight,
  Inbox,
  Mail,
  PenSquare,
  RefreshCw,
  Send,
  TrendingUp,
} from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import {
  CommunicationFolderView,
  FolderIcon,
  type FolderViewRow,
} from '@/components/CommunicationFolderView';
import { MailFilterForm } from '@/components/MailFilterForm';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { listMailboxes } from '@/lib/services/mailbox';
import { listProductProfiles } from '@/lib/services/product-profile';
import {
  countMessagesByFolder,
  countMessagesMatching,
  isHardBounce,
  listMessages,
  markAsSpam,
  moveToTrash,
  permanentlyDelete,
  restoreFromTrash,
  retrySend,
  syncInbound,
  unmarkSpam,
  type MailSourceFilter,
} from '@/lib/services/mail';
import { MAIL_FOLDERS, type MailFolder } from '@/lib/services/mail-folders';
import { isNextRedirectError } from '@/lib/server-redirect';

const FOLDER_LABELS: Record<MailFolder, string> = {
  inbox: 'Inbox',
  sent: 'Sent',
  queued: 'Queued',
  errors: 'Errors',
  spam: 'Spam',
  trash: 'Trash',
};

const PAGE_SIZE_OPTIONS = [10, 50, 100] as const;
const PAGE_SIZE_DEFAULT = 50;
function clampPageSize(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return PAGE_SIZE_DEFAULT;
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(n)
    ? n
    : PAGE_SIZE_DEFAULT;
}

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
      return 'Failed sends + bounces show up here. Retry button surfaces for soft errors.';
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
  return body.replace(/\s+/g, ' ').trim().slice(0, 140);
}

function parseDateStart(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  // <input type="date"> emits YYYY-MM-DD. Anchor to local midnight so
  // "from = 2026-05-20" includes everything that day regardless of TZ.
  const d = new Date(`${raw}T00:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
function parseDateEnd(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  // "to = 2026-05-20" should match through 23:59:59.999 local.
  const d = new Date(`${raw}T23:59:59.999`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function toDateInputValue(d: Date | undefined): string {
  if (!d) return '';
  // Local YYYY-MM-DD for <input type="date">
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export default async function CommunicationPage({
  searchParams,
}: {
  searchParams: Promise<{
    folder?: string;
    mailboxId?: string;
    q?: string;
    source?: string;
    productId?: string;
    from?: string;
    to?: string;
    page?: string;
    perPage?: string;
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
  const sourceParam = sp.source ?? '';
  const source: MailSourceFilter =
    sourceParam === 'outreach' || sourceParam === 'external'
      ? sourceParam
      : 'all';
  const productId =
    sp.productId && /^\d+$/.test(sp.productId) ? BigInt(sp.productId) : undefined;
  const dateFrom = parseDateStart(sp.from);
  const dateTo = parseDateEnd(sp.to);
  const pageSize = clampPageSize(sp.perPage);
  const pageNum = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);
  const offset = (pageNum - 1) * pageSize;

  const sharedFilter = {
    mailboxId: mailboxIdFilter,
    folder: activeFolder,
    search: search || undefined,
    dateFrom,
    dateTo,
    source: source !== 'all' ? source : undefined,
    productId,
  };

  const [messageRows, totalMatching, folderCounts, mailboxes, products] =
    await Promise.all([
      listMessages(ctx, { ...sharedFilter, limit: pageSize, offset }),
      countMessagesMatching(ctx, sharedFilter),
      countMessagesByFolder(ctx, mailboxIdFilter),
      listMailboxes(ctx),
      listProductProfiles(ctx, { includeArchived: false }),
    ]);

  const totalPages = Math.max(1, Math.ceil(totalMatching / pageSize));
  const safePage = Math.min(pageNum, totalPages);

  const mailboxNameById = new Map(
    mailboxes.map((mb) => [mb.id.toString(), mb.name]),
  );

  // Compose routes to: the currently-filtered mailbox if set, else the
  // workspace's default mailbox, else the first available mailbox. Null
  // when no mailbox exists (button disabled with a setup hint).
  const composeMailbox =
    (mailboxIdFilter !== undefined
      ? mailboxes.find((mb) => mb.id === mailboxIdFilter)
      : undefined) ??
    mailboxes.find((mb) => mb.isDefault && mb.status === 'active') ??
    mailboxes.find((mb) => mb.status === 'active') ??
    mailboxes[0] ??
    null;
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

  // ---- server actions ----
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
    const params = new URLSearchParams();
    for (const key of ['folder', 'q', 'mailboxId', 'source', 'productId', 'from', 'to', 'page', 'perPage'] as const) {
      const v = String(formData.get(key) ?? '');
      if (v) params.set(key, v);
    }
    if (!params.get('folder')) params.set('folder', 'inbox');
    return params;
  }
  function parseIds(formData: FormData): bigint[] {
    const out: bigint[] = [];
    for (const raw of formData.getAll('ids')) {
      const s = String(raw);
      if (!/^\d+$/.test(s)) continue;
      try { out.push(BigInt(s)); } catch {}
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
    try { const r = await moveToTrash(c, ids); backToFolder(formData, affectedNote('moved to trash', r.affected)); }
    catch (err) { if (isNextRedirectError(err)) throw err; backToFolderError(formData, err instanceof Error ? err.message : 'trash failed'); }
  }
  async function restoreSelected(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const ids = parseIds(formData);
    try { const r = await restoreFromTrash(c, ids); backToFolder(formData, affectedNote('restored', r.affected)); }
    catch (err) { if (isNextRedirectError(err)) throw err; backToFolderError(formData, err instanceof Error ? err.message : 'restore failed'); }
  }
  async function spamSelected(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const ids = parseIds(formData);
    try { const r = await markAsSpam(c, ids, 'manual'); backToFolder(formData, affectedNote('flagged as spam', r.affected)); }
    catch (err) { if (isNextRedirectError(err)) throw err; backToFolderError(formData, err instanceof Error ? err.message : 'mark-spam failed'); }
  }
  async function unspamSelected(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const ids = parseIds(formData);
    try { const r = await unmarkSpam(c, ids); backToFolder(formData, affectedNote('un-flagged', r.affected)); }
    catch (err) { if (isNextRedirectError(err)) throw err; backToFolderError(formData, err instanceof Error ? err.message : 'unmark failed'); }
  }
  async function deleteSelected(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const ids = parseIds(formData);
    try { const r = await permanentlyDelete(c, ids); backToFolder(formData, affectedNote('permanently deleted', r.affected)); }
    catch (err) { if (isNextRedirectError(err)) throw err; backToFolderError(formData, err instanceof Error ? err.message : 'delete failed'); }
  }
  async function syncMailbox(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    // Lazy-resolve mailboxes here — server actions can't close over the
    // page's outer mailboxes list without serialising it (it's
    // server-only state). Re-fetch with a fresh ctx.
    const { listMailboxes: refetch } = await import('@/lib/services/mailbox');
    const all = await refetch(c);
    const filterIdRaw = formData.get('mailboxId');
    const filterId =
      typeof filterIdRaw === 'string' && /^\d+$/.test(filterIdRaw)
        ? BigInt(filterIdRaw)
        : null;
    const targets = filterId
      ? all.filter((mb) => mb.id === filterId && mb.imapHost)
      : all.filter((mb) => mb.status === 'active' && mb.imapHost);
    if (targets.length === 0) {
      backToFolderError(
        formData,
        filterId
          ? 'Selected mailbox has no IMAP configured.'
          : 'No active IMAP-enabled mailbox to sync.',
      );
    }
    let totalFetched = 0;
    let totalInserted = 0;
    const failures: string[] = [];
    for (const mb of targets) {
      try {
        const r = await syncInbound(c, mb.id);
        totalFetched += r.fetched;
        totalInserted += r.inserted;
      } catch (err) {
        failures.push(
          `${mb.name}: ${err instanceof Error ? err.message : 'failed'}`,
        );
      }
    }
    if (failures.length > 0 && totalInserted === 0) {
      backToFolderError(formData, `Sync failed — ${failures.join('; ')}`);
    } else {
      const summary =
        targets.length === 1
          ? `Synced ${targets[0]!.name} — fetched ${totalFetched}, new ${totalInserted}.`
          : `Synced ${targets.length} mailboxes — fetched ${totalFetched}, new ${totalInserted}${failures.length ? ` (${failures.length} failed)` : ''}.`;
      backToFolder(formData, summary);
    }
  }

  async function retrySelected(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const ids = parseIds(formData);
    try {
      const r = await retrySend(c, ids);
      const parts: string[] = [];
      if (r.retried.length > 0) parts.push(r.retried.length === 1 ? '1 message resent' : `${r.retried.length} messages resent`);
      if (r.skippedHardBounce.length > 0) parts.push(`${r.skippedHardBounce.length} hard-bounced (skipped)`);
      if (r.skippedIneligible.length > 0) parts.push(`${r.skippedIneligible.length} ineligible`);
      if (r.errors.length > 0) parts.push(`${r.errors.length} failed`);
      backToFolder(formData, parts.length > 0 ? parts.join(', ') + '.' : 'Nothing to retry.');
    } catch (err) { if (isNextRedirectError(err)) throw err; backToFolderError(formData, err instanceof Error ? err.message : 'retry failed'); }
  }

  // ---- helpers for URL building in JSX ----
  function buildHref(overrides: Partial<{
    folder: MailFolder;
    source: MailSourceFilter;
    productId: string;
    from: string;
    to: string;
    q: string;
    mailboxId: string;
    page: number;
    perPage: number;
  }>): string {
    const params = new URLSearchParams();
    const f = overrides.folder ?? activeFolder;
    if (f !== 'inbox') params.set('folder', f);
    const s = overrides.source ?? source;
    if (s !== 'all') params.set('source', s);
    const pId = overrides.productId !== undefined
      ? overrides.productId
      : productId?.toString() ?? '';
    if (pId) params.set('productId', pId);
    const fr = overrides.from !== undefined ? overrides.from : toDateInputValue(dateFrom);
    if (fr) params.set('from', fr);
    const toV = overrides.to !== undefined ? overrides.to : toDateInputValue(dateTo);
    if (toV) params.set('to', toV);
    const qv = overrides.q !== undefined ? overrides.q : search;
    if (qv) params.set('q', qv);
    const mb = overrides.mailboxId !== undefined ? overrides.mailboxId : mailboxIdFilter?.toString() ?? '';
    if (mb) params.set('mailboxId', mb);
    const pg = overrides.page ?? 1;
    if (pg > 1) params.set('page', String(pg));
    const ps = overrides.perPage ?? pageSize;
    if (ps !== PAGE_SIZE_DEFAULT) params.set('perPage', String(ps));
    const qs = params.toString();
    return qs ? `/communication?${qs}` : '/communication';
  }

  return (
    <AppShell>
      {/* ============ Dashboard ============ */}
      <section className="mail-dashboard" aria-label="Communication summary">
        <div className="mail-metric" data-accent="blue">
          <div className="mail-metric-label">
            <Inbox className="lucide" /> Inbox
          </div>
          <div className="mail-metric-value">{folderCounts.inbox}</div>
          <div className="mail-metric-sub">Awaiting your attention</div>
        </div>
        <div className="mail-metric" data-accent="teal">
          <div className="mail-metric-label">
            <Send className="lucide" /> Sent
          </div>
          <div className="mail-metric-value">{folderCounts.sent}</div>
          <div className="mail-metric-sub">Delivered or in transit</div>
        </div>
        <div className="mail-metric" data-accent="amber">
          <div className="mail-metric-label">
            <Mail className="lucide" /> Queued
          </div>
          <div className="mail-metric-value">{folderCounts.queued}</div>
          <div className="mail-metric-sub">Drafts waiting to send</div>
        </div>
        <div className="mail-metric" data-accent="red">
          <div className="mail-metric-label">
            <TrendingUp className="lucide" /> Needs attention
          </div>
          <div className="mail-metric-value">
            {folderCounts.errors + folderCounts.spam}
          </div>
          <div className="mail-metric-sub">
            {folderCounts.errors} errors · {folderCounts.spam} spam
          </div>
        </div>
      </section>

      {/* ============ Filters (auto-submit on change) ============ */}
      <MailFilterForm
        activeFolder={activeFolder}
        source={source}
        productId={productId?.toString() ?? ''}
        dateFrom={toDateInputValue(dateFrom)}
        dateTo={toDateInputValue(dateTo)}
        search={search}
        mailboxId={mailboxIdFilter?.toString() ?? ''}
        products={products.map((p) => ({
          id: p.id.toString(),
          name: p.name,
        }))}
        folderLabel={FOLDER_LABELS[activeFolder]}
        hasActiveFilters={
          !!(
            search ||
            mailboxIdFilter !== undefined ||
            productId !== undefined ||
            dateFrom ||
            dateTo ||
            source !== 'all'
          )
        }
        resetHref={`/communication?folder=${activeFolder}`}
        segmentLinks={{
          all: buildHref({ source: 'all', page: 1 }),
          outreach: buildHref({ source: 'outreach', page: 1 }),
          external: buildHref({ source: 'external', page: 1 }),
        }}
      />

      {/* ============ 2-pane layout ============ */}
      <div className="mail-shell">
        <aside className="mail-rail" aria-label="Mail folders">
          {composeMailbox ? (
            <Link
              href={`/mailbox/${composeMailbox.id}/compose`}
              className="mail-compose-btn"
              title={`Compose from ${composeMailbox.name}`}
            >
              <PenSquare className="lucide" />
              <span>Compose</span>
            </Link>
          ) : (
            <Link
              href="/mailbox"
              className="mail-compose-btn is-disabled"
              title="Set up a mailbox to send messages"
            >
              <PenSquare className="lucide" />
              <span>Set up mailbox</span>
            </Link>
          )}

          {/* Sync — pulls inbound for the active mailbox, or all when
              no mailbox filter is set. */}
          {mailboxes.length > 0 ? (
            <form action={syncMailbox} className="mail-sync-form">
              <input
                type="hidden"
                name="folder"
                value={activeFolder}
              />
              {mailboxIdFilter !== undefined ? (
                <input
                  type="hidden"
                  name="mailboxId"
                  value={mailboxIdFilter.toString()}
                />
              ) : null}
              <button
                type="submit"
                className="mail-sync-btn"
                title={
                  mailboxIdFilter !== undefined
                    ? 'Force-sync the selected mailbox now'
                    : 'Force-sync every active mailbox now'
                }
              >
                <RefreshCw className="lucide" />
                <span>
                  {mailboxIdFilter !== undefined ? 'Sync mailbox' : 'Sync all'}
                </span>
              </button>
            </form>
          ) : null}

          <div className="mail-rail-section-title">Folders</div>
          {MAIL_FOLDERS.map((f) => {
            const isActive = f === activeFolder;
            return (
              <Link
                key={f}
                href={buildHref({ folder: f, page: 1 })}
                className={`mail-rail-item${isActive ? ' is-active' : ''}`}
                aria-current={isActive ? 'page' : undefined}
              >
                <FolderIcon folder={f} />
                <span>{FOLDER_LABELS[f]}</span>
                <span className="mail-rail-item-count">{folderCounts[f]}</span>
              </Link>
            );
          })}
          {mailboxes.length > 1 ? (
            <form method="get" action="/communication" className="mail-rail-mailbox-select">
              <input type="hidden" name="folder" value={activeFolder} />
              {search ? <input type="hidden" name="q" value={search} /> : null}
              {source !== 'all' ? <input type="hidden" name="source" value={source} /> : null}
              {productId !== undefined ? <input type="hidden" name="productId" value={productId.toString()} /> : null}
              <label className="mail-rail-section-title" style={{ padding: 0 }}>Mailbox</label>
              <select name="mailboxId" defaultValue={mailboxIdFilter?.toString() ?? ''}>
                <option value="">All mailboxes</option>
                {mailboxes.map((m) => (
                  <option key={m.id.toString()} value={m.id.toString()}>
                    {m.name}
                  </option>
                ))}
              </select>
              <button type="submit" className="ghost-btn" style={{ fontSize: '0.78rem', padding: '0.3rem 0.5rem' }}>
                Apply
              </button>
            </form>
          ) : null}
        </aside>

        <div className="mail-content">
          {sp.message ? <p className="mail-flash info">{sp.message}</p> : null}
          {sp.error ? <p className="mail-flash error">{sp.error}</p> : null}

          {serialisedRows.length === 0 ? (
            <div className="mail-empty">
              <div className="mail-empty-icon">
                <FolderIcon folder={activeFolder} />
              </div>
              <p className="mail-empty-title">
                {search || productId !== undefined || dateFrom || dateTo || source !== 'all'
                  ? `No messages match these filters`
                  : emptyFolderTitle(activeFolder)}
              </p>
              <p style={{ margin: 0 }}>
                {search || productId !== undefined || dateFrom || dateTo || source !== 'all'
                  ? 'Reset the filters above to widen the view, or switch folder.'
                  : emptyFolderHint(activeFolder)}
              </p>
            </div>
          ) : (
            <>
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

              {/* Pagination footer */}
              <div className="mail-pagination">
                <span>
                  Showing {offset + 1}–{Math.min(offset + serialisedRows.length, totalMatching)} of {totalMatching}
                </span>
                <div className="mail-pagination-perpage">
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <Link
                      key={size}
                      href={buildHref({ perPage: size, page: 1 })}
                      className={size === pageSize ? 'is-active' : ''}
                      aria-label={`Show ${size} per page`}
                    >
                      {size}
                    </Link>
                  ))}
                  <span className="muted small" style={{ marginLeft: '0.4rem' }}>
                    per page
                  </span>
                </div>
                <div className="mail-pagination-controls">
                  {safePage > 1 ? (
                    <Link
                      href={buildHref({ page: safePage - 1 })}
                      aria-label="Previous page"
                    >
                      <ChevronLeft className="lucide" /> Prev
                    </Link>
                  ) : (
                    <span className="is-disabled" aria-disabled="true">
                      <ChevronLeft className="lucide" /> Prev
                    </span>
                  )}
                  <span>Page {safePage} of {totalPages}</span>
                  {safePage < totalPages ? (
                    <Link
                      href={buildHref({ page: safePage + 1 })}
                      aria-label="Next page"
                    >
                      Next <ChevronRight className="lucide" />
                    </Link>
                  ) : (
                    <span className="is-disabled" aria-disabled="true">
                      Next <ChevronRight className="lucide" />
                    </span>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
