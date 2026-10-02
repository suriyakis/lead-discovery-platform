// AP-06: the diagnostics engine's vocabulary. Pure module (no imports
// but other pure modules), so pages, client components, the tone and label
// maps and tests can share it.
//
// A Finding is one problem (or one notable state) of one workspace, as
// every surface shows it: /health, the weekly report, the 6-hourly notify
// sweep, Today and the assistant's <workspace_state>. Rules produce them;
// the engine adds what the registry knows (code order, isolation) and
// sorts them. See README.md for the contribution contract.

import type { NotificationKind } from '@/lib/kinds/notification';

/** Mildest first. `advisory` is a flag on 'info', not a severity. */
export const FINDING_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** Rank for sorting: critical first. */
export const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/**
 * When the notify sweep may raise a notification for a finding:
 *   never               shown on /health, Today and to the assistant only
 *   on_appear           once per episode (the finding appeared since it was
 *                       last absent); the per-rule 24 h cap still applies
 *   max_once_per_days   at most once every `days` days while present
 * Whatever the policy, a workspace gets at most ONE notification per rule
 * per 24 h (several findings of one rule are folded into one).
 */
export type NotifyPolicy =
  | { readonly kind: 'never' }
  | { readonly kind: 'on_appear' }
  | { readonly kind: 'max_once_per_days'; readonly days: number };

export const NOTIFY_NEVER: NotifyPolicy = Object.freeze({ kind: 'never' });
export const NOTIFY_ON_APPEAR: NotifyPolicy = Object.freeze({ kind: 'on_appear' });
export function notifyEveryDays(days: number): NotifyPolicy {
  return Object.freeze({ kind: 'max_once_per_days', days: Math.max(1, Math.floor(days)) });
}

export interface FindingNotify {
  policy: NotifyPolicy;
  /**
   * The episode identity (and the in-app notification's dedupe key when the
   * rule has a single finding to send). Stable across sweeps; the same key
   * a source event uses when one exists (e.g. `mailbox.failing:<id>`, so
   * the sweep never doubles an alert the IMAP tick already raised).
   */
  dedupeKey: string;
  /** The bell's kind; defaults by severity (health.critical / health.finding). */
  kind?: NotificationKind;
}

/** The record a finding is about, when it is about one. */
export interface FindingEntity {
  type: string;
  id: string;
  label?: string;
}

/** Facts are small and serialisable: they go into the stored report and
 *  the assistant's prompt. */
export type FindingFacts = Readonly<Record<string, string | number | boolean | null>>;

/** What the operator (or the assistant, AP-10) can do about it. */
export const FINDING_ACTION_KINDS = ['open', 'pause_automation', 'contact_support'] as const;
export type FindingActionKind = (typeof FINDING_ACTION_KINDS)[number];

export interface Finding {
  /** The rule's code (`mailbox.failing`), or `ops.<kind>` for incidents. */
  code: string;
  /** The id of the rule that produced it (= `code`, except ops incidents
   *  whose rule is `ops.incidents`). */
  rule: string;
  severity: FindingSeverity;
  /** Context, not a problem: never notifies, never costs score. */
  advisory: boolean;
  /** Short, no trailing period: "Mailbox "Sales" is failing". */
  title: string;
  /** Full sentences: what it means and what to do. */
  detail: string;
  facts: FindingFacts;
  /** Where to fix it (a registry route or a detail page); null = nothing
   *  the workspace can do (e.g. a platform stop) beyond reading. */
  href: string | null;
  entity?: FindingEntity;
  /** ISO time the condition started, when known. */
  since: string | null;
  actionKinds: readonly FindingActionKind[];
  notify: FindingNotify;
  /** 'rule' (computed live) or 'ops_event' (an open incident). */
  source: 'rule' | 'ops_event';
}

/** What a rule returns: the engine fills `code` defaults and freezes it. */
export type FindingDraft = Omit<
  Finding,
  'rule' | 'advisory' | 'facts' | 'since' | 'actionKinds' | 'source' | 'notify'
> & {
  advisory?: boolean;
  facts?: FindingFacts;
  since?: Date | string | null;
  actionKinds?: readonly FindingActionKind[];
  notify?: Partial<FindingNotify> & { policy?: NotifyPolicy };
  source?: Finding['source'];
};

/** The workstream that owns a rule (README: the contribution contract). */
export type RuleOwner = 'diagnostics' | 'ops' | 'outreach' | 'discovery' | 'knowledge' | 'billing';

/** Score cost per rule at its worst severity (advisory findings cost 0). */
export const SEVERITY_PENALTY: Readonly<Record<FindingSeverity, number>> = {
  critical: 25,
  warning: 10,
  info: 0,
};

/** `diagnostics.partial`: one or more rules threw; the rest still report. */
export const PARTIAL_CODE = 'diagnostics.partial';

/** The legacy finding shape (`collectRuleFindings`, reports stored before
 *  AP-06): one sentence in `message`. */
export interface LegacyHealthFinding {
  severity: FindingSeverity;
  code: string;
  message: string;
  href?: string;
}

/** One sentence for surfaces that show a single line. */
export function findingMessage(f: Pick<Finding, 'title' | 'detail'>): string {
  const title = f.title.trim();
  const detail = f.detail.trim();
  if (!detail) return title.endsWith('.') ? title : `${title}.`;
  return `${title.endsWith('.') ? title : `${title}.`} ${detail}`;
}

/** Most severe first; advisory after the rest of its severity. */
export function compareFindings(a: Finding, b: Finding): number {
  const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (s !== 0) return s;
  if (a.advisory !== b.advisory) return a.advisory ? 1 : -1;
  return 0;
}

/** A finding a person should act on (not info, not advisory). */
export function isProblem(f: { severity: FindingSeverity; advisory?: boolean }): boolean {
  return !f.advisory && f.severity !== 'info';
}
