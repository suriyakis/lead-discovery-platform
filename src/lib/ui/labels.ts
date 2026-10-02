// Operator-facing labels for every value the UI shows (DS-09, absorbs
// ia:F-11), in the DS-05 vocabulary (docs/design/IA.md): a review row is a
// record, 'discovery' is the 'First contact' stage, searches and schedules
// replace connectors and crawl plans, lessons replace learning memory.
//
// Raw codes (needs_review, follow_up.awaiting_approval) never reach the
// screen: pages render a value through <StatusBadge> or signalFor(), and
// audit and usage kinds through auditKindLabel() / usageKindLabel().
// Every map is `satisfies Record<Value, string>` and LABEL_MAPS mirrors
// TONE_MAPS (tone.ts) set for set and value for value, so a value without
// a label fails typecheck; src/tests/signals.test.ts checks the same at
// runtime against every pgEnum and registry. A value missing from a map
// at runtime (an older row of a text column) falls back to
// humanizeCode(), which never shows underscores or dots either.
//
// Labels are sentence case; system states render as lowercase mono chips
// by CSS, not by changing the words here.

import type { AccountStatus, UserRole } from '@/lib/db/schema/auth';
import type { ConnectorRunStatus, ConnectorTemplateType } from '@/lib/db/schema/connectors';
import type { ContactStatus } from '@/lib/db/schema/contacts';
import type { CrmConnectionStatus, CrmSyncKind, CrmSyncOutcome } from '@/lib/db/schema/crm';
import type {
  DocumentStatus,
  KnowledgePurposeCategory,
  KnowledgeSourceExternalStatus,
  KnowledgeSourceKind,
} from '@/lib/db/schema/documents';
import type { FollowUpSkipReason, FollowUpStatus } from '@/lib/db/schema/follow-ups';
import type {
  MailboxStatus,
  MailDirection,
  MailOutreachRelevance,
  MailStatus,
  SuppressionKind,
  SuppressionReason,
  SuppressionSource,
} from '@/lib/db/schema/mailing';
import type {
  OutreachDraftMethod,
  OutreachDraftStatus,
  OutreachQueueStatus,
  OutreachStage,
  SendDelayMode,
} from '@/lib/db/schema/outreach';
import type { CloseReason, PipelineState } from '@/lib/db/schema/pipeline';
import type { QualificationMethod } from '@/lib/db/schema/qualifications';
import type { ReviewItemState } from '@/lib/db/schema/review';
import type {
  OnboardingStatus,
  SubscriptionStatus,
  WorkspaceMemberRole,
  WorkspaceStatus,
} from '@/lib/db/schema/workspaces';
import type { WorkspacePlan } from '@/lib/billing/plans';
import type { LabelledAuditKind } from '@/lib/kinds/audit';
import type {
  AutomationCapability,
  WorkspaceHoldKind,
  WorkspaceHoldScope,
  WorkspaceHoldSource,
  WorkspaceHoldState,
} from '@/lib/db/schema/holds';
import type { KnowledgeIndexStatus, KnowledgeScopeKind } from '@/lib/db/schema/documents';
import type {
  LessonLifecycle,
  LessonRetiredReason,
  LessonScopeKind,
} from '@/lib/db/schema/learning';
import type { NotificationKind } from '@/lib/kinds/notification';
import type { LabelledUsageKind, UsageKeySource } from '@/lib/kinds/usage';
import type { ReplyClass } from '@/lib/mail/reply-classes';
import type { GeoStatus } from '@/lib/services/geo';
import type { FindingSeverity as HealthFindingSeverity } from '@/lib/diagnostics/types';
import type { HintSeverity } from '@/lib/services/hints';
import {
  PULSE_VALUES,
  REPLY_TRIAGE_TRUSTED,
  TONE_MAPS,
  type SignalSet,
  type SignalValue,
  type Tone,
} from './tone';

// ---- pgEnums -----------------------------------------------------------

export const ACCOUNT_STATUS_LABEL = {
  pending: 'Awaiting approval',
  active: 'Active',
  suspended: 'Suspended',
  rejected: 'Rejected',
} as const satisfies Record<AccountStatus, string>;

/** The platform role (users.role), not a workspace role. */
export const USER_ROLE_LABEL = {
  member: 'User',
  super_admin: 'Super-admin',
} as const satisfies Record<UserRole, string>;

export const ONBOARDING_STATUS_LABEL = {
  pending: 'Not started',
  in_progress: 'In progress',
  completed: 'Complete',
} as const satisfies Record<OnboardingStatus, string>;

export const SUBSCRIPTION_STATUS_LABEL = {
  trial: 'Trial',
  active: 'Active',
  past_due: 'Past due',
  canceled: 'Canceled',
} as const satisfies Record<SubscriptionStatus, string>;

export const WORKSPACE_MEMBER_ROLE_LABEL = {
  owner: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  member: 'Member',
  viewer: 'Viewer',
} as const satisfies Record<WorkspaceMemberRole, string>;

export const WORKSPACE_STATUS_LABEL = {
  active: 'Active',
  archived: 'Archived',
} as const satisfies Record<WorkspaceStatus, string>;

export const CONNECTOR_RUN_STATUS_LABEL = {
  pending: 'Waiting to start',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  partial: 'Partly failed',
} as const satisfies Record<ConnectorRunStatus, string>;

/** What a search source is (connector template type). */
export const CONNECTOR_TEMPLATE_TYPE_LABEL = {
  internet_search: 'Web search',
  directory_harvester: 'Directory',
  tender_api: 'Tender feed',
  csv_import: 'CSV import',
  mock: 'Demo source',
} as const satisfies Record<ConnectorTemplateType, string>;

export const REVIEW_ITEM_STATE_LABEL = {
  new: 'New',
  needs_review: 'Needs review',
  approved: 'Approved',
  rejected: 'Rejected',
  ignored: 'Ignored',
  duplicate: 'Duplicate',
  archived: 'Archived',
} as const satisfies Record<ReviewItemState, string>;

export const OUTREACH_DRAFT_STATUS_LABEL = {
  draft: 'Draft',
  needs_edit: 'Needs edit',
  approved: 'Approved',
  rejected: 'Rejected',
  superseded: 'Superseded',
} as const satisfies Record<OutreachDraftStatus, string>;

export const OUTREACH_QUEUE_STATUS_LABEL = {
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
} as const satisfies Record<OutreachQueueStatus, string>;

/** 'discovery' reads 'First contact' so it never clashes with the Discovery area. */
export const OUTREACH_STAGE_LABEL = {
  discovery: 'First contact',
  engagement: 'Engagement',
  pitch: 'Pitch',
  closing: 'Closing',
} as const satisfies Record<OutreachStage, string>;

export const SEND_DELAY_MODE_LABEL = {
  immediate: 'No delay',
  fixed: 'Fixed delay',
  random: 'Random delay',
} as const satisfies Record<SendDelayMode, string>;

export const DOCUMENT_STATUS_LABEL = {
  uploading: 'Uploading',
  ready: 'Ready',
  failed: 'Failed',
  archived: 'Archived',
} as const satisfies Record<DocumentStatus, string>;

export const KNOWLEDGE_PURPOSE_CATEGORY_LABEL = {
  technical: 'Technical',
  marketing: 'Marketing',
  case_study: 'Case study',
  internal_note: 'Internal note',
  objection_handling: 'Objection handling',
  general: 'General',
} as const satisfies Record<KnowledgePurposeCategory, string>;

export const KNOWLEDGE_SOURCE_KIND_LABEL = {
  document: 'Document',
  url: 'Web page',
  text: 'Note',
} as const satisfies Record<KnowledgeSourceKind, string>;

export const MAIL_DIRECTION_LABEL = {
  outbound: 'Outbound',
  inbound: 'Inbound',
} as const satisfies Record<MailDirection, string>;

export const MAIL_STATUS_LABEL = {
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  bounced: 'Bounced',
  failed: 'Failed',
  received: 'Received',
} as const satisfies Record<MailStatus, string>;

export const MAILBOX_STATUS_LABEL = {
  active: 'Active',
  paused: 'Paused',
  failing: 'Failing',
  archived: 'Archived',
} as const satisfies Record<MailboxStatus, string>;

/** Which inbound mail answers our outreach (the X1 relevance gate). */
export const OUTREACH_RELEVANCE_LABEL = {
  prospect_reply: 'Prospect reply',
  auto_reply: 'Auto-reply',
  bounce: 'Bounce',
  bulk: 'Bulk mail',
  unrelated: 'Unrelated',
} as const satisfies Record<MailOutreachRelevance, string>;

export const SUPPRESSION_KIND_LABEL = {
  email: 'Address',
  domain: 'Domain',
  company: 'Company',
} as const satisfies Record<SuppressionKind, string>;

export const SUPPRESSION_REASON_LABEL = {
  bounce_hard: 'Hard bounce',
  bounce_soft: 'Soft bounce',
  unsubscribe: 'Unsubscribed',
  complaint: 'Spam complaint',
  manual: 'Added by hand',
} as const satisfies Record<SuppressionReason, string>;

/** Where a suppression came from (its origin). */
export const SUPPRESSION_SOURCE_LABEL = {
  unsubscribe_link: 'Unsubscribe link',
  reply: 'Reply',
  dsn: 'Bounce report',
  smtp: 'Mail server refusal',
  manual: 'Added by hand',
  import: 'Import',
  legacy_auto: 'Automatic (before October 2026)',
  legacy_unknown: 'Unknown (before October 2026)',
} as const satisfies Record<SuppressionSource, string>;

export const CLOSE_REASON_LABEL = {
  won: 'Won',
  lost: 'Lost',
  no_response: 'No response',
  wrong_fit: 'Wrong fit',
  duplicate: 'Duplicate',
  spam: 'Spam',
  other: 'Other',
} as const satisfies Record<CloseReason, string>;

/** The funnel, the kanban and the state filter all read these. */
export const PIPELINE_STATE_LABEL = {
  raw_discovered: 'Discovered',
  relevant: 'Relevant',
  contacted: 'Contacted',
  replied: 'Replied',
  contact_identified: 'Contact identified',
  qualified: 'Qualified',
  handed_over: 'Handed over',
  synced_to_crm: 'Synced to CRM',
  closed: 'Closed',
} as const satisfies Record<PipelineState, string>;

export const CRM_CONNECTION_STATUS_LABEL = {
  active: 'Active',
  paused: 'Paused',
  failing: 'Failing',
  archived: 'Archived',
} as const satisfies Record<CrmConnectionStatus, string>;

export const CRM_SYNC_KIND_LABEL = {
  contact: 'Contact',
  note: 'Note',
  deal: 'Deal',
} as const satisfies Record<CrmSyncKind, string>;

export const CRM_SYNC_OUTCOME_LABEL = {
  pending: 'Pending',
  succeeded: 'Synced',
  failed: 'Failed',
  skipped: 'Skipped',
} as const satisfies Record<CrmSyncOutcome, string>;

export const CONTACT_STATUS_LABEL = {
  active: 'Active',
  archived: 'Archived',
} as const satisfies Record<ContactStatus, string>;

// ---- Text-column registries --------------------------------------------

export const REPLY_CLASS_LABEL = {
  positive: 'Positive',
  interest: 'Interested',
  question: 'Question',
  doc_request: 'Wants documents',
  redirect: 'Redirect',
  negative: 'Not interested',
  out_of_office: 'Out of office',
  unsubscribe: 'Unsubscribe',
  irrelevant: 'Irrelevant',
  bounce: 'Bounce',
} as const satisfies Record<ReplyClass, string>;

/** 'pending' is a scheduled follow-up waiting for its send time. */
export const FOLLOW_UP_STATUS_LABEL = {
  pending: 'Scheduled',
  awaiting_approval: 'Awaiting approval',
  sent: 'Sent',
  skipped: 'Skipped',
  failed: 'Failed',
} as const satisfies Record<FollowUpStatus, string>;

export const FOLLOW_UP_SKIP_REASON_LABEL = {
  replied: 'Prospect replied',
  bounce: 'Bounced',
  manual_cancel: 'Cancelled by hand',
  product_archived: 'Product archived',
  lead_closed: 'Lead closed',
  unsubscribed: 'Unsubscribed',
  suppressed: 'Address suppressed',
} as const satisfies Record<FollowUpSkipReason, string>;

export const NOTIFICATION_KIND_LABEL = {
  'review.needs_review': 'Needs review',
  'follow_up.awaiting_approval': 'Follow-up approval',
  'health.warning': 'Health check',
  'health.finding': 'Needs attention',
  'health.critical': 'Problem found',
  'lead.replied': 'Reply',
  mention: 'Mention',
  assignment: 'Assigned to you',
  'support.reply': 'Support reply',
  'run.failed': 'Search failed',
  'mailbox.failing': 'Mailbox failing',
  'learning.synthesis': 'New lessons',
  'tokens.low': 'Tokens low',
  'tokens.empty': 'Out of tokens',
  'tokens.auto_topup': 'Tokens topped up',
  'tokens.auto_topup_pending': 'Top-up processing',
  'tokens.auto_topup_failed': 'Top-up failed',
  'automation.paused': 'Automation paused',
  'automation.hold': 'Hold changed',
  'automation.owner_unaccountable': 'Automation stopped',
  'outreach.go_live': 'Outreach release',
  'knowledge.index_failed': 'Indexing failed',
  'learning.failed': 'Learning failed',
} as const satisfies Record<NotificationKind, string>;

export const KNOWLEDGE_EXTERNAL_STATUS_LABEL = {
  pending: 'Indexing',
  indexed: 'Indexed',
  failed: 'Index failed',
} as const satisfies Record<KnowledgeSourceExternalStatus, string>;

export const QUALIFICATION_METHOD_LABEL = {
  rules: 'Rules',
  ai: 'AI',
  rules_fallback: 'Rules (AI unavailable)',
  hybrid: 'Rules and AI',
} as const satisfies Record<QualificationMethod, string>;

export const OUTREACH_DRAFT_METHOD_LABEL = {
  rules: 'Template',
  ai: 'AI',
  hybrid: 'Template and AI',
} as const satisfies Record<OutreachDraftMethod, string>;

export const GEO_STATUS_LABEL = {
  no_gate: 'No location rule',
  match: 'In target country',
  mismatch: 'Outside target country',
  unverified: 'Location unverified',
} as const satisfies Record<GeoStatus, string>;

export const HEALTH_FINDING_SEVERITY_LABEL = {
  info: 'Info',
  warning: 'Warning',
  critical: 'Critical',
} as const satisfies Record<HealthFindingSeverity, string>;

export const HINT_SEVERITY_LABEL = {
  info: 'Info',
  action: 'Needs action',
  warning: 'Warning',
  critical: 'Critical',
  success: 'Good',
  note: 'Note',
} as const satisfies Record<HintSeverity, string>;

export const WORKSPACE_PLAN_LABEL = {
  trial: 'Trial',
  starter: 'Starter',
  pro: 'Pro',
} as const satisfies Record<WorkspacePlan, string>;

export const USAGE_KEY_SOURCE_LABEL = {
  workspace: 'Your key',
  platform: 'Platform key',
  mock: 'Test provider',
} as const satisfies Record<UsageKeySource, string>;

// ---- Phase 1 sets (automation control, knowledge foundation) ----------

export const AUTOMATION_CAPABILITY_LABEL = {
  sending: 'Sending',
  inbox_sync: 'Inbox sync',
  inbound_actions: 'Reply auto-actions',
  discovery: 'Discovery',
  autopilot: 'Autopilot',
  crm_sync: 'CRM sync',
  background_ai: 'Background AI',
  auto_topup: 'Auto top-up',
  trash_purge: 'Trash purge',
} as const satisfies Record<AutomationCapability, string>;

export const WORKSPACE_HOLD_SCOPE_LABEL = {
  all: 'All automation',
  capabilities: 'Chosen capabilities',
} as const satisfies Record<WorkspaceHoldScope, string>;

export const WORKSPACE_HOLD_KIND_LABEL = {
  hold: 'Hold',
  note: 'Note',
} as const satisfies Record<WorkspaceHoldKind, string>;

export const WORKSPACE_HOLD_STATE_LABEL = {
  active: 'Active',
  pending_review: 'Waiting for review',
  released: 'Released',
  discarded: 'Discarded',
} as const satisfies Record<WorkspaceHoldState, string>;

export const WORKSPACE_HOLD_SOURCE_LABEL = {
  tenant: 'This workspace',
  platform: 'Platform',
} as const satisfies Record<WorkspaceHoldSource, string>;

export const KNOWLEDGE_INDEX_STATUS_LABEL = {
  queued: 'Queued',
  indexing: 'Indexing',
  indexed: 'Indexed',
  stale: 'Stale',
  failed: 'Failed',
} as const satisfies Record<KnowledgeIndexStatus, string>;

export const KNOWLEDGE_SCOPE_KIND_LABEL = {
  workspace: 'Every product',
  products: 'Chosen products',
} as const satisfies Record<KnowledgeScopeKind, string>;

export const LESSON_SCOPE_KIND_LABEL = {
  workspace: 'Every product',
  products: 'Chosen products',
} as const satisfies Record<LessonScopeKind, string>;

export const LESSON_LIFECYCLE_LABEL = {
  active: 'Active',
  proposed: 'Suggested',
  disabled: 'Switched off',
  retired: 'Retired',
} as const satisfies Record<LessonLifecycle, string>;

export const LESSON_RETIRED_REASON_LABEL = {
  stale: 'Unused for a long time',
  merged: 'Merged into another rule',
  superseded: 'Replaced by a newer rule',
  contradicted: 'Contradicted by another rule',
  operator_rejected: 'Rejected by a person',
  source_decision_voided: 'Its decision was changed',
  absorbed_into_profile: 'Moved into the product profile',
  product_deleted: 'Its product was deleted',
  category_removed: 'Its category was removed',
} as const satisfies Record<LessonRetiredReason, string>;

// ---- The index ---------------------------------------------------------

/** One label map per TONE_MAPS set, value for value. */
export const LABEL_MAPS = {
  account_status: ACCOUNT_STATUS_LABEL,
  user_role: USER_ROLE_LABEL,
  onboarding_status: ONBOARDING_STATUS_LABEL,
  subscription_status: SUBSCRIPTION_STATUS_LABEL,
  workspace_member_role: WORKSPACE_MEMBER_ROLE_LABEL,
  workspace_status: WORKSPACE_STATUS_LABEL,
  connector_run_status: CONNECTOR_RUN_STATUS_LABEL,
  connector_template_type: CONNECTOR_TEMPLATE_TYPE_LABEL,
  review_item_state: REVIEW_ITEM_STATE_LABEL,
  outreach_draft_status: OUTREACH_DRAFT_STATUS_LABEL,
  outreach_queue_status: OUTREACH_QUEUE_STATUS_LABEL,
  outreach_stage: OUTREACH_STAGE_LABEL,
  send_delay_mode: SEND_DELAY_MODE_LABEL,
  document_status: DOCUMENT_STATUS_LABEL,
  knowledge_purpose_category: KNOWLEDGE_PURPOSE_CATEGORY_LABEL,
  knowledge_source_kind: KNOWLEDGE_SOURCE_KIND_LABEL,
  mail_direction: MAIL_DIRECTION_LABEL,
  mail_status: MAIL_STATUS_LABEL,
  mailbox_status: MAILBOX_STATUS_LABEL,
  outreach_relevance: OUTREACH_RELEVANCE_LABEL,
  suppression_kind: SUPPRESSION_KIND_LABEL,
  suppression_reason: SUPPRESSION_REASON_LABEL,
  suppression_source: SUPPRESSION_SOURCE_LABEL,
  close_reason: CLOSE_REASON_LABEL,
  pipeline_state: PIPELINE_STATE_LABEL,
  crm_connection_status: CRM_CONNECTION_STATUS_LABEL,
  crm_sync_kind: CRM_SYNC_KIND_LABEL,
  crm_sync_outcome: CRM_SYNC_OUTCOME_LABEL,
  contact_status: CONTACT_STATUS_LABEL,
  reply_class: REPLY_CLASS_LABEL,
  follow_up_status: FOLLOW_UP_STATUS_LABEL,
  follow_up_skip_reason: FOLLOW_UP_SKIP_REASON_LABEL,
  notification_kind: NOTIFICATION_KIND_LABEL,
  knowledge_external_status: KNOWLEDGE_EXTERNAL_STATUS_LABEL,
  qualification_method: QUALIFICATION_METHOD_LABEL,
  outreach_draft_method: OUTREACH_DRAFT_METHOD_LABEL,
  geo_status: GEO_STATUS_LABEL,
  health_finding_severity: HEALTH_FINDING_SEVERITY_LABEL,
  hint_severity: HINT_SEVERITY_LABEL,
  workspace_plan: WORKSPACE_PLAN_LABEL,
  usage_key_source: USAGE_KEY_SOURCE_LABEL,
  automation_capability: AUTOMATION_CAPABILITY_LABEL,
  workspace_hold_scope: WORKSPACE_HOLD_SCOPE_LABEL,
  workspace_hold_kind: WORKSPACE_HOLD_KIND_LABEL,
  workspace_hold_state: WORKSPACE_HOLD_STATE_LABEL,
  workspace_hold_source: WORKSPACE_HOLD_SOURCE_LABEL,
  knowledge_index_status: KNOWLEDGE_INDEX_STATUS_LABEL,
  knowledge_scope_kind: KNOWLEDGE_SCOPE_KIND_LABEL,
  lesson_scope_kind: LESSON_SCOPE_KIND_LABEL,
  lesson_lifecycle: LESSON_LIFECYCLE_LABEL,
  lesson_retired_reason: LESSON_RETIRED_REASON_LABEL,
} as const satisfies { readonly [S in SignalSet]: Readonly<Record<SignalValue<S>, string>> };

// ---- Descriptions (tooltips, role pickers) -----------------------------

/** What each workspace role may do (services/context.ts holds the rules). */
export const WORKSPACE_MEMBER_ROLE_DESCRIPTION = {
  owner: 'Everything an admin can do, plus transferring ownership and deleting the workspace.',
  admin: 'Manages members, mailboxes, connections and settings, and works every queue.',
  manager: 'Works every queue: review, pipeline, outreach and conversations. No settings.',
  member: 'Works every queue: review, pipeline, outreach and conversations. No settings.',
  viewer: 'Sees everything, changes nothing.',
} as const satisfies Record<WorkspaceMemberRole, string>;

export const USER_ROLE_DESCRIPTION = {
  member: 'Signs in to the workspaces they belong to.',
  super_admin: 'Platform staff: the Platform console and every workspace.',
} as const satisfies Record<UserRole, string>;

export const FOLLOW_UP_STATUS_DESCRIPTION = {
  pending: 'Scheduled, waiting for its send time.',
  awaiting_approval: 'Written by AI, waiting for you to approve or reject it.',
  sent: 'Delivered to the prospect.',
  skipped: 'Cancelled: a reply arrived, the lead closed, or someone stopped it.',
  failed: 'Writing or sending failed; it needs a retry.',
} as const satisfies Record<FollowUpStatus, string>;

const DESCRIPTION_MAPS: { readonly [S in SignalSet]?: Readonly<Record<SignalValue<S>, string>> } = {
  workspace_member_role: WORKSPACE_MEMBER_ROLE_DESCRIPTION,
  user_role: USER_ROLE_DESCRIPTION,
  follow_up_status: FOLLOW_UP_STATUS_DESCRIPTION,
};

// ---- Kinds: label only (kinds are neutral history, not signals) --------

export const AUDIT_KIND_LABEL = {
  // Platform console
  'admin.feature_flag.set': 'Feature flag changed',
  'admin.set_billing_exempt': 'Billing exemption changed',
  'admin.user.add_to_workspace': 'User added to a workspace',
  'admin.user.move': 'User moved to another workspace',
  'admin.user.remove_from_workspace': 'User removed from a workspace',
  'admin.user.set_member_role': 'Workspace role changed by platform staff',
  'admin.user.update_profile': 'User profile edited by platform staff',
  'admin.workspace.archive': 'Workspace archived',
  'admin.workspace.create': 'Workspace created',
  'admin.workspace.delete': 'Workspace deleted',
  'admin.workspace.restore': 'Workspace restored',
  'admin.workspace.set_default': 'Default workspace set',
  'admin.workspace.update': 'Workspace edited',
  'admin.audit.refile': 'Audit rows refiled',
  'admin.audit.refile_revert': 'Audit refile reverted',
  // Autopilot
  'autopilot.settings.update': 'Autopilot settings changed',
  'autopilot.product_settings.create': 'Product autopilot settings added',
  'autopilot.product_settings.update': 'Product autopilot settings changed',
  'autopilot.product_settings.clear': 'Product autopilot settings cleared',
  // Billing and tokens
  'billing.checkout_session_created': 'Plan checkout started',
  'billing.portal_session_created': 'Billing portal opened',
  'billing.token_checkout_created': 'Token purchase started',
  'tokens.adjust': 'Token balance adjusted',
  // Discovery
  'connector.create': 'Search source added',
  'connector.consolidate': 'Search sources merged',
  'connector_recipe.create': 'Search added',
  'connector_recipe.update': 'Search edited',
  'connector_recipe.delete': 'Search deleted',
  'connector_run.start': 'Search run started',
  'connector_run.complete': 'Search run finished',
  'connector_run.bulk_delete': 'Search runs deleted',
  'crawl_plan.create': 'Schedule added',
  'crawl_plan.update': 'Schedule edited',
  'crawl_plan.delete': 'Schedule deleted',
  'crawl_plan.run': 'Schedule ran',
  // Review and qualification
  'review.new': 'Record reopened',
  'review.needs_review': 'Record flagged for review',
  'review.approved': 'Record approved',
  'review.rejected': 'Record rejected',
  'review.ignored': 'Record ignored',
  'review.duplicate': 'Record marked duplicate',
  'review.archived': 'Record archived',
  'review.assign': 'Record assigned',
  'review.comment': 'Comment on a record',
  'review.bulk_archive': 'Records archived in bulk',
  'review.bulk_delete': 'Records deleted in bulk',
  'qualification.reclassify_workspace': 'Records requalified',
  'lead.bulk_archive': 'Matches archived in bulk',
  'lead.bulk_delete': 'Matches deleted in bulk',
  'lead_research.run': 'Lead research run',
  'lead_research.delete': 'Lead research deleted',
  // Pipeline and contacts
  'pipeline.ensure': 'Lead added to the pipeline',
  'pipeline.transition': 'Lead moved in the pipeline',
  'contact.create': 'Contact added',
  'contact.update': 'Contact edited',
  'contact.archive': 'Contact archived',
  'contact.merge': 'Contacts merged',
  // Outreach
  'outreach.generate': 'Draft written',
  'outreach.edit': 'Draft edited',
  'outreach.translate': 'Draft translated',
  'outreach.approve': 'Draft approved',
  'outreach.reject': 'Draft rejected',
  'outreach.archive': 'Draft archived',
  'outreach.enqueue': 'Email queued to send',
  'outreach.geo_blocked': 'Send held: outside target country',
  'outreach.queue.cancel': 'Queued email cancelled',
  'outreach.send_settings.update': 'Send settings changed',
  'outreach.reply_handled': 'Reply handled automatically',
  'follow_up.scheduled': 'Follow-ups scheduled',
  'follow_up.awaiting_approval': 'Follow-up waiting for approval',
  'follow_up.approved': 'Follow-up approved',
  'follow_up.rejected': 'Follow-up rejected',
  'follow_up.sent': 'Follow-up sent',
  'follow_up.cancelled': 'Follow-ups cancelled',
  'follow_up_config.update': 'Follow-up settings changed',
  'signature.create': 'Signature added',
  'signature.update': 'Signature edited',
  'signature.delete': 'Signature deleted',
  'signature.redesign': 'Signature redesigned with AI',
  // Mail and mailboxes
  'mail.send': 'Email sent',
  'mail.send_test': 'Test email sent',
  'mail.retry_send': 'Email send retried',
  'mail.sync_inbound': 'Mailbox synced',
  'mail.relevance_backfill': 'Inbound mail re-sorted',
  'mail.mark_as_spam': 'Marked as spam',
  'mail.unmark_spam': 'Spam mark removed',
  'mail.move_to_trash': 'Moved to trash',
  'mail.restore_from_trash': 'Restored from trash',
  'mail.permanently_delete': 'Email deleted for good',
  'mail.empty_trash_now': 'Trash emptied',
  'mail.bounce_loop_auto_spam': 'Bounce loop moved to spam',
  'mail.update_auto_sync': 'Mailbox auto-sync changed',
  'mail.update_trash_retention': 'Trash retention changed',
  'mailbox.create': 'Mailbox connected',
  'mailbox.update': 'Mailbox edited',
  'mailbox.test_connection': 'Mailbox connection tested',
  'mailbox.pause': 'Mailbox paused',
  'mailbox.reactivate': 'Mailbox resumed',
  'mailbox.marked_failing': 'Mailbox started failing',
  'mailbox.recovered': 'Mailbox recovered',
  'mailbox.archive': 'Mailbox archived',
  'mailbox.delete': 'Mailbox deleted',
  // Replies
  'reply.classify': 'Reply sorted',
  'reply.suggest': 'Reply suggested',
  'reply.auto_suppress_refused': 'Automatic suppression refused',
  'reply_auto_actions.changed': 'Reply automation changed',
  // Suppression
  'suppression.add': 'Address suppressed',
  'suppression.revoke': 'Suppression lifted',
  'suppression.unsubscribe_via_token': 'Unsubscribed through the link',
  'unsubscribe.outreach_stopped': 'Outreach stopped after unsubscribe',
  // Translation
  'translation.to_english': 'Translated to English',
  'translation.from_english': 'Translated from English',
  'translation.text': 'Text translated',
  // Products, knowledge, documents, lessons
  'product_profile.create': 'Product added',
  'product_profile.update': 'Product edited',
  'product_profile.autofill': 'Product drafted with AI',
  'product_profile.delete': 'Product deleted',
  'knowledge_source.create': 'Knowledge added',
  'knowledge_source.update': 'Knowledge edited',
  'knowledge_source.attach': 'Knowledge indexed for AI search',
  'knowledge_source.delete': 'Knowledge deleted',
  'knowledge.compaction.run': 'Knowledge tidy-up ran',
  'knowledge.compaction.merge': 'Knowledge entries merged',
  'knowledge.compaction.retire_stale': 'Stale knowledge retired',
  'document.upload': 'Document uploaded',
  'document.update': 'Document edited',
  'document.archive': 'Document archived',
  'document.restore': 'Document restored',
  'rag.index_document': 'Document indexed',
  'rag.index_knowledge_source': 'Knowledge indexed',
  'vector_storage.attach': 'Added to the vector store',
  'vector_storage.detach': 'Removed from the vector store',
  'learning.feedback': 'Decision fed to learning',
  'learning.lesson.create': 'Lesson added',
  'learning.lesson.update': 'Lesson edited',
  'learning.lesson.reinforce': 'Lesson reinforced',
  'learning.lesson.dedup_reinforce': 'Duplicate lesson folded in',
  'learning.lesson.bulk_enable': 'Lessons turned on',
  'learning.lesson.bulk_disable': 'Lessons turned off',
  'learning.synthesis.run': 'Weekly self-learning ran',
  // CRM
  'crm.create_connection': 'CRM connected',
  'crm.update_connection': 'CRM connection edited',
  'crm.archive_connection': 'CRM connection archived',
  'crm.restore_connection': 'CRM connection restored',
  'crm.push': 'Lead sent to the CRM',
  'crm.push_notes': 'Notes sent to the CRM',
  'crm.push_deal': 'Deal sent to the CRM',
  'crm.export_csv': 'Leads exported as CSV',
  // Workspace, keys, settings
  'workspace.bootstrap': 'Workspace set up',
  'workspace.god_mode_switch': 'Platform staff opened the workspace',
  'workspace.update_native_language': 'Workspace language changed',
  'workspace.update_outreach_defaults': 'Outreach defaults changed',
  'workspace.update_outreach_language': 'Outreach language changed',
  'workspace.update_vector_storage_quota': 'Vector storage quota changed',
  'health_check.settings_update': 'Health check settings changed',
  'workspace.archive': 'Workspace archived (older entry)',
  'onboarding.setup_mode': 'Setup mode chosen',
  'onboarding.complete': 'Setup completed',
  'provider_settings.update': 'AI and search settings changed',
  'secret.set': 'API key saved',
  'secret.delete': 'API key removed',
  'platform_secret.set': 'Platform key saved',
  'platform_secret.delete': 'Platform key removed',
  'platform_settings.update': 'Platform settings changed',
  // Users
  'user.set_account_status': 'Account status changed',
  'user.preauthorize': 'Sign-up pre-approved',
  'user.preauthorize_consumed': 'Pre-approved user signed up',
  'user.revoke_preauthorize': 'Sign-up pre-approval withdrawn',
  'user.create_password_user': 'Password user created',
  'user.set_platform_role': 'Platform role changed',
  'user.set_password': 'Password set',
  'user.change_own_password': 'Own password changed',
  'user.update_own_profile': 'Own profile edited',
  'user.add_member': 'Teammate added',
  'user.set_member_role': 'Teammate role changed',
  'user.remove_member': 'Teammate removed',
  'user.delete': 'User deleted',
  // Support
  'support.thread.create': 'Support request opened',
  'support.thread.close': 'Support request closed',
  'support.thread.reopen': 'Support request reopened',
  'support.message.customer': 'Message to support',
  'support.message.admin': 'Reply from support',
  // Automation control
  'automation.paused': 'Automation paused',
  'automation.pause_undone': 'Pause undone',
  'automation.resumed': 'Automation resumed',
  'automation.product_paused': 'Product paused',
  'automation.product_resumed': 'Product resumed',
  'automation.owner_unaccountable': 'Automation stopped: no accountable owner',
  'automation.owner_accountable_again': 'Accountable owner back',
  'workspace.hold.place': 'Hold placed',
  'workspace.hold.release': 'Hold released',
  'workspace.hold.confirm': 'Hold confirmed',
  'workspace.hold.discard': 'Hold discarded',
  'workspace.hold.import': 'Legacy switch imported as a hold',
  'admin.legacy_flags.import': 'Legacy feature switches imported',
  'platform.outbound_stop.set': 'Outbound email stopped platform-wide',
  'platform.outbound_stop.clear': 'Platform outbound stop lifted',
  'outbound.override': 'Sent by hand while automation was paused',
  'outreach.go_live.release': 'Workspace released for outreach',
  'outreach.go_live.revoke': 'Outreach release withdrawn',
  'reply.auto_actions_held': 'Reply auto-actions held',
  // Ops
  'ops.alert.test': 'Test alert sent',
  'ops.retention.run': 'Old log rows deleted',
  'connector_run.cancel': 'Search run cancelled',
  'connector_run.reaped': 'Stuck search run closed',
  'outreach.queue.reaped': 'Stuck send settled',
  'outreach.queue.requeue': 'Email put back in the queue',
  'outreach.queue.retry': 'Email retried',
  'outreach.queue.mark_delivered': 'Email marked as delivered',
  // Knowledge and learning
  'review.verdicts_changed': 'Product verdicts changed',
  'knowledge_source.index_requested': 'Knowledge indexing requested',
  'rag.index_document_requested': 'Document indexing requested',
  'rag.index_knowledge_source_late': 'Knowledge indexed after a delay',
  'rag.index_knowledge_source_failed': 'Knowledge indexing failed',
  'document.reextract_ocr': 'Document re-read with OCR',
  'learning.lesson.retire': 'Rule retired',
  'learning.decision.processed': 'Decision learned from',
  'workspace.update_learn_from_replies': 'Learning from replies changed',
  'knowledge_source.shadow_chunks_adopted': 'Knowledge passages moved to their source',
  'document.shadow_chunks_deleted': 'Duplicate document passages removed',
  // Remediation
  'remediation.apply': 'Data repair applied',
  'remediation.revert': 'Data repair reverted',
} as const satisfies Record<LabelledAuditKind, string>;

export const USAGE_KIND_LABEL = {
  'ai.generate': 'AI writing (other)',
  'ai.qualification': 'Record qualification',
  'ai.outreach': 'Outreach drafting',
  'ai.suggestion': 'Product angle ideas',
  'ai.assistant': 'Assistant questions',
  'ai.learning_extract': 'Lesson extraction',
  'ai.learning_synthesis': 'Weekly self-learning',
  'ai.health_check': 'Health checks',
  'ai.signature_redesign': 'Signature redesign',
  'search.query': 'Web searches',
  'research.query': 'Lead research',
  'embedding.embed': 'Knowledge indexing',
  'ocr.pdf': 'PDF text reading',
} as const satisfies Record<LabelledUsageKind, string>;

// ---- Lookups -----------------------------------------------------------

/**
 * A code the maps do not know (an older row of a text column), as words:
 * 'mail.bounce_loop' → 'Mail bounce loop'. Never returns underscores or
 * dots, so a raw code cannot leak even then.
 */
export function humanizeCode(code: string): string {
  const words = code
    .replace(/[._\-:/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!words) return 'Unknown';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A resolved value: what a badge shows and how it reads. */
export interface Signal {
  label: string;
  tone: Tone;
  /** Tooltip text, when the set carries descriptions. */
  description?: string;
  /** A process running right now. */
  pulse: boolean;
}

function lookup<T>(map: unknown, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key)
    ? ((map as Record<string, T>)[key] as T)
    : undefined;
}

/**
 * The label, tone and description of `value` in `set`. Takes any string so
 * text columns can be passed as read; an unknown value reads neutral with
 * a humanized label. Reply classes stay neutral and say 'auto' until
 * triage is trusted (tone.ts REPLY_TRIAGE_TRUSTED).
 */
export function signalFor<S extends SignalSet>(
  set: S,
  value: SignalValue<S> | (string & {}),
): Signal {
  const label = lookup<string>(LABEL_MAPS[set], value);
  const tone = lookup<Tone>(TONE_MAPS[set], value);
  const descriptions = DESCRIPTION_MAPS[set];
  const description = descriptions ? lookup<string>(descriptions, value) : undefined;
  const pulsing = PULSE_VALUES[set] as ReadonlyArray<string> | undefined;
  const signal: Signal = {
    label: label ?? humanizeCode(value),
    tone: tone ?? 'neutral',
    pulse: pulsing?.includes(value) ?? false,
    ...(description ? { description } : {}),
  };
  if (set === 'reply_class' && !REPLY_TRIAGE_TRUSTED) {
    return {
      ...signal,
      label: `${signal.label} · auto`,
      tone: 'neutral',
      description: 'Sorted automatically by keyword rules; not verified yet.',
    };
  }
  return signal;
}

/** The label of `value` in `set` (signalFor without the tone). */
export function labelFor<S extends SignalSet>(
  set: S,
  value: SignalValue<S> | (string & {}),
): string {
  return lookup<string>(LABEL_MAPS[set], value) ?? humanizeCode(value);
}

/** An audit_log.kind as words (the audit logs and their kind filter). */
export function auditKindLabel(kind: string): string {
  return lookup<string>(AUDIT_KIND_LABEL, kind) ?? humanizeCode(kind);
}

/**
 * The options of an audit-log kind filter: each distinct kind once, as its
 * label, sorted by label (the value stays the kind).
 */
export function auditKindOptions(
  kinds: ReadonlyArray<string>,
): Array<{ kind: string; label: string }> {
  return [...new Set(kinds)]
    .map((kind) => ({ kind, label: auditKindLabel(kind) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'en') || a.kind.localeCompare(b.kind, 'en'));
}

/** A usage_log.kind as words (Usage, Billing). */
export function usageKindLabel(kind: string): string {
  return lookup<string>(USAGE_KIND_LABEL, kind) ?? humanizeCode(kind);
}
