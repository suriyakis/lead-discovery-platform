// Remediation 2026-10-funnel, mail module (flow:F-06). See ../README.md.
export * from './types';
export {
  buildMailPlan,
  brandStem,
  notificationThreadId,
  ownDomainMatcher,
  planHashInput,
} from './plan';
export {
  decisionTargets,
  renderDecisionsCsv,
  resolveDecisions,
  DECISIONS_HEADER,
} from './decisions';
export { applyMailPlan, assertMailReport, APPLY_ORDER, type ApplyResult } from './apply';
export { renderApplyMarkdown, renderPlanMarkdown, renderRevertMarkdown } from './report';
