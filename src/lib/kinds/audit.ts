// Audit kinds: every audit_log.kind the platform writes (DS-09, ia:F-11).
//
// recordAuditEvent() and recordPlatformAuditEvent() type `kind` to
// AuditKind, so a producer cannot write an unregistered kind without a
// typecheck failure. The few direct inserts into audit_log (in-transaction
// writes, remediation scripts, the demo seed) are checked by
// src/tests/signals.test.ts. src/lib/ui/labels.ts gives every kind its
// operator-facing label (`satisfies Record<…>`), which the workspace and
// platform audit logs show instead of the raw code. Kinds are neutral: the
// log is history, not a signal.
//
// Append-only: the log keeps rows of kinds nothing writes any more, so a
// retired kind moves to LEGACY_AUDIT_KINDS (still labelled, no longer
// writable). PLATFORM_AUDIT_KINDS (src/lib/audit-scope.ts) is a subset.
// Pure module (no imports).

export const AUDIT_KINDS = [
  // ---- Platform console (services/admin.ts) ----
  'admin.set_billing_exempt',
  'admin.user.add_to_workspace',
  'admin.user.move',
  'admin.user.remove_from_workspace',
  'admin.user.set_member_role',
  'admin.user.update_profile',
  'admin.workspace.archive',
  'admin.workspace.create',
  'admin.workspace.delete',
  'admin.workspace.restore',
  'admin.workspace.set_default',
  'admin.workspace.update',
  /** PC-03 remediation (src/lib/remediation/refile-platform-audit.ts). */
  'admin.audit.refile',
  'admin.audit.refile_revert',
  // ---- Autopilot ----
  'autopilot.settings.update',
  'autopilot.product_settings.create',
  'autopilot.product_settings.update',
  'autopilot.product_settings.clear',
  // ---- Billing and tokens ----
  'billing.checkout_session_created',
  'billing.portal_session_created',
  'billing.token_checkout_created',
  'tokens.adjust',
  // ---- Discovery: searches, runs, schedules ----
  'connector.create',
  'connector.consolidate',
  'connector_recipe.create',
  'connector_recipe.update',
  'connector_recipe.delete',
  'connector_run.start',
  'connector_run.complete',
  'connector_run.bulk_delete',
  'crawl_plan.create',
  'crawl_plan.update',
  'crawl_plan.delete',
  'crawl_plan.run',
  // ---- Review and qualification ----
  /** review.ts transitions: `review.${state}`, one per review_item_state. */
  'review.new',
  'review.needs_review',
  'review.approved',
  'review.rejected',
  'review.ignored',
  'review.duplicate',
  'review.archived',
  'review.assign',
  'review.comment',
  'review.bulk_archive',
  'review.bulk_delete',
  'qualification.reclassify_workspace',
  'lead.bulk_archive',
  'lead.bulk_delete',
  'lead_research.run',
  'lead_research.delete',
  // ---- Pipeline and contacts ----
  'pipeline.ensure',
  'pipeline.transition',
  'contact.create',
  'contact.update',
  'contact.archive',
  'contact.merge',
  // ---- Outreach ----
  'outreach.generate',
  'outreach.edit',
  'outreach.translate',
  'outreach.approve',
  'outreach.reject',
  'outreach.archive',
  'outreach.enqueue',
  'outreach.geo_blocked',
  'outreach.queue.cancel',
  'outreach.send_settings.update',
  'outreach.reply_handled',
  'follow_up.scheduled',
  'follow_up.awaiting_approval',
  'follow_up.approved',
  'follow_up.rejected',
  'follow_up.sent',
  'follow_up.cancelled',
  'follow_up_config.update',
  'signature.create',
  'signature.update',
  'signature.delete',
  'signature.redesign',
  // ---- Mail and mailboxes ----
  'mail.send',
  'mail.send_test',
  'mail.retry_send',
  'mail.sync_inbound',
  'mail.relevance_backfill',
  'mail.mark_as_spam',
  'mail.unmark_spam',
  'mail.move_to_trash',
  'mail.restore_from_trash',
  'mail.permanently_delete',
  'mail.empty_trash_now',
  'mail.bounce_loop_auto_spam',
  'mail.update_auto_sync',
  'mail.update_trash_retention',
  'mailbox.create',
  'mailbox.update',
  'mailbox.test_connection',
  'mailbox.pause',
  'mailbox.reactivate',
  'mailbox.marked_failing',
  'mailbox.recovered',
  'mailbox.archive',
  'mailbox.delete',
  // ---- Replies ----
  'reply.classify',
  'reply.suggest',
  'reply.auto_suppress_refused',
  'reply_auto_actions.changed',
  // ---- Suppression and unsubscribes ----
  'suppression.add',
  'suppression.revoke',
  'suppression.unsubscribe_via_token',
  'unsubscribe.outreach_stopped',
  // ---- Translation ----
  'translation.to_english',
  'translation.from_english',
  'translation.text',
  // ---- Products, knowledge, documents, lessons ----
  'product_profile.create',
  'product_profile.update',
  'product_profile.autofill',
  'product_profile.delete',
  'knowledge_source.create',
  'knowledge_source.update',
  'knowledge_source.attach',
  'knowledge_source.delete',
  'knowledge.compaction.run',
  'knowledge.compaction.merge',
  'knowledge.compaction.retire_stale',
  'document.upload',
  'document.update',
  'document.archive',
  'document.restore',
  'rag.index_document',
  'rag.index_knowledge_source',
  'vector_storage.attach',
  'vector_storage.detach',
  'learning.lesson.create',
  'learning.lesson.update',
  'learning.lesson.reinforce',
  'learning.lesson.dedup_reinforce',
  'learning.lesson.bulk_enable',
  'learning.lesson.bulk_disable',
  'learning.synthesis.run',
  // ---- CRM ----
  'crm.create_connection',
  'crm.update_connection',
  'crm.archive_connection',
  'crm.restore_connection',
  'crm.push',
  'crm.push_notes',
  'crm.push_deal',
  'crm.export_csv',
  // ---- Workspace, members, keys, settings ----
  'workspace.bootstrap',
  'workspace.god_mode_switch',
  'workspace.update_native_language',
  'workspace.update_outreach_defaults',
  'workspace.update_outreach_language',
  'workspace.update_vector_storage_quota',
  /** AP-06 (I069): the scheduled health check switched on/off or its interval. */
  'health_check.settings_update',
  'onboarding.setup_mode',
  'onboarding.complete',
  'provider_settings.update',
  'secret.set',
  'secret.delete',
  'platform_secret.set',
  'platform_secret.delete',
  'platform_settings.update',
  // ---- Users and accounts ----
  'user.set_account_status',
  'user.preauthorize',
  'user.preauthorize_consumed',
  'user.revoke_preauthorize',
  'user.create_password_user',
  'user.set_platform_role',
  'user.set_password',
  'user.change_own_password',
  'user.update_own_profile',
  'user.add_member',
  'user.set_member_role',
  'user.remove_member',
  'user.delete',
  // ---- Support ----
  'support.thread.create',
  'support.thread.close',
  'support.thread.reopen',
  'support.message.customer',
  'support.message.admin',
  // ---- Automation control (Phase 1: PC-05 pause, PC-06 holds, PC-13 policy, flow:F-07 go-live) ----
  'automation.paused',
  'automation.pause_undone',
  'automation.resumed',
  'automation.product_paused',
  'automation.product_resumed',
  'automation.owner_unaccountable',
  'automation.owner_accountable_again',
  'workspace.hold.place',
  'workspace.hold.release',
  'workspace.hold.confirm',
  'workspace.hold.discard',
  'workspace.hold.import',
  'admin.legacy_flags.import',
  'platform.outbound_stop.set',
  'platform.outbound_stop.clear',
  'outbound.override',
  'outreach.go_live.release',
  'outreach.go_live.revoke',
  'reply.auto_actions_held',
  // ---- Ops (Phase 1: PC-08 owner alerts, PC-10 stuck work and recovery, PC-35 retention) ----
  'ops.alert.test',
  'ops.retention.run',
  'connector_run.cancel',
  'connector_run.reaped',
  'outreach.queue.reaped',
  'outreach.queue.requeue',
  'outreach.queue.retry',
  'outreach.queue.mark_delivered',
  // ---- Knowledge and learning (Phase 1: KL-01 to KL-06) ----
  'review.verdicts_changed',
  'knowledge_source.index_requested',
  'rag.index_document_requested',
  'rag.index_knowledge_source_late',
  'rag.index_knowledge_source_failed',
  'document.reextract_ocr',
  'learning.lesson.retire',
  'learning.decision.processed',
  'workspace.update_learn_from_replies',
  // ---- Remediation runs (scripts/remediation, flow:F-06) ----
  'remediation.apply',
  'remediation.revert',
] as const;

export type AuditKind = (typeof AUDIT_KINDS)[number];

/**
 * Kinds that rows may still carry but nothing writes any more. Labelled,
 * never writable (they are not AuditKinds).
 */
export const LEGACY_AUDIT_KINDS = [
  /** Workspace archiving before the console's admin.workspace.archive. */
  'workspace.archive',
  /** The console's feature-flag switch: replaced by holds (PC-06). */
  'admin.feature_flag.set',
  /** recordFeedback before the KL-02 decision record replaced it. */
  'learning.feedback',
  /** Written once by the p1_knowledge_foundation migration (KL-05). */
  'knowledge_source.shadow_chunks_adopted',
  'document.shadow_chunks_deleted',
] as const;

export type LegacyAuditKind = (typeof LEGACY_AUDIT_KINDS)[number];

/** Every kind a row of the log can carry and the UI can label. */
export type LabelledAuditKind = AuditKind | LegacyAuditKind;

const KNOWN: ReadonlySet<string> = new Set<string>([...AUDIT_KINDS, ...LEGACY_AUDIT_KINDS]);

/** True for a kind the UI has a label for. */
export function isLabelledAuditKind(kind: string): kind is LabelledAuditKind {
  return KNOWN.has(kind);
}
