// Form parsing, error wording and time formatting for /mailbox/queue.
//
// A plain module (no 'use server'), so the page, the server actions in
// ./actions.ts and the tests can all import it. A 'use server' module may
// only export async functions.

import { z } from 'zod';
import {
  outreachQueueStatus,
  sendDelayMode,
  type OutreachQueueStatus,
  type OutreachSendSettings,
} from '@/lib/db/schema/outreach';
import {
  OutreachQueueError,
  type RetryQueueEntryResult,
  type SendGateRefusal,
  type UpdateSendSettingsInput,
} from '@/lib/services/outreach-queue';
import { withFlash } from '@/lib/action-errors';
import { SEND_FAILURE_POLICY, isSendFailureKind } from '@/lib/mail/send-failure';
import { formatUtc as formatUtcDate } from '@/lib/format-utc';

// ---- views ----------------------------------------------------------

/** The status tabs on the page; 'all' lists every status. */
export type QueueView = OutreachQueueStatus | 'all';

export const QUEUE_VIEWS: readonly QueueView[] = [...outreachQueueStatus.enumValues, 'all'];

/** The view a form posted from; anything unknown falls back to 'queued'. */
export function parseQueueView(raw: unknown): QueueView {
  const s = typeof raw === 'string' ? raw : '';
  return (QUEUE_VIEWS as readonly string[]).includes(s) ? (s as QueueView) : 'queued';
}

/** /mailbox/queue on `view`, optionally carrying a flash message or error
 *  (the shared withFlash builder of src/lib/action-errors.ts). */
export function queueHref(view: QueueView, flash?: { kind: 'message' | 'error'; text: string }): string {
  const path = view === 'queued' ? '/mailbox/queue' : `/mailbox/queue?status=${view}`;
  return flash ? withFlash(path, { [flash.kind]: flash.text }) : path;
}

// ---- send settings --------------------------------------------------

// Upper bounds match the clamps in updateSendSettings, so the form
// rejects what the service would otherwise silently cut down.
export const SEND_SETTINGS_LIMITS = {
  dailyEmailLimit: 10_000,
  domainCooldownHours: 24 * 30,
  delayMinutes: 24 * 60,
} as const;

function wholeNumber(label: string, max: number) {
  return z
    .string({ required_error: `${label} is required.` })
    .trim()
    .min(1, `${label} is required.`)
    .regex(/^\d+$/, `${label} must be a whole number (0 or more).`)
    .transform(Number)
    .refine((n) => n <= max, `${label} can be at most ${max.toLocaleString('en-GB')}.`);
}

const sendSettingsSchema = z
  .object({
    dailyEmailLimit: wholeNumber('Daily email limit', SEND_SETTINGS_LIMITS.dailyEmailLimit),
    domainCooldownHours: wholeNumber(
      'Domain cooldown hours',
      SEND_SETTINGS_LIMITS.domainCooldownHours,
    ),
    defaultDelayMode: z.enum(sendDelayMode.enumValues, {
      errorMap: () => ({ message: 'Choose a delay mode: immediate, fixed or random.' }),
    }),
    fixedDelayMinutes: wholeNumber('Fixed delay', SEND_SETTINGS_LIMITS.delayMinutes),
    randomDelayMinMinutes: wholeNumber('Random min', SEND_SETTINGS_LIMITS.delayMinutes),
    randomDelayMaxMinutes: wholeNumber('Random max', SEND_SETTINGS_LIMITS.delayMinutes),
    emergencyPause: z.boolean(),
  })
  .refine((v) => v.randomDelayMinMinutes <= v.randomDelayMaxMinutes, {
    message: 'Random min cannot be more than random max.',
  });

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validate the Send settings form. The first problem becomes the error. */
export function parseSendSettingsForm(formData: FormData): ParseResult<UpdateSendSettingsInput> {
  const text = (key: string): string | undefined => {
    const v = formData.get(key);
    return typeof v === 'string' ? v : undefined;
  };
  const result = sendSettingsSchema.safeParse({
    dailyEmailLimit: text('dailyEmailLimit'),
    domainCooldownHours: text('domainCooldownHours'),
    defaultDelayMode: text('defaultDelayMode'),
    fixedDelayMinutes: text('fixedDelayMinutes'),
    randomDelayMinMinutes: text('randomDelayMinMinutes'),
    randomDelayMaxMinutes: text('randomDelayMaxMinutes'),
    // An unticked checkbox is simply absent from the form.
    emergencyPause: formData.get('emergencyPause') === 'on',
  });
  if (!result.success) {
    return { ok: false, error: result.error.issues[0]?.message ?? 'Check the send settings.' };
  }
  return { ok: true, value: result.data };
}

/** One-line, read-only summary of the settings for non-admins. */
export function describeSendSettings(s: OutreachSendSettings): string {
  const delay =
    s.defaultDelayMode === 'immediate'
      ? 'no delay before sending'
      : s.defaultDelayMode === 'fixed'
        ? `a ${s.fixedDelayMinutes}-minute delay before sending`
        : `a random ${s.randomDelayMinMinutes}–${s.randomDelayMaxMinutes}-minute delay before sending`;
  return (
    `Up to ${s.dailyEmailLimit} emails a day, ${s.domainCooldownHours} h between emails ` +
    `to the same domain, ${delay}.`
  );
}

// ---- queue entries --------------------------------------------------

/** A queue entry id from a form; null when it is not a positive integer. */
export function parseEntryId(raw: unknown): bigint | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+$/.test(s)) return null;
  const id = BigInt(s);
  return id > 0n ? id : null;
}

/**
 * A datetime-local value ("2026-10-01T14:30", seconds optional) read as
 * UTC. The page labels every time UTC, so the input means UTC too, no
 * matter what time zone the server runs in. Null when the value is
 * malformed or names a date that does not exist (e.g. 31 June).
 */
export function parseUtcDateTimeLocal(raw: unknown): Date | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map((p) => Number(p ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  // Date.UTC rolls 31 June over to 1 July; reject instead of guessing.
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day ||
    d.getUTCHours() !== hour ||
    d.getUTCMinutes() !== minute
  ) {
    return null;
  }
  return d;
}

// One UTC formatter for the app (src/lib/format-utc.ts, shared with the
// mailbox page and the health check); re-exported for the queue page.
export { formatUtc, toUtcInputValue } from '@/lib/format-utc';

// ---- errors ---------------------------------------------------------

export type QueueOperation = 'settings' | 'cancel' | 'reschedule' | 'drain' | 'retry' | 'requeue';

const FALLBACK: Record<QueueOperation, string> = {
  settings: 'Could not save the send settings. Please try again.',
  cancel: 'Could not cancel that email. Please try again.',
  reschedule: 'Could not reschedule that email. Please try again.',
  drain: 'Could not send the queue right now. Please try again.',
  retry: 'Could not retry that email. Please try again.',
  requeue: 'Could not put that email back in the queue. Please try again.',
};

/**
 * What the operator reads when a queue action fails. Service errors
 * carry developer wording ("Permission denied: outreach.queue.cancel",
 * "cannot cancel entry in status sent"), so map them by code. Anything
 * unexpected gets a generic line; the caller logs the real error.
 */
export function queueErrorMessage(err: unknown, op: QueueOperation): string {
  if (err instanceof OutreachQueueError) {
    switch (err.code) {
      case 'permission_denied':
        return op === 'settings'
          ? 'Only workspace admins can change the send settings.'
          : 'Your role can view the send queue but not change it.';
      case 'not_found':
        return 'That email is no longer in the queue.';
      case 'conflict':
        // PC-10: Retry / Requeue refusals are written for the operator.
        if (op === 'retry' || op === 'requeue') return err.message;
        return 'That email is no longer waiting to be sent: it has already been sent, cancelled or picked up for sending.';
      case 'invalid_input':
        return err.message;
    }
  }
  return FALLBACK[op];
}

// ---- retry / requeue (PC-10) ------------------------------------------

/** The flash after Retry now: what the attempt came to. */
export function describeRetryOutcome(result: RetryQueueEntryResult): {
  kind: 'message' | 'error';
  text: string;
} {
  const reason = result.entry.lastError ? ` ${result.entry.lastError.slice(0, 220)}` : '';
  switch (result.outcome) {
    case 'sent':
      return { kind: 'message', text: 'Sent.' };
    case 'queued':
      return { kind: 'message', text: `Put back in the queue. ${heldBecause(result.reason)}` };
    case 'retrying':
      return {
        kind: 'error',
        text: `It failed again for a temporary reason and will be retried automatically.${reason}`,
      };
    case 'skipped':
      return { kind: 'message', text: `Not sent now.${reason}` };
    case 'failed':
      return { kind: 'error', text: `It failed again.${reason}` };
  }
}

/**
 * Why Retry now put an email back without sending it: the send gate's
 * refusal (services/outreach-queue.ts evaluateSendGate). Exhaustive on
 * purpose: a refusal added to the gate does not compile until it is
 * worded here.
 */
function heldBecause(reason: SendGateRefusal | undefined): string {
  switch (reason) {
    case 'paused':
      return 'Sending is paused, so it goes out once the emergency pause is switched off.';
    case 'daily_limit':
      return "Today's email limit is used up, so it goes out when there is room again.";
    case undefined:
      return 'It goes out with the next send pass.';
  }
}

/** The Send now flash when the send gate kept the whole pass from sending. */
export function describeDrainBlocked(reason: SendGateRefusal): string {
  switch (reason) {
    case 'paused':
      return 'Sending is paused, so nothing was sent. Turn off the emergency pause to resume.';
    case 'daily_limit':
      return "Nothing was sent: today's email limit has been reached.";
  }
}

export const REQUEUED_MESSAGE =
  'Put back in the queue. It goes out with the next send pass, after the usual checks (suppression, limits, cooldown).';

/** The confirmation Retry / Requeue ask for on an entry whose delivery is
 *  unknown (cut off mid-send). */
export const INTERRUPTED_RESEND_CONFIRM =
  'This email was cut off while it was being sent and no sent copy was found, so it may already have been delivered. Check the mailbox’s Sent folder first. Send it again?';

/** "next attempt … (after 2 of 5)" for a queued entry backing off. */
export function describeBackoff(entry: {
  attemptCount: number;
  nextAttemptAt: Date | null;
  lastFailureKind: string | null;
}): string | null {
  if (!entry.nextAttemptAt || !isSendFailureKind(entry.lastFailureKind)) return null;
  const max = SEND_FAILURE_POLICY[entry.lastFailureKind].maxAttempts;
  return `next attempt ${formatUtcDate(entry.nextAttemptAt)} (after ${entry.attemptCount} of ${max})`;
}

/** Label + explanation of a stored failure kind, or null. */
export function failureKindBadge(kind: string | null): { label: string; title: string } | null {
  if (!isSendFailureKind(kind)) return null;
  const policy = SEND_FAILURE_POLICY[kind];
  return { label: policy.label, title: policy.explanation };
}
