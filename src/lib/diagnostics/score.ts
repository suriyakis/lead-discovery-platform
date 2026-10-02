// AP-06: the calibrated health score. Pure.
//
//   100 − Σ over rules (codes) of the rule's worst severity:
//       critical 25, warning 10, info 0; advisory findings cost nothing.
//
// A rule costs once whatever its finding count: two failing mailboxes are
// one critical problem area, not a score of 50, and one noisy rule cannot
// drive a workspace to 0 on its own. Calibration (fixture-tested in
// src/tests/diagnostics.test.ts): a healthy trial workspace scores ≥ 90;
// the production-shaped fixture scores 20.
//
// The weekly report blends the AI conversation review in exactly as before
// AP-06: 60% rules, 40% the average naturalness, only when a review ran.

import { SEVERITY_PENALTY, type Finding } from './types';

export function scoreFindings(
  findings: ReadonlyArray<Pick<Finding, 'code' | 'severity' | 'advisory'>>,
): number {
  const worst = new Map<string, number>();
  for (const f of findings) {
    if (f.advisory) continue;
    const penalty = SEVERITY_PENALTY[f.severity];
    worst.set(f.code, Math.max(worst.get(f.code) ?? 0, penalty));
  }
  let score = 100;
  for (const p of worst.values()) score -= p;
  return Math.max(0, Math.min(100, score));
}

export function blendConversationReview(
  ruleScore: number,
  naturalness: ReadonlyArray<number>,
): number {
  if (naturalness.length === 0) return ruleScore;
  const avg = naturalness.reduce((a, n) => a + n, 0) / naturalness.length;
  return Math.max(0, Math.min(100, Math.round(ruleScore * 0.6 + avg * 0.4)));
}
