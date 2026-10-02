// AP-06 (absorbs PC-33, ia:F-16 and MOB-02's getFindings): THE diagnostics
// engine. One answer to "what is wrong in this workspace right now", read
// by /health and the weekly report (health-check.ts), the 6-hourly notify
// sweep (notify.ts), Today and the assistant's <workspace_state>
// (assistant.ts). There is no second diagnostic query (I129).
//
//   getWorkspaceDiagnostics(ctx, { fresh?, now? })
//     runs every rule of the registry in parallel against one shared
//     environment, isolates each rule (one that throws becomes part of a
//     `diagnostics.partial` finding; the others still report), normalises
//     and sorts the findings (most severe first, registry order inside a
//     severity) and scores them (score.ts). No writes, no AI, no network.
//
//   Memo: the result is kept 30 s per workspace for the pages that render
//   on every navigation (Today). /health, the weekly report, the sweep and
//   the assistant ask for a fresh evaluation.

import { describeError } from '@/lib/ops/mask';
import type { WorkspaceContext } from '@/lib/services/context';
import { createDiagnosticsEnv } from './env';
import { fixHref } from './hrefs';
import { DIAGNOSTIC_RULES, assertUniqueRuleIds } from './registry';
import type { DiagnosticRule } from './rule';
import { scoreFindings } from './score';
import {
  NOTIFY_NEVER,
  PARTIAL_CODE,
  compareFindings,
  type Finding,
  type FindingDraft,
} from './types';

export interface DiagnosticsReport {
  workspaceId: bigint;
  evaluatedAt: Date;
  /** Most severe first. */
  findings: readonly Finding[];
  /** 0–100 (score.ts), without the AI conversation review. */
  score: number;
  /** Ids of the rules that threw this time (their findings are missing). */
  failedRules: readonly string[];
  partial: boolean;
}

export interface DiagnosticsOptions {
  /** Skip the 30 s memo (and refresh it). */
  fresh?: boolean;
  /** Test seam: the evaluation clock. Bypasses the memo. */
  now?: Date;
  /** Test seam: another rule list. Bypasses the memo. */
  rules?: readonly DiagnosticRule[];
}

export const DIAGNOSTICS_MEMO_TTL_MS = 30_000;
const MEMO_MAX_WORKSPACES = 500;
const memo = new Map<string, { at: number; report: Promise<DiagnosticsReport> }>();

assertUniqueRuleIds(DIAGNOSTIC_RULES);

/** The rule's findings must carry its id as their code (ops.incidents:
 *  any `ops.<kind>`), so the ledger and the docs can trust the code. */
function codeBelongsToRule(rule: DiagnosticRule, code: string): boolean {
  return rule.id === 'ops.incidents' ? code.startsWith('ops.') : code === rule.id;
}

function normalize(rule: DiagnosticRule, draft: FindingDraft): Finding {
  if (!codeBelongsToRule(rule, draft.code)) {
    throw new Error(`rule "${rule.id}" returned a finding coded "${draft.code}"`);
  }
  const advisory = draft.advisory ?? false;
  const since =
    draft.since instanceof Date
      ? draft.since.toISOString()
      : typeof draft.since === 'string'
        ? draft.since
        : null;
  const policy = advisory ? NOTIFY_NEVER : (draft.notify?.policy ?? NOTIFY_NEVER);
  return Object.freeze({
    code: draft.code,
    rule: rule.id,
    // Advisory findings are context: never above info.
    severity: advisory ? 'info' : draft.severity,
    advisory,
    title: draft.title.trim(),
    detail: draft.detail.trim(),
    facts: Object.freeze({ ...(draft.facts ?? {}) }),
    href: draft.href,
    ...(draft.entity ? { entity: Object.freeze({ ...draft.entity }) } : {}),
    since,
    actionKinds: Object.freeze([...(draft.actionKinds ?? (draft.href ? ['open' as const] : []))]),
    notify: Object.freeze({
      policy,
      dedupeKey:
        draft.notify?.dedupeKey ?? (draft.entity ? `${draft.code}:${draft.entity.id}` : draft.code),
      ...(draft.notify?.kind ? { kind: draft.notify.kind } : {}),
    }),
    source: draft.source ?? 'rule',
  });
}

function partialFinding(failed: readonly string[]): Finding {
  return Object.freeze({
    code: PARTIAL_CODE,
    rule: PARTIAL_CODE,
    severity: 'info',
    advisory: false,
    title: `Some checks could not run (${failed.length})`,
    detail:
      `${failed.join(', ')} failed this time, so whatever they would report is missing from this ` +
      'list. Everything else here is current; the checks run again on the next visit.',
    facts: Object.freeze({ failedRules: failed.join(',') }),
    href: fixHref.health(),
    since: null,
    actionKinds: Object.freeze([]),
    notify: Object.freeze({ policy: NOTIFY_NEVER, dedupeKey: PARTIAL_CODE }),
    source: 'rule',
  });
}

async function evaluate(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  now: Date,
  rules: readonly DiagnosticRule[],
): Promise<DiagnosticsReport> {
  const env = createDiagnosticsEnv(ctx, now);
  const results = await Promise.all(
    rules.map(async (rule) => {
      try {
        const drafts = await rule.evaluate(env);
        return { rule, findings: drafts.map((d) => normalize(rule, d)) };
      } catch (error) {
        return { rule, error };
      }
    }),
  );

  const ordered: Array<{ finding: Finding; order: number }> = [];
  const failedRules: string[] = [];
  results.forEach((r, ruleIndex) => {
    if ('error' in r) {
      failedRules.push(r.rule.id);
      const { name, message } = describeError(r.error);
      console.error(
        `[diagnostics] rule ${r.rule.id} failed for workspace=${ctx.workspaceId}: ${name}: ${message}`,
      );
      return;
    }
    r.findings.forEach((finding, i) => ordered.push({ finding, order: ruleIndex * 1000 + i }));
  });
  if (failedRules.length > 0) {
    ordered.push({ finding: partialFinding(failedRules), order: Number.MAX_SAFE_INTEGER });
  }
  ordered.sort((a, b) => compareFindings(a.finding, b.finding) || a.order - b.order);
  const findings = ordered.map((o) => o.finding);
  return {
    workspaceId: ctx.workspaceId,
    evaluatedAt: now,
    findings,
    score: scoreFindings(findings),
    failedRules,
    partial: failedRules.length > 0,
  };
}

/** The workspace's findings and score right now. Read-only; any member. */
export function getWorkspaceDiagnostics(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  options: DiagnosticsOptions = {},
): Promise<DiagnosticsReport> {
  const key = ctx.workspaceId.toString();
  const seam = options.now !== undefined || options.rules !== undefined;
  if (!seam && !options.fresh) {
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < DIAGNOSTICS_MEMO_TTL_MS) return hit.report;
  }
  const report = evaluate(ctx, options.now ?? new Date(), options.rules ?? DIAGNOSTIC_RULES);
  if (!seam) {
    memo.delete(key);
    memo.set(key, { at: Date.now(), report });
    // A failed evaluation is never served from the memo.
    report.catch(() => {
      if (memo.get(key)?.report === report) memo.delete(key);
    });
    while (memo.size > MEMO_MAX_WORKSPACES) {
      const oldest = memo.keys().next().value;
      if (oldest === undefined) break;
      memo.delete(oldest);
    }
  }
  return report;
}

/** Drop the memo for a workspace after a change the next read must see
 *  (the health settings, a manual check). */
export function invalidateDiagnostics(workspaceId: bigint): void {
  memo.delete(workspaceId.toString());
}

/** Tests: forget every memoised result (truncateAll calls it: workspace
 *  ids restart at 1 after a truncate). */
export function _resetDiagnosticsMemoForTests(): void {
  memo.clear();
}
