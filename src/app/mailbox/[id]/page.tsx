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
  testMailboxConnection,
} from '@/lib/services/mailbox';
import { listThreads, syncInbound } from '@/lib/services/mail';
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
  searchParams: Promise<{ message?: string; error?: string }>;
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

  const threads = await listThreads(ctx, { mailboxId: id, limit: 100 });

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
          </dl>
          <div className="action-row">
            <form action={runTest}>
              <button type="submit">Test connection</button>
            </form>
            {mailbox.imapHost ? (
              <form action={runSync}>
                <button type="submit">Sync inbound</button>
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
          <h2>Threads ({threads.length})</h2>
          {threads.length === 0 ? (
            <p className="muted">No conversations yet. Compose a message or run a sync.</p>
          ) : (
            <ul className="lead-list">
              {threads.map((t) => (
                <li key={t.id.toString()}>
                  <div className="lead-row">
                    <Link href={`/mailbox/threads/${t.id}`}>{t.subject || '(no subject)'}</Link>
                    <span className="muted">{t.messageCount} msg</span>
                  </div>
                  <div className="lead-meta">
                    {t.participants.length > 0 ? (
                      <span>{t.participants.slice(0, 4).join(', ')}{t.participants.length > 4 ? '…' : ''}</span>
                    ) : null}
                    {t.lastMessageAt ? <span>{t.lastMessageAt.toLocaleString()}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
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
  return 'badge';
}

function clampInt(raw: FormDataEntryValue | null, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return Math.floor(n);
}
