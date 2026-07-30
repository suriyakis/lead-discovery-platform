import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import {
  learningEvents,
  learningLessons,
  type LearningEvent,
  type LearningLesson,
  type NewLearningEvent,
  type NewLearningLesson,
} from '@/lib/db/schema/learning';
import { getAIProviderForCtx } from '@/lib/ai';
import { recordAuditEvent } from './audit';
import { canWrite, type WorkspaceContext } from './context';
import { recordUsage } from './usage';

export class LearningServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'LearningServiceError';
    this.code = code;
  }
}

const permissionDenied = (op: string) =>
  new LearningServiceError(`Permission denied: ${op}`, 'permission_denied');
const notFound = () => new LearningServiceError('learning_lesson not found', 'not_found');
const invariant = (msg: string) =>
  new LearningServiceError(msg, 'invariant_violation');
const invalid = (msg: string) => new LearningServiceError(msg, 'invalid_input');

// ---- categories --------------------------------------------------------

export const LESSON_CATEGORIES = [
  'qualification_positive',
  'qualification_negative',
  'outreach_style',
  'contact_role',
  'sector_preference',
  'connector_quality',
  'false_positive',
  'false_negative',
  'dedupe_hint',
  'general_instruction',
  'reply_quality',
  'product_positioning',
] as const;
export type LessonCategory = (typeof LESSON_CATEGORIES)[number];

const CATEGORY_SET = new Set<string>(LESSON_CATEGORIES);

function assertCategory(input: string): LessonCategory {
  if (!CATEGORY_SET.has(input)) {
    throw invalid(`unknown category: ${input}`);
  }
  return input as LessonCategory;
}

export type LessonSource = 'operator' | 'draft_edit' | 'synthesis';

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
  // Extraction first (outside tx) so a slow / failing AI call doesn't hold
  // a transaction open. extractLesson never throws — it falls back to the
  // deterministic heuristic on any error.
  const draft = await extractLesson(ctx, input.originalComment ?? null);
  // Dedup check also outside the tx (may make an embedding call). A
  // repeat of an already-known rule reinforces the existing lesson
  // instead of planting a near-identical sibling.
  const duplicate = draft
    ? await findNearDuplicateLesson(ctx, {
        category: draft.category,
        rule: draft.rule,
        productProfileId: input.productProfileId ?? null,
      })
    : null;

  return db.transaction(async (tx) => {
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

    let lesson: LearningLesson | null = null;
    let dedupReinforced = false;
    if (draft && duplicate) {
      // Reinforce inside the tx so event-link + confidence bump are atomic.
      const evidence = Array.from(
        new Set<bigint>([...duplicate.evidenceEventIds, insertedEvent.id]),
      );
      const [updated] = await tx
        .update(learningLessons)
        .set({
          confidence: sql`LEAST(${learningLessons.confidence} + 5, 95)`,
          evidenceEventIds: evidence,
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
      if (updated) {
        lesson = updated;
        dedupReinforced = true;
        await tx
          .update(learningEvents)
          .set({ extractedLessonId: updated.id })
          .where(eq(learningEvents.id, insertedEvent.id));
        insertedEvent.extractedLessonId = updated.id;
      }
    } else if (draft) {
      const lessonRow: NewLearningLesson = {
        workspaceId: ctx.workspaceId,
        productProfileId: input.productProfileId ?? null,
        category: draft.category,
        rule: draft.rule,
        evidenceEventIds: [insertedEvent.id],
        enabled: true,
        confidence: draft.confidence,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      };
      const insertedLesson = (await tx.insert(learningLessons).values(lessonRow).returning())[0];
      if (insertedLesson) {
        lesson = insertedLesson;
        await tx
          .update(learningEvents)
          .set({ extractedLessonId: insertedLesson.id })
          .where(eq(learningEvents.id, insertedEvent.id));
        // Reflect the FK on the returned object — the post-INSERT snapshot
        // doesn't see the subsequent UPDATE.
        insertedEvent.extractedLessonId = insertedLesson.id;
      }
    }

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
  }).then((result) => {
    // Outside the tx: embed only NEW lessons — a reinforced duplicate's
    // rule text didn't change, so its stored embedding is still right.
    if (result.lesson && !result.dedupReinforced) {
      scheduleLessonEmbedding(ctx, result.lesson.id);
    }
    return { event: result.event, lesson: result.lesson };
  });
}

// ---- extractor (AI first, heuristic fallback) -------------------------

export interface LessonDraft {
  category: LessonCategory;
  rule: string;
  confidence: number;
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

const EXTRACTOR_SYSTEM_PROMPT = `You categorize a single operator note into ONE lesson the lead-discovery platform will reuse for future qualification.

Allowed categories (pick the most specific):
- qualification_positive: positive fit signal — this kind of record should be approved
- qualification_negative: negative fit signal — this kind of record should be rejected
- outreach_style: how the email should sound (tone, length, formality)
- contact_role: which contact roles to target or avoid
- sector_preference: which sectors/industries to favour or avoid
- connector_quality: a source is noisy / outdated / unreliable
- false_positive: the engine wrongly classified as relevant
- false_negative: the engine wrongly classified as irrelevant
- dedupe_hint: this looks like a duplicate of something we already have
- general_instruction: a workspace-wide rule that doesn't fit above
- reply_quality: how to handle inbound replies
- product_positioning: how the product itself should be described

Return a strict JSON object: {"category": "<one of the above or null>", "rule": "<a generalized one-sentence rule>", "confidence": <integer 0-100>}.
- "rule" must generalize from the specific example so the platform can match similar cases later.
- If the note carries no reusable signal, return {"category": null, "rule": "", "confidence": 0}.
- Output JSON only, no prose.`;

const ExtractorResultSchema = z.object({
  category: z.string().nullable(),
  rule: z.string(),
  confidence: z.number().int().min(0).max(100),
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

  if (!result.category || !CATEGORY_SET.has(result.category)) return null;
  const rule = result.rule.trim();
  if (!rule) return null;
  return {
    category: result.category as LessonCategory,
    rule: rule.slice(0, 1000),
    confidence: clampConfidence(result.confidence),
  };
}

/**
 * Cheap pattern-matching extractor. Looks for clear directional signals in
 * the comment and produces a draft lesson when found. Returns null when the
 * comment is too low-signal — those are kept only as raw events.
 *
 * The patterns are deliberately conservative; false positives would teach
 * the future AI/rule engine the wrong things. Operators can disable any
 * lesson the heuristic produces from the /learning page.
 */
export function extractLessonHeuristic(comment: string | null): LessonDraft | null {
  if (!comment) return null;
  const trimmed = comment.trim();
  if (trimmed.length < 8) return null;
  const lower = trimmed.toLowerCase();

  // Order matters: more-specific signals win.
  if (/\b(false positive|wrong fit|wrongly classified|misqualified)\b/.test(lower)) {
    return { category: 'false_positive', rule: trimmed, confidence: 70 };
  }
  if (/\b(false negative|missed lead|should have been approved)\b/.test(lower)) {
    return { category: 'false_negative', rule: trimmed, confidence: 70 };
  }
  if (/\b(don't|do not|avoid|skip|never|exclude|not relevant|not interested)\b/.test(lower)) {
    return { category: 'qualification_negative', rule: trimmed, confidence: 65 };
  }
  if (/\b(perfect|ideal|excellent fit|good fit|exactly the kind|target|focus)\b/.test(lower)) {
    return { category: 'qualification_positive', rule: trimmed, confidence: 65 };
  }
  if (/\b(tone|formal|casual|too long|too short|robotic|wording|style)\b/.test(lower)) {
    return { category: 'outreach_style', rule: trimmed, confidence: 60 };
  }
  if (/\b(procurement|engineer|architect|cmo|cto|ceo|head of|director of)\b/.test(lower)) {
    return { category: 'contact_role', rule: trimmed, confidence: 60 };
  }
  if (/\b(sector|industry|construction|finance|retail|tender|government)\b/.test(lower)) {
    return { category: 'sector_preference', rule: trimmed, confidence: 55 };
  }
  if (/\b(duplicate|same company|merge|already have)\b/.test(lower)) {
    return { category: 'dedupe_hint', rule: trimmed, confidence: 70 };
  }
  if (/\b(connector|directory|source) (is )?(noisy|low quality|outdated|stale)\b/.test(lower)) {
    return { category: 'connector_quality', rule: trimmed, confidence: 65 };
  }
  return null;
}

// ---- listing -----------------------------------------------------------

export interface ListLessonsFilter {
  category?: LessonCategory | readonly LessonCategory[];
  productProfileId?: bigint | null;
  /** With a bigint productProfileId: widen the scope to (that product OR
   *  workspace-wide). Lets qualification/outreach fetch both scopes in
   *  ONE query + ONE embedding rerank instead of two of each. */
  includeWorkspaceWide?: boolean;
  enabled?: boolean;
  limit?: number;
  offset?: number;
}

function buildLessonConditions(
  ctx: WorkspaceContext,
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
    // Workspace-wide only. NOTE: this MUST be isNull — an eq(col, null)
    // compiles to SQL `= NULL`, which is never true; that exact bug made
    // workspace-wide lessons silently unretrievable until 2026-07.
    conds.push(isNull(learningLessons.productProfileId));
  } else if (filter.productProfileId !== undefined) {
    if (filter.includeWorkspaceWide) {
      conds.push(
        or(
          eq(learningLessons.productProfileId, filter.productProfileId),
          isNull(learningLessons.productProfileId),
        )!,
      );
    } else {
      conds.push(eq(learningLessons.productProfileId, filter.productProfileId));
    }
  }
  if (filter.enabled !== undefined) {
    conds.push(eq(learningLessons.enabled, filter.enabled));
  }
  return conds;
}

export async function listLessons(
  ctx: WorkspaceContext,
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
  ctx: WorkspaceContext,
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
 * Per-category lesson counts for the workspace, plus a `total`. Used to render
 * count badges on the /learning category tabs. `enabled` filters the same way
 * as listLessons — pass `true` to mirror the default "hide disabled" view.
 */
export async function getLessonCategoryCounts(
  ctx: WorkspaceContext,
  filter: { enabled?: boolean } = {},
): Promise<LessonCategoryCounts> {
  const conds: SQL[] = [eq(learningLessons.workspaceId, ctx.workspaceId)];
  if (filter.enabled !== undefined) {
    conds.push(eq(learningLessons.enabled, filter.enabled));
  }
  const rows = await db
    .select({
      category: learningLessons.category,
      count: sql<number>`count(*)::int`,
    })
    .from(learningLessons)
    .where(and(...conds))
    .groupBy(learningLessons.category);

  const init = Object.fromEntries(
    LESSON_CATEGORIES.map((c) => [c, 0]),
  ) as Record<LessonCategory, number>;
  const counts: LessonCategoryCounts = { ...init, total: 0 };
  for (const row of rows) {
    if (CATEGORY_SET.has(row.category)) {
      counts[row.category as LessonCategory] = row.count;
    }
    counts.total += row.count;
  }
  return counts;
}

export async function getLesson(
  ctx: WorkspaceContext,
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

/**
 * Find an enabled lesson in the same (workspace, category, product scope)
 * that says the same thing as `rule`. Exact (case-insensitive) text match
 * is checked first — free; then embedding similarity when an embedding
 * provider is available. Returns null on any failure — dedup is an
 * optimization, never a gate.
 */
export async function findNearDuplicateLesson(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  input: {
    category: LessonCategory;
    rule: string;
    productProfileId: bigint | null;
  },
): Promise<LearningLesson | null> {
  try {
    const conds: SQL[] = [
      eq(learningLessons.workspaceId, ctx.workspaceId),
      eq(learningLessons.category, input.category),
      eq(learningLessons.enabled, true),
      input.productProfileId === null
        ? isNull(learningLessons.productProfileId)
        : eq(learningLessons.productProfileId, input.productProfileId),
    ];
    const candidates = await db
      .select()
      .from(learningLessons)
      .where(and(...conds))
      .orderBy(desc(learningLessons.confidence))
      .limit(200);
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
  productProfileId?: bigint | null;
  confidence?: number;
  /** Provenance shown on /learning. Defaults to 'operator'. */
  source?: LessonSource;
  evidenceEventIds?: readonly bigint[];
}

export async function createLesson(
  ctx: WorkspaceContext,
  input: CreateLessonInput,
): Promise<LearningLesson> {
  if (!canWrite(ctx)) throw permissionDenied('create lesson');
  assertCategory(input.category);
  const rule = input.rule.trim();
  if (!rule) throw invalid('rule is required');
  if (rule.length > 1000) throw invalid('rule too long (1000 char max)');

  // Same rule already known in this scope → reinforce it instead of
  // planting a duplicate (see the dedup section above).
  const duplicate = await findNearDuplicateLesson(ctx, {
    category: input.category,
    rule,
    productProfileId: input.productProfileId ?? null,
  });
  if (duplicate) {
    return reinforceDuplicateLesson(ctx, duplicate, input.evidenceEventIds ?? []);
  }

  const row: NewLearningLesson = {
    workspaceId: ctx.workspaceId,
    productProfileId: input.productProfileId ?? null,
    category: input.category,
    rule,
    source: input.source ?? 'operator',
    evidenceEventIds: input.evidenceEventIds ? [...input.evidenceEventIds] : [],
    confidence: clampConfidence(input.confidence ?? 65),
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  };
  const inserted = (await db.insert(learningLessons).values(row).returning())[0];
  if (!inserted) throw invariant('learning_lessons insert returned no row');

  await recordAuditEvent(ctx, {
    kind: 'learning.lesson.create',
    entityType: 'learning_lesson',
    entityId: inserted.id,
    payload: {
      category: inserted.category,
      source: inserted.source,
      productProfileId: input.productProfileId?.toString() ?? null,
    },
  });

  scheduleLessonEmbedding(ctx, inserted.id);
  return inserted;
}

export interface UpdateLessonInput {
  rule?: string;
  category?: LessonCategory;
  confidence?: number;
  enabled?: boolean;
  productProfileId?: bigint | null;
}

export async function updateLesson(
  ctx: WorkspaceContext,
  id: bigint,
  patch: UpdateLessonInput,
): Promise<LearningLesson> {
  if (!canWrite(ctx)) throw permissionDenied('update lesson');

  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(learningLessons)
      .where(
        and(eq(learningLessons.workspaceId, ctx.workspaceId), eq(learningLessons.id, id)),
      );
    if (!existing[0]) throw notFound();

    const updates: Partial<NewLearningLesson> & { updatedAt: Date } = {
      updatedBy: ctx.userId,
      updatedAt: new Date(),
    };
    if (patch.rule !== undefined) {
      const trimmed = patch.rule.trim();
      if (!trimmed) throw invalid('rule cannot be empty');
      if (trimmed.length > 1000) throw invalid('rule too long');
      updates.rule = trimmed;
    }
    if (patch.category !== undefined) {
      updates.category = assertCategory(patch.category);
    }
    if (patch.confidence !== undefined) {
      updates.confidence = clampConfidence(patch.confidence);
    }
    if (patch.enabled !== undefined) {
      updates.enabled = patch.enabled;
    }
    if (patch.productProfileId !== undefined) {
      updates.productProfileId = patch.productProfileId;
    }

    const updated = (await tx
      .update(learningLessons)
      .set(updates)
      .where(
        and(eq(learningLessons.workspaceId, ctx.workspaceId), eq(learningLessons.id, id)),
      )
      .returning())[0];
    if (!updated) throw invariant('learning_lessons update returned no row');

    await recordAuditEvent(ctx, {
      kind: 'learning.lesson.update',
      entityType: 'learning_lesson',
      entityId: updated.id,
      payload: { changedKeys: Object.keys(updates).filter((k) => k !== 'updatedAt' && k !== 'updatedBy') },
    });

    return updated;
  }).then((updated) => {
    // Rule text changed → the stored embedding is stale; refresh it.
    if (patch.rule !== undefined) scheduleLessonEmbedding(ctx, updated.id);
    return updated;
  });
}

export const enableLesson = (ctx: WorkspaceContext, id: bigint) =>
  updateLesson(ctx, id, { enabled: true });
export const disableLesson = (ctx: WorkspaceContext, id: bigint) =>
  updateLesson(ctx, id, { enabled: false });

const BULK_LESSON_LIMIT = 500;

/**
 * Flip `enabled` on a batch of lessons in one statement. Workspace-scoped via
 * WHERE so foreign ids silently no-op. member+ gating mirrors the single-row
 * enable/disable. Returns the rows that actually changed (already-enabled
 * rows in an enable batch don't count) so the UI can flash an accurate
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
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(learningLessons)
      .set({ enabled, updatedAt: new Date(), updatedBy: ctx.userId })
      .where(
        and(
          eq(learningLessons.workspaceId, ctx.workspaceId),
          inArray(learningLessons.id, cappedIds as bigint[]),
          eq(learningLessons.enabled, !enabled),
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
  productProfileId?: bigint | null;
  /** With a bigint productProfileId: also include workspace-wide lessons
   *  in the same query. Preferred over calling twice (once per scope) —
   *  one DB fetch, one embedding call, one rerank over the union. */
  includeWorkspaceLessons?: boolean;
  category?: LessonCategory | readonly LessonCategory[];
  taskType?: 'classification' | 'outreach' | 'reply';
  /** Free-text the caller is about to act on (subject, snippet, etc.). Phase 5 ignores; Phase 12 ranks by similarity. */
  contextText?: string;
  limit?: number;
}

/**
 * Retrieval: filter by workspace/category/(product) + enabled, rank by
 * confidence then recency. When the caller provides `contextText` AND the
 * candidate pool exceeds the limit (prompt budget), rerank by embedding
 * similarity so the lessons most relevant to the record at hand win a
 * slot instead of just the most confident ones. Falls back to confidence
 * order on any embedding failure — retrieval must never break a caller.
 */
export async function getRelevantLessons(
  ctx: WorkspaceContext,
  query: LessonQuery = {},
): Promise<LearningLesson[]> {
  const categories = resolveCategoriesForTask(query);
  const limit = query.limit ?? 20;
  const filter: ListLessonsFilter = { enabled: true, limit };
  if (categories) filter.category = categories;
  if (query.productProfileId !== undefined) filter.productProfileId = query.productProfileId;
  if (query.includeWorkspaceLessons) filter.includeWorkspaceWide = true;

  const contextText = query.contextText?.trim();
  if (contextText) {
    try {
      const total = await countLessons(ctx, {
        category: filter.category,
        productProfileId: filter.productProfileId,
        includeWorkspaceWide: filter.includeWorkspaceWide,
        enabled: true,
      });
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

function resolveCategoriesForTask(query: LessonQuery): LessonCategory[] | undefined {
  if (query.category !== undefined) {
    return Array.isArray(query.category)
      ? (query.category as LessonCategory[])
      : [query.category as LessonCategory];
  }
  switch (query.taskType) {
    case 'classification':
      return [
        'qualification_positive',
        'qualification_negative',
        'sector_preference',
        'contact_role',
        'product_positioning',
        'false_positive',
        'false_negative',
      ];
    case 'outreach':
      return ['outreach_style', 'product_positioning', 'contact_role'];
    case 'reply':
      return ['reply_quality', 'outreach_style'];
    default:
      return undefined;
  }
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
 * decision the real world just judged. Approvals / positive replies push
 * the applied lessons up; rejections / negative replies push them down
 * (down is steeper — wrong advice is worse than the absence of advice).
 * Compaction's stale-retirement then naturally garbage-collects lessons
 * the outcomes keep punishing. Workspace-scoped; never throws.
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
