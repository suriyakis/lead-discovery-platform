// Notification kinds: the one registry of what can ring the bell (DS-09).
//
// notifications.kind is free-form text so a new kind needs no migration,
// but every producer goes through notify() / notifyWorkspaceAdmins(),
// whose `kind` is typed to this list: a call with an unregistered kind
// fails typecheck. src/lib/ui/tone.ts and labels.ts map every kind to a
// tone and an operator-facing label (both `satisfies Record<…>`, so a kind
// added here without them fails typecheck too), and
// src/tests/signals.test.ts cross-checks the lists at runtime.
//
// Keep it append-only: rows of a kind nothing writes any more still sit in
// the feed. Pure module (no imports), so pages, client components and
// scripts can share it.

export const NOTIFICATION_KINDS = [
  // Work waiting for a person
  /** qualification.ts: relevant records whose location could not be verified. */
  'review.needs_review',
  /** follow-up.ts: staged follow-ups wait for approval. */
  'follow_up.awaiting_approval',
  /** health-check.ts: the weekly check found warnings. */
  'health.warning',
  // Conversations and people
  /** mail.ts: a prospect answered our outreach. */
  'lead.replied',
  /** review.ts: someone @-mentioned the recipient in a comment. */
  'mention',
  /** review.ts: a record was assigned to the recipient. */
  'assignment',
  /** support.ts: the platform team answered a support thread. */
  'support.reply',
  // Failures
  /** connectors/runner.ts: a search run failed. */
  'run.failed',
  /** mailbox.ts: a mailbox's connection keeps failing (flow:F-04). */
  'mailbox.failing',
  // Learning
  /** learning-synthesis.ts: weekly self-learning proposed lessons. */
  'learning.synthesis',
  // Tokens and billing
  /** token-ledger.ts: the wallet crossed the low-balance threshold. */
  'tokens.low',
  /** token-ledger.ts: the wallet is empty; metered work is paused. */
  'tokens.empty',
  /** billing.ts: an automatic top-up was charged. */
  'tokens.auto_topup',
  /** billing.ts: an automatic top-up is still settling; tokens follow. */
  'tokens.auto_topup_pending',
  /** billing.ts: an automatic top-up was declined. */
  'tokens.auto_topup_failed',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

const KNOWN: ReadonlySet<string> = new Set(NOTIFICATION_KINDS);

/** True for a registered kind (rows are text: older rows may hold others). */
export function isNotificationKind(kind: string): kind is NotificationKind {
  return KNOWN.has(kind);
}
