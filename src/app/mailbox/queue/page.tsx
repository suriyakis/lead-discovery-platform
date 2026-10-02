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
import { canAdminWorkspace, canWrite } from '@/lib/services/context';
import { getSendSettings, listQueueEntries } from '@/lib/services/outreach-queue';
import {
  cancelQueuedEmailAction,
  drainSendQueueAction,
  rescheduleQueuedEmailAction,
  saveSendSettingsAction,
} from './actions';
import {
  SEND_SETTINGS_LIMITS,
  describeSendSettings,
  formatUtc,
  parseQueueView,
  toUtcInputValue,
  type QueueView,
} from './forms';

const STATUS_TABS: ReadonlyArray<{ key: QueueView; label: string }> = [
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
  const statusKey = parseQueueView(sp.status);

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) redirect('/');
    throw err;
  }
  const settings = await getSendSettings(ctx);
  const entries = await listQueueEntries(ctx, {
    status: statusKey === 'all' ? undefined : statusKey,
    limit: 200,
  });
  // The real role decides what is editable: admins change the settings
  // (updateSendSettings enforces the same rule), writers act on entries,
  // viewers only read.
  const isAdmin = canAdminWorkspace(ctx);
  const canAct = canWrite(ctx);

  return (
    <AppShell>
      <p className="muted">
        <Link href="/today">Today</Link> /{' '}
        <Link href="/mailbox">Mailbox</Link> / Queue
      </p>
      <h1>Send queue</h1>
      {sp.message ? <p className="form-message">{sp.message}</p> : null}
      {sp.error ? <p className="form-error">{sp.error}</p> : null}

      {/* The sidebar's interim Emergency stop links here (ia:F-10). */}
      <section id="send-settings">
        <h2>Send settings</h2>
        {settings.emergencyPause ? (
          <p className="form-error">
            Emergency pause is on. Queued emails are held while sending is paused.
          </p>
        ) : null}
        {isAdmin ? (
          <form action={saveSendSettingsAction} className="edit-draft-form">
            <input type="hidden" name="status" value={statusKey} />
            <fieldset className="ks-kind-fields">
              <legend className="muted">Limits</legend>
              <label>
                <span>Daily email limit</span>
                <input
                  type="number"
                  name="dailyEmailLimit"
                  defaultValue={settings.dailyEmailLimit}
                  min={0}
                  max={SEND_SETTINGS_LIMITS.dailyEmailLimit}
                  required
                />
              </label>
              <label>
                <span>Domain cooldown hours</span>
                <input
                  type="number"
                  name="domainCooldownHours"
                  defaultValue={settings.domainCooldownHours}
                  min={0}
                  max={SEND_SETTINGS_LIMITS.domainCooldownHours}
                  required
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
                  max={SEND_SETTINGS_LIMITS.delayMinutes}
                  required
                />
              </label>
              <label>
                <span>Random min (minutes)</span>
                <input
                  type="number"
                  name="randomDelayMinMinutes"
                  defaultValue={settings.randomDelayMinMinutes}
                  min={0}
                  max={SEND_SETTINGS_LIMITS.delayMinutes}
                  required
                />
              </label>
              <label>
                <span>Random max (minutes)</span>
                <input
                  type="number"
                  name="randomDelayMaxMinutes"
                  defaultValue={settings.randomDelayMaxMinutes}
                  min={0}
                  max={SEND_SETTINGS_LIMITS.delayMinutes}
                  required
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
        ) : (
          <p className="muted">
            {describeSendSettings(settings)} Only workspace admins can change these
            settings.
          </p>
        )}
      </section>

      {canAct ? (
        <section>
          <h2>Send now</h2>
          <p className="muted">
            Due emails are sent automatically in the background. Use this to send
            the ones that are already due right away.
          </p>
          <form action={drainSendQueueAction}>
            <input type="hidden" name="status" value={statusKey} />
            <button type="submit">Send due emails now</button>
          </form>
        </section>
      ) : null}

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
        <p className="muted small">All times are in UTC.</p>
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
                  <span>scheduled {formatUtc(e.scheduledSendAt)}</span>
                  <span>delay: {e.delayMode}</span>
                  <span>attempts: {e.attemptCount}</span>
                </div>
                {e.lastError ? (
                  <p
                    className={
                      e.status === 'queued'
                        ? 'queue-reason queue-reason-info'
                        : 'queue-reason queue-reason-warn'
                    }
                  >
                    {e.status === 'queued' ? (
                      <>
                        <strong>Why scheduled here:</strong> {e.lastError}
                      </>
                    ) : (
                      e.lastError.slice(0, 400)
                    )}
                  </p>
                ) : null}
                {canAct && e.status === 'queued' ? (
                  <div className="action-row" style={{ marginTop: '0.5rem' }}>
                    <form action={cancelQueuedEmailAction}>
                      <input type="hidden" name="status" value={statusKey} />
                      <input type="hidden" name="id" value={e.id.toString()} />
                      <button type="submit" className="ghost-btn">
                        Cancel
                      </button>
                    </form>
                    <form action={rescheduleQueuedEmailAction} className="inline-form">
                      <input type="hidden" name="status" value={statusKey} />
                      <input type="hidden" name="id" value={e.id.toString()} />
                      <label>
                        <span>Reschedule (UTC)</span>
                        <input
                          type="datetime-local"
                          name="scheduledSendAt"
                          defaultValue={toUtcInputValue(e.scheduledSendAt)}
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
