// PC-10 (I007, I013, I014) — the send-failure model of the outreach queue.
//
// A failed queued send used to end 'failed' whatever the cause, so a
// greylisting 451, a translation hiccup or a restart mid-drain each lost
// the email for good, and nothing could put it back. Here every failure
// gets a KIND, and the kind decides what the queue does:
//
//   retry  transient       SMTP 4xx or no reply at all (greylisting, rate
//                          limit, busy server, dropped connection) — 5
//                          attempts with exponential backoff
//          local           failed on our side before the email reached the
//                          mail server (translation / AI, database) — 3
//          unknown         a send error we cannot read — 3
//   hold   sender_auth     the mail server refused the mailbox login: the
//                          mailbox is marked failing (flow:F-05) and its
//                          entries wait, attempts not counted
//   fail   recipient_hard  the receiving server says the address does not
//                          exist (sendMessage suppresses that address only)
//          policy          any other permanent refusal that is not about the
//                          recipient (relay, policy, content, sender), or
//                          the platform refused the message as it is
//          interrupted     the stuck-work reaper found the send cut off
//                          mid-flight with no sent copy: delivery unknown
//
// Sender-side failures never suppress a recipient: only recipient_hard
// does, and that decision stays in sendMessage (classifySmtpError).
//
// sendMessage TAGS the errors it throws (WeakMap / WeakSet, so the error
// objects and their messages stay exactly as nodemailer made them):
//   - a provider.send failure carries its SMTP classification;
//   - an error thrown AFTER the server accepted the message is "after
//     delivery": the email went out, so the queue must never retry it.
// Pure: no DB, no network.

import { classifySmtpError, type SmtpFailureClassification } from './smtp-errors';

export const SEND_FAILURE_KINDS = [
  'transient',
  'local',
  'unknown',
  'sender_auth',
  'recipient_hard',
  'policy',
  'interrupted',
] as const;
export type SendFailureKind = (typeof SEND_FAILURE_KINDS)[number];

export type SendFailureAction = 'retry' | 'hold' | 'fail';

export interface SendFailurePolicy {
  action: SendFailureAction;
  /** Attempts in total (the first one included) before a retryable kind
   *  gives up; 0 for kinds that are never retried automatically. */
  maxAttempts: number;
  /** Short operator label, e.g. on a queue row. */
  label: string;
  /** One sentence on what happened and what the queue does about it. */
  explanation: string;
}

export const TRANSIENT_MAX_ATTEMPTS = 5;
export const LOCAL_MAX_ATTEMPTS = 3;

export const SEND_FAILURE_POLICY: Readonly<Record<SendFailureKind, SendFailurePolicy>> = {
  transient: {
    action: 'retry',
    maxAttempts: TRANSIENT_MAX_ATTEMPTS,
    label: 'Temporary failure',
    explanation:
      'The mail server could not take the email right now (busy, rate limit, greylisting or a dropped connection). It is retried automatically.',
  },
  local: {
    action: 'retry',
    maxAttempts: LOCAL_MAX_ATTEMPTS,
    label: 'Error before sending',
    explanation:
      'Something failed on our side before the email reached the mail server (for example the translation). It is retried automatically.',
  },
  unknown: {
    action: 'retry',
    maxAttempts: LOCAL_MAX_ATTEMPTS,
    label: 'Unrecognised send error',
    explanation: 'The send failed with an error we could not read. It is retried automatically.',
  },
  sender_auth: {
    action: 'hold',
    maxAttempts: 0,
    label: 'Mailbox login refused',
    explanation:
      'The mail server refused the mailbox login. The mailbox is marked failing and its emails wait until it works again. No recipient is affected.',
  },
  recipient_hard: {
    action: 'fail',
    maxAttempts: 0,
    label: 'Address does not exist',
    explanation:
      'The receiving server says this address does not exist, so the address was suppressed. Sending again will not help.',
  },
  policy: {
    action: 'fail',
    maxAttempts: 0,
    label: 'Refused',
    explanation:
      'The email was refused for a reason that is not about the recipient (a relay, policy, content or sender rule, or a message that cannot be sent as it is). Fix the cause, then Retry.',
  },
  interrupted: {
    action: 'fail',
    maxAttempts: 0,
    label: 'Interrupted, delivery unknown',
    explanation:
      'Sending was cut off (a restart or a crash) and no sent copy was found, so the email may or may not have been delivered. Check the mailbox’s Sent folder before you retry.',
  },
};

export function isSendFailureKind(value: unknown): value is SendFailureKind {
  return typeof value === 'string' && (SEND_FAILURE_KINDS as readonly string[]).includes(value);
}

/** The label for a stored kind; null for an unknown / empty value. */
export function sendFailureLabel(kind: string | null | undefined): string | null {
  return isSendFailureKind(kind) ? SEND_FAILURE_POLICY[kind].label : null;
}

// ---- backoff ---------------------------------------------------------

export const SEND_BACKOFF_BASE_MS = 5 * 60 * 1000;
export const SEND_BACKOFF_MAX_MS = 2 * 60 * 60 * 1000;

/**
 * Delay before the next attempt after `attempt` attempts have failed
 * (attempt ≥ 1): 5, 10, 20, 40 … minutes, capped at 2 hours. Exponential
 * so a greylisting server (usually 5–15 min) is cleared early and a
 * longer outage is not hammered.
 */
export function sendBackoffMs(attempt: number): number {
  const n = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  // 2^(n-1) overflows nothing at these sizes; the cap bounds it anyway.
  return Math.min(SEND_BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 20), SEND_BACKOFF_MAX_MS);
}

export type RetryDecision =
  | { action: 'retry'; nextAttemptAt: Date; attempt: number; maxAttempts: number }
  | { action: 'give_up'; attempt: number; maxAttempts: number }
  | { action: 'hold' }
  | { action: 'fail' };

/**
 * What the queue does after attempt number `attempt` (1-based, this one
 * included) failed with `kind`.
 */
export function decideRetry(kind: SendFailureKind, attempt: number, now: Date): RetryDecision {
  const policy = SEND_FAILURE_POLICY[kind];
  if (policy.action === 'hold') return { action: 'hold' };
  if (policy.action === 'fail') return { action: 'fail' };
  if (attempt < policy.maxAttempts) {
    return {
      action: 'retry',
      nextAttemptAt: new Date(now.getTime() + sendBackoffMs(attempt)),
      attempt,
      maxAttempts: policy.maxAttempts,
    };
  }
  return { action: 'give_up', attempt, maxAttempts: policy.maxAttempts };
}

// ---- tagging thrown errors -------------------------------------------

const transportFailures = new WeakMap<object, SmtpFailureClassification>();
const afterDelivery = new WeakSet<object>();

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/** sendMessage: this error came from provider.send (the SMTP submission). */
export function tagTransportFailure(err: unknown, classification: SmtpFailureClassification): void {
  if (isObject(err)) transportFailures.set(err, classification);
}

/** The SMTP classification sendMessage attached, or null. */
export function transportFailureOf(err: unknown): SmtpFailureClassification | null {
  return isObject(err) ? (transportFailures.get(err) ?? null) : null;
}

/** sendMessage: this error was thrown after the server accepted the
 *  message — the email went out, whatever failed afterwards. */
export function tagAfterDelivery(err: unknown): void {
  if (isObject(err)) afterDelivery.add(err);
}

export function isAfterDelivery(err: unknown): boolean {
  return isObject(err) && afterDelivery.has(err);
}

// ---- classification --------------------------------------------------

export interface ClassifiedSendFailure {
  kind: SendFailureKind;
  /** The error's own message (not masked: it stays on the tenant's row). */
  message: string;
  /** The SMTP reading, when the error came from the submission. */
  smtp: SmtpFailureClassification | null;
}

/** Codes of the platform's own refusals (MailServiceError & co.): the
 *  message cannot be sent as it is, so retrying would not help. */
const PERMANENT_LOCAL_CODES: ReadonlySet<string> = new Set(['invalid_input', 'permission_denied']);

const SMTP_KIND_TO_SEND_KIND: Readonly<Record<SmtpFailureClassification['kind'], SendFailureKind>> =
  {
    auth: 'sender_auth',
    recipient_hard: 'recipient_hard',
    transient: 'transient',
    connection: 'transient',
    rejected: 'policy',
    unknown: 'unknown',
  };

/**
 * Classify an error thrown while sending a queued email. The caller
 * handles "after delivery" (isAfterDelivery) and the suppression refusal
 * before calling this; everything else maps to a kind.
 *
 * `attempted` is only used for an SMTP-shaped error sendMessage did not
 * tag (defensive: today every provider error is tagged).
 */
export function classifySendFailure(
  err: unknown,
  attempted: ReadonlyArray<string> = [],
): ClassifiedSendFailure {
  const message = err instanceof Error ? err.message : String(err);
  const tagged = transportFailureOf(err);
  if (tagged) {
    return { kind: SMTP_KIND_TO_SEND_KIND[tagged.kind], message, smtp: tagged };
  }
  const e = (isObject(err) ? err : {}) as {
    code?: unknown;
    responseCode?: unknown;
    command?: unknown;
  };
  if (typeof e.code === 'string' && PERMANENT_LOCAL_CODES.has(e.code)) {
    return { kind: 'policy', message, smtp: null };
  }
  if (typeof e.responseCode === 'number' || typeof e.command === 'string') {
    const smtp = classifySmtpError(err, attempted);
    return { kind: SMTP_KIND_TO_SEND_KIND[smtp.kind], message, smtp };
  }
  return { kind: 'local', message, smtp: null };
}
