// The signal meaning map (DS-09; design proposal §6.2): which tone every
// value an operator sees carries. Pure data, no runtime imports, so server
// pages, client components and the gallery share it.
//
// A hue carries one meaning (src/styles/tokens.css), and a component picks
// a tone, never a hue:
//   neutral   the default: counts, 'new', roles, kinds, stages, tags
//   muted     ignored, archived, superseded
//   info      act, you, links, scores, progress
//   live      live, indexed, evidence
//   ai        AI-written text, AI verdicts, learned rules
//   attention a decision waiting for this user
//   success   approved, sent, won
//   danger    rejected, failed, destructive
// plus a pulse modifier for processes that are running right now.
//
// Every map is exhaustive over its real type: `satisfies Record<Value,
// Tone>` makes a missing (or unknown) value a typecheck error, and
// src/tests/signals.test.ts cross-checks every pgEnum's enumValues, the
// text-column registries (REPLY_CLASSES, followUpStatus, notification kinds,
// knowledge_sources.external_status, …) and labels.ts against TONE_MAPS.
// Labels live in labels.ts; <Badge>/<StatusBadge> (components/Badge.tsx)
// render both.

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
  MailboxFailureClassValue,
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
import type { NotificationKind } from '@/lib/kinds/notification';
import type { UsageKeySource } from '@/lib/kinds/usage';
import type { ReplyClass } from '@/lib/mail/reply-classes';
import type { GeoStatus } from '@/lib/services/geo';
import type { FindingSeverity as HealthFindingSeverity } from '@/lib/diagnostics/types';
import type { HintSeverity } from '@/lib/services/hints';
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

// ---- Tones -------------------------------------------------------------

export const TONES = [
  'neutral',
  'muted',
  'info',
  'live',
  'ai',
  'attention',
  'success',
  'danger',
] as const;

export type Tone = (typeof TONES)[number];

/** What each tone means: the gallery's legend and the docs. */
export const TONE_MEANING = {
  neutral: 'The default: counts, new records, roles, kinds, stages, tags',
  muted: 'Ignored, archived, superseded',
  info: 'Act, you, links, scores, progress',
  live: 'Live, indexed, evidence',
  ai: 'AI-written text, AI verdicts, learned rules',
  attention: 'A decision waiting for this user',
  success: 'Approved, sent, won',
  danger: 'Rejected, failed, destructive',
} as const satisfies Record<Tone, string>;

/** Counts are neutral unless a decision waits on this user. */
export type CountTone = Extract<Tone, 'neutral' | 'attention'>;

// ---- pgEnums (src/lib/db/schema), keyed by the enum's SQL name ---------

export const ACCOUNT_STATUS_TONE = {
  pending: 'attention',
  active: 'neutral',
  suspended: 'danger',
  rejected: 'neutral',
} as const satisfies Record<AccountStatus, Tone>;

export const USER_ROLE_TONE = {
  member: 'neutral',
  super_admin: 'neutral',
} as const satisfies Record<UserRole, Tone>;

export const ONBOARDING_STATUS_TONE = {
  pending: 'neutral',
  in_progress: 'info',
  completed: 'success',
} as const satisfies Record<OnboardingStatus, Tone>;

/** 'trial' stays neutral until it means a real Stripe trial (I045). */
export const SUBSCRIPTION_STATUS_TONE = {
  trial: 'neutral',
  active: 'neutral',
  past_due: 'danger',
  canceled: 'neutral',
} as const satisfies Record<SubscriptionStatus, Tone>;

/** Roles are neutral: who someone is is not a signal. */
export const WORKSPACE_MEMBER_ROLE_TONE = {
  owner: 'neutral',
  admin: 'neutral',
  manager: 'neutral',
  member: 'neutral',
  viewer: 'neutral',
} as const satisfies Record<WorkspaceMemberRole, Tone>;

export const WORKSPACE_STATUS_TONE = {
  active: 'neutral',
  archived: 'muted',
} as const satisfies Record<WorkspaceStatus, Tone>;

export const CONNECTOR_RUN_STATUS_TONE = {
  pending: 'neutral',
  running: 'live',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  /** PC-10: finished, but some search queries failed. */
  partial: 'attention',
} as const satisfies Record<ConnectorRunStatus, Tone>;

export const CONNECTOR_TEMPLATE_TYPE_TONE = {
  internet_search: 'neutral',
  directory_harvester: 'neutral',
  tender_api: 'neutral',
  csv_import: 'neutral',
  mock: 'neutral',
} as const satisfies Record<ConnectorTemplateType, Tone>;

export const REVIEW_ITEM_STATE_TONE = {
  new: 'neutral',
  needs_review: 'attention',
  approved: 'success',
  rejected: 'danger',
  ignored: 'muted',
  duplicate: 'neutral',
  archived: 'muted',
} as const satisfies Record<ReviewItemState, Tone>;

/** 'approved' is info: approved is not yet sent (it waits in the queue). */
export const OUTREACH_DRAFT_STATUS_TONE = {
  draft: 'attention',
  needs_edit: 'attention',
  approved: 'info',
  rejected: 'neutral',
  superseded: 'muted',
} as const satisfies Record<OutreachDraftStatus, Tone>;

export const OUTREACH_QUEUE_STATUS_TONE = {
  queued: 'info',
  sending: 'info',
  sent: 'success',
  failed: 'danger',
  skipped: 'neutral',
  cancelled: 'neutral',
} as const satisfies Record<OutreachQueueStatus, Tone>;

/**
 * A stage is a kind of message, never a verdict: 'closing' also holds
 * decline acknowledgements, so no stage is coloured.
 */
export const OUTREACH_STAGE_TONE = {
  discovery: 'neutral',
  engagement: 'neutral',
  pitch: 'neutral',
  closing: 'neutral',
} as const satisfies Record<OutreachStage, Tone>;

export const SEND_DELAY_MODE_TONE = {
  immediate: 'neutral',
  fixed: 'neutral',
  random: 'neutral',
} as const satisfies Record<SendDelayMode, Tone>;

export const DOCUMENT_STATUS_TONE = {
  uploading: 'info',
  ready: 'live',
  failed: 'danger',
  archived: 'muted',
} as const satisfies Record<DocumentStatus, Tone>;

export const KNOWLEDGE_PURPOSE_CATEGORY_TONE = {
  technical: 'neutral',
  marketing: 'neutral',
  case_study: 'neutral',
  internal_note: 'neutral',
  objection_handling: 'neutral',
  general: 'neutral',
} as const satisfies Record<KnowledgePurposeCategory, Tone>;

export const KNOWLEDGE_SOURCE_KIND_TONE = {
  document: 'neutral',
  url: 'neutral',
  text: 'neutral',
} as const satisfies Record<KnowledgeSourceKind, Tone>;

export const MAIL_DIRECTION_TONE = {
  outbound: 'neutral',
  inbound: 'neutral',
} as const satisfies Record<MailDirection, Tone>;

export const MAIL_STATUS_TONE = {
  queued: 'info',
  sending: 'info',
  sent: 'success',
  delivered: 'success',
  bounced: 'danger',
  failed: 'danger',
  received: 'neutral',
} as const satisfies Record<MailStatus, Tone>;

/** No syncing state exists, so 'active' is a static live dot. */
export const MAILBOX_STATUS_TONE = {
  active: 'live',
  paused: 'attention',
  failing: 'danger',
  archived: 'muted',
} as const satisfies Record<MailboxStatus, Tone>;

/** PC-09: why a failing mailbox fails. A refused login waits for a person;
 *  the other two recover on their own when they can. */
export const MAILBOX_FAILURE_CLASS_TONE = {
  auth: 'danger',
  connection: 'attention',
  ambiguous: 'attention',
} as const satisfies Record<MailboxFailureClassValue, Tone>;

export const OUTREACH_RELEVANCE_TONE = {
  prospect_reply: 'info',
  auto_reply: 'neutral',
  bounce: 'danger',
  bulk: 'muted',
  unrelated: 'muted',
} as const satisfies Record<MailOutreachRelevance, Tone>;

export const SUPPRESSION_KIND_TONE = {
  email: 'neutral',
  domain: 'neutral',
  company: 'neutral',
} as const satisfies Record<SuppressionKind, Tone>;

export const SUPPRESSION_REASON_TONE = {
  bounce_hard: 'danger',
  bounce_soft: 'neutral',
  unsubscribe: 'neutral',
  complaint: 'danger',
  manual: 'neutral',
} as const satisfies Record<SuppressionReason, Tone>;

/** Where a suppression came from: provenance, not a signal. */
export const SUPPRESSION_SOURCE_TONE = {
  unsubscribe_link: 'neutral',
  reply: 'neutral',
  dsn: 'neutral',
  smtp: 'neutral',
  manual: 'neutral',
  import: 'neutral',
  legacy_auto: 'neutral',
  legacy_unknown: 'neutral',
} as const satisfies Record<SuppressionSource, Tone>;

/** One closing vocabulary: only a win is good news; never red. */
export const CLOSE_REASON_TONE = {
  won: 'success',
  lost: 'neutral',
  no_response: 'neutral',
  wrong_fit: 'neutral',
  duplicate: 'neutral',
  spam: 'neutral',
  other: 'neutral',
} as const satisfies Record<CloseReason, Tone>;

/**
 * Progress states are info: how far a lead got is shown by position and
 * the one-hue --seq ramp, not by hue. Closed is neutral with a
 * close-reason chip beside it.
 */
export const PIPELINE_STATE_TONE = {
  raw_discovered: 'neutral',
  relevant: 'info',
  contacted: 'info',
  replied: 'info',
  contact_identified: 'info',
  qualified: 'info',
  handed_over: 'info',
  synced_to_crm: 'info',
  closed: 'neutral',
} as const satisfies Record<PipelineState, Tone>;

export const CRM_CONNECTION_STATUS_TONE = {
  active: 'live',
  paused: 'attention',
  failing: 'danger',
  archived: 'muted',
} as const satisfies Record<CrmConnectionStatus, Tone>;

export const CRM_SYNC_KIND_TONE = {
  contact: 'neutral',
  note: 'neutral',
  deal: 'neutral',
} as const satisfies Record<CrmSyncKind, Tone>;

export const CRM_SYNC_OUTCOME_TONE = {
  pending: 'neutral',
  succeeded: 'success',
  failed: 'danger',
  skipped: 'neutral',
} as const satisfies Record<CrmSyncOutcome, Tone>;

export const CONTACT_STATUS_TONE = {
  active: 'neutral',
  archived: 'muted',
} as const satisfies Record<ContactStatus, Tone>;

// ---- Text-column registries --------------------------------------------

/**
 * The tone each reply class earns once triage can be trusted. Until then
 * (REPLY_TRIAGE_TRUSTED below) every class renders neutral and is
 * labelled 'auto' (labels.ts signalFor).
 */
export const REPLY_CLASS_TONE = {
  positive: 'success',
  interest: 'success',
  question: 'info',
  doc_request: 'info',
  redirect: 'info',
  negative: 'neutral',
  out_of_office: 'neutral',
  unsubscribe: 'neutral',
  irrelevant: 'neutral',
  bounce: 'danger',
} as const satisfies Record<ReplyClass, Tone>;

/**
 * Reply classification is keyword heuristics only (I088): the relevance
 * gate (X1, P0-13) keeps bulk mail out, but the class itself is not
 * reliable yet. While false, reply-class badges are neutral and say
 * 'auto'. Flip it when the AI classifier with a correction path lands.
 */
export const REPLY_TRIAGE_TRUSTED = false;

export const FOLLOW_UP_STATUS_TONE = {
  pending: 'neutral',
  processing: 'info',
  awaiting_approval: 'attention',
  sent: 'success',
  skipped: 'neutral',
  failed: 'danger',
} as const satisfies Record<FollowUpStatus, Tone>;

export const FOLLOW_UP_SKIP_REASON_TONE = {
  replied: 'neutral',
  bounce: 'neutral',
  manual_cancel: 'neutral',
  product_archived: 'neutral',
  lead_closed: 'neutral',
  unsubscribed: 'neutral',
  suppressed: 'neutral',
} as const satisfies Record<FollowUpSkipReason, Tone>;

export const NOTIFICATION_KIND_TONE = {
  'review.needs_review': 'attention',
  'follow_up.awaiting_approval': 'attention',
  'health.warning': 'attention',
  'health.finding': 'attention',
  'health.critical': 'danger',
  'lead.replied': 'info',
  mention: 'info',
  assignment: 'info',
  'support.reply': 'info',
  'run.failed': 'danger',
  'mailbox.failing': 'danger',
  'mailbox.recovered': 'success',
  'learning.synthesis': 'ai',
  'tokens.low': 'attention',
  'tokens.empty': 'danger',
  'tokens.auto_topup': 'success',
  'tokens.auto_topup_pending': 'attention',
  'tokens.auto_topup_failed': 'danger',
  'automation.paused': 'attention',
  'automation.hold': 'attention',
  'automation.owner_unaccountable': 'danger',
  'outreach.go_live': 'info',
  'knowledge.index_failed': 'danger',
  'learning.failed': 'danger',
} as const satisfies Record<NotificationKind, Tone>;

export const KNOWLEDGE_EXTERNAL_STATUS_TONE = {
  pending: 'info',
  indexed: 'live',
  failed: 'danger',
} as const satisfies Record<KnowledgeSourceExternalStatus, Tone>;

export const QUALIFICATION_METHOD_TONE = {
  rules: 'neutral',
  ai: 'ai',
  rules_fallback: 'neutral',
  hybrid: 'ai',
} as const satisfies Record<QualificationMethod, Tone>;

export const OUTREACH_DRAFT_METHOD_TONE = {
  rules: 'neutral',
  ai: 'ai',
  hybrid: 'ai',
} as const satisfies Record<OutreachDraftMethod, Tone>;

export const GEO_STATUS_TONE = {
  no_gate: 'neutral',
  match: 'success',
  mismatch: 'danger',
  unverified: 'attention',
} as const satisfies Record<GeoStatus, Tone>;

export const HEALTH_FINDING_SEVERITY_TONE = {
  info: 'neutral',
  warning: 'attention',
  critical: 'danger',
} as const satisfies Record<HealthFindingSeverity, Tone>;

/** Hints on list rows: 'action' and 'warning' wait on the operator. */
export const HINT_SEVERITY_TONE = {
  info: 'info',
  action: 'attention',
  warning: 'attention',
  critical: 'danger',
  success: 'success',
  note: 'neutral',
} as const satisfies Record<HintSeverity, Tone>;

export const WORKSPACE_PLAN_TONE = {
  trial: 'neutral',
  starter: 'neutral',
  pro: 'neutral',
} as const satisfies Record<WorkspacePlan, Tone>;

/** 'workspace' = the operator's own key (info: "you"). */
export const USAGE_KEY_SOURCE_TONE = {
  workspace: 'info',
  platform: 'neutral',
  mock: 'neutral',
} as const satisfies Record<UsageKeySource, Tone>;

// ---- The index ---------------------------------------------------------

// ---- Phase 1 sets (automation control, knowledge foundation) ----------

/** PC-06: kinds of work a hold can stop; a kind is not a signal. */
export const AUTOMATION_CAPABILITY_TONE = {
  sending: 'neutral',
  inbox_sync: 'neutral',
  inbound_actions: 'neutral',
  discovery: 'neutral',
  autopilot: 'neutral',
  crm_sync: 'neutral',
  background_ai: 'neutral',
  auto_topup: 'neutral',
  trash_purge: 'neutral',
} as const satisfies Record<AutomationCapability, Tone>;

export const WORKSPACE_HOLD_SCOPE_TONE = {
  all: 'neutral',
  capabilities: 'neutral',
} as const satisfies Record<WorkspaceHoldScope, Tone>;

export const WORKSPACE_HOLD_KIND_TONE = {
  hold: 'neutral',
  note: 'muted',
} as const satisfies Record<WorkspaceHoldKind, Tone>;

/** An active hold stops work, like a paused mailbox. */
export const WORKSPACE_HOLD_STATE_TONE = {
  active: 'attention',
  pending_review: 'attention',
  released: 'muted',
  discarded: 'muted',
} as const satisfies Record<WorkspaceHoldState, Tone>;

export const WORKSPACE_HOLD_SOURCE_TONE = {
  tenant: 'neutral',
  platform: 'neutral',
} as const satisfies Record<WorkspaceHoldSource, Tone>;

/** KL-06: the honest index status of a knowledge source. */
export const KNOWLEDGE_INDEX_STATUS_TONE = {
  queued: 'neutral',
  indexing: 'live',
  indexed: 'live',
  stale: 'attention',
  failed: 'danger',
} as const satisfies Record<KnowledgeIndexStatus, Tone>;

export const KNOWLEDGE_SCOPE_KIND_TONE = {
  workspace: 'neutral',
  products: 'neutral',
} as const satisfies Record<KnowledgeScopeKind, Tone>;

export const LESSON_SCOPE_KIND_TONE = {
  workspace: 'neutral',
  products: 'neutral',
} as const satisfies Record<LessonScopeKind, Tone>;

/** KL-01: a learned rule is AI-made; a suggestion waits on a person. */
export const LESSON_LIFECYCLE_TONE = {
  active: 'ai',
  proposed: 'attention',
  disabled: 'muted',
  retired: 'muted',
} as const satisfies Record<LessonLifecycle, Tone>;

export const LESSON_RETIRED_REASON_TONE = {
  stale: 'muted',
  merged: 'muted',
  superseded: 'muted',
  contradicted: 'muted',
  operator_rejected: 'muted',
  source_decision_voided: 'muted',
  absorbed_into_profile: 'muted',
  product_deleted: 'muted',
  category_removed: 'muted',
} as const satisfies Record<LessonRetiredReason, Tone>;

/**
 * Every value set an operator sees, by name: pgEnums by their SQL name,
 * text-column registries by theirs. labels.ts keys LABEL_MAPS the same way
 * (a mapped type makes a missing set or value a typecheck error).
 */
export const TONE_MAPS = {
  account_status: ACCOUNT_STATUS_TONE,
  user_role: USER_ROLE_TONE,
  onboarding_status: ONBOARDING_STATUS_TONE,
  subscription_status: SUBSCRIPTION_STATUS_TONE,
  workspace_member_role: WORKSPACE_MEMBER_ROLE_TONE,
  workspace_status: WORKSPACE_STATUS_TONE,
  connector_run_status: CONNECTOR_RUN_STATUS_TONE,
  connector_template_type: CONNECTOR_TEMPLATE_TYPE_TONE,
  review_item_state: REVIEW_ITEM_STATE_TONE,
  outreach_draft_status: OUTREACH_DRAFT_STATUS_TONE,
  outreach_queue_status: OUTREACH_QUEUE_STATUS_TONE,
  outreach_stage: OUTREACH_STAGE_TONE,
  send_delay_mode: SEND_DELAY_MODE_TONE,
  document_status: DOCUMENT_STATUS_TONE,
  knowledge_purpose_category: KNOWLEDGE_PURPOSE_CATEGORY_TONE,
  knowledge_source_kind: KNOWLEDGE_SOURCE_KIND_TONE,
  mail_direction: MAIL_DIRECTION_TONE,
  mail_status: MAIL_STATUS_TONE,
  mailbox_status: MAILBOX_STATUS_TONE,
  mailbox_failure_class: MAILBOX_FAILURE_CLASS_TONE,
  outreach_relevance: OUTREACH_RELEVANCE_TONE,
  suppression_kind: SUPPRESSION_KIND_TONE,
  suppression_reason: SUPPRESSION_REASON_TONE,
  suppression_source: SUPPRESSION_SOURCE_TONE,
  close_reason: CLOSE_REASON_TONE,
  pipeline_state: PIPELINE_STATE_TONE,
  crm_connection_status: CRM_CONNECTION_STATUS_TONE,
  crm_sync_kind: CRM_SYNC_KIND_TONE,
  crm_sync_outcome: CRM_SYNC_OUTCOME_TONE,
  contact_status: CONTACT_STATUS_TONE,
  reply_class: REPLY_CLASS_TONE,
  follow_up_status: FOLLOW_UP_STATUS_TONE,
  follow_up_skip_reason: FOLLOW_UP_SKIP_REASON_TONE,
  notification_kind: NOTIFICATION_KIND_TONE,
  knowledge_external_status: KNOWLEDGE_EXTERNAL_STATUS_TONE,
  qualification_method: QUALIFICATION_METHOD_TONE,
  outreach_draft_method: OUTREACH_DRAFT_METHOD_TONE,
  geo_status: GEO_STATUS_TONE,
  health_finding_severity: HEALTH_FINDING_SEVERITY_TONE,
  hint_severity: HINT_SEVERITY_TONE,
  workspace_plan: WORKSPACE_PLAN_TONE,
  usage_key_source: USAGE_KEY_SOURCE_TONE,
  automation_capability: AUTOMATION_CAPABILITY_TONE,
  workspace_hold_scope: WORKSPACE_HOLD_SCOPE_TONE,
  workspace_hold_kind: WORKSPACE_HOLD_KIND_TONE,
  workspace_hold_state: WORKSPACE_HOLD_STATE_TONE,
  workspace_hold_source: WORKSPACE_HOLD_SOURCE_TONE,
  knowledge_index_status: KNOWLEDGE_INDEX_STATUS_TONE,
  knowledge_scope_kind: KNOWLEDGE_SCOPE_KIND_TONE,
  lesson_scope_kind: LESSON_SCOPE_KIND_TONE,
  lesson_lifecycle: LESSON_LIFECYCLE_TONE,
  lesson_retired_reason: LESSON_RETIRED_REASON_TONE,
} as const;

export type SignalSet = keyof typeof TONE_MAPS;

/** The values of one set (for a pgEnum: its enumValues). */
export type SignalValue<S extends SignalSet> = keyof (typeof TONE_MAPS)[S] & string;

/**
 * Values that are processes running right now: their badge pulses (the
 * only animated signal; prefers-reduced-motion stills it).
 */
export const PULSE_VALUES: { readonly [S in SignalSet]?: ReadonlyArray<SignalValue<S>> } = {
  connector_run_status: ['running'],
  outreach_queue_status: ['sending'],
  mail_status: ['sending'],
  document_status: ['uploading'],
  knowledge_external_status: ['pending'],
  knowledge_index_status: ['indexing'],
};

// ---- Rules that are not a lookup ----------------------------------------

/** Health and naturalness scores (0–100): ≥80 success, 50–79 attention, <50 danger. */
export function healthScoreTone(score: number): Extract<Tone, 'success' | 'attention' | 'danger'> {
  if (score >= 80) return 'success';
  if (score >= 50) return 'attention';
  return 'danger';
}

/**
 * The pipeline's progress states in order: the funnel's rows, the kanban's
 * columns and the order of the state filter. raw_discovered never reaches
 * the pipeline page and closed sits outside the funnel.
 */
export const PIPELINE_PROGRESS = [
  'relevant',
  'contacted',
  'replied',
  'contact_identified',
  'qualified',
  'handed_over',
  'synced_to_crm',
] as const satisfies ReadonlyArray<PipelineState>;

/** Steps of the one-hue sequence ramp (--seq-1 … --seq-7 in tokens.css). */
export const SEQUENCE_STEPS = 7;

/**
 * The ramp step for position `index` of an ordered progression of `count`
 * items: the first item gets --seq-1 (full primary), the last --seq-7
 * (40%), and the steps in between spread evenly.
 */
export function sequenceStep(index: number, count: number): number {
  if (count <= 1) return 1;
  const clamped = Math.min(Math.max(index, 0), count - 1);
  return 1 + Math.round((clamped * (SEQUENCE_STEPS - 1)) / (count - 1));
}
