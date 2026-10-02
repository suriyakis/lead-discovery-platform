import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const VECTOR_DIM = 1536;
const lessonEmbedding = customType<{ data: number[]; default: false; driverData: string }>({
  dataType: () => `vector(${VECTOR_DIM})`,
  fromDriver(value: unknown): number[] {
    if (Array.isArray(value)) return value as number[];
    if (typeof value === 'string') {
      return value
        .replace(/^\[/, '')
        .replace(/\]$/, '')
        .split(',')
        .map((n) => Number(n));
    }
    return [];
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
});
import { users } from './auth';
import { workspaces } from './workspaces';
import { productProfiles } from './products';

// `category` stays a free-form text column; the category REGISTRY
// (src/lib/services/learning-categories.ts) is the source of truth for
// which categories exist, their polarity, what reads them and who may
// create them. The service validates against it.

// ---- KL-02: the decision record -------------------------------------------
//
// Small value sets are text + CHECK rather than pgEnum: adding a value
// later is a plain constraint swap inside drizzle's single migration
// transaction, which ALTER TYPE ... ADD VALUE cannot be (flow:F-17).

/** Who made a decision. Only 'operator' decisions teach (I034): autopilot
 *  and system decisions are recorded for the audit trail and never mined,
 *  extracted from or reinforced by. */
export const DECISION_ORIGINS = ['operator', 'autopilot', 'system'] as const;
export type DecisionOrigin = (typeof DECISION_ORIGINS)[number];

/** A per-product verdict on a record: the operator's (qualifications.
 *  operator_verdict) or, on an autopilot event, the machine's. */
export const OPERATOR_VERDICTS = ['fit', 'not_fit'] as const;
export type OperatorVerdict = (typeof OPERATOR_VERDICTS)[number];

/** Outbox state of a decision event. Written as 'pending' in the same
 *  transaction as the state change; learning.process claims it
 *  (KL-03, src/lib/services/learning-processor.ts).
 *   - pending / processing: waiting for, or claimed by, learning.process
 *   - done:      a rule was created or strengthened from it
 *   - no_rule:   processed; nothing reusable to learn (processing_note
 *                says why)
 *   - below_floor: the extractor was less than 50 % sure — no rule
 *   - skipped_no_tokens: needs an AI extraction but the wallet is empty
 *                or no AI provider is set; the sweeper re-queues it once
 *                both are back
 *   - skipped:   never processed by design (autopilot/system events, or
 *                voided before processing)
 *   - failed:    gave up after the retry budget (5 attempts) */
export const LEARNING_PROCESSING_STATUSES = [
  'pending',
  'processing',
  'done',
  'no_rule',
  'below_floor',
  'skipped_no_tokens',
  'skipped',
  'failed',
] as const;
export type LearningProcessingStatus = (typeof LEARNING_PROCESSING_STATUSES)[number];

/** Why a decision event stopped counting. */
export const LEARNING_VOID_REASONS = ['changed_mind', 'undo', 'autopilot_override'] as const;
export type LearningVoidReason = (typeof LEARNING_VOID_REASONS)[number];

const sqlList = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * KL-02: one row per decision (an approve, a reject, a bulk archive, a
 * comment...). `decision_key` is the idempotency key — a form nonce for
 * operator decisions, `autopilot:<run>:<item>` for autopilot — so a
 * double submit records nothing twice. The subject is generic
 * (subject_type + subject_id) so later subjects (the Lead, flow:F-17)
 * plug in without a schema change; subject_id is NULL for a bulk decision
 * whose events each name their own subject.
 */
export const learningDecisions = pgTable(
  'learning_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    decisionKey: text('decision_key').notNull(),
    /** e.g. review.approve, review.reject, review.ignore, review.archive,
     *  review.comment — validated by the service (learning-decisions.ts). */
    kind: text('kind').notNull(),
    origin: text('origin', { enum: DECISION_ORIGINS }).notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id'),
    /** The person who decided; NULL for autopilot / system decisions. */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    decisionKeyUnique: unique('learning_decisions_ws_key_unique').on(
      table.workspaceId,
      table.decisionKey,
    ),
    /** Target of the composite FK from learning_events. */
    workspaceIdUnique: unique('learning_decisions_workspace_id_id_unique').on(
      table.workspaceId,
      table.id,
    ),
    subjectIdx: index('learning_decisions_ws_subject_idx').on(
      table.workspaceId,
      table.subjectType,
      table.subjectId,
    ),
    originCheck: check(
      'learning_decisions_origin_check',
      sql`${table.origin} IN (${sqlList(DECISION_ORIGINS)})`,
    ),
  }),
);

/**
 * Append-only feedback log. The raw signal: a user did X to entity Y
 * with optional comment text.
 *
 * KL-02 makes it the decision log AND the learning outbox: every decision
 * (review approve/reject/ignore/archive, comment, autopilot approval)
 * writes its events here in the SAME transaction as the state change,
 * with processing_status 'pending' for the learning.process job — no
 * decision without events, no event without a decision. A newer decision
 * on the same (subject, product) voids the older event (voided_at /
 * voided_by_event_id / void_reason); a voided event is never mined.
 * `context` snapshots what the record looked like when it was decided, so
 * comment-less decisions still carry the features a later distiller can
 * learn from (I036). Rows from before KL-02 have decision_id NULL and
 * processing_status 'done'.
 */
export const learningEvents = pgTable(
  'learning_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** The decision's subject (e.g. 'review_item' + its id). */
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    /** Events are history: deleting a product keeps them (SET NULL) and
     *  the product name stays in `context`. */
    productProfileId: bigint('product_profile_id', { mode: 'bigint' }).references(
      () => productProfiles.id,
      { onDelete: 'set null' },
    ),
    /** Category-shaped action, e.g. `qualification_negative`, `outreach_style`. */
    actionType: text('action_type').notNull(),
    /** The decision's reason text (an operator's note or comment). */
    originalComment: text('original_comment'),
    extractedLessonId: bigint('extracted_lesson_id', { mode: 'bigint' }),
    confidence: smallint('confidence').notNull().default(50),
    // ---- KL-02: decision record ----
    decisionId: uuid('decision_id'),
    origin: text('origin', { enum: DECISION_ORIGINS }).notNull().default('operator'),
    /** fit / not_fit for a product verdict; NULL for an unscoped event
     *  (no relevant product, no explicit choice) and for comments. */
    verdict: text('verdict', { enum: OPERATOR_VERDICTS }),
    /** +1 toward fit, -1 against, 0 neutral (comments). */
    polarity: smallint('polarity').notNull().default(0),
    /** 1 for an explicit verdict or a disagreement with the AI; 0.5 for a
     *  default left untouched and for archive / ignore. */
    weight: numeric('weight', { precision: 3, scale: 2 }).notNull().default('1.00'),
    /** The operator chose this product's verdict (vs. a default). */
    explicit: boolean('explicit').notNull().default(false),
    reasonCodes: text('reason_codes').array().notNull().default(sql`'{}'::text[]`),
    /** Snapshot of the record at decision time (learning-decisions.ts
     *  DecisionContext): normalized domain (never a Vertex redirect),
     *  countries, per-product AI verdict / method / score / threshold /
     *  reason / cited rules, evidence quality, connector + recipe ids,
     *  product names. */
    context: jsonb('context').notNull().default(sql`'{}'::jsonb`),
    // ---- KL-02: outbox ----
    processingStatus: text('processing_status', { enum: LEARNING_PROCESSING_STATUSES })
      .notNull()
      .default('done'),
    attempts: smallint('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { mode: 'date', withTimezone: true }),
    lastError: text('last_error'),
    processedAt: timestamp('processed_at', { mode: 'date', withTimezone: true }),
    /** KL-03: when learning.process claimed the row ('processing'). It is
     *  also the claim token: a worker only writes rows still carrying the
     *  claimed_at it set, and the sweeper releases claims older than 10
     *  minutes (a killed worker). */
    claimedAt: timestamp('claimed_at', { mode: 'date', withTimezone: true }),
    /** KL-03: why the processor closed the row the way it did — a short
     *  code (learning-processor.ts LEARNING_PROCESSING_NOTES), read by the
     *  decision receipt. */
    processingNote: text('processing_note'),
    // ---- KL-02: supersession ----
    voidedAt: timestamp('voided_at', { mode: 'date', withTimezone: true }),
    voidedByEventId: bigint('voided_by_event_id', { mode: 'bigint' }),
    voidReason: text('void_reason', { enum: LEARNING_VOID_REASONS }),
    /** An operator verdict that overturned an autopilot event. */
    overridesAutopilot: boolean('overrides_autopilot').notNull().default(false),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceCreatedIdx: index('learning_events_ws_created_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
    productActionIdx: index('learning_events_product_action_idx').on(
      table.productProfileId,
      table.actionType,
    ),
    /** Composite on workspace_id: an event can only join a decision of
     *  its own workspace. NULL decision_id (pre-KL-02 rows) is unchecked. */
    decisionFk: foreignKey({
      name: 'learning_events_decision_fk',
      columns: [table.workspaceId, table.decisionId],
      foreignColumns: [learningDecisions.workspaceId, learningDecisions.id],
    }).onDelete('cascade'),
    voidedByFk: foreignKey({
      name: 'learning_events_voided_by_fk',
      columns: [table.voidedByEventId],
      foreignColumns: [table.id],
    }).onDelete('set null'),
    decisionIdx: index('learning_events_ws_decision_idx').on(table.workspaceId, table.decisionId),
    /** Supersession and the delete guard look events up by subject. */
    subjectIdx: index('learning_events_ws_subject_idx').on(
      table.workspaceId,
      table.entityType,
      table.entityId,
    ),
    /** The outbox: what learning.process (and the KL-03 sweeper) picks up. */
    outboxIdx: index('learning_events_outbox_idx')
      .on(table.processingStatus, table.nextAttemptAt)
      .where(sql`${table.processingStatus} IN ('pending', 'processing')`),
    /** KL-03: the sweeper's "waiting for tokens" pass, per workspace. */
    waitingTokensIdx: index('learning_events_waiting_tokens_idx')
      .on(table.workspaceId)
      .where(sql`${table.processingStatus} = 'skipped_no_tokens'`),
    /** KL-03: supersession looks up the events a claimed event voided. */
    voidedByIdx: index('learning_events_voided_by_idx')
      .on(table.voidedByEventId)
      .where(sql`${table.voidedByEventId} IS NOT NULL`),
    originCheck: check(
      'learning_events_origin_check',
      sql`${table.origin} IN (${sqlList(DECISION_ORIGINS)})`,
    ),
    verdictCheck: check(
      'learning_events_verdict_check',
      sql`${table.verdict} IS NULL OR ${table.verdict} IN (${sqlList(OPERATOR_VERDICTS)})`,
    ),
    polarityCheck: check('learning_events_polarity_check', sql`${table.polarity} IN (-1, 0, 1)`),
    weightCheck: check(
      'learning_events_weight_check',
      sql`${table.weight} > 0 AND ${table.weight} <= 1`,
    ),
    processingStatusCheck: check(
      'learning_events_processing_status_check',
      sql`${table.processingStatus} IN (${sqlList(LEARNING_PROCESSING_STATUSES)})`,
    ),
    voidReasonCheck: check(
      'learning_events_void_reason_check',
      sql`${table.voidReason} IS NULL OR ${table.voidReason} IN (${sqlList(LEARNING_VOID_REASONS)})`,
    ),
    /** Voided iff a reason says why; a voiding event implies voided. */
    voidedCheck: check(
      'learning_events_voided_check',
      sql`(${table.voidedAt} IS NULL) = (${table.voidReason} IS NULL) AND (${table.voidedByEventId} IS NULL OR ${table.voidedAt} IS NOT NULL)`,
    ),
  }),
);

/** KL-01: where a rule applies. 'workspace' = every product of the
 *  workspace; 'products' = exactly the products listed in lesson_scopes.
 *  NULL never means "everywhere" any more, and a 'products' rule whose
 *  scope rows are all gone (its products were deleted) applies nowhere —
 *  it shows as "Needs a scope" until an operator re-scopes or retires it. */
export const lessonScopeKind = pgEnum('lesson_scope_kind', ['workspace', 'products']);

/** KL-01: the single lifecycle of a rule (replaces the old `enabled`).
 *  Only 'active' rules reach any prompt or scoring step.
 *   - active:   in force
 *   - proposed: suggested by the platform, waiting for an operator
 *   - disabled: switched off by an operator, can be switched back on
 *   - retired:  taken out of service for a recorded reason (below) */
export const lessonLifecycle = pgEnum('lesson_lifecycle', [
  'active',
  'proposed',
  'disabled',
  'retired',
]);

/** Why a rule was retired. `merged` / `superseded` point at the surviving
 *  rule through merged_into_id. */
export const lessonRetiredReason = pgEnum('lesson_retired_reason', [
  /** Low confidence and not used for a long time (compaction). */
  'stale',
  /** Folded into another rule (compaction merge); see merged_into_id. */
  'merged',
  /** Replaced by a narrower/rewritten rule; see merged_into_id. */
  'superseded',
  /** Lost a contradiction reconciliation against another rule. */
  'contradicted',
  /** An operator rejected it; kept so extraction cannot recreate it. */
  'operator_rejected',
  /** Its only evidence was a decision that was later undone. */
  'source_decision_voided',
  /** Absorbed into the product profile by an accepted suggestion. */
  'absorbed_into_profile',
  /** Its only product was deleted. */
  'product_deleted',
  /** Its category was removed from the registry (nothing consumed it). */
  'category_removed',
]);

/**
 * Structured durable lesson ("rule") distilled from one or more
 * `learning_events`. Soft-delete only — lessons are never hard-deleted so
 * the audit trail is preserved; `lifecycle` says whether one is in force.
 *
 * Phase 12 adds an `embedding` vector(1536) column (requires the pgvector
 * extension).
 */
export const learningLessons = pgTable(
  'learning_lessons',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** KL-01: 'workspace' or 'products' (the products are lesson_scopes
     *  rows). Every reader filters through lessonInScope() in
     *  src/lib/services/learning.ts. */
    scopeKind: lessonScopeKind('scope_kind').notNull().default('workspace'),
    category: text('category').notNull(),
    /** One-sentence imperative, e.g. "Skip councils for Vetrofluid offers." */
    rule: text('rule').notNull(),
    /** KL-01: +1 PREFER, -1 AVOID, 0 neutral guidance. Allowed values per
     *  category come from the category registry. */
    polarity: smallint('polarity').notNull().default(0),
    /** Where this lesson came from:
     *  - operator:   created by hand on /learning
     *  - decision:   extracted by learning.process from an operator's
     *                decision (reason, chips, disagreement or override)
     *                or review comment (KL-03); evidence_event_ids names
     *                the decision events
     *  - draft_edit: learned by diffing an AI draft against the operator's edit
     *  - synthesis:  proposed by the weekly self-learning pattern miner */
    source: text('source').notNull().default('operator'),
    evidenceEventIds: bigint('evidence_event_ids', { mode: 'bigint' })
      .array()
      .notNull()
      .default(sql`'{}'::bigint[]`),
    lifecycle: lessonLifecycle('lifecycle').notNull().default('active'),
    retiredReason: lessonRetiredReason('retired_reason'),
    retiredNote: text('retired_note'),
    /** The surviving rule when this one was merged / superseded. */
    mergedIntoId: bigint('merged_into_id', { mode: 'bigint' }),
    confidence: smallint('confidence').notNull().default(60),
    /** P60-06: how many times the qualifier/outreach actually pulled this
     *  lesson into a prompt/scoring step. Compaction (P60-04) uses this +
     *  lastAppliedAt to retire dead-weight lessons. */
    applicationCount: integer('application_count').notNull().default(0),
    lastAppliedAt: timestamp('last_applied_at', { mode: 'date', withTimezone: true }),
    /** KL-01 (filled by KL-04): how often a model actually CITED this rule
     *  in a verdict — exposure (applicationCount) is not use. */
    citedCount: integer('cited_count').notNull().default(0),
    lastCitedAt: timestamp('last_cited_at', { mode: 'date', withTimezone: true }),
    /** Last confidence change from an outcome (kept apart from updatedAt,
     *  which tracks operator edits). */
    reinforcedAt: timestamp('reinforced_at', { mode: 'date', withTimezone: true }),
    /** Phase 12: vector(1536) for similarity-based lesson retrieval. Populated by the indexer. */
    embedding: lessonEmbedding('embedding'),
    embeddingModel: text('embedding_model'),
    embeddingDim: integer('embedding_dim').notNull().default(VECTOR_DIM),
    embeddedAt: timestamp('embedded_at', { mode: 'date', withTimezone: true }),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),

    // ---- DEPRECATED (KL-01 expand phase) ----------------------------------
    // The pre-KL-01 columns stay DECLARED until the knowledge-foundation
    // contract PR drops them, so this lane's migration is purely additive
    // and regenerates from this file in one pass: the custom block of
    // p1_knowledge_foundation_* reads them to backfill scope_kind /
    // lesson_scopes / lifecycle. Nothing reads or writes them any more
    // (src/tests/learning-legacy-columns.test.ts fails the build on a use
    // outside this file); their values freeze at the backfill.
    /** @deprecated replaced by scope_kind + lesson_scopes. ON DELETE SET
     *  NULL (was CASCADE): deleting a product must not hard-delete a rule
     *  through the legacy column (I109). */
    legacyProductProfileId: bigint('product_profile_id', { mode: 'bigint' }).references(
      () => productProfiles.id,
      { onDelete: 'set null' },
    ),
    /** @deprecated replaced by lifecycle. */
    legacyEnabled: boolean('enabled').notNull().default(true),
  },
  (table) => ({
    /** Target of the composite FKs from lesson_scopes and
     *  lesson_reinforcements: a scope or ledger row can only join a lesson
     *  of the SAME workspace. Those FKs are DB-only (see lessonScopes). */
    workspaceIdUnique: unique('learning_lessons_workspace_id_id_unique').on(
      table.workspaceId,
      table.id,
    ),
    workspaceLifecycleIdx: index('learning_lessons_ws_lifecycle_category_idx').on(
      table.workspaceId,
      table.lifecycle,
      table.category,
    ),
    mergedIntoFk: foreignKey({
      name: 'learning_lessons_merged_into_id_fk',
      columns: [table.mergedIntoId],
      foreignColumns: [table.id],
    }).onDelete('set null'),
    polarityCheck: check('learning_lessons_polarity_check', sql`${table.polarity} IN (-1, 0, 1)`),
    /** A retired rule always says why; a rule in service never carries a reason. */
    retiredReasonCheck: check(
      'learning_lessons_retired_reason_check',
      sql`(${table.lifecycle} = 'retired') = (${table.retiredReason} IS NOT NULL)`,
    ),
    mergedIntoCheck: check(
      'learning_lessons_merged_into_check',
      sql`${table.mergedIntoId} IS NULL OR (${table.lifecycle} = 'retired' AND ${table.mergedIntoId} <> ${table.id})`,
    ),
  }),
);

/**
 * KL-01: which products a 'products'-scoped rule applies to. Both FKs are
 * composite on workspace_id, so the database itself refuses a scope row
 * that joins a rule to another tenant's product (I167) — there is no code
 * path to forget. Deleting a product cascades its scope rows; a rule left
 * with none applies nowhere.
 *
 * DB-only constraints (deliberately NOT declared here): the two composite
 * FKs lesson_scopes_lesson_fk (workspace_id, lesson_id) -> learning_lessons
 * (workspace_id, id) and lesson_scopes_product_fk (workspace_id,
 * product_profile_id) -> product_profiles (workspace_id, id), both ON
 * DELETE CASCADE. They reference UNIQUE(workspace_id, id) constraints this
 * lane adds to EXISTING tables, which drizzle-kit always emits after every
 * FK, so a generated migration would create the FK first and Postgres would
 * refuse it. The custom block of the p1_knowledge_foundation_* migration
 * creates them after the UNIQUEs; src/tests/db-only-constraints.test.ts
 * fails if a regeneration loses them.
 */
export const lessonScopes = pgTable(
  'lesson_scopes',
  {
    lessonId: bigint('lesson_id', { mode: 'bigint' }).notNull(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' }).notNull(),
    productProfileId: bigint('product_profile_id', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: 'lesson_scopes_pk',
      columns: [table.lessonId, table.productProfileId],
    }),
    workspaceProductIdx: index('lesson_scopes_ws_product_idx').on(
      table.workspaceId,
      table.productProfileId,
    ),
  }),
);

/** KL-03: what moved a rule's confidence.
 *   - cited:        an operator verdict on a record whose AI verdict cited
 *                   the rule (+2 when the citation agreed with the verdict,
 *                   -3 when it opposed it, x the event weight)
 *   - dedup_match:  a decision's extracted rule repeated this one (+5)
 *   - compensation: reverses one earlier row exactly (its delta_applied)
 *                   because that row's event was voided */
export const LESSON_REINFORCEMENT_KINDS = ['cited', 'dedup_match', 'compensation'] as const;
export type LessonReinforcementKind = (typeof LESSON_REINFORCEMENT_KINDS)[number];

/**
 * KL-03: the reinforcement ledger. Every confidence change a decision
 * causes is one row, written in the same transaction as the confidence
 * update, so the ledger always explains the number:
 *
 *   - idempotent: at most one forward row per (event, rule) — the partial
 *     UNIQUE(event_id, lesson_id) — so a re-run job never moves a rule
 *     twice for the same decision;
 *   - exact: delta_applied is what really changed after the 5..95 bounds,
 *     so a compensation (event voided: changed mind, undo, autopilot
 *     override) restores the previous confidence exactly, clamped cases
 *     included; each forward row is compensated at most once
 *     (UNIQUE(compensates_id)).
 */
export const lessonReinforcements = pgTable(
  'lesson_reinforcements',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    lessonId: bigint('lesson_id', { mode: 'bigint' }).notNull(),
    /** The decision event behind the change (for a compensation: the
     *  voided event whose earlier row it reverses). */
    eventId: bigint('event_id', { mode: 'bigint' })
      .notNull()
      .references(() => learningEvents.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: LESSON_REINFORCEMENT_KINDS }).notNull(),
    /** The step asked for (e.g. +2, -3, +5, or minus a row's delta_applied). */
    deltaRequested: smallint('delta_requested').notNull(),
    /** The step actually applied after the bounds; 0 when bounded out. */
    deltaApplied: smallint('delta_applied').notNull(),
    confidenceBefore: smallint('confidence_before').notNull(),
    confidenceAfter: smallint('confidence_after').notNull(),
    /** The forward row a compensation reverses. */
    compensatesId: bigint('compensates_id', { mode: 'bigint' }),
    /** e.g. cited_agrees, cited_opposes, dedup_match, void:changed_mind. */
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // lesson_reinforcements_lesson_fk (workspace_id, lesson_id) ->
    // learning_lessons (workspace_id, id) ON DELETE CASCADE — a ledger row
    // can only move a rule of its own workspace — is DB-only, created by
    // the migration's custom block (same reason as lessonScopes).
    compensatesFk: foreignKey({
      name: 'lesson_reinforcements_compensates_fk',
      columns: [table.compensatesId],
      foreignColumns: [table.id],
    }).onDelete('cascade'),
    /** One forward row per (event, rule): the idempotency key. */
    eventLessonUnique: uniqueIndex('lesson_reinforcements_event_lesson_unique')
      .on(table.eventId, table.lessonId)
      .where(sql`${table.compensatesId} IS NULL`),
    compensatesUnique: unique('lesson_reinforcements_compensates_unique').on(table.compensatesId),
    /** Receipts and compensation read an event's rows of every kind. */
    eventIdx: index('lesson_reinforcements_event_idx').on(table.eventId),
    lessonIdx: index('lesson_reinforcements_ws_lesson_idx').on(
      table.workspaceId,
      table.lessonId,
      table.createdAt,
    ),
    kindCheck: check(
      'lesson_reinforcements_kind_check',
      sql`${table.kind} IN (${sqlList(LESSON_REINFORCEMENT_KINDS)})`,
    ),
    /** A compensation, and only a compensation, points at the row it reverses. */
    compensationCheck: check(
      'lesson_reinforcements_compensation_check',
      sql`(${table.kind} = 'compensation') = (${table.compensatesId} IS NOT NULL)`,
    ),
    confidenceCheck: check(
      'lesson_reinforcements_confidence_check',
      sql`${table.confidenceBefore} BETWEEN 0 AND 100 AND ${table.confidenceAfter} BETWEEN 0 AND 100 AND ${table.confidenceAfter} - ${table.confidenceBefore} = ${table.deltaApplied}`,
    ),
  }),
);

export type LearningDecision = typeof learningDecisions.$inferSelect;
export type NewLearningDecision = typeof learningDecisions.$inferInsert;
export type LearningEvent = typeof learningEvents.$inferSelect;
export type NewLearningEvent = typeof learningEvents.$inferInsert;
/** A rule row without the deprecated legacy columns (KL-01 expand phase). */
export type LearningLesson = Omit<
  typeof learningLessons.$inferSelect,
  'legacyProductProfileId' | 'legacyEnabled'
>;
export type NewLearningLesson = typeof learningLessons.$inferInsert;
export type LessonScope = typeof lessonScopes.$inferSelect;
export type LessonReinforcement = typeof lessonReinforcements.$inferSelect;
export type NewLessonReinforcement = typeof lessonReinforcements.$inferInsert;
export type LessonScopeKind = (typeof lessonScopeKind.enumValues)[number];
export type LessonLifecycle = (typeof lessonLifecycle.enumValues)[number];
export type LessonRetiredReason = (typeof lessonRetiredReason.enumValues)[number];
