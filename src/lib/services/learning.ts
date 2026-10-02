import {
  and,
  desc,
  eq,
  exists,
  inArray,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import {
  learningEvents,
  learningLessons,
  lessonScopes,
  type LearningEvent,
  type LearningLesson,
  type LessonLifecycle,
  type LessonRetiredReason,
  type LessonScopeKind,
  type NewLearningEvent,
  type NewLearningLesson,
} from '@/lib/db/schema/learning';
import { getAIProviderForCtx } from '@/lib/ai';
import { recordAuditEvent } from './audit';
import { canAdminWorkspace, canWrite, type WorkspaceContext } from './context';
import {
  LESSON_CATEGORIES,
  LESSON_CATEGORY_REGISTRY,
  categoriesForTaskType,
  isLessonCategory,
  isPolarityAllowed,
  parseLessonPolarity,
  polarityForRule,
  resolveLessonPolarity,
  type LessonCategory,
  type LessonPolarity,
  type LessonTaskType,
} from './learning-categories';
import { recordUsage } from './usage';

export {
  LESSON_CATEGORIES,
  type LessonCategory,
  type LessonPolarity,
  type LessonTaskType,
} from './learning-categories';

// ---- errors --------------------------------------------------------------

export type LearningErrorCode =
  | 'permission_denied'
  | 'not_found'
  | 'invalid_input'
  | 'invariant_violation'
  | 'unknown_category'
  | 'invalid_polarity'
  | 'rule_required'
  | 'rule_too_long'
  | 'product_not_found'
  | 'scope_required'
  | 'lifecycle_conflict';

export class LearningServiceError extends Error {
  public readonly code: LearningErrorCode;
  constructor(message: string, code: LearningErrorCode) {
    super(message);
    this.name = 'LearningServiceError';
    this.code = code;
  }
}

const permissionDenied = (op: string) =>
  new LearningServiceError(`Permission denied: ${op}`, 'permission_denied');
const notFound = () => new LearningServiceError('learning_lesson not found', 'not_found');
const invariant = (msg: string) => new LearningServiceError(msg, 'invariant_violation');
const invalid = (msg: string) => new LearningServiceError(msg, 'invalid_input');
/** Same error for another tenant's product and for an id that does not
 *  exist: the composite FK cannot tell them apart, and neither may we. */
const productNotFound = () => new LearningServiceError('Product not found', 'product_not_found');
const scopeRequired = () =>
  new LearningServiceError(
    'A rule scoped to products needs at least one product',
    'scope_required',
  );

/** What an operator reads for each error code. Pages redirect with the
 *  code and render this — never the raw code. */
const LEARNING_ERROR_MESSAGES: Record<LearningErrorCode, string> = {
  permission_denied: 'Your role cannot change learning rules. Ask a workspace admin.',
  not_found: 'That rule no longer exists in this workspace.',
  invalid_input: 'Some values were not valid. Check the form and try again.',
  invariant_violation: 'The rule could not be saved. Try again in a moment.',
  unknown_category: 'Choose what the rule is about from the list.',
  invalid_polarity:
    'That direction does not fit the chosen category. Fit signals are Prefer or Avoid; writing and reply guidance is Neutral.',
  rule_required: 'Write the rule: one sentence the platform should follow.',
  rule_too_long: 'Keep the rule under 1,000 characters.',
  product_not_found: "Product not found. Pick one of this workspace's products.",
  scope_required: 'Choose at least one product, or apply the rule to all products.',
  lifecycle_conflict: 'That change does not apply to a rule in its current state.',
};

/** Human message for an error code a page received (e.g. `?error=`).
 *  Unknown codes get a generic sentence; a raw code is never shown. */
export function learningErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return (
    (LEARNING_ERROR_MESSAGES as Record<string, string>)[code] ??
    'Something went wrong while saving the rule. Try again.'
  );
}

/** Postgres FK violation on lesson_scopes → product (composite on
 *  workspace_id): the product is another tenant's or does not exist. */
function isScopeProductFkViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth++) {
    const e = cur as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown };
    if (
      e.code === '23503' &&
      (e.constraint_name === 'lesson_scopes_product_fk' || e.constraint === 'lesson_scopes_product_fk')
    ) {
      return true;
    }
    cur = e.cause;
  }
  return false;
}

function mapScopeError(err: unknown): unknown {
  return isScopeProductFkViolation(err) ? productNotFound() : err;
}

function assertCategory(input: string): LessonCategory {
  if (!isLessonCategory(input)) {
    throw new LearningServiceError(`unknown category: ${input}`, 'unknown_category');
  }
  return input;
}

const RULE_MAX = 1000;

function validateRule(input: string): string {
  const rule = input.trim();
  if (!rule) throw new LearningServiceError('rule is required', 'rule_required');
  if (rule.length > RULE_MAX) {
    throw new LearningServiceError(`rule too long (${RULE_MAX} char max)`, 'rule_too_long');
  }
  return rule;
}

export type LessonSource = 'operator' | 'draft_edit' | 'synthesis';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** An open transaction on the shared client (KL-02 writes inside it). */
export type LearningTx = Tx;

// ---- scope -----------------------------------------------------------------
//
// KL-01. A rule applies either to the whole workspace (scope_kind
// 'workspace') or to exactly the products in lesson_scopes (scope_kind
// 'products'). NULL never means "everywhere". Both lesson_scopes FKs are
// composite on workspace_id, so the database refuses a scope row joining a
// rule to another tenant's product — createLesson / updateLesson rely on
// that instead of a check that a future caller could skip.

export type LessonScopeInput =
  | { kind: 'workspace' }
  | { kind: 'products'; productProfileIds: readonly bigint[] };

export const WORKSPACE_SCOPE: LessonScopeInput = { kind: 'workspace' };

/** Scope for callers that hold at most one product (an event, a draft). */
export function scopeForProduct(productProfileId: bigint | null | undefined): LessonScopeInput {
  return productProfileId !== null && productProfileId !== undefined
    ? { kind: 'products', productProfileIds: [productProfileId] }
    : WORKSPACE_SCOPE;
}

interface NormalizedScope {
  kind: LessonScopeKind;
  productProfileIds: bigint[];
}

const MAX_SCOPE_PRODUCTS = 100;

function normalizeScope(scope: LessonScopeInput | null | undefined): NormalizedScope {
  if (!scope || scope.kind === 'workspace') return { kind: 'workspace', productProfileIds: [] };
  if (scope.kind !== 'products') throw invalid('unknown scope kind');
  const ids = Array.from(new Set(scope.productProfileIds.map((id) => id.toString())))
    .map((s) => BigInt(s))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (ids.length === 0) throw scopeRequired();
  if (ids.length > MAX_SCOPE_PRODUCTS) throw invalid('too many products in one scope');
  return { kind: 'products', productProfileIds: ids };
}

function scopeRowExists(productProfileId?: bigint): SQL {
  const conds: SQL[] = [
    eq(lessonScopes.workspaceId, learningLessons.workspaceId),
    eq(lessonScopes.lessonId, learningLessons.id),
  ];
  if (productProfileId !== undefined) {
    conds.push(eq(lessonScopes.productProfileId, productProfileId));
  }
  return exists(db.select({ one: sql`1` }).from(lessonScopes).where(and(...conds)));
}

/**
 * THE scope predicate. Every reader that decides whether a rule applies
 * goes through it (retrieval, rerank, embedding, dedup, compaction, the
 * semantic lesson search):
 *
 *   scope_kind = 'workspace' OR EXISTS (lesson_scopes row [for this product])
 *
 * With a product id: workspace-wide rules plus the rules scoped to that
 * product. Without one ("any product" — the reply assistant, compaction):
 * workspace-wide rules plus product rules that still have a product. A
 * 'products' rule whose products were all deleted matches neither — it
 * applies nowhere until an operator re-scopes or retires it (I109).
 */
export function lessonInScope(productProfileId?: bigint): SQL {
  return or(eq(learningLessons.scopeKind, 'workspace'), scopeRowExists(productProfileId))!;
}

/** 'products' rules with no product left ("Needs a scope"). */
export function lessonNeedsScope(): SQL {
  return and(
    eq(learningLessons.scopeKind, 'products'),
    notExists(
      db
        .select({ one: sql`1` })
        .from(lessonScopes)
        .where(
          and(
            eq(lessonScopes.workspaceId, learningLessons.workspaceId),
            eq(lessonScopes.lessonId, learningLessons.id),
          ),
        ),
    ),
  )!;
}

async function insertScopeRows(
  tx: Tx,
  workspaceId: bigint,
  lessonId: bigint,
  scope: NormalizedScope,
): Promise<void> {
  if (scope.kind !== 'products' || scope.productProfileIds.length === 0) return;
  await tx.insert(lessonScopes).values(
    scope.productProfileIds.map((productProfileId) => ({
      lessonId,
      workspaceId,
      productProfileId,
    })),
  );
}

async function insertLessonWithScope(
  tx: Tx,
  row: NewLearningLesson,
  scope: NormalizedScope,
): Promise<LearningLesson> {
  const inserted = (
    await tx
      .insert(learningLessons)
      .values({ ...row, scopeKind: scope.kind })
      .returning()
  )[0];
  if (!inserted) throw invariant('learning_lessons insert returned no row');
  await insertScopeRows(tx, row.workspaceId, inserted.id, scope);
  return inserted;
}

/** Product ids each lesson is scoped to (workspace-scoped read). Lessons
 *  with scope_kind 'workspace' have no entry. */
export async function getLessonScopeProducts(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  lessonIds: readonly bigint[],
): Promise<Map<string, bigint[]>> {
  const out = new Map<string, bigint[]>();
  if (lessonIds.length === 0) return out;
  const rows = await db
    .select({
      lessonId: lessonScopes.lessonId,
      productProfileId: lessonScopes.productProfileId,
    })
    .from(lessonScopes)
    .where(
      and(
        eq(lessonScopes.workspaceId, ctx.workspaceId),
        inArray(lessonScopes.lessonId, [...lessonIds]),
      ),
    )
    .orderBy(lessonScopes.lessonId, lessonScopes.productProfileId);
  for (const r of rows) {
    const key = r.lessonId.toString();
    const list = out.get(key) ?? [];
    list.push(r.productProfileId);
    out.set(key, list);
  }
  return out;
}

// ---- auto-embedding ------------------------------------------------------

/**
 * Fire-and-forget embedding of a freshly created / edited lesson so the
 * semantic retrieval paths (reply-assistant, contextText reranking) see it
 * immediately instead of waiting for a manual bulk embed. Never throws —
 * a missing embedding provider only degrades retrieval to confidence order.
 */
export function scheduleLessonEmbedding(
  ctx: WorkspaceContext,
  lessonId: bigint,
): void {
  void import('./rag')
    .then(({ embedLesson }) => embedLesson(ctx, lessonId))
    .catch((err) =>
      console.error(
        `[learning] auto-embed failed for lesson ${lessonId}:`,
        err instanceof Error ? err.message : err,
      ),
    );
}

// ---- feedback recording ------------------------------------------------

export interface FeedbackInput {
  entityType?: string | null;
  entityId?: string | null;
  /** The product the event is about; an extracted rule is scoped to it
   *  (none = workspace-wide). */
  productProfileId?: bigint | null;
  /** Loose enum — common values are the lesson categories above. */
  actionType: string;
  originalComment?: string | null;
  confidence?: number;
}

/**
 * Append a feedback event and, when an extractor finds a clean signal,
 * also materialize a `learning_lessons` row linked back to the event.
 *
 * Extraction order: AI provider first (when configured + workspace context),
 * heuristic fallback on any AI failure or null. AI runs OUTSIDE the
 * transaction so the network call doesn't tie up a DB connection.
 */
export async function recordFeedback(
  ctx: WorkspaceContext,
  input: FeedbackInput,
): Promise<{ event: LearningEvent; lesson: LearningLesson | null }> {
  // Extraction + dedup lookup first (outside tx) so a slow / failing AI
  // call doesn't hold a transaction open.
  const prepared = await prepareLessonFromText(
    ctx,
    input.originalComment ?? null,
    scopeForProduct(input.productProfileId),
  );

  let result: { event: LearningEvent; lesson: LearningLesson | null; dedupReinforced: boolean };
  try {
    result = await db.transaction(async (tx) => {
      const eventRow: NewLearningEvent = {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        productProfileId: input.productProfileId ?? null,
        actionType: input.actionType,
        originalComment: input.originalComment ?? null,
        confidence: clampConfidence(input.confidence ?? 50),
      };

      const insertedEvent = (await tx.insert(learningEvents).values(eventRow).returning())[0];
      if (!insertedEvent) throw invariant('learning_events insert returned no row');

      const written = prepared
        ? await writePreparedLesson(tx, ctx, prepared, [insertedEvent.id])
        : { lesson: null, dedupReinforced: false };
      const lesson = written.lesson;
      const dedupReinforced = written.dedupReinforced;
      // Reflect the FK on the returned object — the post-INSERT snapshot
      // doesn't see the subsequent UPDATE.
      if (lesson) insertedEvent.extractedLessonId = lesson.id;

      await recordAuditEvent(ctx, {
        kind: 'learning.feedback',
        entityType: 'learning_event',
        entityId: insertedEvent.id,
        payload: {
          actionType: input.actionType,
          extractedLessonId: lesson?.id.toString() ?? null,
          dedupReinforced,
          productProfileId: input.productProfileId?.toString() ?? null,
        },
      });

      return { event: insertedEvent, lesson, dedupReinforced };
    });
  } catch (err) {
    throw mapScopeError(err);
  }
  // Outside the tx: embed only NEW lessons — a reinforced duplicate's
  // rule text didn't change, so its stored embedding is still right.
  if (result.lesson && !result.dedupReinforced) {
    scheduleLessonEmbedding(ctx, result.lesson.id);
  }
  return { event: result.event, lesson: result.lesson };
}

/** A rule extracted from a piece of operator text, ready to be written:
 *  either a brand-new rule or the near-duplicate it repeats. */
export interface PreparedLesson {
  draft: LessonDraft;
  scope: { kind: LessonScopeKind; productProfileIds: bigint[] };
  /** The existing rule this one repeats; writing then reinforces it. */
  duplicate: LearningLesson | null;
}

/**
 * Extract a rule from operator text and look for a near-duplicate in the
 * same scope. Runs OUTSIDE any transaction (it may call the AI provider
 * and the embedder). Never throws for extraction trouble — extractLesson
 * falls back to the heuristic — and returns null when the text carries no
 * reusable rule. Shared by recordFeedback and the decision processor
 * (learning-decisions.ts), so a decision's reason is extracted ONCE however
 * many products it covers (I032).
 */
export async function prepareLessonFromText(
  ctx: WorkspaceContext,
  text: string | null,
  /** The rule's scope, or a function choosing it from the extracted draft
   *  (e.g. by its polarity); returning null means "no rule". */
  scopeInput:
    | LessonScopeInput
    | ((draft: LessonDraft) => Promise<LessonScopeInput | null> | LessonScopeInput | null),
): Promise<PreparedLesson | null> {
  const draft = await extractLesson(ctx, text);
  if (!draft) return null;
  const chosen = typeof scopeInput === 'function' ? await scopeInput(draft) : scopeInput;
  if (!chosen) return null;
  const scope = normalizeScope(chosen);
  // A repeat of an already-known rule reinforces the existing lesson
  // instead of planting a near-identical sibling.
  const duplicate = await findNearDuplicateLesson(ctx, {
    category: draft.category,
    rule: draft.rule,
    polarity: draft.polarity,
    scope,
  });
  return { draft, scope, duplicate };
}

/**
 * Write a prepared rule inside the caller's transaction and link the
 * evidence events to it: a duplicate is reinforced (+5, evidence merged),
 * otherwise a new active rule is inserted with its scope rows. The caller
 * maps a scope FK violation (mapScopeError) and schedules the embedding
 * for a new rule after commit.
 */
export async function writePreparedLesson(
  tx: LearningTx,
  ctx: WorkspaceContext,
  prepared: PreparedLesson,
  evidenceEventIds: readonly bigint[],
): Promise<{ lesson: LearningLesson | null; dedupReinforced: boolean }> {
  const { draft, duplicate } = prepared;
  const linkEvents = async (lessonId: bigint) => {
    if (evidenceEventIds.length === 0) return;
    await tx
      .update(learningEvents)
      .set({ extractedLessonId: lessonId })
      .where(
        and(
          eq(learningEvents.workspaceId, ctx.workspaceId),
          inArray(learningEvents.id, [...evidenceEventIds]),
        ),
      );
  };
  if (duplicate) {
    // Reinforce inside the tx so event-link + confidence bump are atomic.
    const evidence = Array.from(
      new Set<bigint>([...duplicate.evidenceEventIds, ...evidenceEventIds]),
    );
    const [updated] = await tx
      .update(learningLessons)
      .set({
        confidence: sql`LEAST(${learningLessons.confidence} + ${DEDUP_REINFORCE_STEP}, ${DEDUP_CONFIDENCE_CEILING})`,
        evidenceEventIds: evidence,
        reinforcedAt: new Date(),
        updatedAt: new Date(),
        updatedBy: ctx.userId,
      })
      .where(
        and(
          eq(learningLessons.workspaceId, ctx.workspaceId),
          eq(learningLessons.id, duplicate.id),
        ),
      )
      .returning();
    if (!updated) return { lesson: null, dedupReinforced: false };
    await linkEvents(updated.id);
    return { lesson: updated, dedupReinforced: true };
  }
  const inserted = await insertLessonWithScope(
    tx,
    {
      workspaceId: ctx.workspaceId,
      category: draft.category,
      rule: draft.rule,
      polarity: draft.polarity,
      evidenceEventIds: [...evidenceEventIds],
      lifecycle: 'active',
      confidence: draft.confidence,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    },
    prepared.scope,
  );
  await linkEvents(inserted.id);
  return { lesson: inserted, dedupReinforced: false };
}

// ---- extractor (AI first, heuristic fallback) -------------------------

export interface LessonDraft {
  category: LessonCategory;
  rule: string;
  confidence: number;
  polarity: LessonPolarity;
}

/**
 * Try the workspace's AI provider first; fall back to the heuristic on any
 * error. Never throws — extraction failures must never break the event
 * write that called us.
 */
export async function extractLesson(
  ctx: WorkspaceContext,
  comment: string | null,
): Promise<LessonDraft | null> {
  if (!comment) return null;
  const trimmed = comment.trim();
  if (trimmed.length < 8) return null;
  try {
    const ai = await extractLessonAI(ctx, trimmed);
    if (ai) return ai;
  } catch (err) {
    // Provider not configured, network error, schema-validation failure on
    // mock provider, etc. Fall back to the deterministic heuristic.
    console.error('[learning.extractLesson] AI extraction failed:', err);
  }
  return extractLessonHeuristic(trimmed);
}

function polarityHint(category: LessonCategory): string {
  const allowed = LESSON_CATEGORY_REGISTRY[category].polarity.allowed as readonly number[];
  if (allowed.length === 1) {
    return allowed[0] === 1 ? 'always prefer' : allowed[0] === -1 ? 'always avoid' : 'neutral';
  }
  return allowed.includes(0) ? 'prefer, avoid or neutral' : 'prefer or avoid';
}

/** Built from the category registry, so the extractor can only ever name
 *  a category something consumes. */
export const EXTRACTOR_SYSTEM_PROMPT = `You categorize a single operator note into ONE lesson the lead-discovery platform will reuse.

Allowed categories (pick the most specific):
${LESSON_CATEGORIES.map(
  (c) => `- ${c}: ${LESSON_CATEGORY_REGISTRY[c].description} (${polarityHint(c)})`,
).join('\n')}

Return a strict JSON object: {"category": "<one of the above or null>", "rule": "<a generalized one-sentence rule>", "polarity": "prefer" | "avoid" | "neutral", "confidence": <integer 0-100>}.
- "rule" must generalize from the specific example so the platform can match similar cases later.
- "polarity" says whether the rule pushes toward approving similar records (prefer), against (avoid), or is neutral guidance.
- If the note carries no reusable signal, return {"category": null, "rule": "", "polarity": "neutral", "confidence": 0}.
- Output JSON only, no prose.`;

const ExtractorResultSchema = z.object({
  category: z.string().nullable(),
  rule: z.string(),
  confidence: z.number().int().min(0).max(100),
  polarity: z.string().nullable().optional(),
});

export async function extractLessonAI(
  ctx: WorkspaceContext,
  comment: string,
): Promise<LessonDraft | null> {
  const provider = await getAIProviderForCtx(ctx);
  const result = await provider.generateJson(
    {
      system: EXTRACTOR_SYSTEM_PROMPT,
      prompt: `Operator note:\n"""${comment}"""`,
    },
    ExtractorResultSchema,
    {
      maxTokens: 256,
      temperature: 0,
      // Mock provider seeds on the prompt; including a stable marker lets
      // tests deterministically inject a JSON response via mockSeed.
      mockSeed: `learning.extract:${comment}`,
    },
  );

  // Audit + cost: a lesson extraction is a billable AI call. Best-effort —
  // a usage-log write failure must not lose a successful extraction.
  try {
    await recordUsage(ctx, {
      kind: 'ai.learning_extract',
      provider: provider.id,
      units: 1n,
      costEstimateCents: 0,
      payload: { model: provider.model },
    });
  } catch (err) {
    console.error('[learning.extractLessonAI] recordUsage failed:', err);
  }

  // Only registry categories: a removed or invented one is no lesson.
  if (!result.category || !isLessonCategory(result.category)) return null;
  const rule = result.rule.trim();
  if (!rule) return null;
  const category = result.category;
  const truncated = rule.slice(0, RULE_MAX);
  return {
    category,
    rule: truncated,
    confidence: clampConfidence(result.confidence),
    polarity: polarityForRule(category, truncated, parseLessonPolarity(result.polarity)),
  };
}

/**
 * Cheap pattern-matching extractor. Looks for clear directional signals in
 * the comment and produces a draft lesson when found. Returns null when the
 * comment is too low-signal — those are kept only as raw events.
 *
 * The patterns are deliberately conservative; false positives would teach
 * the future AI/rule engine the wrong things. Operators can disable any
 * lesson the heuristic produces from the /learning page. It only emits
 * registry categories (dedupe_hint / connector_quality are gone, KL-01).
 */
export function extractLessonHeuristic(comment: string | null): LessonDraft | null {
  if (!comment) return null;
  const trimmed = comment.trim();
  if (trimmed.length < 8) return null;
  const lower = trimmed.toLowerCase();
  const draft = (category: LessonCategory, confidence: number): LessonDraft => ({
    category,
    rule: trimmed,
    confidence,
    polarity: polarityForRule(category, trimmed),
  });

  // Order matters: more-specific signals win.
  if (/\b(false positive|wrong fit|wrongly classified|misqualified)\b/.test(lower)) {
    return draft('false_positive', 70);
  }
  if (/\b(false negative|missed lead|should have been approved)\b/.test(lower)) {
    return draft('false_negative', 70);
  }
  if (/\b(don't|do not|avoid|skip|never|exclude|not relevant|not interested)\b/.test(lower)) {
    return draft('qualification_negative', 65);
  }
  if (/\b(perfect|ideal|excellent fit|good fit|exactly the kind|target|focus)\b/.test(lower)) {
    return draft('qualification_positive', 65);
  }
  if (/\b(tone|formal|casual|too long|too short|robotic|wording|style)\b/.test(lower)) {
    return draft('outreach_style', 60);
  }
  if (/\b(procurement|engineer|architect|cmo|cto|ceo|head of|director of)\b/.test(lower)) {
    return draft('contact_role', 60);
  }
  if (/\b(sector|industry|construction|finance|retail|tender|government)\b/.test(lower)) {
    return draft('sector_preference', 55);
  }
  return null;
}

// ---- listing -----------------------------------------------------------

export interface ListLessonsFilter {
  category?: LessonCategory | readonly LessonCategory[];
  /** Scope filter:
   *   undefined — any scope (the /learning console lists everything);
   *   null      — workspace-wide rules only;
   *   bigint    — rules scoped to that product (plus the workspace-wide
   *               ones with includeWorkspaceWide: lessonInScope(pid)). */
  productProfileId?: bigint | null;
  /** With a bigint productProfileId: widen the scope to (that product OR
   *  workspace-wide). Lets qualification/outreach fetch both scopes in
   *  ONE query + ONE embedding rerank instead of two of each. */
  includeWorkspaceWide?: boolean;
  /** Without a productProfileId: only rules that apply somewhere
   *  (lessonInScope()). Every retrieval path sets it. */
  inScopeOnly?: boolean;
  /** Only 'products' rules with no product left ("Needs a scope"). */
  needsScope?: boolean;
  lifecycle?: LessonLifecycle | readonly LessonLifecycle[];
  limit?: number;
  offset?: number;
}

function buildLessonConditions(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: Omit<ListLessonsFilter, 'limit' | 'offset'>,
): SQL[] | null {
  const conds: SQL[] = [eq(learningLessons.workspaceId, ctx.workspaceId)];
  if (filter.category !== undefined) {
    if (Array.isArray(filter.category)) {
      if (filter.category.length === 0) return null;
      conds.push(inArray(learningLessons.category, filter.category as string[]));
    } else {
      conds.push(eq(learningLessons.category, filter.category as string));
    }
  }
  if (filter.productProfileId === null) {
    conds.push(eq(learningLessons.scopeKind, 'workspace'));
  } else if (filter.productProfileId !== undefined) {
    conds.push(lessonInScope(filter.productProfileId));
    // Without includeWorkspaceWide: that product's own rules only.
    if (!filter.includeWorkspaceWide) conds.push(eq(learningLessons.scopeKind, 'products'));
  } else if (filter.inScopeOnly) {
    conds.push(lessonInScope());
  }
  if (filter.needsScope) conds.push(lessonNeedsScope());
  if (filter.lifecycle !== undefined) {
    if (Array.isArray(filter.lifecycle)) {
      if (filter.lifecycle.length === 0) return null;
      conds.push(inArray(learningLessons.lifecycle, filter.lifecycle as LessonLifecycle[]));
    } else {
      conds.push(eq(learningLessons.lifecycle, filter.lifecycle as LessonLifecycle));
    }
  }
  return conds;
}

export async function listLessons(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: ListLessonsFilter = {},
): Promise<LearningLesson[]> {
  const conds = buildLessonConditions(ctx, filter);
  if (conds === null) return [];
  const limit = clamp(filter.limit, 200, 1000);
  const offset = filter.offset !== undefined && Number.isFinite(filter.offset) && filter.offset > 0
    ? Math.floor(filter.offset)
    : 0;
  return db
    .select()
    .from(learningLessons)
    .where(and(...conds))
    .orderBy(desc(learningLessons.confidence), desc(learningLessons.updatedAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Count lessons matching the same filter as listLessons (excluding limit /
 * offset). Powers the pagination UI on /learning.
 */
export async function countLessons(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: Omit<ListLessonsFilter, 'limit' | 'offset'> = {},
): Promise<number> {
  const conds = buildLessonConditions(ctx, filter);
  if (conds === null) return 0;
  const result = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(learningLessons)
    .where(and(...conds));
  return result[0]?.value ?? 0;
}

export type LessonCategoryCounts = Record<LessonCategory, number> & { total: number };

/**
 * Per-category lesson counts for the workspace, plus a `total` (which also
 * counts legacy rows whose category left the registry). Used to render
 * count badges on the /learning category tabs. `lifecycle` filters the
 * same way as listLessons.
 */
export async function getLessonCategoryCounts(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: { lifecycle?: LessonLifecycle | readonly LessonLifecycle[] } = {},
): Promise<LessonCategoryCounts> {
  const init = Object.fromEntries(
    LESSON_CATEGORIES.map((c) => [c, 0]),
  ) as Record<LessonCategory, number>;
  const counts: LessonCategoryCounts = { ...init, total: 0 };
  const conds = buildLessonConditions(ctx, { lifecycle: filter.lifecycle });
  if (conds === null) return counts;
  const rows = await db
    .select({
      category: learningLessons.category,
      count: sql<number>`count(*)::int`,
    })
    .from(learningLessons)
    .where(and(...conds))
    .groupBy(learningLessons.category);

  for (const row of rows) {
    if (isLessonCategory(row.category)) {
      counts[row.category] = row.count;
    }
    counts.total += row.count;
  }
  return counts;
}

export async function getLesson(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<LearningLesson> {
  const rows = await db
    .select()
    .from(learningLessons)
    .where(
      and(eq(learningLessons.workspaceId, ctx.workspaceId), eq(learningLessons.id, id)),
    );
  const lesson = rows[0];
  if (!lesson) throw notFound();
  return lesson;
}

// ---- create-time dedup -------------------------------------------------
//
// Before this existed, every repeated operator comment ("avoid
// consultancies", written across 15 reviews) materialized 15 near-identical
// lessons: 15 embeddings, 15 prompt-budget slots, and weekly AI merge calls
// to clean up after the fact. Deduping at CREATE time turns repetition into
// what it actually is — accumulating evidence for ONE rule: the existing
// lesson gets a confidence bump and the new event unioned into its
// evidence chain, and no duplicate row is born.

/** Cosine similarity at/above which two rules in the same (category,
 *  scope) cluster count as the same lesson. Conservative — compaction's
 *  AI merge still catches paraphrases below this line. */
const DEDUP_SIMILARITY_THRESHOLD = 0.92;
/** Confidence bump when repeated evidence confirms an existing lesson.
 *  Stronger than an outcome-reinforcement (+2): an operator writing the
 *  same thing again is deliberate confirmation. */
const DEDUP_REINFORCE_STEP = 5;
const DEDUP_CONFIDENCE_CEILING = 95;

function sameIds(a: readonly bigint[], b: readonly bigint[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Find an active lesson with the same category, polarity and EXACT scope
 * (workspace-wide, or the identical product set) that says the same thing
 * as `rule`. Exact (case-insensitive) text match is checked first — free;
 * then embedding similarity when an embedding provider is available.
 * Returns null on any failure — dedup is an optimization, never a gate.
 */
export async function findNearDuplicateLesson(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  input: {
    category: LessonCategory;
    rule: string;
    polarity?: LessonPolarity;
    scope: LessonScopeInput | NormalizedScope;
  },
): Promise<LearningLesson | null> {
  try {
    const scope = normalizeScope(input.scope as LessonScopeInput);
    const conds: SQL[] = [
      eq(learningLessons.workspaceId, ctx.workspaceId),
      eq(learningLessons.category, input.category),
      eq(learningLessons.lifecycle, 'active'),
      eq(learningLessons.scopeKind, scope.kind),
    ];
    if (input.polarity !== undefined) conds.push(eq(learningLessons.polarity, input.polarity));
    // In scope for the first product (or anywhere, for a workspace rule);
    // the exact product set is compared below.
    conds.push(lessonInScope(scope.productProfileIds[0]));
    let candidates = await db
      .select()
      .from(learningLessons)
      .where(and(...conds))
      .orderBy(desc(learningLessons.confidence))
      .limit(200);
    if (scope.kind === 'products' && candidates.length > 0) {
      const scopes = await getLessonScopeProducts(
        ctx,
        candidates.map((c) => c.id),
      );
      candidates = candidates.filter((c) =>
        sameIds(scopes.get(c.id.toString()) ?? [], scope.productProfileIds),
      );
    }
    if (candidates.length === 0) return null;

    const norm = input.rule.trim().toLowerCase();
    const exact = candidates.find((c) => c.rule.trim().toLowerCase() === norm);
    if (exact) return exact;

    const embeddable = candidates.filter(
      (c) => c.embedding && c.embedding.length > 0,
    );
    if (embeddable.length === 0) return null;
    const { getEmbeddingProviderForCtx } = await import('@/lib/embeddings');
    const embedder = await getEmbeddingProviderForCtx(ctx as WorkspaceContext);
    const result = await embedder.embed({ texts: [input.rule.slice(0, 2000)] });
    const vec = result.embeddings[0];
    if (!vec) return null;

    let best: { lesson: LearningLesson; sim: number } | null = null;
    for (const c of embeddable) {
      if (c.embedding!.length !== vec.length) continue;
      const sim = cosineSimilarity(c.embedding!, vec);
      if (!best || sim > best.sim) best = { lesson: c, sim };
    }
    return best && best.sim >= DEDUP_SIMILARITY_THRESHOLD ? best.lesson : null;
  } catch (err) {
    console.error(
      '[learning.findNearDuplicateLesson] dedup check failed (creating anyway):',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Repeated-evidence reinforcement: bump the duplicate's confidence, union
 * the new evidence event ids into its chain, and audit. Returns the
 * refreshed lesson row.
 */
async function reinforceDuplicateLesson(
  ctx: WorkspaceContext,
  existing: LearningLesson,
  newEvidenceEventIds: readonly bigint[],
): Promise<LearningLesson> {
  const evidence = Array.from(
    new Set<bigint>([...existing.evidenceEventIds, ...newEvidenceEventIds]),
  );
  const [updated] = await db
    .update(learningLessons)
    .set({
      confidence: sql`LEAST(${learningLessons.confidence} + ${DEDUP_REINFORCE_STEP}, ${DEDUP_CONFIDENCE_CEILING})`,
      evidenceEventIds: evidence,
      reinforcedAt: new Date(),
      updatedAt: new Date(),
      updatedBy: ctx.userId,
    })
    .where(
      and(
        eq(learningLessons.workspaceId, ctx.workspaceId),
        eq(learningLessons.id, existing.id),
      ),
    )
    .returning();
  await recordAuditEvent(ctx, {
    kind: 'learning.lesson.dedup_reinforce',
    entityType: 'learning_lesson',
    entityId: existing.id,
    payload: {
      addedEvidence: newEvidenceEventIds.map((id) => id.toString()),
    },
  });
  return updated ?? existing;
}

// ---- mutations ---------------------------------------------------------

export interface CreateLessonInput {
  category: LessonCategory;
  rule: string;
  /** Where the rule applies. Defaults to workspace-wide. */
  scope?: LessonScopeInput;
  /** +1 PREFER / -1 AVOID / 0 neutral. Must be allowed for the category;
   *  omitted = read from the wording where the category allows either
   *  direction (polarityForRule), else the category's polarity. */
  polarity?: LessonPolarity;
  confidence?: number;
  /** Provenance shown on /learning. Defaults to 'operator'. */
  source?: LessonSource;
  evidenceEventIds?: readonly bigint[];
  /** 'proposed' parks a platform suggestion until an operator accepts it. */
  lifecycle?: 'active' | 'proposed';
}

export async function createLesson(
  ctx: WorkspaceContext,
  input: CreateLessonInput,
): Promise<LearningLesson> {
  if (!canWrite(ctx)) throw permissionDenied('create lesson');
  const category = assertCategory(input.category);
  const rule = validateRule(input.rule);
  if (input.polarity !== undefined && !isPolarityAllowed(category, input.polarity)) {
    throw new LearningServiceError(
      `polarity ${input.polarity} is not allowed for ${category}`,
      'invalid_polarity',
    );
  }
  // No explicit direction: read it from the wording where the category
  // lets the rule choose ("Avoid councils" filed as a sector preference is
  // an AVOID rule), else the category's fixed / default polarity.
  const polarity = polarityForRule(category, rule, input.polarity);
  const scope = normalizeScope(input.scope);
  const lifecycle = input.lifecycle ?? 'active';

  // Same rule already known in this scope → reinforce it instead of
  // planting a duplicate (see the dedup section above).
  if (lifecycle === 'active') {
    const duplicate = await findNearDuplicateLesson(ctx, { category, rule, polarity, scope });
    if (duplicate) {
      return reinforceDuplicateLesson(ctx, duplicate, input.evidenceEventIds ?? []);
    }
  }

  let inserted: LearningLesson;
  try {
    inserted = await db.transaction(async (tx) => {
      const row = await insertLessonWithScope(
        tx,
        {
          workspaceId: ctx.workspaceId,
          category,
          rule,
          polarity,
          source: input.source ?? 'operator',
          evidenceEventIds: input.evidenceEventIds ? [...input.evidenceEventIds] : [],
          lifecycle,
          confidence: clampConfidence(input.confidence ?? 65),
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        },
        scope,
      );
      await recordAuditEvent(ctx, {
        kind: 'learning.lesson.create',
        entityType: 'learning_lesson',
        entityId: row.id,
        payload: {
          category: row.category,
          source: row.source,
          polarity: row.polarity,
          lifecycle: row.lifecycle,
          scopeKind: scope.kind,
          productProfileIds: scope.productProfileIds.map((id) => id.toString()),
        },
      });
      return row;
    });
  } catch (err) {
    throw mapScopeError(err);
  }

  scheduleLessonEmbedding(ctx, inserted.id);
  return inserted;
}

export interface UpdateLessonInput {
  rule?: string;
  category?: LessonCategory;
  polarity?: LessonPolarity;
  confidence?: number;
  /** Operator lifecycle moves: 'active' (enable, accept a proposal, or —
   *  admins only — restore a retired rule) or 'disabled'. Retiring goes
   *  through retireLessons. */
  lifecycle?: 'active' | 'disabled';
  /** Replace the rule's scope. */
  scope?: LessonScopeInput;
}

export async function updateLesson(
  ctx: WorkspaceContext,
  id: bigint,
  patch: UpdateLessonInput,
): Promise<LearningLesson> {
  if (!canWrite(ctx)) throw permissionDenied('update lesson');

  let updated: LearningLesson;
  try {
    updated = await db.transaction(async (tx) => {
      const existing = (
        await tx
          .select()
          .from(learningLessons)
          .where(
            and(eq(learningLessons.workspaceId, ctx.workspaceId), eq(learningLessons.id, id)),
          )
          .for('update')
      )[0];
      if (!existing) throw notFound();

      const updates: Partial<NewLearningLesson> & { updatedAt: Date } = {
        updatedBy: ctx.userId,
        updatedAt: new Date(),
      };
      if (patch.rule !== undefined) {
        updates.rule = validateRule(patch.rule);
      }
      // Only a CHANGED category is validated, so a legacy rule whose
      // category left the registry can still have its text edited.
      const categoryChanged =
        patch.category !== undefined && patch.category !== existing.category;
      if (categoryChanged) {
        updates.category = assertCategory(patch.category!);
      }
      const finalCategory = updates.category ?? existing.category;
      const polarityChanged =
        patch.polarity !== undefined && patch.polarity !== existing.polarity;
      if (polarityChanged || (patch.polarity !== undefined && categoryChanged)) {
        const category = assertCategory(finalCategory);
        if (!isPolarityAllowed(category, patch.polarity!)) {
          throw new LearningServiceError(
            `polarity ${patch.polarity} is not allowed for ${category}`,
            'invalid_polarity',
          );
        }
        updates.polarity = patch.polarity!;
      } else if (categoryChanged) {
        // Keep the rule's direction when the new category allows it.
        updates.polarity = resolveLessonPolarity(
          assertCategory(finalCategory),
          existing.polarity,
        );
      }
      if (patch.confidence !== undefined) {
        updates.confidence = clampConfidence(patch.confidence);
      }

      let scopeChange: NormalizedScope | null = null;
      if (patch.scope !== undefined) {
        const next = normalizeScope(patch.scope);
        const current = (
          await tx
            .select({ productProfileId: lessonScopes.productProfileId })
            .from(lessonScopes)
            .where(
              and(
                eq(lessonScopes.workspaceId, ctx.workspaceId),
                eq(lessonScopes.lessonId, existing.id),
              ),
            )
            .orderBy(lessonScopes.productProfileId)
        ).map((r) => r.productProfileId);
        const unchanged =
          next.kind === existing.scopeKind && sameIds(current, next.productProfileIds);
        if (!unchanged) {
          scopeChange = next;
          updates.scopeKind = next.kind;
          await tx
            .delete(lessonScopes)
            .where(
              and(
                eq(lessonScopes.workspaceId, ctx.workspaceId),
                eq(lessonScopes.lessonId, existing.id),
              ),
            );
          await insertScopeRows(tx, ctx.workspaceId, existing.id, next);
        }
      }

      let lifecycleChange: { from: LessonLifecycle; to: LessonLifecycle } | null = null;
      if (patch.lifecycle !== undefined && patch.lifecycle !== existing.lifecycle) {
        if (patch.lifecycle === 'disabled') {
          if (existing.lifecycle === 'retired') {
            throw new LearningServiceError(
              'a retired rule is already out of service',
              'lifecycle_conflict',
            );
          }
        } else {
          if (existing.lifecycle === 'retired') {
            if (!canAdminWorkspace(ctx)) throw permissionDenied('restore retired lesson');
            updates.retiredReason = null;
            updates.retiredNote = null;
            updates.mergedIntoId = null;
          }
          // Only a rule the platform can actually apply may go live: a
          // known category, and a product scope that still has a product.
          assertCategory(finalCategory);
          const finalKind = scopeChange?.kind ?? existing.scopeKind;
          if (finalKind === 'products' && !scopeChange) {
            const rows = await tx
              .select({ one: sql`1` })
              .from(lessonScopes)
              .where(
                and(
                  eq(lessonScopes.workspaceId, ctx.workspaceId),
                  eq(lessonScopes.lessonId, existing.id),
                ),
              )
              .limit(1);
            if (rows.length === 0) throw scopeRequired();
          }
        }
        updates.lifecycle = patch.lifecycle;
        lifecycleChange = { from: existing.lifecycle, to: patch.lifecycle };
      }

      const row = (
        await tx
          .update(learningLessons)
          .set(updates)
          .where(
            and(eq(learningLessons.workspaceId, ctx.workspaceId), eq(learningLessons.id, id)),
          )
          .returning()
      )[0];
      if (!row) throw invariant('learning_lessons update returned no row');

      await recordAuditEvent(ctx, {
        kind: 'learning.lesson.update',
        entityType: 'learning_lesson',
        entityId: row.id,
        payload: {
          changedKeys: Object.keys(updates).filter(
            (k) => k !== 'updatedAt' && k !== 'updatedBy',
          ),
          ...(lifecycleChange ? { lifecycle: lifecycleChange } : {}),
          ...(scopeChange
            ? {
                scope: {
                  kind: scopeChange.kind,
                  productProfileIds: scopeChange.productProfileIds.map((p) => p.toString()),
                },
              }
            : {}),
        },
      });

      return row;
    });
  } catch (err) {
    throw mapScopeError(err);
  }
  // Rule text changed → the stored embedding is stale; refresh it.
  if (patch.rule !== undefined) scheduleLessonEmbedding(ctx, updated.id);
  return updated;
}

export const enableLesson = (ctx: WorkspaceContext, id: bigint) =>
  updateLesson(ctx, id, { lifecycle: 'active' });
export const disableLesson = (ctx: WorkspaceContext, id: bigint) =>
  updateLesson(ctx, id, { lifecycle: 'disabled' });

/**
 * Take rules out of service for a recorded reason. Workspace-scoped; rules
 * already retired are left alone (their first reason stands). Returns the
 * ids that actually changed. Runs on the caller's transaction so a merge
 * and its retirements commit together.
 */
export async function retireLessons(
  tx: Tx,
  workspaceId: bigint,
  ids: readonly bigint[],
  opts: { reason: LessonRetiredReason; note?: string | null; mergedIntoId?: bigint | null },
): Promise<bigint[]> {
  if (ids.length === 0) return [];
  const conds: SQL[] = [
    eq(learningLessons.workspaceId, workspaceId),
    inArray(learningLessons.id, [...ids]),
    ne(learningLessons.lifecycle, 'retired'),
  ];
  if (opts.mergedIntoId !== undefined && opts.mergedIntoId !== null) {
    conds.push(ne(learningLessons.id, opts.mergedIntoId));
  }
  const rows = await tx
    .update(learningLessons)
    .set({
      lifecycle: 'retired',
      retiredReason: opts.reason,
      retiredNote: opts.note ?? null,
      mergedIntoId: opts.mergedIntoId ?? null,
      updatedAt: new Date(),
    })
    .where(and(...conds))
    .returning({ id: learningLessons.id });
  return rows.map((r) => r.id);
}

const BULK_LESSON_LIMIT = 500;

/**
 * Enable or disable a batch of lessons in one statement. Workspace-scoped
 * via WHERE so foreign ids silently no-op. member+ gating mirrors the
 * single-row enable/disable. Enabling moves disabled/proposed rules to
 * active — but never a retired rule (restore is an admin action on its
 * page), a rule whose category left the registry, or a product rule with
 * no product left. Disabling moves active/proposed rules to disabled.
 * Returns the rows that actually changed so the UI can flash an accurate
 * "Disabled N of M" message.
 */
export async function bulkSetLessonsEnabled(
  ctx: WorkspaceContext,
  ids: readonly bigint[],
  enabled: boolean,
): Promise<{ updated: number; requested: number }> {
  if (!canWrite(ctx)) throw permissionDenied('update lessons');
  const cappedIds = ids.slice(0, BULK_LESSON_LIMIT);
  if (cappedIds.length === 0) return { updated: 0, requested: ids.length };
  const target: LessonLifecycle = enabled ? 'active' : 'disabled';
  const eligible: SQL = enabled
    ? and(
        inArray(learningLessons.lifecycle, ['disabled', 'proposed']),
        inArray(learningLessons.category, [...LESSON_CATEGORIES]),
        lessonInScope(),
      )!
    : inArray(learningLessons.lifecycle, ['active', 'proposed']);
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(learningLessons)
      .set({ lifecycle: target, updatedAt: new Date(), updatedBy: ctx.userId })
      .where(
        and(
          eq(learningLessons.workspaceId, ctx.workspaceId),
          inArray(learningLessons.id, cappedIds as bigint[]),
          eligible,
        ),
      )
      .returning({ id: learningLessons.id });
    if (updated.length > 0) {
      await recordAuditEvent(ctx, {
        kind: enabled ? 'learning.lesson.bulk_enable' : 'learning.lesson.bulk_disable',
        entityType: 'learning_lesson',
        entityId: null,
        payload: { ids: updated.map((u) => u.id.toString()), count: updated.length },
      });
    }
    return { updated: updated.length, requested: ids.length };
  });
}

// ---- retrieval (for prompts/rules) ------------------------------------

export interface LessonQuery {
  /** bigint: that product's rules (plus workspace-wide ones with
   *  includeWorkspaceLessons). null: workspace-wide rules only.
   *  undefined: every rule that applies somewhere. */
  productProfileId?: bigint | null;
  /** With a bigint productProfileId: also include workspace-wide lessons
   *  in the same query. Preferred over calling twice (once per scope) —
   *  one DB fetch, one embedding call, one rerank over the union. */
  includeWorkspaceLessons?: boolean;
  category?: LessonCategory | readonly LessonCategory[];
  /** The consuming task; its categories come from the category registry. */
  taskType?: LessonTaskType;
  /** Free-text the caller is about to act on (subject, snippet, etc.). Phase 5 ignores; Phase 12 ranks by similarity. */
  contextText?: string;
  limit?: number;
}

/**
 * Retrieval: active rules in scope (lessonInScope), filtered by the task's
 * registry categories, ranked by confidence then recency. When the caller
 * provides `contextText` AND the candidate pool exceeds the limit (prompt
 * budget), rerank by embedding similarity so the lessons most relevant to
 * the record at hand win a slot instead of just the most confident ones.
 * Falls back to confidence order on any embedding failure — retrieval must
 * never break a caller.
 */
export async function getRelevantLessons(
  ctx: WorkspaceContext,
  query: LessonQuery = {},
): Promise<LearningLesson[]> {
  const categories = resolveCategoriesForTask(query);
  const limit = query.limit ?? 20;
  const filter: ListLessonsFilter = { lifecycle: 'active', inScopeOnly: true, limit };
  if (categories) filter.category = categories;
  if (query.productProfileId !== undefined) filter.productProfileId = query.productProfileId;
  if (query.includeWorkspaceLessons) filter.includeWorkspaceWide = true;

  const contextText = query.contextText?.trim();
  if (contextText) {
    try {
      const total = await countLessons(ctx, filter);
      if (total > limit) {
        return await rerankLessonsBySimilarity(ctx, filter, contextText, limit);
      }
    } catch (err) {
      console.error(
        '[learning.getRelevantLessons] semantic rerank failed, using confidence order:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  return listLessons(ctx, filter);
}

const RERANK_CANDIDATE_CAP = 200;
/** Similarity dominates but confidence still matters — a barely-related
 *  high-confidence rule shouldn't beat a directly-relevant mid one. */
const RERANK_SIMILARITY_WEIGHT = 0.7;

async function rerankLessonsBySimilarity(
  ctx: WorkspaceContext,
  filter: ListLessonsFilter,
  contextText: string,
  limit: number,
): Promise<LearningLesson[]> {
  const candidates = await listLessons(ctx, { ...filter, limit: RERANK_CANDIDATE_CAP });
  const { getEmbeddingProviderForCtx } = await import('@/lib/embeddings');
  const embedder = await getEmbeddingProviderForCtx(ctx);
  const result = await embedder.embed({ texts: [contextText.slice(0, 2000)] });
  const queryVec = result.embeddings[0];
  if (!queryVec) return candidates.slice(0, limit);

  const scored = candidates.map((lesson) => {
    const sim =
      lesson.embedding && lesson.embedding.length === queryVec.length
        ? cosineSimilarity(lesson.embedding, queryVec)
        : 0;
    return {
      lesson,
      score:
        sim * RERANK_SIMILARITY_WEIGHT +
        (lesson.confidence / 100) * (1 - RERANK_SIMILARITY_WEIGHT),
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.lesson);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * The categories a retrieval reads: an explicit category list wins;
 * otherwise the task's categories from the registry (so a category is
 * fetched exactly where the registry says it is consumed); no task and no
 * category means every category.
 */
export function resolveCategoriesForTask(
  query: Pick<LessonQuery, 'category' | 'taskType'>,
): LessonCategory[] | undefined {
  if (query.category !== undefined) {
    return Array.isArray(query.category)
      ? (query.category as LessonCategory[])
      : [query.category as LessonCategory];
  }
  return query.taskType ? categoriesForTaskType(query.taskType) : undefined;
}

/**
 * Append lesson rules to a base prompt as numbered guidelines. Used by
 * qualification/draft prompts in later phases.
 */
export function applyLessonsToPrompt(
  basePrompt: string,
  lessons: ReadonlyArray<LearningLesson>,
): string {
  if (lessons.length === 0) return basePrompt;
  const guidelines = lessons
    .map((l, i) => `${i + 1}. [${l.category}] ${l.rule}`)
    .join('\n');
  return `${basePrompt}\n\nWorkspace-specific guidelines (in priority order):\n${guidelines}`;
}

/**
 * Mark the given lessons as applied — bumps application_count + sets
 * last_applied_at=NOW(). Callers pass this once per real "lesson used in
 * a scoring/prompt step" event. Workspace-scoped guard so a misbehaving
 * caller can't bump lessons from another tenant. Never throws — metrics
 * write must not break the business call that triggered it.
 */
export async function recordLessonsApplied(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  lessonIds: readonly bigint[],
): Promise<void> {
  if (lessonIds.length === 0) return;
  try {
    await db
      .update(learningLessons)
      .set({
        applicationCount: sql`${learningLessons.applicationCount} + 1`,
        lastAppliedAt: new Date(),
      })
      .where(
        and(
          eq(learningLessons.workspaceId, ctx.workspaceId),
          inArray(learningLessons.id, lessonIds as bigint[]),
        ),
      );
  } catch (err) {
    console.error('[learning.recordLessonsApplied] failed:', err);
  }
}

/** Bounds for outcome-driven confidence adjustment. The floor keeps a
 *  repeatedly-punished lesson visible (an operator can still read and
 *  delete it); the ceiling leaves headroom so no lesson becomes gospel. */
const REINFORCE_UP_STEP = 2;
const REINFORCE_DOWN_STEP = 3;
const REINFORCE_FLOOR = 5;
const REINFORCE_CEILING = 95;

/**
 * Outcome feedback: nudge the confidence of lessons that were APPLIED to a
 * decision the real world just judged. Positive replies push the applied
 * lessons up; negative replies push them down (down is steeper — wrong
 * advice is worse than the absence of advice). Compaction's
 * stale-retirement then naturally garbage-collects lessons the outcomes
 * keep punishing. Workspace-scoped; never throws. For fit verdicts use
 * reinforceLessonsForVerdict, which honours each rule's polarity.
 */
export async function reinforceLessons(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  lessonIds: readonly bigint[],
  direction: 'up' | 'down',
  reason: string,
): Promise<number> {
  if (lessonIds.length === 0) return 0;
  try {
    const updated = await db
      .update(learningLessons)
      .set({
        confidence:
          direction === 'up'
            ? sql`LEAST(${learningLessons.confidence} + ${REINFORCE_UP_STEP}, ${REINFORCE_CEILING})`
            : sql`GREATEST(${learningLessons.confidence} - ${REINFORCE_DOWN_STEP}, ${REINFORCE_FLOOR})`,
        reinforcedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(learningLessons.workspaceId, ctx.workspaceId),
          inArray(learningLessons.id, lessonIds as bigint[]),
        ),
      )
      .returning({ id: learningLessons.id });
    if (updated.length > 0) {
      const { recordPlatformAuditEvent } = await import('./audit');
      await recordPlatformAuditEvent(null, {
        kind: 'learning.lesson.reinforce',
        entityType: 'learning_lesson',
        entityId: null,
        payload: {
          workspaceId: ctx.workspaceId.toString(),
          direction,
          reason,
          ids: updated.map((u) => u.id.toString()),
        },
      });
    }
    return updated.length;
  } catch (err) {
    console.error('[learning.reinforceLessons] failed:', err);
    return 0;
  }
}

/**
 * Fit-verdict reinforcement that honours each rule's polarity (I098). A
 * rule AGREES with the verdict when its polarity points the same way —
 * a PREFER rule on a Fit, an AVOID rule on a Not-a-fit — and gains
 * confidence; a rule pointing the other way loses some. Neutral rules
 * (polarity 0) never moved the verdict and are left alone. Before KL-01 a
 * correct AVOID rule lost 3 points every time the operator agreed with it.
 * Workspace-scoped; never throws.
 */
export async function reinforceLessonsForVerdict(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  lessonIds: readonly bigint[],
  verdict: 'fit' | 'not_fit',
  reason: string,
): Promise<{ strengthened: bigint[]; weakened: bigint[] }> {
  const none = { strengthened: [] as bigint[], weakened: [] as bigint[] };
  if (lessonIds.length === 0) return none;
  const agreeing = verdict === 'fit' ? 1 : -1;
  try {
    const rows = await db
      .update(learningLessons)
      .set({
        confidence: sql`CASE WHEN ${learningLessons.polarity} = ${agreeing}
          THEN LEAST(${learningLessons.confidence} + ${REINFORCE_UP_STEP}, ${REINFORCE_CEILING})
          ELSE GREATEST(${learningLessons.confidence} - ${REINFORCE_DOWN_STEP}, ${REINFORCE_FLOOR}) END`,
        reinforcedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(learningLessons.workspaceId, ctx.workspaceId),
          inArray(learningLessons.id, lessonIds as bigint[]),
          ne(learningLessons.polarity, 0),
        ),
      )
      .returning({ id: learningLessons.id, polarity: learningLessons.polarity });
    const out = {
      strengthened: rows.filter((r) => r.polarity === agreeing).map((r) => r.id),
      weakened: rows.filter((r) => r.polarity !== agreeing).map((r) => r.id),
    };
    if (rows.length > 0) {
      const { recordPlatformAuditEvent } = await import('./audit');
      await recordPlatformAuditEvent(null, {
        kind: 'learning.lesson.reinforce',
        entityType: 'learning_lesson',
        entityId: null,
        payload: {
          workspaceId: ctx.workspaceId.toString(),
          verdict,
          reason,
          strengthened: out.strengthened.map((id) => id.toString()),
          weakened: out.weakened.map((id) => id.toString()),
        },
      });
    }
    return out;
  } catch (err) {
    console.error('[learning.reinforceLessonsForVerdict] failed:', err);
    return none;
  }
}

// ---- helpers -----------------------------------------------------------

function clampConfidence(input: number): number {
  if (!Number.isFinite(input)) return 50;
  return Math.max(0, Math.min(100, Math.round(input)));
}

function clamp(input: number | undefined, fallback: number, max: number): number {
  if (input === undefined) return fallback;
  if (!Number.isFinite(input) || input <= 0) return fallback;
  return Math.min(Math.floor(input), max);
}
