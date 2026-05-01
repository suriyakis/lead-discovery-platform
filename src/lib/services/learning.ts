import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  learningEvents,
  learningLessons,
  type LearningEvent,
  type LearningLesson,
  type NewLearningEvent,
  type NewLearningLesson,
} from '@/lib/db/schema/learning';
import { recordAuditEvent } from './audit';
import { canWrite, type WorkspaceContext } from './context';

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
 * Append a feedback event and, when the heuristic extractor finds a clean
 * signal, also materialize a `learning_lessons` row linked back to the event.
 *
 * The extractor is intentionally cheap and deterministic in Phase 5 so the
 * platform behaves the same with or without a configured AI provider.
 * Phase 7+ swaps the heuristic for the AI provider abstraction.
 */
export async function recordFeedback(
  ctx: WorkspaceContext,
  input: FeedbackInput,
): Promise<{ event: LearningEvent; lesson: LearningLesson | null }> {
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

    const draft = extractLessonHeuristic(input.originalComment ?? null);
    let lesson: LearningLesson | null = null;
    if (draft) {
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
        productProfileId: input.productProfileId?.toString() ?? null,
      },
    });

    return { event: insertedEvent, lesson };
  });
}

// ---- heuristic extractor ----------------------------------------------

interface LessonDraft {
  category: LessonCategory;
  rule: string;
  confidence: number;
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
  enabled?: boolean;
  limit?: number;
}

export async function listLessons(
  ctx: WorkspaceContext,
  filter: ListLessonsFilter = {},
): Promise<LearningLesson[]> {
  const conds: SQL[] = [eq(learningLessons.workspaceId, ctx.workspaceId)];
  if (filter.category !== undefined) {
    if (Array.isArray(filter.category)) {
      if (filter.category.length === 0) return [];
      conds.push(inArray(learningLessons.category, filter.category as string[]));
    } else {
      conds.push(eq(learningLessons.category, filter.category as string));
    }
  }
  if (filter.productProfileId === null) {
    // Drizzle has isNull but we keep the SQL identity simple — no explicit null filter unless requested.
    // For "workspace-wide only" the caller passes productProfileId: null.
    conds.push(eq(learningLessons.productProfileId, null as unknown as bigint));
  } else if (filter.productProfileId !== undefined) {
    conds.push(eq(learningLessons.productProfileId, filter.productProfileId));
  }
  if (filter.enabled !== undefined) {
    conds.push(eq(learningLessons.enabled, filter.enabled));
  }

  const limit = clamp(filter.limit, 200, 1000);
  return db
    .select()
    .from(learningLessons)
    .where(and(...conds))
    .orderBy(desc(learningLessons.confidence), desc(learningLessons.updatedAt))
    .limit(limit);
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

// ---- mutations ---------------------------------------------------------

export interface CreateLessonInput {
  category: LessonCategory;
  rule: string;
  productProfileId?: bigint | null;
  confidence?: number;
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

  const row: NewLearningLesson = {
    workspaceId: ctx.workspaceId,
    productProfileId: input.productProfileId ?? null,
    category: input.category,
    rule,
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
    payload: { category: inserted.category, productProfileId: input.productProfileId?.toString() ?? null },
  });

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
  });
}

export const enableLesson = (ctx: WorkspaceContext, id: bigint) =>
  updateLesson(ctx, id, { enabled: true });
export const disableLesson = (ctx: WorkspaceContext, id: bigint) =>
  updateLesson(ctx, id, { enabled: false });

// ---- retrieval (for prompts/rules) ------------------------------------

export interface LessonQuery {
  productProfileId?: bigint | null;
  category?: LessonCategory | readonly LessonCategory[];
  taskType?: 'classification' | 'outreach' | 'reply';
  /** Free-text the caller is about to act on (subject, snippet, etc.). Phase 5 ignores; Phase 12 ranks by similarity. */
  contextText?: string;
  limit?: number;
}

/**
 * Phase 5 retrieval: filter by workspace/category/(product) + enabled,
 * rank by confidence then recency. Phase 12 reranks via embedding similarity
 * against `contextText`.
 */
export async function getRelevantLessons(
  ctx: WorkspaceContext,
  query: LessonQuery = {},
): Promise<LearningLesson[]> {
  const categories = resolveCategoriesForTask(query);
  const filter: ListLessonsFilter = { enabled: true, limit: query.limit ?? 20 };
  if (categories) filter.category = categories;
  if (query.productProfileId !== undefined) filter.productProfileId = query.productProfileId;

  return listLessons(ctx, filter);
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
