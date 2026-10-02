// Remediation 2026-10-funnel, mail module (flow:F-06) — owner decisions.
//
// The dry run writes decisions.csv with every decision pre-filled with its
// default. The owner edits the `decision` column and passes the file to
// --apply. Bulk categories are decided per workspace (R0, R2, R4, R8; one
// row with target_id '*'); rows that need judgement are decided one by one
// (R1a, R1b, R3, R7). A plan row with no decision row is left alone.

import { RemediationError, formatCsv, parseCsv, sha256, unguardCell } from '../../lib/report-io';
import type { MailPlan } from './types';

export const DECISIONS_HEADER = [
  'batch_id',
  'category',
  'workspace_id',
  'target_id',
  'own_domain',
  'target',
  'why',
  'default',
  'decision',
] as const;

export type CategoryDecision = 'approve' | 'skip';
export type RowDecision = 'revoke' | 'keep' | 'archive' | 'recheck_now';

const ALLOWED: Record<string, readonly string[]> = {
  R0: ['approve', 'skip'],
  R2: ['approve', 'skip'],
  R4: ['approve', 'skip'],
  R8: ['approve', 'skip'],
  R1a: ['revoke', 'keep'],
  R1b: ['revoke', 'keep'],
  R3: ['archive', 'keep'],
  R7: ['keep', 'recheck_now'],
};

const CATEGORY_LEVEL = new Set(['R0', 'R2', 'R4', 'R8']);

interface DecisionTarget {
  category: string;
  workspaceId: string;
  targetId: string;
  ownDomain: string;
  target: string;
  why: string;
  defaultDecision: string;
}

/** Every decidable target of a plan, in report order. */
export function decisionTargets(plan: MailPlan): DecisionTarget[] {
  const out: DecisionTarget[] = [];
  for (const w of plan.workspaces) {
    const ws = w.workspaceId;
    if (w.r0.length > 0) {
      out.push({
        category: 'R0',
        workspaceId: ws,
        targetId: '*',
        ownDomain: '',
        target: `label ${w.r0.length} inbound message(s) with their F-01 relevance`,
        why: 'synced before the relevance gate',
        defaultDecision: 'approve',
      });
    }
    for (const r of w.r1) {
      out.push({
        category: r.class,
        workspaceId: ws,
        targetId: r.suppressionId,
        ownDomain: r.ownDomain ?? '',
        target: `${r.kind}:${r.value} (${r.reason})`,
        why: r.why,
        defaultDecision: r.defaultDecision,
      });
    }
    if (w.r2.length > 0) {
      out.push({
        category: 'R2',
        workspaceId: ws,
        targetId: '*',
        ownDomain: '',
        target: `clear reply labels on ${w.r2.length} bulk/unrelated message(s)`,
        why: 'labels were set by the classifier on mail that is not a reply',
        defaultDecision: 'approve',
      });
    }
    for (const r of w.r3) {
      out.push({
        category: 'R3',
        workspaceId: ws,
        targetId: r.contactId,
        ownDomain: r.ownDomain ?? '',
        target: r.email,
        why: r.why,
        defaultDecision: r.defaultDecision,
      });
    }
    if (w.r4.length > 0) {
      out.push({
        category: 'R4',
        workspaceId: ws,
        targetId: '*',
        ownDomain: '',
        target: `delete ${w.r4.length} lead.replied notification(s)`,
        why: 'their threads contain no outbound message of ours',
        defaultDecision: 'approve',
      });
    }
    for (const r of w.r7) {
      out.push({
        category: 'R7',
        workspaceId: ws,
        targetId: r.mailboxId,
        ownDomain: '',
        target: `mailbox "${r.name}"`,
        why: `failing since ${r.failingSince ?? 'unknown'}; archive it on the mailbox page if it is no longer used`,
        defaultDecision: r.defaultDecision,
      });
    }
    if (BigInt(w.r8.tokens) > 0n) {
      out.push({
        category: 'R8',
        workspaceId: ws,
        targetId: '*',
        ownDomain: '',
        target: `credit ${w.r8.tokens} token(s)`,
        why: `spent translating ${w.r8.billedTranslations} non-prospect message(s) (optional)`,
        defaultDecision: 'skip',
      });
    }
  }
  return out;
}

export function renderDecisionsCsv(plan: MailPlan): string {
  return formatCsv(
    DECISIONS_HEADER,
    decisionTargets(plan).map((t) => [
      plan.batchId,
      t.category,
      t.workspaceId,
      t.targetId,
      t.ownDomain,
      t.target,
      t.why,
      t.defaultDecision,
      t.defaultDecision,
    ]),
  );
}

export interface ResolvedDecisions {
  hash: string;
  /** `${category}|${workspaceId}` → approved. */
  categories: Map<string, boolean>;
  /** `${category}|${workspaceId}|${targetId}` → decision. */
  rows: Map<string, RowDecision>;
  /** Plan targets without a decision row (left alone). */
  missing: string[];
  /** Rows whose decision differs from the default. */
  overrides: string[];
}

export const decisionKey = (category: string, workspaceId: string, targetId = '*'): string =>
  targetId === '*' ? `${category}|${workspaceId}` : `${category}|${workspaceId}|${targetId}`;

/** Validate the owner's decisions file against the recomputed plan. */
export function resolveDecisions(plan: MailPlan, csvText: string): ResolvedDecisions {
  const table = parseCsv(csvText).map((r) => r.map((c) => unguardCell(c.trim())));
  const header = table.shift()?.map((h) => h.toLowerCase());
  if (!header || DECISIONS_HEADER.some((h, i) => header[i] !== h)) {
    throw new RemediationError(
      `decisions file must start with the header ${DECISIONS_HEADER.join(',')}`,
      'invalid_decisions',
    );
  }
  const targets = new Map(
    decisionTargets(plan).map((t) => [decisionKey(t.category, t.workspaceId, t.targetId), t]),
  );
  const categories = new Map<string, boolean>();
  const rows = new Map<string, RowDecision>();
  const seen = new Set<string>();
  const overrides: string[] = [];

  table.forEach((cells, i) => {
    const line = i + 2;
    const [batchId, category, workspaceId, targetId, , , , , decisionRaw] = cells;
    if (batchId !== plan.batchId) {
      throw new RemediationError(
        `decisions line ${line}: batch ${batchId} is not this report's batch ${plan.batchId}`,
        'invalid_decisions',
      );
    }
    const allowed = ALLOWED[category ?? ''];
    if (!allowed) {
      throw new RemediationError(
        `decisions line ${line}: unknown category ${category}`,
        'invalid_decisions',
      );
    }
    const decision = (decisionRaw ?? '').toLowerCase();
    if (!allowed.includes(decision)) {
      throw new RemediationError(
        `decisions line ${line}: ${category} takes ${allowed.join(' / ')}, not "${decisionRaw}"`,
        'invalid_decisions',
      );
    }
    const key = decisionKey(category!, workspaceId ?? '', targetId ?? '');
    const target = targets.get(key);
    if (!target) {
      throw new RemediationError(
        `decisions line ${line}: ${category} ${workspaceId}/${targetId} is not in this plan`,
        'invalid_decisions',
      );
    }
    if (seen.has(key)) {
      throw new RemediationError(
        `decisions line ${line}: duplicate decision for ${key}`,
        'invalid_decisions',
      );
    }
    seen.add(key);
    if (decision !== target.defaultDecision) overrides.push(`${key} → ${decision}`);
    if (CATEGORY_LEVEL.has(category!)) {
      categories.set(key, decision === 'approve');
    } else {
      rows.set(key, decision as RowDecision);
    }
  });

  return {
    hash: sha256(csvText),
    categories,
    rows,
    missing: [...targets.keys()].filter((k) => !seen.has(k)),
    overrides,
  };
}
