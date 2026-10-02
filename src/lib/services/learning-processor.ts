// The learning processor (KL-03): learning.process and learning.sweep.
//
// recordDecision (learning-decisions.ts) writes an operator decision's
// events as 'pending' inside the decision's own transaction — the outbox.
// This module drains it, off the request (I108):
//
// learning.process {decisionId}
//   1. CLAIM the decision's due 'pending' events by a conditional UPDATE
//      (status 'processing', attempts + 1, claimed_at = the claim token).
//      Two workers can never hold the same event.
//   2. PLAN, outside any transaction: which events can teach a rule.
//      ONE AI extraction per decision (I032); a bulk decision gets one per
//      product-group x polarity with at most 10 sampled records. An
//      extraction runs only when the decision has a note, a generalisable
//      reason chip, an AI/operator disagreement or an autopilot override —
//      an agreement teaches through the ledger, not through a new rule. No
//      tokens or no AI provider: the events wait ('skipped_no_tokens') and
//      the sweeper resumes them; nothing is minted by a heuristic (the
//      cited-rule reinforcement below needs no AI and is applied anyway).
//   3. WRITE, in one transaction that re-locks the claimed events and
//      checks the claim is still ours:
//        - compensate the events this decision voided (ledger + retire the
//          rules learned only from them);
//        - the rule: a new one (source 'decision', scoped to every product
//          sharing the verdict), or +5 on the active rule it repeats, or
//          nothing when it repeats a rule the operator rejected or switched
//          off (disabled). Scope is never widened implicitly: an UNSCOPED event (no
//          relevant product, no explicit choice) speaks for the products
//          the record was qualified against (its context snapshot) — with
//          none left, the rule is only PROPOSED and "Needs a scope". Only
//          an explicit "every product" comment makes a workspace rule;
//        - reinforcement of the rules the AI cited (operator, method 'ai',
//          at or above the threshold), via the ledger;
//        - every claimed event closed: done | no_rule | below_floor |
//          skipped_no_tokens | skipped, with a processing_note.
//      A job killed anywhere before the commit leaves nothing behind; one
//      killed after it has nothing left to do. Re-runs are idempotent
//      (claims, the ledger's UNIQUE(event, rule), the extracted_lesson_id
//      link).
//   4. FAIL: the claimed events go back to 'pending' with exponential
//      backoff (2, 4, 8, 16 minutes); after 5 attempts they are 'failed'
//      and the workspace gets ONE 'learning.failed' notification per day.
//
// learning.sweep (repeatable, every 2 minutes, every active workspace)
//   - releases claims older than 10 minutes (a killed worker);
//   - compensates voided events nobody compensated (catch-all);
//   - re-queues 'skipped_no_tokens' events once the wallet and an AI
//     provider are back;
//   - re-enqueues learning.process for 'pending' events whose job was lost
//     (older than 2 minutes) or whose backoff has passed.
// It works the same on the memory and the BullMQ queue: it only enqueues.

import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { getAIProviderForCtx, type IAIProvider } from '@/lib/ai';
import { db } from '@/lib/db/client';
import type { IJobQueue } from '@/lib/jobs';
import {
  learningDecisions,
  learningEvents,
  learningLessons,
  lessonReinforcements,
  type LearningDecision,
  type LearningEvent,
  type LearningLesson,
  type LearningProcessingStatus,
  type LessonLifecycle,
} from '@/lib/db/schema/learning';
import { notifications } from '@/lib/db/schema/notifications';
import { productProfiles } from '@/lib/db/schema/products';
import { workspaces } from '@/lib/db/schema/workspaces';
import { recordAuditEvent } from './audit';
import { makeWorkspaceContext, type WorkspaceContext } from './context';
import type { LessonPolarity } from './learning-categories';
import { generalisableChips, reasonChipLabel } from './learning-chips';
import {
  DecisionContextSchema,
  LEARNING_PROCESS_JOB,
  MIN_TEACHABLE_TEXT,
  stripMentions,
  type DecisionContext,
  type DecisionProductSnapshot,
  type LearningProcessPayload,
} from './learning-decisions';
import {
  EXTRACTED_CONFIDENCE_CEILING,
  MAX_SAMPLED_CONTEXTS,
  TEXTLESS_RULE_CONFIDENCE,
  extractRule,
  type ExtractedRule,
  type ExtractionRecord,
  type ExtractionRequest,
} from './learning-extraction';
import {
  DEDUP_MATCH_STEP,
  applyForwardEntries,
  compensateVoidedEvents,
  verdictReinforcementDelta,
  type CitationEffect,
  type ForwardEntry,
} from './learning-ledger';
import {
  NEEDS_SCOPE,
  findNearDuplicateLesson,
  findRejectedRuleMatch,
  insertLessonWithScope,
  scheduleLessonEmbedding,
  type LearningTx,
  type NormalizedScope,
} from './learning';
import { notify } from './notifications';
import { hasTokens } from './token-ledger';

export const LEARNING_SWEEP_JOB = 'learning.sweep';
export const LEARNING_SWEEP_TICK_MS = 2 * 60 * 1000;
export const MAX_LEARNING_ATTEMPTS = 5;
/** A 'pending' event with no backoff older than this lost its job. */
export const LOST_JOB_AFTER_MS = 2 * 60 * 1000;
/** A 'processing' claim older than this belongs to a dead worker. */
export const STALE_CLAIM_AFTER_MS = 10 * 60 * 1000;
const SWEEP_BATCH = 200;

/** Why an event was closed the way it was (learning_events.processing_note). */
export const LEARNING_PROCESSING_NOTES = [
  'rule_created',
  'rule_created_from_verdict',
  /** An unscoped event whose record was qualified against no (existing)
   *  product: the rule is 'proposed' and "Needs a scope" (KL-03). */
  'rule_proposed_needs_scope',
  'rule_strengthened',
  'matches_rejected_rule',
  /** Repeats a rule the operator switched off (lifecycle 'disabled'): not
   *  recreated as an active copy (Disable is the operator's no until
   *  KL-12's "Not what I meant" retires a rule as operator_rejected). */
  'matches_disabled_rule',
  'nothing_to_learn',
  'other_direction',
  'below_floor',
  'products_deleted',
  'no_tokens',
  'no_ai_provider',
  'voided',
  'machine',
  'failed',
] as const;
export type LearningProcessingNote =
  | (typeof LEARNING_PROCESSING_NOTES)[number]
  | `rejected:${string}`;

export interface ProcessDecisionResult {
  claimed: number;
  /** The rule created or strengthened (the first, for a bulk decision). */
  lessonId: bigint | null;
  lessonIds: bigint[];
  dedupReinforced: boolean;
  /** Cited-rule ledger rows written. */
  reinforcedRules: number;
  compensated: number;
  retired: bigint[];
  statuses: Partial<Record<LearningProcessingStatus, number>>;
  error: string | null;
}

class ClaimLostError extends Error {
  constructor() {
    super('the claim on these learning events was released and taken by another run');
    this.name = 'ClaimLostError';
  }
}

// ---- the gate ------------------------------------------------------------------

export type LearningGate =
  | { ok: true; provider: IAIProvider }
  | { ok: false; reason: 'no_tokens' | 'no_ai_provider' };

/**
 * May the workspace spend an AI call on learning right now? Needs tokens
 * and a real AI provider (the mock cannot extract rules). When not, events
 * that need an extraction wait as 'skipped_no_tokens' and the sweeper
 * resumes them.
 */
export async function learningGate(ctx: WorkspaceContext): Promise<LearningGate> {
  if (!(await hasTokens(ctx))) return { ok: false, reason: 'no_tokens' };
  let provider: IAIProvider;
  try {
    provider = await getAIProviderForCtx(ctx, 'ai.learning_extract');
  } catch {
    return { ok: false, reason: 'no_ai_provider' };
  }
  if (provider.id === 'mock') return { ok: false, reason: 'no_ai_provider' };
  return { ok: true, provider };
}

// ---- planning --------------------------------------------------------------------

interface EventFacts {
  event: LearningEvent;
  context: DecisionContext | null;
  product: DecisionProductSnapshot | null;
  /** The AI's verdict on the product counts: method 'ai' and, when it
   *  said relevant, at or above the threshold (§5). */
  aiAvailable: boolean;
  disagreement: boolean;
  override: boolean;
  /** An explicit "every product" choice (a comment posted with
   *  appliesTo 'workspace'): the only way to a workspace-wide rule. */
  workspaceWide: boolean;
  /** For an UNSCOPED event (no product, no explicit choice): the products
   *  the record was qualified against when it was decided. What the
   *  decision teaches is scoped to them — never widened to the workspace. */
  candidates: DecisionProductSnapshot[];
  /** The candidates whose available AI verdict the operator's direction
   *  contradicts (e.g. an approve of a record the AI judged not relevant
   *  for them: a false_negative, §5) — the scope of a verdict-only rule. */
  disagreeing: DecisionProductSnapshot[];
}

/** The AI verdict counts as the AI's view (§5): method 'ai' and, when it
 *  said relevant, at or above the threshold. */
function aiCounts(p: DecisionProductSnapshot | null | undefined): boolean {
  const ai = p?.ai ?? null;
  return !!ai && ai.method === 'ai' && !ai.belowThreshold;
}

const DISMISSAL_KINDS = new Set(['review.ignore', 'review.archive']);
const VERB: Record<string, string> = {
  'review.approve': 'APPROVED',
  'review.reject': 'REJECTED',
  'review.ignore': 'IGNORED',
  'review.archive': 'ARCHIVED',
};

function factsOf(event: LearningEvent, dismissal: boolean): EventFacts {
  const parsed = DecisionContextSchema.safeParse(event.context);
  const context = parsed.success ? parsed.data : null;
  const scoped = event.productProfileId !== null;
  const product =
    context && scoped
      ? (context.products.find((p) => p.id === event.productProfileId!.toString()) ?? null)
      : null;
  const aiAvailable = aiCounts(product);
  // An event with no product and an explicit choice is the operator's
  // "every product"; without the choice it is unscoped.
  const workspaceWide = !scoped && event.explicit;
  const candidates = scoped || workspaceWide ? [] : (context?.products ?? []);
  const direction = event.verdict !== null ? event.verdict === 'fit' : event.polarity > 0;
  const directional = event.verdict !== null || (!scoped && event.polarity !== 0);
  const disagreeing =
    dismissal || !directional
      ? []
      : candidates.filter((p) => aiCounts(p) && p.ai!.relevant !== direction);
  const disagreement = scoped
    ? !dismissal && aiAvailable && event.verdict !== null && direction !== product!.ai!.relevant
    : disagreeing.length > 0;
  return {
    event,
    context,
    product,
    aiAvailable,
    disagreement,
    override: event.overridesAutopilot,
    workspaceWide,
    candidates,
    disagreeing,
  };
}

type Trigger = 'note' | 'chips' | 'override' | 'disagreement';

interface ExtractionGroup {
  events: EventFacts[];
  instruction: boolean;
  trigger: Trigger | null;
  /** No note and no chip: the rule is a guess at the operator's why. */
  textless: boolean;
  polarities: LessonPolarity[];
  chips: string[];
  note: string | null;
}

function distinct<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

function verdictPolarity(e: LearningEvent): LessonPolarity {
  return e.polarity > 0 ? 1 : e.polarity < 0 ? -1 : 0;
}

/**
 * Split a decision's live events into extraction groups: one for a single
 * record (whatever the number of products), one per product-set x polarity
 * for a bulk decision. Each group knows whether it may teach a rule and in
 * which directions.
 */
function planGroups(
  decision: LearningDecision,
  live: EventFacts[],
  reasonText: string | null,
  reasonCodes: readonly string[],
): ExtractionGroup[] {
  if (live.length === 0) return [];
  const instruction = decision.kind === 'review.comment';
  const subjects = distinct(live.map((f) => f.event.entityId ?? ''));
  const buckets: EventFacts[][] = [];
  if (instruction || subjects.length <= 1) {
    buckets.push(live);
  } else {
    const byKey = new Map<string, EventFacts[]>();
    for (const p of [1, -1] as const) {
      for (const subject of subjects) {
        const mine = live.filter(
          (f) => (f.event.entityId ?? '') === subject && verdictPolarity(f.event) === p,
        );
        if (mine.length === 0) continue;
        const productKey = distinct(mine.map((f) => f.event.productProfileId?.toString() ?? '*'))
          .sort()
          .join(',');
        const key = `${p}|${productKey}`;
        byKey.set(key, [...(byKey.get(key) ?? []), ...mine]);
      }
    }
    buckets.push(...byKey.values());
  }

  const text = reasonText ? stripMentions(reasonText) : '';
  const note = text.length >= MIN_TEACHABLE_TEXT ? text : null;
  return buckets.map((events) => {
    const verdictPolarities = instruction
      ? ([1, -1, 0] as LessonPolarity[])
      : distinct(events.map((f) => verdictPolarity(f.event))).filter((p) => p !== 0);
    const chips = instruction
      ? generalisableChips(reasonCodes)
      : generalisableChips(reasonCodes, verdictPolarities);
    const base = { events, instruction, chips: chips.map((c) => reasonChipLabel(c) ?? c), note };
    if (note || chips.length > 0) {
      return {
        ...base,
        trigger: note ? 'note' : 'chips',
        textless: false,
        polarities: verdictPolarities,
      } satisfies ExtractionGroup;
    }
    const triggers = instruction ? [] : events.filter((f) => f.override || f.disagreement);
    if (triggers.length > 0) {
      return {
        ...base,
        trigger: triggers.some((f) => f.override) ? 'override' : 'disagreement',
        textless: true,
        polarities: distinct(triggers.map((f) => verdictPolarity(f.event))).filter((p) => p !== 0),
      } satisfies ExtractionGroup;
    }
    return { ...base, trigger: null, textless: false, polarities: [] } satisfies ExtractionGroup;
  });
}

function cleanName(p: DecisionProductSnapshot | null | undefined): string {
  return p?.name?.replace(/\s+/g, ' ').trim().slice(0, 120) || 'a product';
}

function productName(f: EventFacts): string {
  return cleanName(f.product);
}

function joinNames(names: readonly string[]): string {
  const list = distinct(names);
  if (list.length <= 1) return list[0] ?? 'a product';
  return `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

function nameList(facts: readonly EventFacts[]): string {
  return joinNames(facts.map(productName));
}

/** The products the unscoped events among `facts` were qualified against. */
function candidateNames(facts: readonly EventFacts[]): string | null {
  const names = facts.flatMap((f) => f.candidates.map(cleanName));
  return names.length > 0 ? joinNames(names) : null;
}

/** What the operator did, in plain sentences, from trusted data only. */
function statementsFor(decision: LearningDecision, group: ExtractionGroup): string[] {
  const subjects = distinct(group.events.map((f) => f.event.entityId ?? ''));
  const what = subjects.length > 1 ? `${subjects.length} records` : 'this record';
  if (group.instruction) {
    const scoped = group.events.filter((f) => f.event.productProfileId !== null);
    const unscoped = group.events.filter(
      (f) => f.event.productProfileId === null && !f.workspaceWide,
    );
    const checked = candidateNames(unscoped);
    const target = group.events.some((f) => f.workspaceWide)
      ? 'every product'
      : scoped.length > 0
        ? nameList(scoped)
        : checked
          ? `the products it was checked against (${checked})`
          : 'a product the operator has not chosen yet';
    return [`The operator wrote a note about ${what}; it applies to ${target}.`];
  }
  const out: string[] = [];
  const fit = group.events.filter((f) => verdictPolarity(f.event) > 0);
  const notFit = group.events.filter((f) => verdictPolarity(f.event) < 0);
  const scopedFit = fit.filter((f) => f.event.productProfileId !== null);
  const scopedNot = notFit.filter((f) => f.event.productProfileId !== null);
  const checkedFit = candidateNames(fit.filter((f) => f.event.productProfileId === null));
  const checkedNot = candidateNames(notFit.filter((f) => f.event.productProfileId === null));
  if (fit.length > 0) {
    out.push(
      scopedFit.length > 0
        ? `The operator APPROVED ${what} for ${nameList(scopedFit)}.`
        : checkedFit
          ? `The operator APPROVED ${what} without choosing a product; it had been checked against ${checkedFit}.`
          : `The operator APPROVED ${what}; it was not matched to any product.`,
    );
  }
  if (notFit.length > 0) {
    const verb = VERB[decision.kind] ?? 'REJECTED';
    const forWhat =
      scopedNot.length > 0
        ? ` for ${nameList(scopedNot)}`
        : checkedNot
          ? ` (it had been checked against ${checkedNot})`
          : '';
    if (decision.kind === 'review.approve') {
      out.push(`The operator marked ${what} NOT A FIT${forWhat}.`);
    } else if (DISMISSAL_KINDS.has(decision.kind)) {
      out.push(`The operator ${verb} ${what} as not a fit${forWhat}.`);
    } else {
      out.push(`The operator ${verb} ${what}${forWhat}.`);
    }
  }
  const overrides = group.events.filter((f) => f.override);
  if (overrides.length > 0) {
    out.push(`Autopilot had approved it for ${nameList(overrides)}; the operator overturned that.`);
  }
  const disagreements = group.events.filter((f) => f.disagreement);
  if (disagreements.length > 0 && subjects.length <= 1) {
    for (const f of disagreements) {
      if (f.product) {
        out.push(
          `The AI had judged it ${f.product.ai!.relevant ? 'relevant' : 'not relevant'} for ${productName(f)}; the operator disagreed.`,
        );
        continue;
      }
      for (const relevant of [true, false]) {
        const names = f.disagreeing.filter((p) => p.ai!.relevant === relevant).map(cleanName);
        if (names.length === 0) continue;
        out.push(
          `The AI had judged it ${relevant ? 'relevant' : 'not relevant'} for ${joinNames(names)}; the operator disagreed.`,
        );
      }
    }
  } else if (disagreements.length > 0) {
    out.push("For some of these records the AI's verdict differed from the operator's.");
  }
  return out;
}

/** Up to MAX_SAMPLED_CONTEXTS records, evenly spread, in subject order. */
function sampleRecords(group: ExtractionGroup): { records: ExtractionRecord[]; total: number } {
  const bySubject = new Map<string, EventFacts[]>();
  for (const f of group.events) {
    const key = f.event.entityId ?? '';
    bySubject.set(key, [...(bySubject.get(key) ?? []), f]);
  }
  const subjects = [...bySubject.keys()].sort((a, b) =>
    a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0,
  );
  const total = subjects.length;
  const picks =
    total <= MAX_SAMPLED_CONTEXTS
      ? subjects
      : Array.from(
          { length: MAX_SAMPLED_CONTEXTS },
          (_, i) => subjects[Math.floor((i * total) / MAX_SAMPLED_CONTEXTS)]!,
        );
  const records = picks.map((subject) => {
    const facts = bySubject.get(subject)!;
    const record = facts.find((f) => f.context?.record)?.context?.record ?? null;
    // A scoped event's product; an unscoped one's qualified-against
    // products (the verdicts the operator's decision answered).
    const seen = new Set<string>();
    const aiVerdicts = facts
      .flatMap((f) => (f.product ? [f.product] : f.candidates))
      .filter((p) => p.ai && !seen.has(p.id) && seen.add(p.id))
      .map((p) => ({
        product: cleanName(p),
        relevant: p.ai!.relevant,
        score: p.ai!.score,
        threshold: p.ai!.threshold,
        method: p.ai!.method,
        reason: p.ai!.reason,
      }));
    return {
      title: record?.title ?? null,
      domain: record?.domain ?? null,
      snippet: record?.snippet ?? null,
      aiVerdicts,
    };
  });
  return { records, total };
}

type GroupOutcome =
  | { kind: 'none'; group: ExtractionGroup }
  | { kind: 'waiting'; group: ExtractionGroup; note: 'no_tokens' | 'no_ai_provider' }
  | { kind: 'below_floor'; group: ExtractionGroup }
  | { kind: 'rejected'; group: ExtractionGroup; note: `rejected:${string}` }
  | { kind: 'no_scope'; group: ExtractionGroup }
  | {
      kind: 'rule';
      group: ExtractionGroup;
      rule: ExtractedRule;
      confidence: number;
      targets: EventFacts[];
      /** NEEDS_SCOPE (products, none) for a proposed rule. */
      scope: NormalizedScope;
      /** 'proposed' when the scope could not be inferred (an unscoped
       *  record qualified against no existing product). */
      lifecycle: Extract<LessonLifecycle, 'active' | 'proposed'>;
      duplicate: LearningLesson | null;
      rejectedTwin: LearningLesson | null;
    };

async function existingProducts(ctx: WorkspaceContext, ids: readonly bigint[]): Promise<bigint[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: productProfiles.id })
    .from(productProfiles)
    .where(
      and(eq(productProfiles.workspaceId, ctx.workspaceId), inArray(productProfiles.id, [...ids])),
    );
  return rows.map((r) => r.id);
}

/** Outside any transaction: the AI call and the dedup lookups. */
async function resolveGroup(
  ctx: WorkspaceContext,
  decision: LearningDecision,
  group: ExtractionGroup,
  gate: () => Promise<LearningGate>,
): Promise<GroupOutcome> {
  if (!group.trigger || group.polarities.length === 0) return { kind: 'none', group };
  const g = await gate();
  if (!g.ok) return { kind: 'waiting', group, note: g.reason };

  const { records, total } = sampleRecords(group);
  const request: ExtractionRequest = {
    statements: statementsFor(decision, group),
    chips: group.chips,
    note: group.note,
    records,
    recordCount: total,
    polarities: group.polarities,
  };
  const verdict = await extractRule(g.provider, request);
  if (verdict.kind === 'rejected')
    return { kind: 'rejected', group, note: `rejected:${verdict.reason}` };
  if (verdict.kind === 'below_floor') return { kind: 'below_floor', group };

  const rule = verdict.rule;
  // The rule speaks for every product whose verdict points its way (an
  // instruction: for every product it was written for).
  const targets = group.instruction
    ? group.events
    : group.events.filter((f) => verdictPolarity(f.event) === rule.polarity);
  if (targets.length === 0) return { kind: 'rejected', group, note: 'rejected:polarity_mismatch' };
  const resolved = await resolveScope(ctx, targets, group.textless);
  if (!resolved) return { kind: 'no_scope', group };
  const { scope, lifecycle } = resolved;
  const confidence = group.textless
    ? TEXTLESS_RULE_CONFIDENCE
    : Math.min(rule.confidence, EXTRACTED_CONFIDENCE_CEILING);
  const duplicate = await findNearDuplicateLesson(ctx, {
    category: rule.category,
    rule: rule.rule,
    polarity: rule.polarity,
    scope,
    // A proposed "Needs a scope" rule repeats an earlier proposed one.
    lifecycles: lifecycle === 'proposed' ? ['proposed'] : ['active'],
  });
  const rejectedTwin = duplicate
    ? null
    : await findRejectedRuleMatch(ctx, {
        category: rule.category,
        rule: rule.rule,
        polarity: rule.polarity,
        scope,
      });
  return {
    kind: 'rule',
    group,
    rule,
    confidence,
    targets,
    scope,
    lifecycle,
    duplicate,
    rejectedTwin,
  };
}

/**
 * Where a rule learned from these target events applies. Never wider than
 * the decision said (I032, contract §2.3 / §5):
 *   - a scoped event speaks for its product;
 *   - an explicit "every product" comment, and only that, for the
 *     workspace;
 *   - an UNSCOPED event (no relevant product, no explicit choice) for the
 *     products the record was qualified against — for a verdict-only rule
 *     just those whose AI verdict the operator contradicted.
 * Products deleted since are dropped. Nothing left: null (no rule) when
 * every target named its products, or a PROPOSED rule that "Needs a scope"
 * when the scope had to be inferred — the operator chooses it on /learning.
 */
async function resolveScope(
  ctx: WorkspaceContext,
  targets: readonly EventFacts[],
  textless: boolean,
): Promise<{ scope: NormalizedScope; lifecycle: 'active' | 'proposed' } | null> {
  if (targets.some((f) => f.workspaceWide)) {
    return { scope: { kind: 'workspace', productProfileIds: [] }, lifecycle: 'active' };
  }
  const wanted = new Set<string>();
  let inferred = false;
  for (const f of targets) {
    if (f.event.productProfileId !== null) {
      wanted.add(f.event.productProfileId.toString());
      continue;
    }
    inferred = true;
    for (const p of textless ? f.disagreeing : f.candidates) wanted.add(p.id);
  }
  const ids = [...wanted].filter((s) => /^\d{1,19}$/.test(s)).map((s) => BigInt(s));
  const found = (await existingProducts(ctx, ids)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (found.length > 0) {
    return { scope: { kind: 'products', productProfileIds: found }, lifecycle: 'active' };
  }
  return inferred ? { scope: NEEDS_SCOPE, lifecycle: 'proposed' } : null;
}

/** Rules a product verdict cited, with the direction each argued. Without
 *  KL-04's explicit effects: citedLessonIds, else matchedLessonIds (which
 *  KL-04 keeps equal to the cited ids), with the effect read from the
 *  rule's polarity. */
function citationsOf(
  product: DecisionProductSnapshot,
): Array<{ id: bigint; effect: CitationEffect | null }> {
  const ai = product.ai;
  if (!ai) return [];
  const isId = (v: string) => /^\d{1,19}$/.test(v);
  if (ai.citedLessons && ai.citedLessons.length > 0) {
    const seen = new Set<string>();
    return ai.citedLessons
      .filter((c) => isId(c.id) && !seen.has(c.id) && seen.add(c.id))
      .map((c) => ({ id: BigInt(c.id), effect: c.effect }));
  }
  const ids = ai.citedLessonIds.length > 0 ? ai.citedLessonIds : ai.matchedLessonIds;
  return distinct(ids.filter(isId)).map((id) => ({ id: BigInt(id), effect: null }));
}

// ---- the job ---------------------------------------------------------------------

interface Closure {
  status: LearningProcessingStatus;
  note: LearningProcessingNote;
  lessonId: bigint | null;
}

/**
 * Work one decision's outbox rows (the learning.process job). See the
 * module header. Never throws; the result says what happened.
 */
export async function processDecision(
  ctx: WorkspaceContext,
  decisionId: string,
  opts: { now?: Date } = {},
): Promise<ProcessDecisionResult> {
  const now = opts.now ?? new Date();
  const result: ProcessDecisionResult = {
    claimed: 0,
    lessonId: null,
    lessonIds: [],
    dedupReinforced: false,
    reinforcedRules: 0,
    compensated: 0,
    retired: [],
    statuses: {},
    error: null,
  };
  const claimToken = now;
  const claimed = await db
    .update(learningEvents)
    .set({
      processingStatus: 'processing',
      attempts: sql`${learningEvents.attempts} + 1`,
      nextAttemptAt: null,
      claimedAt: claimToken,
    })
    .where(
      and(
        eq(learningEvents.workspaceId, ctx.workspaceId),
        eq(learningEvents.decisionId, decisionId),
        eq(learningEvents.processingStatus, 'pending'),
        or(isNull(learningEvents.nextAttemptAt), lte(learningEvents.nextAttemptAt, now)),
      ),
    )
    .returning();
  result.claimed = claimed.length;
  if (claimed.length === 0) return result;

  try {
    const [decision] = await db
      .select()
      .from(learningDecisions)
      .where(
        and(
          eq(learningDecisions.workspaceId, ctx.workspaceId),
          eq(learningDecisions.id, decisionId),
        ),
      );
    if (!decision) throw new Error(`learning decision ${decisionId} not found`);
    const dismissal = DISMISSAL_KINDS.has(decision.kind);
    const facts = claimed.map((e) => factsOf(e, dismissal));
    const live = facts.filter((f) => f.event.voidedAt === null && f.event.origin === 'operator');
    const reasonText = live.find((f) => f.event.originalComment)?.event.originalComment ?? null;
    const reasonCodes = live[0]?.event.reasonCodes ?? [];
    // An event already linked to a rule was learned from by a committed
    // run; it is never extracted twice.
    const unlearned = live.filter((f) => f.event.extractedLessonId === null);

    // ---- plan + extract (outside the transaction) ----
    const groups = planGroups(decision, unlearned, reasonText, reasonCodes);
    let gateMemo: Promise<LearningGate> | null = null;
    const gate = () => (gateMemo ??= learningGate(ctx));
    const outcomes: GroupOutcome[] = [];
    for (const group of groups) outcomes.push(await resolveGroup(ctx, decision, group, gate));

    // ---- write (one transaction) ----
    const { newLessonIds, ...written } = await db.transaction((tx) =>
      writeOutcome(tx, ctx, decision, claimed, claimToken, outcomes, now),
    );
    Object.assign(result, written);
    for (const id of newLessonIds) scheduleLessonEmbedding(ctx, id);
    return result;
  } catch (err) {
    if (err instanceof ClaimLostError) {
      result.error = err.message;
      return result;
    }
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    console.error(`[learning-processor] processing ${decisionId} failed:`, message);
    result.error = message;
    await releaseAfterFailure(ctx, claimed, claimToken, message, now, result);
    return result;
  }
}

async function writeOutcome(
  tx: LearningTx,
  ctx: WorkspaceContext,
  decision: LearningDecision,
  claimed: readonly LearningEvent[],
  claimToken: Date,
  outcomes: readonly GroupOutcome[],
  now: Date,
): Promise<Omit<ProcessDecisionResult, 'claimed' | 'error'> & { newLessonIds: bigint[] }> {
  const claimedIds = claimed.map((e) => e.id);
  const rows = await tx
    .select()
    .from(learningEvents)
    .where(
      and(eq(learningEvents.workspaceId, ctx.workspaceId), inArray(learningEvents.id, claimedIds)),
    )
    .orderBy(asc(learningEvents.id))
    .for('update');
  const ours = rows.filter(
    (r) => r.processingStatus === 'processing' && r.claimedAt?.getTime() === claimToken.getTime(),
  );
  if (ours.length !== claimedIds.length) throw new ClaimLostError();
  const current = new Map(rows.map((r) => [r.id.toString(), r]));
  const isLive = (id: bigint) => {
    const r = current.get(id.toString());
    return !!r && r.voidedAt === null && r.origin === 'operator';
  };

  const closures = new Map<string, Closure>();
  const close = (id: bigint, c: Closure) => closures.set(id.toString(), c);
  for (const r of rows) {
    if (r.voidedAt !== null) close(r.id, { status: 'skipped', note: 'voided', lessonId: null });
    else if (r.origin !== 'operator')
      close(r.id, { status: 'skipped', note: 'machine', lessonId: null });
    else if (r.extractedLessonId !== null) {
      close(r.id, {
        status: 'done',
        note: (r.processingNote as LearningProcessingNote | null) ?? 'rule_created',
        lessonId: r.extractedLessonId,
      });
    }
  }
  // Cited rules move now even when the extraction waits for tokens: the
  // ledger's UNIQUE(event, rule) makes the resumed run skip them.
  const citations: Array<{ facts: EventFacts; id: bigint; effect: CitationEffect | null }> = [];
  const dismissal = DISMISSAL_KINDS.has(decision.kind);
  for (const e of claimed) {
    if (!isLive(e.id) || e.verdict === null) continue;
    const f = factsOf(e, dismissal);
    if (!f.aiAvailable || !f.product) continue;
    for (const c of citationsOf(f.product)) citations.push({ facts: f, ...c });
  }
  const duplicates = outcomes.flatMap((o) =>
    o.kind === 'rule' && o.duplicate ? [o.duplicate.id] : [],
  );

  // 1. Undo what the events this decision voided did (§6), locking — in one
  //    ascending pass — every rule this run may move: the compensated ones,
  //    the cited ones and the duplicates.
  const voidedByThese = await tx
    .select({ id: learningEvents.id })
    .from(learningEvents)
    .where(
      and(
        eq(learningEvents.workspaceId, ctx.workspaceId),
        inArray(learningEvents.voidedByEventId, claimedIds),
      ),
    );
  const compensation = await compensateVoidedEvents(
    tx,
    ctx,
    voidedByThese.map((r) => r.id),
    now,
    [...citations.map((c) => c.id), ...duplicates],
  );
  const locked = compensation.locked;

  // 2. Rules.
  const forward: ForwardEntry[] = [];
  const matchedBy = new Map<string, string>(); // event id -> rule it strengthened
  const newLessonIds: bigint[] = [];
  const lessonIds: bigint[] = [];
  let dedupReinforced = false;
  for (const o of outcomes) {
    const liveEvents = o.group.events.filter((f) => isLive(f.event.id));
    const closeAll = (status: LearningProcessingStatus, note: LearningProcessingNote) => {
      for (const f of liveEvents) close(f.event.id, { status, note, lessonId: null });
    };
    if (o.kind === 'none') {
      closeAll('no_rule', 'nothing_to_learn');
      continue;
    }
    if (o.kind === 'waiting') {
      closeAll('skipped_no_tokens', o.note);
      continue;
    }
    if (o.kind === 'below_floor') {
      closeAll('below_floor', 'below_floor');
      continue;
    }
    if (o.kind === 'rejected') {
      closeAll('no_rule', o.note);
      continue;
    }
    if (o.kind === 'no_scope') {
      closeAll('no_rule', 'products_deleted');
      continue;
    }
    const targets = o.targets.filter((f) => isLive(f.event.id));
    const targetIds = new Set(targets.map((f) => f.event.id.toString()));
    for (const f of liveEvents) {
      if (!targetIds.has(f.event.id.toString())) {
        close(f.event.id, { status: 'no_rule', note: 'other_direction', lessonId: null });
      }
    }
    if (targets.length === 0) continue;
    if (o.rejectedTwin) {
      const note: LearningProcessingNote =
        o.rejectedTwin.lifecycle === 'disabled' ? 'matches_disabled_rule' : 'matches_rejected_rule';
      for (const f of targets) close(f.event.id, { status: 'no_rule', note, lessonId: null });
      continue;
    }
    const dup = o.duplicate ? locked.get(o.duplicate.id.toString()) : undefined;
    let lessonId: bigint;
    let note: LearningProcessingNote;
    // Strengthen the rule this one repeats while it is still what dedup
    // matched: in service (or, for a proposed rule, still proposed).
    if (dup && dup.lifecycle === o.lifecycle) {
      lessonId = dup.id;
      note = 'rule_strengthened';
      dedupReinforced = true;
      // +5 once per decision, on a target event that has not credited this
      // rule yet (a resumed run may already have a cited row for it).
      const credited = await tx
        .select({ eventId: lessonReinforcements.eventId })
        .from(lessonReinforcements)
        .where(
          and(
            eq(lessonReinforcements.workspaceId, ctx.workspaceId),
            eq(lessonReinforcements.lessonId, lessonId),
            inArray(
              lessonReinforcements.eventId,
              targets.map((f) => f.event.id),
            ),
            isNull(lessonReinforcements.compensatesId),
          ),
        );
      const creditedIds = new Set(credited.map((c) => c.eventId.toString()));
      const carrier = targets.find((f) => !creditedIds.has(f.event.id.toString()));
      if (carrier) {
        forward.push({
          lessonId,
          eventId: carrier.event.id,
          kind: 'dedup_match',
          delta: DEDUP_MATCH_STEP,
          reason: 'dedup_match',
        });
      }
      for (const f of targets) matchedBy.set(f.event.id.toString(), lessonId.toString());
      const evidence = distinct([
        ...dup.evidenceEventIds.map((id) => id.toString()),
        ...targets.map((f) => f.event.id.toString()),
      ]).map((s) => BigInt(s));
      await tx
        .update(learningLessons)
        .set({ evidenceEventIds: evidence })
        .where(
          and(eq(learningLessons.workspaceId, ctx.workspaceId), eq(learningLessons.id, lessonId)),
        );
      dup.evidenceEventIds = evidence;
      await recordAuditEvent(
        ctx,
        {
          kind: 'learning.lesson.dedup_reinforce',
          entityType: 'learning_lesson',
          entityId: lessonId,
          payload: {
            decisionId: decision.id,
            addedEvidence: targets.map((f) => f.event.id.toString()),
          },
        },
        tx,
      );
    } else {
      const scope = o.scope;
      const inserted = await insertLessonWithScope(
        tx,
        {
          workspaceId: ctx.workspaceId,
          category: o.rule.category,
          rule: o.rule.rule,
          polarity: o.rule.polarity,
          source: 'decision',
          evidenceEventIds: targets.map((f) => f.event.id),
          lifecycle: o.lifecycle,
          confidence: o.confidence,
          createdBy: decision.userId,
          updatedBy: decision.userId,
        },
        scope,
      );
      lessonId = inserted.id;
      note =
        o.lifecycle === 'proposed'
          ? 'rule_proposed_needs_scope'
          : o.group.textless
            ? 'rule_created_from_verdict'
            : 'rule_created';
      newLessonIds.push(lessonId);
      await recordAuditEvent(
        ctx,
        {
          kind: 'learning.lesson.create',
          entityType: 'learning_lesson',
          entityId: lessonId,
          payload: {
            source: 'decision',
            decisionId: decision.id,
            category: inserted.category,
            polarity: inserted.polarity,
            confidence: inserted.confidence,
            trigger: o.group.trigger,
            lifecycle: o.lifecycle,
            scopeKind: scope.kind,
            productProfileIds: scope.productProfileIds.map((id) => id.toString()),
            // The scope came from the products the record was qualified
            // against (an unscoped decision), not from the decision itself.
            scopeInferred: o.targets.some(
              (f) => f.event.productProfileId === null && !f.workspaceWide,
            ),
          },
        },
        tx,
      );
    }
    lessonIds.push(lessonId);
    for (const f of targets) close(f.event.id, { status: 'done', note, lessonId });
  }

  // 3. Cited-rule reinforcement (the ledger). A rule this event's own
  //    extraction strengthened is credited once, by the dedup row.
  for (const c of citations) {
    const lesson = locked.get(c.id.toString());
    if (!lesson) continue;
    if (matchedBy.get(c.facts.event.id.toString()) === c.id.toString()) continue;
    const effect: CitationEffect | null =
      c.effect ?? (lesson.polarity > 0 ? 'toward_fit' : lesson.polarity < 0 ? 'against_fit' : null);
    if (!effect) continue;
    const verdict = c.facts.event.verdict!;
    const agrees = (verdict === 'fit') === (effect === 'toward_fit');
    forward.push({
      lessonId: c.id,
      eventId: c.facts.event.id,
      kind: 'cited',
      delta: verdictReinforcementDelta(verdict, effect, Number(c.facts.event.weight)),
      reason: agrees ? 'cited_agrees' : 'cited_opposes',
    });
  }
  const ledger = await applyForwardEntries(tx, ctx.workspaceId, locked, forward, now);

  // 4. Close every claimed row (grouped updates).
  const statuses: Partial<Record<LearningProcessingStatus, number>> = {};
  const byClosure = new Map<string, { c: Closure; ids: bigint[] }>();
  for (const r of rows) {
    const c = closures.get(r.id.toString()) ?? {
      status: 'no_rule',
      note: 'nothing_to_learn',
      lessonId: null,
    };
    const key = `${c.status}|${c.note}|${c.lessonId ?? ''}`;
    const entry = byClosure.get(key) ?? { c, ids: [] };
    entry.ids.push(r.id);
    byClosure.set(key, entry);
    statuses[c.status] = (statuses[c.status] ?? 0) + 1;
  }
  for (const { c, ids } of byClosure.values()) {
    const wait = c.status === 'skipped_no_tokens';
    await tx
      .update(learningEvents)
      .set({
        processingStatus: c.status,
        processingNote: c.note,
        processedAt: wait ? null : now,
        claimedAt: null,
        lastError: null,
        // Waiting for tokens is not a failed attempt.
        ...(wait ? { attempts: sql`GREATEST(${learningEvents.attempts} - 1, 0)` } : {}),
        ...(c.lessonId !== null ? { extractedLessonId: c.lessonId } : {}),
      })
      .where(and(eq(learningEvents.workspaceId, ctx.workspaceId), inArray(learningEvents.id, ids)));
  }

  await recordAuditEvent(
    ctx,
    {
      kind: 'learning.decision.processed',
      entityType: 'learning_decision',
      entityId: decision.id,
      payload: {
        statuses,
        lessonIds: lessonIds.map((id) => id.toString()),
        reinforcements: ledger.length,
        compensated: compensation.compensated.length,
        retired: compensation.retired.map((id) => id.toString()),
      },
    },
    tx,
  );

  return {
    lessonId: lessonIds[0] ?? null,
    lessonIds,
    dedupReinforced,
    reinforcedRules: ledger.filter((r) => r.kind === 'cited').length,
    compensated: compensation.compensated.length,
    retired: compensation.retired,
    statuses,
    newLessonIds,
  };
}

/** A failed run gives its rows back: backoff, or 'failed' after the
 *  retry budget (one notification per workspace per day). Only rows still
 *  carrying this run's claim are touched. */
async function releaseAfterFailure(
  ctx: WorkspaceContext,
  claimed: readonly LearningEvent[],
  claimToken: Date,
  message: string,
  now: Date,
  result: ProcessDecisionResult,
): Promise<void> {
  let gaveUp = 0;
  for (const e of claimed) {
    const giveUp = e.attempts >= MAX_LEARNING_ATTEMPTS;
    try {
      const rows = await db
        .update(learningEvents)
        .set({
          processingStatus: giveUp ? 'failed' : 'pending',
          processingNote: giveUp ? 'failed' : null,
          lastError: message,
          claimedAt: null,
          processedAt: giveUp ? now : null,
          nextAttemptAt: giveUp ? null : new Date(now.getTime() + 2 ** e.attempts * 60_000),
        })
        .where(
          and(
            eq(learningEvents.workspaceId, ctx.workspaceId),
            eq(learningEvents.id, e.id),
            eq(learningEvents.processingStatus, 'processing'),
            eq(learningEvents.claimedAt, claimToken),
          ),
        )
        .returning({ id: learningEvents.id });
      if (rows.length === 0) continue;
      const status = giveUp ? 'failed' : 'pending';
      result.statuses[status] = (result.statuses[status] ?? 0) + 1;
      if (giveUp) gaveUp += 1;
    } catch (err) {
      console.error(
        `[learning-processor] releasing event ${e.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (gaveUp > 0) await notifyLearningFailed(ctx.workspaceId, now, gaveUp);
}

/**
 * Tell the workspace that learning gave up on some decisions — at most once
 * per workspace per calendar day (UTC), read or not. The decisions
 * themselves are saved; only what the platform would have learned from
 * them is missing. Best effort, never throws.
 */
export async function notifyLearningFailed(
  workspaceId: bigint,
  now: Date,
  count: number,
): Promise<boolean> {
  try {
    const dedupeKey = `learning.failed:${now.toISOString().slice(0, 10)}`;
    const already = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(eq(notifications.workspaceId, workspaceId), eq(notifications.dedupeKey, dedupeKey)),
      )
      .limit(1);
    if (already.length > 0) return false;
    console.error(
      `[learning-processor] workspace=${workspaceId}: gave up learning from ${count} decision event(s) after ${MAX_LEARNING_ATTEMPTS} attempts`,
    );
    const row = await notify(workspaceId, {
      kind: 'learning.failed',
      title: 'The platform could not learn from some decisions',
      body: `It tried ${MAX_LEARNING_ATTEMPTS} times and gave up. Your decisions are saved; only the rules it would have learned from them are missing.`,
      href: '/learning',
      dedupeKey,
    });
    return row !== null;
  } catch (err) {
    console.error(
      '[learning-processor] failure notice failed:',
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

// ---- the sweeper ------------------------------------------------------------------

export interface LearningSweepResult {
  staleReleased: number;
  failed: number;
  compensated: number;
  resumed: number;
  enqueued: number;
  workspacesFailed: number;
}

function ownerCtx(workspaceId: bigint, ownerUserId: string): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId: ownerUserId, role: 'owner' });
}

const forwardRow = alias(lessonReinforcements, 'forward_row');
const compensationRow = alias(lessonReinforcements, 'compensation_row');
const evidenceEvent = alias(learningEvents, 'evidence_event');

/**
 * One learning.sweep pass over every active workspace (see the module
 * header). Exported for tests; `now` lets them move the clock.
 */
export async function runLearningSweep(now: Date = new Date()): Promise<LearningSweepResult> {
  const result: LearningSweepResult = {
    staleReleased: 0,
    failed: 0,
    compensated: 0,
    resumed: 0,
    enqueued: 0,
    workspacesFailed: 0,
  };
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_AFTER_MS);
  const lostBefore = new Date(now.getTime() - LOST_JOB_AFTER_MS);
  const wss = await db
    .select({ id: workspaces.id, ownerUserId: workspaces.ownerUserId })
    .from(workspaces)
    .where(eq(workspaces.status, 'active'));
  const { getJobQueue } = await import('@/lib/jobs');
  for (const ws of wss) {
    try {
      const ctx = ownerCtx(ws.id, ws.ownerUserId);
      await sweepWorkspace(ctx, now, staleBefore, lostBefore, result, getJobQueue());
    } catch (err) {
      result.workspacesFailed += 1;
      console.error(
        `[learning.sweep] workspace=${ws.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return result;
}

async function sweepWorkspace(
  ctx: WorkspaceContext,
  now: Date,
  staleBefore: Date,
  lostBefore: Date,
  result: LearningSweepResult,
  queue: IJobQueue,
): Promise<void> {
  const ws = ctx.workspaceId;

  // 1. Claims of dead workers: back to 'pending' (the claim counted as an
  //    attempt), or 'failed' once the budget is spent.
  const stale = await db
    .select({ id: learningEvents.id, attempts: learningEvents.attempts })
    .from(learningEvents)
    .where(
      and(
        eq(learningEvents.workspaceId, ws),
        eq(learningEvents.processingStatus, 'processing'),
        lt(learningEvents.claimedAt, staleBefore),
      ),
    )
    .limit(SWEEP_BATCH);
  let gaveUp = 0;
  for (const s of stale) {
    const giveUp = s.attempts >= MAX_LEARNING_ATTEMPTS;
    const rows = await db
      .update(learningEvents)
      .set({
        processingStatus: giveUp ? 'failed' : 'pending',
        processingNote: giveUp ? 'failed' : null,
        lastError: 'the learning job stopped before it finished',
        claimedAt: null,
        processedAt: giveUp ? now : null,
        nextAttemptAt: giveUp ? null : now,
      })
      .where(
        and(
          eq(learningEvents.workspaceId, ws),
          eq(learningEvents.id, s.id),
          eq(learningEvents.processingStatus, 'processing'),
          lt(learningEvents.claimedAt, staleBefore),
        ),
      )
      .returning({ id: learningEvents.id });
    if (rows.length === 0) continue;
    if (giveUp) gaveUp += 1;
    else result.staleReleased += 1;
  }
  if (gaveUp > 0) {
    result.failed += gaveUp;
    await notifyLearningFailed(ws, now, gaveUp);
  }

  // 2. Voided events whose effect nobody undid yet (their voiding
  //    decision failed for good, say): uncompensated ledger rows, or a rule
  //    in service learned only from voided events.
  const uncompensated = await db
    .select({ id: learningEvents.id })
    .from(learningEvents)
    .where(
      and(
        eq(learningEvents.workspaceId, ws),
        isNotNull(learningEvents.voidedAt),
        lt(learningEvents.voidedAt, lostBefore),
        or(
          exists(
            db
              .select({ one: sql`1` })
              .from(forwardRow)
              .where(
                and(
                  eq(forwardRow.eventId, learningEvents.id),
                  isNull(forwardRow.compensatesId),
                  notExists(
                    db
                      .select({ one: sql`1` })
                      .from(compensationRow)
                      .where(eq(compensationRow.compensatesId, forwardRow.id)),
                  ),
                ),
              ),
          ),
          exists(
            db
              .select({ one: sql`1` })
              .from(learningLessons)
              .where(
                and(
                  eq(learningLessons.workspaceId, ws),
                  sql`${learningLessons.lifecycle} <> 'retired'`,
                  sql`${learningEvents.id} = ANY(${learningLessons.evidenceEventIds})`,
                  notExists(
                    db
                      .select({ one: sql`1` })
                      .from(evidenceEvent)
                      .where(
                        and(
                          sql`${evidenceEvent.id} = ANY(${learningLessons.evidenceEventIds})`,
                          isNull(evidenceEvent.voidedAt),
                        ),
                      ),
                  ),
                ),
              ),
          ),
        ),
      ),
    )
    .orderBy(asc(learningEvents.id))
    .limit(SWEEP_BATCH);
  if (uncompensated.length > 0) {
    const r = await db.transaction((tx) =>
      compensateVoidedEvents(
        tx,
        ctx,
        uncompensated.map((u) => u.id),
        now,
      ),
    );
    result.compensated += r.compensated.length;
  }

  // 3. Events that waited for tokens / an AI provider: resume them once
  //    the gate is open again.
  const waiting = await db
    .select({ id: learningEvents.id })
    .from(learningEvents)
    .where(
      and(
        eq(learningEvents.workspaceId, ws),
        eq(learningEvents.processingStatus, 'skipped_no_tokens'),
      ),
    )
    .limit(1);
  if (waiting.length > 0 && (await learningGate(ctx)).ok) {
    const resumed = await db
      .update(learningEvents)
      .set({ processingStatus: 'pending', processingNote: null, nextAttemptAt: now })
      .where(
        and(
          eq(learningEvents.workspaceId, ws),
          eq(learningEvents.processingStatus, 'skipped_no_tokens'),
        ),
      )
      .returning({ id: learningEvents.id });
    result.resumed += resumed.length;
  }

  // 4. Due decisions: a lost job (pending, no backoff, older than 2 min)
  //    or a backoff that has passed.
  const due = await db
    .selectDistinct({ decisionId: learningEvents.decisionId })
    .from(learningEvents)
    .where(
      and(
        eq(learningEvents.workspaceId, ws),
        eq(learningEvents.processingStatus, 'pending'),
        isNotNull(learningEvents.decisionId),
        or(
          and(isNull(learningEvents.nextAttemptAt), lt(learningEvents.createdAt, lostBefore)),
          lte(learningEvents.nextAttemptAt, now),
        ),
      ),
    )
    .limit(SWEEP_BATCH);
  for (const d of due) {
    if (!d.decisionId) continue;
    const payload: LearningProcessPayload = {
      workspaceId: ws.toString(),
      decisionId: d.decisionId,
      userId: ctx.userId,
      role: ctx.role,
    };
    await queue.enqueue(LEARNING_PROCESS_JOB, payload, { tag: `learning:${d.decisionId}` });
    result.enqueued += 1;
  }
}
