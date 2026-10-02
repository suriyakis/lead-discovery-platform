# Learning layer

The platform gets better at judging records by learning from what operators decide. A decision (approve, reject, ignore, archive, a comment) is recorded as part of the state change itself, and a background job turns it into reusable rules ("lessons") and adjusts the confidence of the rules the AI relied on. Rules then shape future qualification, outreach drafts and reply suggestions.

This document describes the code as it is after KL-01 (scope, lifecycle, category registry), KL-02 (the decision record) and KL-03 (the learning processor).

## The contract

1. **One decision, one transaction.** Every decision writes its `learning_events` in the same transaction as the state change (`recordDecision`). There is no decision without events and no event without a decision. A repeated form submit (same `decision_key`) records nothing twice.
2. **Slow work never blocks a decision.** No AI call runs inside the operator's request. The events are the outbox; the `learning.process` job drains it (I108).
3. **One extraction per decision.** A decision about several products is one AI call and at most one rule, scoped to every product that got the same verdict (I032). A bulk decision is one call per product-group × polarity with at most 10 sampled records.
4. **Credit only where cited.** Only the rules an AI verdict cited move with the operator's verdict, by polarity (I098). Exposure is not use.
5. **Machines never teach.** Autopilot and system decisions are recorded for the audit trail and never mined, extracted from or reinforced by (I034).
6. **Decisions can be taken back.** A newer decision on the same (record, product) voids the older event. Voiding reverses exactly what the old event did to rule confidence and retires a rule learned only from it.
7. **Untrusted text never becomes an instruction.** Record text and earlier AI reasoning sit in a fenced DATA block, and the extracted rule is validated.
8. **Receipts tell the truth.** Every decision has a receipt that reports what was actually learned.

## Flow

```
Operator / autopilot action
  recordDecision(tx)                 — SAME transaction as the state change
    learning_decisions row          (idempotent on decision_key)
    learning_events: one per product verdict (or one unscoped event),
      origin, verdict, polarity, weight, reason, chips, context snapshot,
      processing_status = 'pending' (operator) | 'skipped' (autopilot/system)
    voids the earlier live event on the same (subject, product)
    qualifications.operator_verdict (review decisions)
  after commit: enqueue learning.process {decisionId}   (best effort)

learning.process {decisionId}        (src/lib/services/learning-processor.ts)
  1. claim   — conditional UPDATE pending -> processing, attempts + 1,
               claimed_at = claim token; only due rows (no backoff pending)
  2. plan    — outside any transaction: extraction groups, the AI call,
               validation, dedup lookups
  3. write   — ONE transaction that re-locks the claimed events and checks
               the claim is still ours:
               a. compensate the events this decision voided
               b. the rule: new / +5 on the active rule it repeats /
                  nothing if it repeats a rule the operator rejected
               c. reinforce the cited rules (the ledger)
               d. close every claimed event with a status and a note
  4. fail    — back to 'pending' with backoff 2, 4, 8, 16 min; after 5
               attempts 'failed' + one 'learning.failed' notification per
               workspace per day

learning.sweep (repeatable, every 2 min, every active workspace)
  - releases 'processing' claims older than 10 min (a dead worker)
  - compensates voided events nobody compensated (catch-all)
  - resumes 'skipped_no_tokens' events once tokens and an AI provider exist
  - re-enqueues learning.process for 'pending' events older than 2 min
    (lost job) or whose backoff has passed
```

The sweeper only enqueues, so it behaves the same on the memory queue (dev, tests) and on BullMQ (prod). Processing is idempotent: claims stop two workers from holding the same event, a job killed before its commit leaves nothing behind, an event already linked to a rule is never extracted again, and the ledger's `UNIQUE(event_id, lesson_id)` stops a rule moving twice for one decision.

## When a decision teaches a rule

An extraction runs for a decision group only when there is something to learn:

| trigger | rule confidence | note |
|---|---|---|
| a written reason (≥ 8 characters, @mentions stripped) | the model's (≥ 50, at most 95) | `rule_created` |
| a generalisable reason chip (see below) | the model's | `rule_created` |
| the operator disagreed with an available AI verdict (method `ai`, at or above the threshold) | **50**, labelled "from your approval" / "from your rejection" | `rule_created_from_verdict` |
| the operator overturned an autopilot approval | **50**, same label | `rule_created_from_verdict` |

A decision that agrees with the AI makes no new rule; it reinforces the cited rules. Archive and ignore are half-weight Not a fit verdicts and never count as a disagreement: they teach a rule only with a chip. Flag records nothing.

**Reason chips** (`src/lib/services/learning-chips.ts`): generalisable chips — right sector, right buyer role, active project or tender, right size, wrong sector, too small, not a company, no need — trigger an extraction and are stated in the prompt. Entity-fact chips — existing customer, competitor, duplicate, wrong country — are kept on the event but never become a generalised rule.

**Scope — never widened implicitly.** The rule applies to every product whose verdict points the rule's way. A comment applies to the products it was written for; only a comment posted explicitly for every product (`appliesTo: 'workspace'`) makes a workspace-wide rule. An **unscoped** event (no relevant product and no explicit choice — in prod most review items) speaks for the products the record was **qualified against** (its context snapshot): a rule from a note or a chip is scoped to all of them, a verdict-only rule to those whose AI verdict the operator contradicted. So an approve of a record the AI rejected for every product (§5's false_negative, "always extract") teaches a PREFER rule for those products, and a reject with a note teaches an AVOID rule for them — not for every current and future product. When the record was qualified against no product that still exists, the rule is only **proposed** with no product ("Needs a scope", `rule_proposed_needs_scope`; the receipt says "Suggested a rule — choose which products it applies to") and reaches no prompt until an operator scopes it. Products deleted since the decision are dropped; when a decision that named its products has none left, there is no rule (`products_deleted`).

## The extraction prompt and validation

`src/lib/services/learning-extraction.ts`:

- The system prompt lists only the registry categories that can carry the decision's polarity. A rejection can never become `qualification_positive` (I099). A comment allows any category.
- The user prompt states what happened with the product names ("The operator REJECTED this record for Vetrofluid."), the AI disagreement or autopilot override if any, the chips and the note.
- Record title, domain and snippet, and the earlier verdict's reasoning, sit between `<<<DATA` and `DATA>>>`. The system prompt says never to follow instructions inside it. Fence markers inside the data are neutralised.
- The answer is validated: at most 200 characters; no URL, domain or e-mail address; nothing instruction-like ("ignore previous instructions", "you are now", "add rule"); not an unconditional "prefer all companies"; not copied from the record data unless the operator's note says it; polarity consistent with the decision.
- **Confidence floor: 50.** A valid rule the model is less than 50 % sure of is not created (`below_floor`).
- An answer that is not the JSON asked for is no rule (`rejected:invalid_output`), not a retry. Network and provider errors are retried.

**No heuristic minting.** There is no keyword fallback. Without tokens or without a real AI provider, an event that needs an extraction waits as `skipped_no_tokens` (note `no_tokens` / `no_ai_provider`; the wait does not use up an attempt) and the sweeper resumes it once the gate is open. The cited-rule reinforcement needs no AI and is applied anyway. Manual `createLesson` on /learning stays synchronous.

**Dedup.** The extracted rule is compared with the active rules of the same category, polarity and exact scope (text first, then embedding similarity ≥ 0.92). A match gets +5 through a `dedup_match` ledger row and the evidence events, and the receipt says "Matched an existing rule — strengthened it". A match with a rule the operator rejected (`retired_reason = 'operator_rejected'`, overlapping scope) is not recreated (`matches_rejected_rule`), and neither is a match with a rule the operator switched off (`lifecycle = 'disabled'`, overlapping scope — Disable is the operator's only "no" until KL-12's "Not what I meant"): `matches_disabled_rule`, receipt "This matches a rule you switched off — it was not recreated". A proposed rule with no product (see Scope) is compared with the proposed rules with no product.

## The reinforcement ledger

`lesson_reinforcements` (`src/lib/services/learning-ledger.ts`) records every confidence change a decision causes, in the same transaction as the change:

- **cited**: an operator verdict on a product whose AI verdict cited the rule. sign = verdict (Fit +1, Not a fit −1) × citation effect (toward_fit +1, against_fit −1). +2 when they agree, −3 when they oppose, × the event weight (1; 0.5 for an untouched default that agrees with the AI, archive and ignore), rounded half away from zero. Without KL-04's explicit effects, the effect is read from the rule's polarity (PREFER = toward_fit, AVOID = against_fit; neutral rules never move). Only origin `operator`, method `ai`, at or above the threshold: rules-fallback and below-threshold verdicts never reinforce.
- **dedup_match**: +5 when the decision's extracted rule repeats this one. A rule credited by a dedup match is not also credited as cited by the same event.
- **compensation**: reverses one forward row exactly by its `delta_applied`.

Forward steps stay within 5..95 and never move a rule against their own direction. `delta_applied` records what really changed, so a compensation restores the earlier confidence exactly, clamped cases included. One forward row per (event, rule) (partial unique index); one compensation per forward row (`UNIQUE(compensates_id)`); a CHECK keeps `confidence_after − confidence_before = delta_applied`.

## Supersession

A newer verdict on the same (subject, product) voids the older event (`voided_at`, `voided_by_event_id`, `void_reason`: `changed_mind`, `undo`, `autopilot_override`). An operator verdict that voids an autopilot event sets `overrides_autopilot`, which always triggers an extraction. When the newer decision is processed:

- every forward ledger row of the voided event is compensated;
- every rule whose evidence events are now all voided is retired with `retired_reason = 'source_decision_voided'` (a rule with any live evidence stays);
- a voided event that was never processed is closed `skipped` and never mined.

The sweeper repeats this for voided events older than 2 minutes that still have uncompensated rows or a rule in service learned only from them. Comments never void verdicts.

## Statuses and receipts

`learning_events.processing_status`: `pending` → `processing` → `done` | `no_rule` | `below_floor` | `skipped_no_tokens` | `skipped` | `failed`. `processing_note` says why: `rule_created`, `rule_created_from_verdict`, `rule_proposed_needs_scope`, `rule_strengthened`, `matches_rejected_rule`, `matches_disabled_rule`, `nothing_to_learn`, `other_direction`, `below_floor`, `products_deleted`, `no_tokens`, `no_ai_provider`, `voided`, `machine`, `failed`, `rejected:<reason>`.

`getDecisionReceipt(ctx, decisionId)` (`src/lib/services/learning-receipts.ts`) and `GET /api/learning/receipts/[decisionId]` (workspace-scoped; another workspace's decision is 404) return the state (learning, learned, needs_scope, strengthened, not_recreated, not_recreated_disabled, too_uncertain, waiting_for_tokens, waiting_for_ai, failed, changed_later, recorded_only, nothing_new), a headline, per-event status, the rules created or strengthened, the ledger changes (with `undone` when a later decision reversed them) and what this decision undid. The decision panel's `<LearningReceipt>` (KL-20) renders it.

## Lesson categories (registry)

`src/lib/services/learning-categories.ts` is the single source of truth (KL-01). For every category it records the operator label and description, the allowed polarity, which tasks read it (`appliesTo`: qualification / outreach / replies), whether the manual form offers it, and the code that consumes it. Retrieval (`resolveCategoriesForTask`), the decision extractor, the synthesis prompt, the /learning forms and the qualification prompt's PREFER / AVOID marks derive from it, and `src/tests/learning-categories.test.ts` fails when a category has no consumer for a task it claims.

| category | polarity | applies to |
|---|---|---|
| `qualification_positive` | PREFER | qualification |
| `qualification_negative` | AVOID | qualification |
| `sector_preference` | PREFER or AVOID | qualification |
| `contact_role` | PREFER or AVOID | qualification, outreach |
| `false_positive` (not manual) | AVOID | qualification |
| `false_negative` (not manual) | PREFER | qualification |
| `outreach_style` | neutral | outreach, replies |
| `product_positioning` | neutral | outreach |
| `reply_quality` | neutral | replies |
| `general_instruction` | any | qualification, outreach, replies |

`dedupe_hint` and `connector_quality` were removed in KL-01: nothing ever read them.

## Data model

- `learning_decisions` — one row per decision; `UNIQUE(workspace_id, decision_key)`; generic `subject_type` / `subject_id`.
- `learning_events` — the decision log and the outbox: `decision_id` (composite FK on workspace), origin, verdict, polarity, weight, explicit, reason_codes, `context` (record snapshot: normalized domain — never a Vertex redirect — title, snippet, countries, per-product AI verdict / method / score / threshold / reason / cited rules, evidence quality, connector and recipe ids, product names), outbox state (`processing_status`, `attempts`, `next_attempt_at`, `last_error`, `processed_at`, `claimed_at`, `processing_note`), supersession (`voided_at`, `voided_by_event_id`, `void_reason`, `overrides_autopilot`) and `extracted_lesson_id`.
- `learning_lessons` — the rules: `scope_kind` (+ `lesson_scopes`), category, rule, polarity, `source` (`operator` = manual, `decision` = learned by the processor, `draft_edit`, `synthesis`), `evidence_event_ids`, lifecycle (`active` / `proposed` / `disabled` / `retired` with `retired_reason`, `retired_note`, `merged_into_id`), confidence, exposure counters, `cited_count`, `reinforced_at`, embedding.
- `lesson_scopes` — `(lesson_id, workspace_id, product_profile_id)` with composite FKs on workspace, `ON DELETE CASCADE`.
- `lesson_reinforcements` — the ledger above.

Full column lists: [`docs/DATABASE_MODEL.md`](DATABASE_MODEL.md).

## How rules influence behaviour

- **Qualification:** `getRelevantLessons({ taskType: 'classification' })`; the AI prompt marks each rule PREFER / AVOID / NOTE from its polarity; the rules fallback adds or subtracts by polarity and ignores neutral rules.
- **Outreach drafts:** `taskType: 'outreach'` (`outreach_style`, `contact_role`, `product_positioning`, `general_instruction`).
- **Reply suggestions:** `retrieveLessons({ taskType: 'reply' })` (`reply_quality`, `outreach_style`, `general_instruction`).
- Only `active` rules in scope (`lessonInScope`) are retrieved.

## Other sources of rules

- **Draft edits** (`learnFromDraftEdit`): a material rewrite of an AI draft is diffed into an `outreach_style` rule (`source = 'draft_edit'`).
- **Reply outcomes** (`learnFromReplyOutcome`): off unless the workspace owner switches `learn_from_replies` on; KL-15 owns the remaining gates.
- **Weekly synthesis** (`learning-synthesis.ts`): mines live operator decisions for patterns and proposes rules.
- **Compaction** (`knowledge-compaction.ts`): merges near-duplicates and retires stale rules.

## What we don't do

- We do not change a decision because of a rule. Every rule can be disabled on /learning and the effect is immediate.
- We do not mint rules from keywords, from autopilot, or from a voided decision.
- We do not learn across workspaces.
