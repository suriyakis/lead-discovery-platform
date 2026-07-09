// Automatic learning loop — the platform teaching itself from outcomes
// nobody wrote a comment about.
//
// Three signal sources, all fire-and-forget from their hook points (an
// outage in the learning layer must never break a review decision, a
// reply, or a draft edit):
//
//   1. Review decisions   → reinforce/weaken the lessons that were applied
//                           to the record's qualifications (hooked in
//                           review.ts; the lesson ids live in
//                           qualifications.evidence.matchedLessonIds).
//   2. Reply outcomes     → a lead's classified reply judges the last
//                           outbound draft: positive intent reinforces the
//                           draft's matched lessons, negative weakens them.
//                           Also appends a learning_event so the weekly
//                           synthesizer can mine reply patterns.
//   3. Draft edits        → when an operator materially rewrites an AI
//                           draft, an AI diff extracts a generalized
//                           outreach_style lesson (source='draft_edit').
//
// The weekly synthesizer (learning-synthesis.ts) then mines the raw event
// stream for patterns none of the individual hooks could see.

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import { learningEvents } from '@/lib/db/schema/learning';
import { outreachDrafts } from '@/lib/db/schema/outreach';
import { getAIProviderForCtx } from '@/lib/ai';
import type { ReplyClass } from './reply-classifier';
import { hasTokens } from './token-ledger';
import {
  createLesson,
  reinforceLessons,
  type LessonDraft,
} from './learning';
import type { WorkspaceContext } from './context';

// ---- reply outcomes ------------------------------------------------------

/** Reply classes that mean the outreach WORKED (the lead engaged). */
const POSITIVE_REPLY_CLASSES: ReadonlySet<ReplyClass> = new Set([
  'positive',
  'interest',
  'question',
  'doc_request',
  'redirect',
]);
/** Reply classes that mean the outreach FAILED on content (not
 *  deliverability — bounces teach nothing about the message). */
const NEGATIVE_REPLY_CLASSES: ReadonlySet<ReplyClass> = new Set([
  'negative',
  'unsubscribe',
]);

export interface ReplyOutcomeInput {
  messageId: bigint;
  replyClass: ReplyClass;
  classifierConfidence: number;
  productProfileId: bigint;
  /** Latest outbound draft in the thread — its matchedLessonIds are the
   *  lessons the reply implicitly judges. */
  precedingDraftId: bigint | null;
}

export interface ReplyOutcomeResult {
  recorded: boolean;
  direction: 'up' | 'down' | null;
  reinforcedCount: number;
}

/**
 * Feed a classified inbound reply back into the learning layer. Neutral
 * classes (out_of_office, bounce, irrelevant) are ignored. Never throws.
 */
export async function learnFromReplyOutcome(
  ctx: WorkspaceContext,
  input: ReplyOutcomeInput,
): Promise<ReplyOutcomeResult> {
  const direction: 'up' | 'down' | null = POSITIVE_REPLY_CLASSES.has(input.replyClass)
    ? 'up'
    : NEGATIVE_REPLY_CLASSES.has(input.replyClass)
      ? 'down'
      : null;
  if (!direction) return { recorded: false, direction: null, reinforcedCount: 0 };

  try {
    // Raw event for the weekly synthesizer — reply outcomes per product are
    // exactly the pattern material it mines ("consultancies never reply").
    await db.insert(learningEvents).values({
      workspaceId: ctx.workspaceId,
      userId: null,
      entityType: 'mail_message',
      entityId: input.messageId.toString(),
      productProfileId: input.productProfileId,
      actionType: direction === 'up' ? 'reply_positive' : 'reply_negative',
      originalComment: null,
      confidence: Math.max(0, Math.min(100, Math.round(input.classifierConfidence))),
    });

    let reinforcedCount = 0;
    if (input.precedingDraftId !== null) {
      const rows = await db
        .select({ matchedLessonIds: outreachDrafts.matchedLessonIds })
        .from(outreachDrafts)
        .where(
          and(
            eq(outreachDrafts.workspaceId, ctx.workspaceId),
            eq(outreachDrafts.id, input.precedingDraftId),
          ),
        )
        .limit(1);
      const lessonIds = rows[0]?.matchedLessonIds ?? [];
      if (lessonIds.length > 0) {
        reinforcedCount = await reinforceLessons(
          ctx,
          lessonIds,
          direction,
          `reply_outcome:${input.replyClass}`,
        );
      }
    }
    return { recorded: true, direction, reinforcedCount };
  } catch (err) {
    console.error('[learning-loop] reply outcome failed:', err);
    return { recorded: false, direction, reinforcedCount: 0 };
  }
}

// ---- draft-edit learning ---------------------------------------------------

/** Word-level Jaccard similarity below which an edit counts as material.
 *  Fixing a typo or a name barely moves this; a rewrite does. */
const EDIT_SIMILARITY_THRESHOLD = 0.85;
const EDIT_ACTION_TYPE = 'outreach_style_edit';

/** Cheap material-change test: word-set Jaccard similarity. */
export function isMaterialEdit(original: string, edited: string): boolean {
  const words = (s: string) =>
    new Set(s.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const a = words(original);
  const b = words(edited);
  if (a.size === 0 && b.size === 0) return false;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const union = a.size + b.size - intersection;
  const jaccard = union === 0 ? 1 : intersection / union;
  return jaccard < EDIT_SIMILARITY_THRESHOLD;
}

const EDIT_EXTRACTOR_PROMPT = `You compare an AI-written outreach email with the version a human operator edited it into. Your job: extract ONE reusable style rule from what the edit changed, so future drafts need less editing.

Look for: tone shifts (formal↔casual), length cuts, removed phrases/claims, structural changes (shorter intro, bullet points), personalization the operator added, sign-off changes.

Strict JSON output:
{"worthLearning": <bool>, "rule": "<one generalized imperative sentence, e.g. 'Keep the opening to one sentence and skip company self-description'>", "confidence": <int 0-100>}

Set worthLearning=false when the edit is factual correction, translation, or personalization specific to one recipient — those generalize badly. Output JSON only.`;

const EditVerdictSchema = z.object({
  worthLearning: z.boolean(),
  rule: z.string(),
  confidence: z.number().int().min(0).max(100),
});

export interface DraftEditInput {
  draftId: bigint;
  productProfileId: bigint;
  originalBody: string;
  editedBody: string;
}

export interface DraftEditResult {
  learned: boolean;
  reason:
    | 'lesson_created'
    | 'not_material'
    | 'already_learned'
    | 'not_worth_learning'
    | 'no_tokens'
    | 'error';
}

/**
 * Learn an outreach_style lesson from an operator's edit of an AI draft.
 * One lesson per draft max (repeat edits of the same draft don't multiply
 * lessons). Billable AI call — skipped on an empty wallet. Never throws.
 */
export async function learnFromDraftEdit(
  ctx: WorkspaceContext,
  input: DraftEditInput,
): Promise<DraftEditResult> {
  try {
    if (!isMaterialEdit(input.originalBody, input.editedBody)) {
      return { learned: false, reason: 'not_material' };
    }
    // One edit-lesson per draft: the FIRST material edit carries the
    // style signal; later touch-ups of the same draft are noise.
    const prior = await db
      .select({ id: learningEvents.id })
      .from(learningEvents)
      .where(
        and(
          eq(learningEvents.workspaceId, ctx.workspaceId),
          eq(learningEvents.entityType, 'outreach_draft'),
          eq(learningEvents.entityId, input.draftId.toString()),
          eq(learningEvents.actionType, EDIT_ACTION_TYPE),
        ),
      )
      .limit(1);
    if (prior[0]) return { learned: false, reason: 'already_learned' };

    if (!(await hasTokens(ctx))) return { learned: false, reason: 'no_tokens' };

    const provider = await getAIProviderForCtx(ctx, 'ai.learning_extract');
    const verdict = await provider.generateJson(
      {
        system: EDIT_EXTRACTOR_PROMPT,
        prompt: `ORIGINAL AI DRAFT:\n"""${input.originalBody.slice(0, 4000)}"""\n\nOPERATOR'S EDITED VERSION:\n"""${input.editedBody.slice(0, 4000)}"""`,
      },
      EditVerdictSchema,
      {
        maxTokens: 256,
        temperature: 0,
        mockSeed: `learning.draft_edit:${input.draftId}`,
      },
    );

    // Record the event regardless of the verdict so the one-per-draft
    // guard holds even when the AI says there's nothing to learn.
    const [event] = await db
      .insert(learningEvents)
      .values({
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        entityType: 'outreach_draft',
        entityId: input.draftId.toString(),
        productProfileId: input.productProfileId,
        actionType: EDIT_ACTION_TYPE,
        originalComment: verdict.worthLearning ? verdict.rule.slice(0, 500) : null,
        confidence: verdict.confidence,
      })
      .returning();

    const rule = verdict.rule.trim();
    if (!verdict.worthLearning || !rule) {
      return { learned: false, reason: 'not_worth_learning' };
    }

    const draft: LessonDraft = {
      category: 'outreach_style',
      rule: rule.slice(0, 1000),
      // Edit-derived rules start modest — reinforcement raises the good ones.
      confidence: Math.min(verdict.confidence, 65),
    };
    await createLesson(ctx, {
      category: draft.category,
      rule: draft.rule,
      productProfileId: input.productProfileId,
      confidence: draft.confidence,
      source: 'draft_edit',
      evidenceEventIds: event ? [event.id] : [],
    });
    return { learned: true, reason: 'lesson_created' };
  } catch (err) {
    console.error('[learning-loop] draft edit learning failed:', err);
    return { learned: false, reason: 'error' };
  }
}
