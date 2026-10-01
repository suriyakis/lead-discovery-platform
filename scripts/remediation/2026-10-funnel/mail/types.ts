// Remediation 2026-10-funnel, mail module (flow:F-06) — shared types.
//
// Everything in a MailPlan is JSON-serialisable (ids and token amounts are
// strings) because the plan IS the dry-run report the owner reviews. It
// never contains message subjects or bodies; addresses appear only where a
// person has to judge a row (R1 suppressions, R3 contacts).

import type { OutreachRelevance } from '@/lib/mail/relevance';
import type { StoredRelevanceSignals } from '@/lib/services/inbound-relevance';

export const SCRIPT = '2026-10-funnel';
export const MODULE = 'mail';
/** Bump when the plan shape or a selector changes: a report made by an
 *  older version can then no longer be applied. */
export const MAIL_PLAN_VERSION = 1;

/** revoke_reason on every suppression this remediation lifts. */
export const REVOKE_REASON = 'remediation 2026-10 X1';
/** Tag added to every contact R3 archives. */
export const INBOUND_AUTO_TAG = 'inbound-auto';
/** A legacy 'suppression.add' counts as automatic when a 'reply.classify'
 *  event for a message from that address precedes it by at most this. */
export const CLASSIFY_WINDOW_MS = 120_000;
/** F-01 must have run this long, with no new non-prospect suppressions,
 *  before an apply (proposal §17, safeguards). */
export const F01_SETTLE_HOURS = 48;
/** A token debit counts as a translation of a message when it was
 *  metered at most this long before the message's translated_at. */
export const TRANSLATION_WINDOW_MS = 120_000;

/** Relevance values R1a / R2 / R3 act on. */
export const NON_PROSPECT: ReadonlySet<OutreachRelevance> = new Set<OutreachRelevance>([
  'bulk',
  'unrelated',
]);

export interface MailPlanOptions {
  /** Extra own domains: `example.com` (every workspace) or `4:example.com`. */
  ownDomains: string[];
  /** Workspace ids in scope; null = every workspace. */
  workspaceIds: string[] | null;
}

export interface OwnDomain {
  domain: string;
  why: string;
}

/** R0: an inbound row synced before F-01, labelled now. */
export interface R0Row {
  messageId: string;
  relevance: OutreachRelevance;
  reason: string;
}

export type TrailKind = 'auto' | 'manual' | 'link' | 'import' | 'smtp' | 'dsn' | 'unknown';

/** One add in a suppression's rebuilt history. */
export interface TrailEvent {
  auditId: string;
  at: string;
  kind: TrailKind;
  /** The message whose classification caused an automatic add. */
  sourceMessageId: string | null;
  detail: string;
}

export interface R1Row {
  suppressionId: string;
  kind: string;
  value: string;
  reason: string;
  source: string;
  createdAt: string;
  /** Why the address counts as the workspace's own, or null. */
  ownDomain: string | null;
  class: 'R1a' | 'R1b';
  why: string;
  defaultDecision: 'revoke' | 'keep';
  trail: TrailEvent[];
  sourceMessages: Array<{ id: string | null; relevance: OutreachRelevance | null }>;
  /** Note cross-check findings; they never change the class. */
  warnings: string[];
}

/** R2: a bulk / unrelated inbound message carrying reply labels. */
export interface R2Row {
  messageId: string;
  relevance: OutreachRelevance;
  label: string | null;
}

/** R3: an inbound-only contact created from bulk / unrelated mail. */
export interface R3Row {
  contactId: string;
  email: string;
  ownDomain: string | null;
  inboundMessages: number;
  relevance: Partial<Record<OutreachRelevance, number>>;
  defaultDecision: 'archive' | 'keep';
  why: string;
}

/** R4: a lead.replied notification on a thread without outbound mail. */
export interface R4Row {
  notificationId: string;
  threadId: string;
  read: boolean;
}

/** R5: downstream effects of the misclassification (expected 0 each). */
export interface ZeroImpactChecks {
  threadStatesWithoutOutbound: number;
  pipelineAutoCloses: number;
  learningEventsFromNonProspectMail: number;
  replyDraftsFromNonProspectMail: number;
  /** Queued sends / due follow-ups to an address R1 would un-suppress by
   *  default. Any blocks the R1 apply. */
  pendingSendsToRevokeTargets: number;
}

/** R6: one feature_flags row and what F-07 will do with it. */
export interface FlagRow {
  key: string;
  enabled: boolean;
  setAt: string;
  effect: string;
  observed: string | null;
}

/** R7: a failing mailbox (decision only; recheck_now sets the gate). */
export interface R7Row {
  mailboxId: string;
  name: string;
  failingSince: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
  nextCheckAt: string | null;
  error: string;
  advice: string;
  defaultDecision: 'keep';
}

/** R8: tokens debited for translating non-prospect mail (estimate). */
export interface R8Estimate {
  translatedMessages: number;
  billedTranslations: number;
  tokens: string;
  usageLogIds: string[];
}

/** Counts that must read 0 after an apply (unless kept by decision). */
export interface MailChecks {
  inboundWithoutRelevance: number;
  activeAutoSuppressionsFromNonProspectMail: number;
  labelledNonProspectInbound: number;
  inboundOnlyContacts: number;
  visibleInboundAutoContacts: number;
  leadRepliedOnThreadsWithoutOutbound: number;
}

export interface WorkspaceMailPlan {
  workspaceId: string;
  name: string;
  status: string;
  ownDomains: OwnDomain[];
  r0: R0Row[];
  r1: R1Row[];
  r2: R2Row[];
  r3: R3Row[];
  r4: R4Row[];
  /** lead.replied rows whose thread could not be read (left alone). */
  r4Unparsed: number;
  r5: ZeroImpactChecks;
  r6: FlagRow[];
  r7: R7Row[];
  r8: R8Estimate;
  checks: MailChecks;
}

export interface MailPreconditions {
  /** First inbound row labelled at parse time by F-01 (in scope). */
  f01LiveSince: string | null;
  hoursLive: number | null;
  /** 'suppression.add' from the reply classifier since F-01 went live
   *  whose message is not a prospect reply (must be 0). */
  nonProspectReplySuppressionsSinceF01: number;
  ok: boolean;
  notes: string[];
}

export interface MailPlan {
  kind: 'remediation-plan';
  script: typeof SCRIPT;
  module: typeof MODULE;
  version: number;
  batchId: string;
  generatedAt: string;
  database: { host: string; name: string };
  options: MailPlanOptions;
  planHash: string;
  preconditions: MailPreconditions;
  workspaces: WorkspaceMailPlan[];
}

/** What apply needs beyond the report: the full R0 assessments. */
export interface MailPlanInternals {
  assessments: Map<string, { workspaceId: bigint; signals: StoredRelevanceSignals }>;
}
