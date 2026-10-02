// AP-06: the rule contract (README.md explains it in prose).

import type { DiagnosticsEnv } from './env';
import type { FindingDraft, RuleOwner } from './types';

export interface DiagnosticRule {
  /**
   * The rule's id, which is also the `code` of every finding it returns —
   * except the ops-incident rule, whose findings are `ops.<kind>`. Unique
   * in the registry; stable (the notify ledger and stored reports key on
   * it).
   */
  readonly id: string;
  /** The workstream that owns it; their PRs change it. */
  readonly owner: RuleOwner;
  /** One line: what it looks at. Shown in README.md and on /health. */
  readonly summary: string;
  /**
   * Read-only: no writes, no AI, no network. Throwing is allowed — the
   * engine isolates it (`diagnostics.partial`) — but returning [] for "no
   * problem" is the norm. Every time window is measured from `env.now`
   * with gte()/lt() builders (never a JS Date inside raw sql).
   */
  evaluate(env: DiagnosticsEnv): Promise<FindingDraft[]>;
}

export function defineRule(rule: DiagnosticRule): DiagnosticRule {
  return Object.freeze(rule);
}
