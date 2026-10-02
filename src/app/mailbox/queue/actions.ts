'use server';

// Server actions for /mailbox/queue: save send settings, cancel or
// reschedule a queued email, and drain the queue now.
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
  rescheduleQueueEntry,
  updateSendSettings,
} from '@/lib/services/outreach-queue';
import { isNextRedirectError } from '@/lib/server-redirect';
import {
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

export async function drainSendQueueAction(formData: FormData): Promise<void> {
  const view = parseQueueView(formData.get('status'));
  const ctx = await requireActionContext();
  const message = await runOrFlash(view, 'drain', async () => {
    const r = await drainQueue(ctx);
    // PC-05: the gate stopped the drain (the workspace pause, a hold, the
    // platform stop) — say why rather than implying the queue is empty.
    const held = r.heldReason ? ` Stopped: ${r.heldReason}` : '';
    if (r.picked > 0) {
      const deferred =
        r.deferred > 0 ? ` (${r.deferred} held — each shows why)` : '';
      return `Sent ${r.sent}, skipped ${r.skipped}${deferred}, failed ${r.failed} of ${r.picked} due ${
        r.picked === 1 ? 'email' : 'emails'
      }.${held}`;
    }
    return r.heldReason
      ? `Nothing was sent. ${r.heldReason}`
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
