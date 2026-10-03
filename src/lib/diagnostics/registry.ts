// AP-06: THE list of diagnostic rules, in display order within a severity
// (the engine sorts most severe first and keeps this order inside one).
// Adding a rule: README.md, "Contributing a rule".

import type { DiagnosticRule } from './rule';
import {
  goLiveRule,
  holdsRule,
  outreachPausedRule,
  ownerRule,
  platformStopRule,
  autopilotStateRule,
} from './rules/automation';
import {
  mailboxFailingRule,
  mailboxNoneRule,
  mailboxPausedRule,
  queueFailedRule,
  sendCapRule,
  suppressionSpikeRule,
} from './rules/mail';
import { jobsStaleRule, opsIncidentsRule } from './rules/ops';
import { recordsUnqualifiedRule, rulesFallbackRule } from './rules/qualification';
import {
  knowledgeIndexFailedRule,
  learningUnfedRule,
  planLimitsRule,
  productsNoneRule,
  recipesNoCountryRule,
  runsFailedRule,
  runsZeroResultsRule,
  searchMockRule,
  tokensEmptyRule,
} from './rules/setup';
import {
  draftsBlockedRule,
  draftsStaleRule,
  followUpsPendingRule,
  reviewBacklogRule,
  reviewNoiseRule,
} from './rules/work';

export const DIAGNOSTIC_RULES: readonly DiagnosticRule[] = Object.freeze([
  // What stops everything
  platformStopRule,
  ownerRule,
  outreachPausedRule,
  holdsRule,
  tokensEmptyRule,
  // Mail
  mailboxFailingRule,
  mailboxNoneRule,
  suppressionSpikeRule,
  queueFailedRule,
  // Discovery and setup
  searchMockRule,
  productsNoneRule,
  recipesNoCountryRule,
  runsFailedRule,
  runsZeroResultsRule,
  recordsUnqualifiedRule,
  rulesFallbackRule,
  reviewNoiseRule,
  knowledgeIndexFailedRule,
  autopilotStateRule,
  // Operations
  opsIncidentsRule,
  jobsStaleRule,
  // Waiting work and context
  reviewBacklogRule,
  draftsBlockedRule,
  draftsStaleRule,
  followUpsPendingRule,
  sendCapRule,
  mailboxPausedRule,
  goLiveRule,
  planLimitsRule,
  learningUnfedRule,
]);

/** Rule ids are unique (the notify ledger and stored reports key on them). */
export function assertUniqueRuleIds(rules: readonly DiagnosticRule[]): void {
  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.id)) throw new Error(`diagnostics: duplicate rule id "${r.id}"`);
    seen.add(r.id);
  }
}
