import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace } from '@/lib/services/context';
import {
  cancelQueueEntry,
  drainQueue,
  getSendSettings,
  listQueueEntries,
  rescheduleQueueEntry,
  updateSendSettings,
} from '@/lib/services/outreach-queue';
import type {
  OutreachQueueEntry,
  OutreachQueueStatus,
  OutreachSendSettings,
  SendDelayMode,
} from '@/lib/db/schema/outreach';

const STATUS_TABS: ReadonlyArray<{ key: OutreachQueueStatus | 'all'; label: string }> = [
  { key: 'queued', label: 'Queued' },
  { key: 'sending', label: 'Sending' },
  { key: 'sent', label: 'Sent' },
  { key: 'failed', label: 'Failed' },
  { key: 'skipped', label: 'Skipped' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'all', label: 'All' },
];

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; message?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;
  const requested = sp.status ?? 'queued';
  const isValid = STATUS_TABS.some((t) => t.key === requested);
  const statusKey = isValid ? (requested as OutreachQueueStatus | 'all') : 'queued';

  let entries: OutreachQueueEntry[] = [];
  let settings: OutreachSendSettings | null = null;
  try {
    const ctx = await getWorkspaceContext();
    settings = await getSendSettings(ctx);
    entries = await listQueueEntries(ctx, {
      status: statusKey === 'all' ? undefined : (statusKey as OutreachQueueStatus),
      limit: 200,
    });
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) redirect('/');
    throw err;
  }

  async function drain() {
    'use server';
    const c = await getWorkspaceContext();
    const r = await drainQueue(c);
    redirect(
      `/mailbox/queue?message=${encodeURIComponent(
        `Drained — picked ${r.picked}, sent ${r.sent}, skipped ${r.skipped}, failed ${r.failed}`,
      )}`,
    );
  }

  async function cancel(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const id = BigInt(String(formData.get('id') ?? '0'));
    await cancelQueueEntry(c, id);
    redirect('/mailbox/queue?message=Cancelled');
  }

  async function reschedule(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const id = BigInt(String(formData.get('id') ?? '0'));
    const when = String(formData.get('scheduledSendAt') ?? '');
    if (!when) return;
    await rescheduleQueueEntry(c, id, new Date(when));
    redirect('/mailbox/queue?message=Rescheduled');
  }

  async function saveSettings(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const num = (k: string) => {
      const v = String(formData.get(k) ?? '');
      return /^\d+$/.test(v) ? Number(v) : undefined;
    };
    await updateSendSettings(c, {
      dailyEmailLimit: num('dailyEmailLimit'),
      domainCooldownHours: num('domainCooldownHours'),
      defaultDelayMode: String(formData.get('defaultDelayMode') ?? 'random') as SendDelayMode,
      fixedDelayMinutes: num('fixedDelayMinutes'),
      randomDelayMinMinutes: num('randomDelayMinMinutes'),
      randomDelayMaxMinutes: num('randomDelayMaxMinutes'),
      emergencyPause: formData.get('emergencyPause') === 'on',
    });
    redirect('/mailbox/queue?message=Settings+saved');
  }

  return (
    <AppShell>
      <p className="muted">
        <Link href="/dashboard">Dashboard</Link> /{' '}
        <Link href="/mailbox">Mailbox</Link> / Queue
      </p>
      <h1>Send queue</h1>
      {sp.message ? <p className="form-message">{sp.message}</p> : null}
      {sp.error ? <p className="form-error">{sp.error}</p> : null}

      {settings ? (
        <section>
          <h2>Send settings</h2>
          {settings.emergencyPause ? (
            <p className="form-error">
              Emergency pause is ON — drainQueue is a no-op until lifted.
            </p>
          ) : null}
          {canAdminWorkspace({ workspaceId: settings.workspaceId, userId: session.user.id, role: 'admin' as never })
            ? (
              <form action={saveSettings} className="edit-draft-form">
                <fieldset className="ks-kind-fields">
                  <legend className="muted">Limits</legend>
                  <label>
                    <span>Daily email limit</span>
                    <input
                      type="number"
                      name="dailyEmailLimit"
                      defaultValue={settings.dailyEmailLimit}
                      min={0}
                    />
                  </label>
                  <label>
                    <span>Domain cooldown hours</span>
                    <input
                      type="number"
                      name="domainCooldownHours"
                      defaultValue={settings.domainCooldownHours}
                      min={0}
                    />
                  </label>
                </fieldset>
                <fieldset className="ks-kind-fields">
                  <legend className="muted">Delay mode</legend>
                  <label>
                    <span>Default mode</span>
                    <select name="defaultDelayMode" defaultValue={settings.defaultDelayMode}>
                      <option value="immediate">immediate</option>
                      <option value="fixed">fixed</option>
                      <option value="random">random</option>
                    </select>
                  </label>
                  <label>
                    <span>Fixed delay (minutes)</span>
                    <input
                      type="number"
                      name="fixedDelayMinutes"
                      defaultValue={settings.fixedDelayMinutes}
                      min={0}
                    />
                  </label>
                  <label>
                    <span>Random min (minutes)</span>
                    <input
                      type="number"
                      name="randomDelayMinMinutes"
                      defaultValue={settings.randomDelayMinMinutes}
                      min={0}
                    />
                  </label>
                  <label>
                    <span>Random max (minutes)</span>
                    <input
                      type="number"
                      name="randomDelayMaxMinutes"
                      defaultValue={settings.randomDelayMaxMinutes}
                      min={0}
                    />
                  </label>
                </fieldset>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    name="emergencyPause"
                    defaultChecked={settings.emergencyPause}
                  />
                  <span>Emergency pause (kill switch)</span>
                </label>
                <div className="action-row">
                  <button type="submit" className="primary-btn">
                    Save settings
                  </button>
                </div>
              </form>
            )
            : null}
        </section>
      ) : null}

      <section>
        <h2>Drain</h2>
        <p className="muted">
          Manually drain the queue right now. A scheduled worker would run
          this on a recurring tick in production.
        </p>
        <form action={drain}>
          <button type="submit">Drain now</button>
        </form>
      </section>

      <section>
        <div className="state-tabs">
          {STATUS_TABS.map((t) => (
            <Link
              key={t.key}
              href={`/mailbox/queue?status=${t.key}`}
              className={t.key === statusKey ? 'tab active' : 'tab'}
            >
              {t.label}
            </Link>
          ))}
        </div>
        <h2>{statusKey === 'all' ? 'All entries' : `${statusKey} entries`} ({entries.length})</h2>
        {entries.length === 0 ? (
          <p className="muted">Nothing in this view.</p>
        ) : (
          <ul className="lead-list">
            {entries.map((e) => (
              <li key={e.id.toString()}>
                <div className="lead-row">
                  <strong>{e.subject}</strong>
                  <span className="badge">{e.status}</span>
                  <span className="muted">{e.toAddresses.join(', ')}</span>
                </div>
                <div className="lead-meta">
                  <span>scheduled {e.scheduledSendAt.toLocaleString()}</span>
                  <span>delay: {e.delayMode}</span>
                  <span>attempts: {e.attemptCount}</span>
                  {e.lastError ? <span className="warn">{e.lastError.slice(0, 200)}</span> : null}
                </div>
                {e.status === 'queued' ? (
                  <div className="action-row" style={{ marginTop: '0.5rem' }}>
                    <form action={cancel}>
                      <input type="hidden" name="id" value={e.id.toString()} />
                      <button type="submit" className="ghost-btn">
                        Cancel
                      </button>
                    </form>
                    <form action={reschedule} className="inline-form">
                      <input type="hidden" name="id" value={e.id.toString()} />
                      <label>
                        <span>Reschedule</span>
                        <input
                          type="datetime-local"
                          name="scheduledSendAt"
                          defaultValue={toLocalInput(e.scheduledSendAt)}
                          required
                        />
                      </label>
                      <button type="submit">Update</button>
                    </form>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}

function toLocalInput(d: Date): string {
  const tzOffset = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - tzOffset).toISOString().slice(0, 16);
}
