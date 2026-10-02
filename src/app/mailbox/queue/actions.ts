'use server';

// Server actions for /mailbox/queue: save send settings, cancel or
// reschedule a queued email, retry or requeue a failed / skipped /
// cancelled one (PC-10), and drain the queue now.
//
// They used to be inline actions in page.tsx with no error handling, and
// the settings form was shown to everyone because the page checked
// canAdminWorkspace() against a hard-coded 'admin' role. A member who
// pressed Save hit updateSendSettings' permission check and landed on
// Next's generic error page (audit I159, deliverable ia:F-02). Every
// action now turns a failure into a flash on the queue page instead.
//
// The redirects happen outside the try blocks, and each catch re-throws
// NEXT_REDIRECT first, so a successful redirect is never mistaken for a
// failure.

import { redirect } from 'next/navigation';
import { requireActionContext } from '@/lib/action-context';
import {
  OutreachQueueError,
  cancelQueueEntry,
  drainQueue,
  getSendSettings,
  requeueQueueEntry,
  rescheduleQueueEntry,
  retryQueueEntry,
  updateSendSettings,
} from '@/lib/services/outreach-queue';
import { isNextRedirectError } from '@/lib/server-redirect';
import {
  REQUEUED_MESSAGE,
  describeRetryOutcome,
  formatUtc,
  parseEntryId,
  parseQueueView,
  parseSendSettingsForm,
  parseUtcDateTimeLocal,
  queueErrorMessage,
  queueHref,
  type QueueOperation,
  type QueueView,
} from './forms';

export async function saveSendSettingsAction(formData: FormData): Promise<void> {
  const view = parseQueueView(formData.get('status'));
  const ctx = await requireActionContext();
  const parsed = parseSendSettingsForm(formData);
  if (!parsed.ok) backToQueue(view, 'error', parsed.error);
  await runOrFlash(view, 'settings', () => updateSendSettings(ctx, parsed.value));
  backToQueue(view, 'message', 'Send settings saved.');
}

export async function cancelQueuedEmailAction(formData: FormData): Promise<void> {
  const view = parseQueueView(formData.get('status'));
  const ctx = await requireActionContext();
  const id = parseEntryId(formData.get('id'));
  if (id === null) backToQueue(view, 'error', 'That email is no longer in the queue.');
  await runOrFlash(view, 'cancel', () => cancelQueueEntry(ctx, id));
  backToQueue(view, 'message', 'Email cancelled. It will not be sent.');
}

export async function rescheduleQueuedEmailAction(formData: FormData): Promise<void> {
  const view = parseQueueView(formData.get('status'));
  const ctx = await requireActionContext();
  const id = parseEntryId(formData.get('id'));
  if (id === null) backToQueue(view, 'error', 'That email is no longer in the queue.');
  const when = parseUtcDateTimeLocal(formData.get('scheduledSendAt'));
  if (when === null) backToQueue(view, 'error', 'Enter a valid date and time (UTC).');
  await runOrFlash(view, 'reschedule', () => rescheduleQueueEntry(ctx, id, when));
  backToQueue(view, 'message', `Rescheduled for ${formatUtc(when)}.`);
}

/**
 * PC-10: Retry now — put a failed / skipped / cancelled email back and
 * attempt it at once, through the same checks as the drain. Any write
 * role (the same as Cancel); the service enforces it.
 */
export async function retryQueuedEmailAction(formData: FormData): Promise<void> {
  const view = parseQueueView(formData.get('status'));
  const ctx = await requireActionContext();
  const id = parseEntryId(formData.get('id'));
  if (id === null) backToQueue(view, 'error', 'That email is no longer in the queue.');
  const result = await runOrFlash(view, 'retry', () => retryQueueEntry(ctx, id));
  const flash = describeRetryOutcome(result);
  backToQueue(view, flash.kind, flash.text);
}

/** PC-10: Requeue — put it back for the background send pass. */
export async function requeueQueuedEmailAction(formData: FormData): Promise<void> {
  const view = parseQueueView(formData.get('status'));
  const ctx = await requireActionContext();
  const id = parseEntryId(formData.get('id'));
  if (id === null) backToQueue(view, 'error', 'That email is no longer in the queue.');
  await runOrFlash(view, 'requeue', () => requeueQueueEntry(ctx, id));
  backToQueue(view, 'message', REQUEUED_MESSAGE);
}

export async function drainSendQueueAction(formData: FormData): Promise<void> {
  const view = parseQueueView(formData.get('status'));
  const ctx = await requireActionContext();
  const message = await runOrFlash(view, 'drain', async () => {
    const r = await drainQueue(ctx);
    if (r.picked > 0) {
      const retrying = r.retrying > 0 ? `, ${r.retrying} will be retried` : '';
      return `Sent ${r.sent}, skipped ${r.skipped}, failed ${r.failed}${retrying} of ${r.picked} due ${
        r.picked === 1 ? 'email' : 'emails'
      }.`;
    }
    // drainQueue returns all zeros when sending is paused; say so rather
    // than implying the queue is simply empty.
    const settings = await getSendSettings(ctx);
    return settings.emergencyPause
      ? 'Sending is paused, so nothing was sent. Turn off the emergency pause to resume.'
      : "Nothing was sent: no emails are due yet, or today's limit has been reached.";
  });
  backToQueue(view, 'message', message);
}

// ---- helpers (module scope: never captured by an action's closure) ----

/**
 * Run a service call; on failure flash a human error instead. Expected
 * refusals (permission, conflict, not found) are OutreachQueueErrors and
 * need no log line; anything else is logged with the real message.
 */
async function runOrFlash<T>(
  view: QueueView,
  op: QueueOperation,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (!(err instanceof OutreachQueueError)) {
      console.error(`[mailbox/queue] ${op} failed:`, err instanceof Error ? err.message : err);
    }
    backToQueue(view, 'error', queueErrorMessage(err, op));
  }
}

function backToQueue(view: QueueView, kind: 'message' | 'error', text: string): never {
  redirect(queueHref(view, { kind, text }));
}
