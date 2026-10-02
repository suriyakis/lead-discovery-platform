import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ExpectedWorkspaceField } from '@/components/WorkspaceGuard';
import { Badge, StatusBadge } from '@/components/Badge';
import { auth } from '@/lib/auth';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { ConfirmFormButton } from '@/components/ConfirmFormButton';
import { canAdminWorkspace, canWrite } from '@/lib/services/context';
import {
  getSendSettings,
  isRecoverableQueueStatus,
  listQueueEntries,
} from '@/lib/services/outreach-queue';
import { getAutomationPauseOverview } from '@/lib/services/automation-pause';
import { AutomationPauseControl } from '@/components/AutomationPauseControl';
import { SEND_STUCK_AFTER_MS } from '@/lib/services/stuck-work';
import { TRANSIENT_MAX_ATTEMPTS, LOCAL_MAX_ATTEMPTS } from '@/lib/mail/send-failure';
import {
  cancelQueuedEmailAction,
  drainSendQueueAction,
  markQueuedEmailDeliveredAction,
  requeueQueuedEmailAction,
  rescheduleQueuedEmailAction,
  retryQueuedEmailAction,
  saveSendSettingsAction,
} from './actions';
import {
  INTERRUPTED_RESEND_CONFIRM,
  MARK_DELIVERED_CONFIRM,
  SEND_SETTINGS_LIMITS,
  describeBackoff,
  describeSendSettings,
  failureKindBadge,
  formatUtc,
  parseQueueView,
  toUtcInputValue,
  type QueueView,
} from './forms';
import { outreachQueueStatus } from '@/lib/db/schema/outreach';
import { labelFor, OUTREACH_QUEUE_STATUS_LABEL } from '@/lib/ui/labels';
import { NoWorkspaceState } from '@/components/NoWorkspaceState';

/** One tab per queue status, labelled from the one vocabulary (DS-09). */
const STATUS_TABS: ReadonlyArray<{ key: QueueView; label: string }> = [
  ...outreachQueueStatus.enumValues.map((key) => ({ key, label: OUTREACH_QUEUE_STATUS_LABEL[key] })),
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
    if (err instanceof NoWorkspaceError) return <NoWorkspaceState />;
    throw err;
  }
  const settings = await getSendSettings(ctx);
  const pauseOverview = await getAutomationPauseOverview(ctx);
  const entries = await listQueueEntries(ctx, {
    status: statusKey === 'all' ? undefined : statusKey,
    limit: 200,
  });
  // The real role decides what is editable: admins change the settings
  // (updateSendSettings enforces the same rule), writers act on entries,
  // viewers only read.
  const isAdmin = canAdminWorkspace(ctx);
  const canAct = canWrite(ctx);
  // Rendered per request; the page is dynamic (auth), so "now" is fresh.
  const stuckBefore = Date.now() - SEND_STUCK_AFTER_MS;

  return (
    <>
      <p className="muted">
        <Link href="/today">Today</Link> /{' '}
        <Link href="/mailbox">Mailbox</Link> / Queue
      </p>
      <h1>Send queue</h1>
      {sp.message ? <p className="form-message">{sp.message}</p> : null}
      {sp.error ? <p className="form-error">{sp.error}</p> : null}

      {/* PC-05: the workspace pause replaces the "Emergency pause (kill
          switch)" checkbox that sat in the settings form below (it wrote
          a separate send-queue flag and only admins could reach it). The
          sidebar's interim Emergency stop (ia:F-10) links to it (#pause). */}
      <AutomationPauseControl overview={pauseOverview} returnTo="/mailbox/queue" />

      <section id="send-settings">
        <h2>Send settings</h2>
        {isAdmin ? (
          <form action={saveSendSettingsAction} className="edit-draft-form">
            <ExpectedWorkspaceField />
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
            <ExpectedWorkspaceField />
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
        <h2>
          {statusKey === 'all' ? 'All entries' : OUTREACH_QUEUE_STATUS_LABEL[statusKey]}{' '}
          ({entries.length})
        </h2>
        <p className="muted small">All times are in UTC.</p>
        {statusKey === 'failed' || statusKey === 'skipped' || statusKey === 'all' ? (
          <p className="muted small">
            A send that fails for a temporary reason is retried automatically (up to{' '}
            {TRANSIENT_MAX_ATTEMPTS} attempts; {LOCAL_MAX_ATTEMPTS} for an error before
            sending), waiting longer each time.
            {canAct
              ? ' Retry now sends a failed, skipped or cancelled email again at once; Requeue puts it back for the background sender. Both go through the same checks again: suppression, limits and the domain cooldown. An email cut off mid-send can instead be marked as delivered once you find it in the Sent folder. An email that has already gone out is never sent twice.'
              : null}
          </p>
        ) : null}
        {entries.length === 0 ? (
          <p className="muted">Nothing in this view.</p>
        ) : (
          <ul className="lead-list">
            {entries.map((e) => {
              const kind = failureKindBadge(e.lastFailureKind);
              const backoff = e.status === 'queued' ? describeBackoff(e) : null;
              const interrupted = e.lastFailureKind === 'interrupted';
              const stuck =
                e.status === 'sending' &&
                (e.claimedAt ?? e.updatedAt).getTime() < stuckBefore;
              return (
                <li key={e.id.toString()}>
                  <div className="lead-row">
                    <strong>{e.subject}</strong>
                    <StatusBadge set="outreach_queue_status" value={e.status} />
                    {kind ? (
                      <Badge tone={e.status === 'failed' ? 'danger' : 'attention'} title={kind.title}>
                        {kind.label}
                      </Badge>
                    ) : null}
                    <span className="muted">{e.toAddresses.join(', ')}</span>
                  </div>
                  <div className="lead-meta">
                    <span>scheduled {formatUtc(e.scheduledSendAt)}</span>
                    <span>delay: {labelFor('send_delay_mode', e.delayMode).toLowerCase()}</span>
                    <span>attempts: {e.attemptCount}</span>
                    {backoff ? <span>{backoff}</span> : null}
                    {e.status === 'sending' && e.claimedAt ? (
                      <span>picked up {formatUtc(e.claimedAt)}</span>
                    ) : null}
                  </div>
                  {stuck ? (
                    <p className="queue-reason queue-reason-warn">
                      This send has not finished for more than 10 minutes. It is checked
                      automatically within a few minutes: marked sent if a sent copy is found,
                      otherwise failed as &ldquo;delivery unknown&rdquo;.
                    </p>
                  ) : null}
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
                        <ExpectedWorkspaceField />
                        <input type="hidden" name="status" value={statusKey} />
                        <input type="hidden" name="id" value={e.id.toString()} />
                        <button type="submit" className="ghost-btn">
                          Cancel
                        </button>
                      </form>
                      <form action={rescheduleQueuedEmailAction} className="inline-form">
                        <ExpectedWorkspaceField />
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
                  {canAct && isRecoverableQueueStatus(e.status) ? (
                    <div className="action-row" style={{ marginTop: '0.5rem' }}>
                      <form action={retryQueuedEmailAction}>
                        <ExpectedWorkspaceField />
                        <input type="hidden" name="status" value={statusKey} />
                        <input type="hidden" name="id" value={e.id.toString()} />
                        {/* PC-05: Retry now is a manual send; while automation
                            is paused it goes out only with an explicit "send
                            anyway" (audited as outbound.override). Requeue
                            needs none: it sends nothing. */}
                        {pauseOverview.pause ? (
                          <label className="checkbox-row">
                            <input type="checkbox" name="confirmPaused" value="on" required />
                            <span>
                              Automation is paused. Send this email anyway (recorded in the
                              audit log).
                            </span>
                          </label>
                        ) : null}
                        {interrupted ? (
                          <ConfirmFormButton message={INTERRUPTED_RESEND_CONFIRM}>
                            Retry now
                          </ConfirmFormButton>
                        ) : (
                          <button type="submit">Retry now</button>
                        )}
                      </form>
                      <form action={requeueQueuedEmailAction}>
                        <ExpectedWorkspaceField />
                        <input type="hidden" name="status" value={statusKey} />
                        <input type="hidden" name="id" value={e.id.toString()} />
                        {interrupted ? (
                          <ConfirmFormButton
                            message={INTERRUPTED_RESEND_CONFIRM}
                            className="ghost-btn"
                          >
                            Requeue
                          </ConfirmFormButton>
                        ) : (
                          <button type="submit" className="ghost-btn">
                            Requeue
                          </button>
                        )}
                      </form>
                      {interrupted ? (
                        <form action={markQueuedEmailDeliveredAction}>
                          <ExpectedWorkspaceField />
                          <input type="hidden" name="status" value={statusKey} />
                          <input type="hidden" name="id" value={e.id.toString()} />
                          <ConfirmFormButton message={MARK_DELIVERED_CONFIRM} className="ghost-btn">
                            Mark as delivered
                          </ConfirmFormButton>
                        </form>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
