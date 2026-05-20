import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db/client';
import { mailboxSendingLimits } from '@/lib/db/schema/mailing';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace } from '@/lib/services/context';
import {
  MailboxServiceError,
  archiveMailbox,
  getMailbox,
  reactivateMailbox,
  testMailboxConnection,
} from '@/lib/services/mailbox';
import {
  countMessagesByFolder,
  isHardBounce,
  listMessages,
  markAsSpam,
  moveToTrash,
  permanentlyDelete,
  restoreFromTrash,
  retrySend,
  syncInbound,
  unmarkSpam,
} from '@/lib/services/mail';
import { MAIL_FOLDERS, type MailFolder } from '@/lib/services/mail-folders';
import { ConfirmFormButton } from '@/components/ConfirmFormButton';
import { getOrCreateMailboxSendingLimits } from '@/lib/services/sending-policy';
import {
  SUPPORTED_HOLIDAY_COUNTRIES,
  type HolidayCountry,
} from '@/lib/i18n/holidays';
import { isNextRedirectError } from '@/lib/server-redirect';

export default async function MailboxDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    message?: string;
    error?: string;
    /** legacy alias kept so old bookmarks (`?view=outreach`) still load */
    view?: string;
    folder?: string;
    q?: string;
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

  // P61: six-folder navigation (Inbox / Sent / Queued / Errors / Spam /
  // Trash) derived from message-level state. Default Inbox so the
  // operator lands on the work surface they expect from any mail client.
  const folderParam = sp.folder ?? '';
  const activeFolder: MailFolder = (
    MAIL_FOLDERS as readonly string[]
  ).includes(folderParam)
    ? (folderParam as MailFolder)
    : 'inbox';
  const search = sp.q?.trim() ?? '';
  const [messageRows, folderCounts] = await Promise.all([
    listMessages(ctx, {
      mailboxId: id,
      folder: activeFolder,
      limit: 100,
      search: search || undefined,
    }),
    countMessagesByFolder(ctx, id),
  ]);

  async function runSync() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      const result = await syncInbound(c, id);
      const msg = `Synced — fetched ${result.fetched}, new ${result.inserted}, deduped ${result.duplicates}.`;
      redirect(`/mailbox/${id}?message=${encodeURIComponent(msg)}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      if (err instanceof MailboxServiceError || err instanceof Error) {
        const m = (err as { message?: string }).message ?? 'sync failed';
        redirect(`/mailbox/${id}?error=${encodeURIComponent(m)}`);
      }
      throw err;
    }
  }

  async function runTest() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      const result = await testMailboxConnection(c, id);
      const allOk = result.smtp.ok && (result.imap === null || result.imap.ok);
      const msg = allOk
        ? 'Connection OK — SMTP and IMAP reachable.'
        : `SMTP ${result.smtp.ok ? 'ok' : `failed: ${result.smtp.detail}`}; IMAP ${result.imap?.ok ? 'ok' : `failed: ${result.imap?.detail}`}`;
      redirect(`/mailbox/${id}?message=${encodeURIComponent(msg)}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof Error ? err.message : 'test failed';
      redirect(`/mailbox/${id}?error=${encodeURIComponent(m)}`);
    }
  }

  async function archive() {
    'use server';
    const c = await getWorkspaceContext();
    await archiveMailbox(c, id);
    redirect('/mailbox');
  }

  async function reactivate() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      await reactivateMailbox(c, id);
      redirect(
        `/mailbox/${id}?message=${encodeURIComponent('Mailbox reactivated — next IMAP tick will retry.')}`,
      );
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof Error ? err.message : 'reactivate failed';
      redirect(`/mailbox/${id}?error=${encodeURIComponent(m)}`);
    }
  }

  // ---- P61-06 bulk actions on the folder view ----
  function backToFolder(formData: FormData, message: string) {
    const folder = String(formData.get('folder') ?? 'inbox');
    const q = String(formData.get('q') ?? '');
    const params = new URLSearchParams({ folder });
    if (q) params.set('q', q);
    params.set('message', message);
    redirect(`/mailbox/${id}?${params.toString()}`);
  }
  function backToFolderError(formData: FormData, message: string) {
    const folder = String(formData.get('folder') ?? 'inbox');
    const q = String(formData.get('q') ?? '');
    const params = new URLSearchParams({ folder });
    if (q) params.set('q', q);
    params.set('error', message);
    redirect(`/mailbox/${id}?${params.toString()}`);
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

  async function saveSendingPolicy(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    if (!canAdminWorkspace(c)) {
      redirect(`/mailbox/${id}?error=${encodeURIComponent('admin only')}`);
    }
    const businessDays = (formData.getAll('businessDays') as string[])
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
    const updates = {
      maxPerDay: clampInt(formData.get('maxPerDay'), 0, 10_000),
      maxPerHour: clampInt(formData.get('maxPerHour'), 0, 10_000),
      maxPerDomain: clampInt(formData.get('maxPerDomain'), 0, 10_000),
      minDelaySeconds: clampInt(formData.get('minDelaySeconds'), 0, 86_400),
      maxDelaySeconds: clampInt(formData.get('maxDelaySeconds'), 0, 86_400),
      businessHoursOnly: formData.get('businessHoursOnly') === 'on',
      businessStartHour: clampInt(formData.get('businessStartHour'), 0, 23),
      businessEndHour: clampInt(formData.get('businessEndHour'), 1, 24),
      businessDays: businessDays.length > 0 ? businessDays : [1, 2, 3, 4, 5],
      timezone: String(formData.get('timezone') ?? 'Europe/Warsaw').trim() || 'Europe/Warsaw',
      respectWeekends: formData.get('respectWeekends') === 'on',
      respectHolidays: formData.get('respectHolidays') === 'on',
      holidayCountry: String(formData.get('holidayCountry') ?? 'PL'),
      updatedAt: new Date(),
    };
    // Lazy-create then update.
    await getOrCreateMailboxSendingLimits(c.workspaceId, id);
    await db
      .update(mailboxSendingLimits)
      .set(updates)
      .where(eq(mailboxSendingLimits.mailboxId, id));
    redirect(
      `/mailbox/${id}?message=${encodeURIComponent('Sending policy saved.')}`,
    );
  }

  // Read current policy for the form.
  const limits = canAdminWorkspace(ctx)
    ? await getOrCreateMailboxSendingLimits(ctx.workspaceId, id)
    : null;

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/mailbox">Mailbox</Link> / {mailbox.name}
        </p>
        <div className="page-header">
          <h1>{mailbox.name}</h1>
          <div className="action-row">
            <Link href={`/mailbox/${id}/compose`} className="primary-btn">
              Compose
            </Link>
            <Link href={`/mailbox/${id}/test`}>Send test</Link>
            <Link href={`/mailbox/${id}/edit`}>Edit settings</Link>
          </div>
        </div>
        <p>
          <span className={statusBadge(mailbox.status)}>{mailbox.status}</span>{' '}
          {mailbox.isDefault ? <span className="badge badge-good">default</span> : null}{' '}
          <span className="muted">{mailbox.fromAddress}</span>
        </p>

        {sp.message ? <p className="form-message">{sp.message}</p> : null}
        {sp.error ? <p className="form-error">{sp.error}</p> : null}

        <section>
          <h2>Connection</h2>
          <dl>
            <dt>SMTP</dt>
            <dd>
              <code>{mailbox.smtpHost}:{mailbox.smtpPort}</code>
              {mailbox.smtpSecure ? <span className="muted"> · SSL</span> : null}
              <span className="muted"> · {mailbox.smtpUser}</span>
            </dd>
            {mailbox.imapHost ? (
              <>
                <dt>IMAP</dt>
                <dd>
                  <code>{mailbox.imapHost}:{mailbox.imapPort}</code>
                  {mailbox.imapSecure ? <span className="muted"> · SSL</span> : null}
                  <span className="muted"> · {mailbox.imapUser} · {mailbox.imapFolder}</span>
                </dd>
                {mailbox.lastSyncedAt ? (
                  <>
                    <dt>Last sync</dt>
                    <dd>{mailbox.lastSyncedAt.toLocaleString()}</dd>
                  </>
                ) : null}
              </>
            ) : null}
            {mailbox.lastError ? (
              <>
                <dt>Last error</dt>
                <dd className="warn">{mailbox.lastError}</dd>
              </>
            ) : null}
            {mailbox.imapHost && mailbox.imapConsecutiveFailures > 0 ? (
              <>
                <dt>Consecutive failures</dt>
                <dd>
                  <span className="badge badge-bad">{mailbox.imapConsecutiveFailures}</span>
                  {mailbox.imapNextSyncAfter ? (
                    <span className="muted">
                      {' '}
                      · next retry {mailbox.imapNextSyncAfter.toLocaleString()}
                    </span>
                  ) : null}
                </dd>
              </>
            ) : null}
            {mailbox.imapHost && mailbox.imapEmptySyncs >= 5 ? (
              <>
                <dt>Adaptive poll</dt>
                <dd>
                  <span className="badge">quiet — 15 min cadence</span>
                  <span className="muted">
                    {' '}
                    · {mailbox.imapEmptySyncs} consecutive empty syncs; reverts
                    to 2 min on next inbound.
                  </span>
                </dd>
              </>
            ) : null}
          </dl>
          {mailbox.status === 'failing' ? (
            <p className="form-error">
              IMAP authentication is failing — the scheduled tick has been
              suspended to prevent the upstream server&apos;s fail2ban /
              rate-limit from banning agregat&apos;s IP. Fix the credentials
              or IMAP config (under <Link href={`/mailbox/${id}/edit`}>Edit settings</Link>),
              then click <strong>Reactivate</strong> to resume polling.
            </p>
          ) : null}
          <div className="action-row">
            <form action={runTest}>
              <button type="submit">Test connection</button>
            </form>
            {mailbox.imapHost ? (
              <form action={runSync}>
                <button type="submit">Sync inbound</button>
              </form>
            ) : null}
            {mailbox.status === 'failing' && canAdminWorkspace(ctx) ? (
              <form action={reactivate}>
                <button type="submit" className="primary-btn">
                  Reactivate
                </button>
              </form>
            ) : null}
          </div>
        </section>

        {limits ? (
          <section>
            <h2>Sending policy</h2>
            <p className="muted small">
              Outreach queue consults this before every send. Counters reset
              per local day / hour in {limits.timezone}. Holiday calendar
              uses {limits.holidayCountry}.
            </p>
            <form action={saveSendingPolicy} className="edit-draft-form">
              <fieldset className="ks-kind-fields">
                <legend className="muted">Quantity caps</legend>
                <label>
                  <span>Max per day</span>
                  <input type="number" name="maxPerDay" min="0" max="10000" defaultValue={limits.maxPerDay} />
                </label>
                <label>
                  <span>Max per hour</span>
                  <input type="number" name="maxPerHour" min="0" max="10000" defaultValue={limits.maxPerHour} />
                </label>
                <label>
                  <span>Max per recipient domain (rolling 24h)</span>
                  <input type="number" name="maxPerDomain" min="0" max="10000" defaultValue={limits.maxPerDomain} />
                </label>
              </fieldset>

              <fieldset className="ks-kind-fields">
                <legend className="muted">Send delay (between consecutive sends)</legend>
                <label>
                  <span>Min delay (seconds)</span>
                  <input type="number" name="minDelaySeconds" min="0" max="86400" defaultValue={limits.minDelaySeconds} />
                </label>
                <label>
                  <span>Max delay (seconds)</span>
                  <input type="number" name="maxDelaySeconds" min="0" max="86400" defaultValue={limits.maxDelaySeconds} />
                </label>
              </fieldset>

              <fieldset className="ks-kind-fields">
                <legend className="muted">Business window</legend>
                <label className="checkbox-row">
                  <input type="checkbox" name="businessHoursOnly" defaultChecked={limits.businessHoursOnly} />
                  <span>Only send during business hours</span>
                </label>
                <label>
                  <span>Start hour (0–23)</span>
                  <input type="number" name="businessStartHour" min="0" max="23" defaultValue={limits.businessStartHour} />
                </label>
                <label>
                  <span>End hour (1–24, exclusive)</span>
                  <input type="number" name="businessEndHour" min="1" max="24" defaultValue={limits.businessEndHour} />
                </label>
                <label>
                  <span>Business days</span>
                  <span className="business-days">
                    {[
                      { iso: 1, label: 'Mon' },
                      { iso: 2, label: 'Tue' },
                      { iso: 3, label: 'Wed' },
                      { iso: 4, label: 'Thu' },
                      { iso: 5, label: 'Fri' },
                      { iso: 6, label: 'Sat' },
                      { iso: 7, label: 'Sun' },
                    ].map((d) => (
                      <label key={d.iso} className="business-day-pill">
                        <input
                          type="checkbox"
                          name="businessDays"
                          value={d.iso}
                          defaultChecked={limits.businessDays.includes(d.iso)}
                        />
                        <span>{d.label}</span>
                      </label>
                    ))}
                  </span>
                </label>
                <label>
                  <span>Timezone (IANA)</span>
                  <input type="text" name="timezone" defaultValue={limits.timezone} placeholder="Europe/Warsaw" />
                </label>
              </fieldset>

              <fieldset className="ks-kind-fields">
                <legend className="muted">Calendar</legend>
                <label className="checkbox-row">
                  <input type="checkbox" name="respectWeekends" defaultChecked={limits.respectWeekends} />
                  <span>Skip weekends</span>
                </label>
                <label className="checkbox-row">
                  <input type="checkbox" name="respectHolidays" defaultChecked={limits.respectHolidays} />
                  <span>Skip public holidays</span>
                </label>
                <label>
                  <span>Holiday country</span>
                  <select name="holidayCountry" defaultValue={limits.holidayCountry}>
                    {SUPPORTED_HOLIDAY_COUNTRIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name} ({c.code})
                      </option>
                    ))}
                  </select>
                </label>
              </fieldset>

              <p className="muted small">
                Counters now: <strong>{limits.sentToday}</strong> sent today,{' '}
                <strong>{limits.sentThisHour}</strong> sent this hour
                {limits.lastResetDate ? <> · last reset {limits.lastResetDate}</> : null}.
              </p>

              <div className="action-row">
                <button type="submit" className="primary-btn">Save policy</button>
              </div>
            </form>
          </section>
        ) : null}

        <section>
          <h2>Messages</h2>
          <p className="muted small">
            Folders are derived from message state — a message can move
            between them as it ages (queued → sent → trashed, for
            example). The Errors folder surfaces failed and bounced sends.
            Trash is auto-purged after the workspace retention window.
          </p>
          <div className="window-tabs" style={{ marginBottom: '0.75rem' }}>
            {MAIL_FOLDERS.map((f) => {
              const href = `/mailbox/${id}?folder=${f}${
                search ? `&q=${encodeURIComponent(search)}` : ''
              }`;
              return (
                <Link
                  key={f}
                  href={href}
                  className={`window-tab${activeFolder === f ? ' window-tab-active' : ''}`}
                >
                  {folderLabel(f)} <span className="badge">{folderCounts[f]}</span>
                </Link>
              );
            })}
          </div>

          <form
            method="get"
            action={`/mailbox/${id}`}
            className="action-row"
            style={{ marginBottom: '0.75rem' }}
          >
            <input type="hidden" name="folder" value={activeFolder} />
            <input
              type="search"
              name="q"
              defaultValue={search}
              placeholder={`Search ${folderLabel(activeFolder)}…`}
              style={{ flex: 1 }}
            />
            <button type="submit">Search</button>
            {search ? (
              <Link href={`/mailbox/${id}?folder=${activeFolder}`}>Clear</Link>
            ) : null}
          </form>

          {messageRows.length === 0 ? (
            <p className="muted">
              {search
                ? `No messages match "${search}" in ${folderLabel(activeFolder)}.`
                : emptyFolderHint(activeFolder)}
            </p>
          ) : (
            <form>
              {/* Carry the active folder + search forward through every
                  bulk action so the redirect lands the operator back on
                  the same view they acted from. */}
              <input type="hidden" name="folder" value={activeFolder} />
              <input type="hidden" name="q" value={search} />

              <div
                className="action-row"
                style={{ marginBottom: '0.5rem', flexWrap: 'wrap' }}
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

              <ul className="lead-list">
                {messageRows.map(({ message, thread }) => {
                  const peer = derivePeer(message);
                  const subject =
                    message.subject || thread?.subject || '(no subject)';
                  const when =
                    message.sentAt ??
                    message.receivedAt ??
                    message.createdAt;
                  const cbId = `msg-${message.id.toString()}`;
                  return (
                    <li key={message.id.toString()}>
                      <div
                        className="lead-row"
                        style={{ alignItems: 'flex-start', gap: '0.5rem' }}
                      >
                        <input
                          id={cbId}
                          type="checkbox"
                          name="ids"
                          value={message.id.toString()}
                          style={{ marginTop: '0.35rem' }}
                        />
                        <div style={{ flex: 1 }}>
                          <div className="lead-row">
                            {thread ? (
                              <Link href={`/communication/${thread.id}`}>
                                {subject}
                              </Link>
                            ) : (
                              <label htmlFor={cbId}>{subject}</label>
                            )}
                            <span className={statusBadge(message.status)}>
                              {message.status}
                            </span>
                          </div>
                          <div className="lead-meta">
                            <span>
                              {message.direction === 'outbound' ? '→ ' : '← '}
                              {peer || '(unknown)'}
                            </span>
                            <span>{when.toLocaleString()}</span>
                            {activeFolder === 'errors' && isHardBounce(message) ? (
                              <span className="badge badge-bad">Hard bounce</span>
                            ) : null}
                            {activeFolder === 'errors' && message.failureReason ? (
                              <span className="warn">
                                {message.failureReason}
                              </span>
                            ) : null}
                            {activeFolder === 'spam' && message.spamReason ? (
                              <span className="muted">
                                flag: {message.spamReason}
                              </span>
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
        </section>

        {canAdminWorkspace(ctx) && mailbox.status !== 'archived' ? (
          <section>
            <h2>Admin</h2>
            <form action={archive}>
              <button type="submit" className="ghost-btn">
                Archive mailbox
              </button>
            </form>
          </section>
        ) : null}
      </AppShell>
  );
}

function statusBadge(status: string): string {
  if (status === 'active') return 'badge badge-good';
  if (status === 'failing' || status === 'archived') return 'badge badge-bad';
  if (status === 'paused') return 'badge badge-warn';
  return 'badge';
}

function clampInt(raw: FormDataEntryValue | null, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return Math.floor(n);
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
      return 'Inbox is empty. Inbound messages will land here as they arrive.';
    case 'sent':
      return 'Nothing sent yet. Compose a message or let the outreach engine generate one.';
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
