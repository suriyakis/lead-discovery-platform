// MOB-06: every action that sends, spends or decides is wrapped in
// withWorkspaceGuard (server actions) or withWorkspaceGuardRoute (API
// routes) under one of these ids. src/tests/workspace-guard.test.ts maps
// each id to its export and fails when one is missing or unwrapped, and
// when a form or fetch that reaches it does not carry the page's
// workspace.

export const GUARDED_ACTIONS = {
  // Review (decide; Generate draft spends tokens)
  'review.approve': 'Approve a review item',
  'review.reject': 'Reject a review item',
  'review.ignore': 'Ignore a review item',
  'review.flag': 'Flag a review item for a second look',
  'review.archive': 'Archive a review item',
  'review.generate_draft': 'Generate an outreach draft from a review item',
  'review.bulk_archive': 'Archive selected review items',
  'review.bulk_delete': 'Delete selected review items',
  // Drafts
  'draft.approve': 'Approve an outreach draft',
  'draft.enqueue': 'Queue an outreach draft for sending',
  'draft.reject': 'Reject an outreach draft',
  'draft.regenerate': 'Regenerate an outreach draft',
  'draft.archive': 'Archive an outreach draft',
  'draft.translate': 'Translate an outreach draft',
  // Follow-ups
  'follow_up.approve': 'Approve (send) a follow-up',
  'follow_up.skip': "Cancel a thread's pending follow-ups",
  'follow_up.reject': 'Reject (skip) a follow-up',
  // Conversations
  'communication.reply': 'Send a reply in a conversation',
  'communication.compose': 'Send a new email from a mailbox',
  'communication.compose_translate': 'Translate a composed email',
  'communication.suggest_reply': 'Draft a reply with AI',
  'communication.translate': 'Translate a reply or follow-up',
  // Send queue
  'queue.save_settings': 'Save the send settings',
  'queue.cancel': 'Cancel a queued email',
  'queue.reschedule': 'Reschedule a queued email',
  'queue.retry': 'Retry a queued email now',
  'queue.requeue': 'Requeue a queued email',
  'queue.mark_delivered': 'Mark a queued email as delivered',
  'queue.drain': 'Send the due queued emails now',
  // Autopilot and the workspace pause
  'autopilot.save_defaults': 'Save the autopilot workspace defaults',
  'autopilot.save_product': "Save a product's autopilot overrides",
  'autopilot.clear_product': "Clear a product's autopilot overrides",
  'autopilot.pause_product': "Pause a product's automation",
  'autopilot.resume_product': "Resume a product's automation",
  'autopilot.run_now': 'Run autopilot once now',
  'automation.pause': 'Pause all automation',
  'automation.undo_pause': 'Undo a pause',
  'automation.resume': 'Resume automation',
  // Billing (spend)
  'billing.buy_tokens': 'Buy a token pack',
  'billing.subscribe': 'Subscribe to a plan',
  'billing.auto_topup': 'Change auto top-up',
  // The assistant (spends tokens)
  'assistant.ask': 'Ask the platform guide',
} as const;

export type GuardedActionId = keyof typeof GUARDED_ACTIONS;

export const GUARDED_ACTION_IDS = Object.keys(GUARDED_ACTIONS) as GuardedActionId[];

/**
 * DS-07: whether a guarded server action re-renders the workspace frame
 * when it succeeds (refreshChrome(): the sidebar badges, the bell, the
 * automation banners). Every id is classified, so a new guarded action
 * has to decide. 'none' is for actions that only hand a value back to the
 * page (translations, AI suggestions) and change no count or banner, and
 * for API routes (withWorkspaceGuardRoute), whose callers refresh the
 * badges themselves with refreshAttention().
 */
export const GUARDED_ACTION_CHROME: Readonly<Record<GuardedActionId, 'refresh' | 'none'>> = {
  'review.approve': 'refresh',
  'review.reject': 'refresh',
  'review.ignore': 'refresh',
  'review.flag': 'refresh',
  'review.archive': 'refresh',
  'review.generate_draft': 'refresh',
  'review.bulk_archive': 'refresh',
  'review.bulk_delete': 'refresh',
  'draft.approve': 'refresh',
  'draft.enqueue': 'refresh',
  'draft.reject': 'refresh',
  'draft.regenerate': 'refresh',
  'draft.archive': 'refresh',
  'draft.translate': 'none',
  'follow_up.approve': 'refresh',
  'follow_up.skip': 'refresh',
  'follow_up.reject': 'refresh',
  'communication.reply': 'none',
  'communication.compose': 'refresh',
  'communication.compose_translate': 'none',
  'communication.suggest_reply': 'none',
  'communication.translate': 'none',
  'queue.save_settings': 'refresh',
  'queue.cancel': 'refresh',
  'queue.reschedule': 'refresh',
  'queue.retry': 'refresh',
  'queue.requeue': 'refresh',
  'queue.mark_delivered': 'refresh',
  'queue.drain': 'refresh',
  'autopilot.save_defaults': 'refresh',
  'autopilot.save_product': 'refresh',
  'autopilot.clear_product': 'refresh',
  'autopilot.pause_product': 'refresh',
  'autopilot.resume_product': 'refresh',
  'autopilot.run_now': 'refresh',
  'automation.pause': 'refresh',
  'automation.undo_pause': 'refresh',
  'automation.resume': 'refresh',
  'billing.buy_tokens': 'refresh',
  'billing.subscribe': 'refresh',
  'billing.auto_topup': 'refresh',
  'assistant.ask': 'none',
};
