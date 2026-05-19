import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/auth';
import { sourceRecords, type SourceRecord } from '@/lib/db/schema/connectors';
import {
  reviewComments,
  reviewItems,
  type NewReviewItem,
  type ReviewComment,
  type ReviewItem,
  type ReviewItemState,
} from '@/lib/db/schema/review';
import { qualifications } from '@/lib/db/schema/qualifications';
import { recordAuditEvent } from './audit';
import { canAdminWorkspace, canWrite, type WorkspaceContext } from './context';
import { recordFeedback } from './learning';

export class ReviewServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ReviewServiceError';
    this.code = code;
  }
}

const permissionDenied = (op: string) =>
  new ReviewServiceError(`Permission denied: ${op}`, 'permission_denied');
const notFound = () => new ReviewServiceError('review_item not found', 'not_found');
const invariant = (msg: string) => new ReviewServiceError(msg, 'invariant_violation');
const invalid = (msg: string) => new ReviewServiceError(msg, 'invalid_input');
const conflict = (msg: string) => new ReviewServiceError(msg, 'conflict');

const TERMINAL_STATES = new Set<ReviewItemState>(['archived']);

// ---- seeding (called by the connector runner) ------------------------

/**
 * Idempotently create a review_items row for the given source_record.
 * Workspace scope is implied by the source record. Used by the connector
 * runner immediately after inserting a source_record.
 */
export async function seedReviewItem(
  workspaceId: bigint,
  sourceRecordId: bigint,
): Promise<ReviewItem> {
  // ON CONFLICT DO NOTHING then SELECT keeps this race-safe within a workspace.
  await db
    .insert(reviewItems)
    .values({ workspaceId, sourceRecordId, state: 'new' })
    .onConflictDoNothing({
      target: [reviewItems.workspaceId, reviewItems.sourceRecordId],
    });
  const rows = await db
    .select()
    .from(reviewItems)
    .where(
      and(
        eq(reviewItems.workspaceId, workspaceId),
        eq(reviewItems.sourceRecordId, sourceRecordId),
      ),
    );
  if (!rows[0]) throw invariant('seedReviewItem: row missing after upsert');
  return rows[0];
}

// ---- read --------------------------------------------------------------

export interface ListReviewFilter {
  state?: ReviewItemState | readonly ReviewItemState[];
  assignedToUserId?: string;
  limit?: number;
}

export async function listReviewItems(
  ctx: WorkspaceContext,
  filter: ListReviewFilter = {},
): Promise<Array<{ item: ReviewItem; sourceRecord: SourceRecord }>> {
  const conds: SQL[] = [eq(reviewItems.workspaceId, ctx.workspaceId)];

  if (filter.state !== undefined) {
    if (Array.isArray(filter.state)) {
      if (filter.state.length === 0) return [];
      conds.push(inArray(reviewItems.state, filter.state as ReviewItemState[]));
    } else {
      conds.push(eq(reviewItems.state, filter.state as ReviewItemState));
    }
  }

  if (filter.assignedToUserId !== undefined) {
    conds.push(eq(reviewItems.assignedToUserId, filter.assignedToUserId));
  }

  const limit = clamp(filter.limit, 100, 1000);

  const rows = await db
    .select({
      item: reviewItems,
      sourceRecord: sourceRecords,
    })
    .from(reviewItems)
    .innerJoin(sourceRecords, eq(sourceRecords.id, reviewItems.sourceRecordId))
    .where(and(...conds))
    .orderBy(desc(reviewItems.createdAt))
    .limit(limit);

  return rows;
}

export async function getReviewItem(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<{
  item: ReviewItem;
  sourceRecord: SourceRecord;
  comments: Array<{ comment: ReviewComment; author: { id: string; email: string; name: string | null } | null }>;
}> {
  const rows = await db
    .select({ item: reviewItems, sourceRecord: sourceRecords })
    .from(reviewItems)
    .innerJoin(sourceRecords, eq(sourceRecords.id, reviewItems.sourceRecordId))
    .where(and(eq(reviewItems.workspaceId, ctx.workspaceId), eq(reviewItems.id, id)));
  const row = rows[0];
  if (!row) throw notFound();

  const commentRows = await db
    .select({
      comment: reviewComments,
      author: { id: users.id, email: users.email, name: users.name },
    })
    .from(reviewComments)
    .leftJoin(users, eq(users.id, reviewComments.userId))
    .where(eq(reviewComments.reviewItemId, id))
    .orderBy(asc(reviewComments.createdAt));

  return {
    item: row.item,
    sourceRecord: row.sourceRecord,
    comments: commentRows.map((r) => ({ comment: r.comment, author: r.author })),
  };
}

// ---- transitions -------------------------------------------------------

interface BasicTransitionOptions {
  /** Set when a transition implies an explicit reason. */
  reason?: string | null;
}

async function applyStateChange(
  ctx: WorkspaceContext,
  id: bigint,
  to: ReviewItemState,
  options: BasicTransitionOptions = {},
): Promise<ReviewItem> {
  if (!canWrite(ctx)) throw permissionDenied(`set review state -> ${to}`);

  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(reviewItems)
      .where(
        and(eq(reviewItems.workspaceId, ctx.workspaceId), eq(reviewItems.id, id)),
      );
    const item = existing[0];
    if (!item) throw notFound();
    if (TERMINAL_STATES.has(item.state) && to !== item.state) {
      throw conflict(`review item is in terminal state '${item.state}'`);
    }

    const now = new Date();
    const updates: Partial<NewReviewItem> & { updatedAt: Date } = {
      state: to,
      updatedAt: now,
    };

    // Side-channel timestamps for the common transitions.
    if (to === 'approved') {
      updates.approvedByUserId = ctx.userId;
      updates.approvedAt = now;
      updates.approvalReason = options.reason ?? null;
    } else if (to === 'rejected') {
      updates.rejectedByUserId = ctx.userId;
      updates.rejectedAt = now;
      updates.rejectionReason = options.reason ?? null;
    }

    const updated = await tx
      .update(reviewItems)
      .set(updates)
      .where(
        and(eq(reviewItems.workspaceId, ctx.workspaceId), eq(reviewItems.id, id)),
      )
      .returning();
    const result = updated[0];
    if (!result) throw invariant('review_items update returned no row');

    await recordAuditEvent(ctx, {
      kind: `review.${to}`,
      entityType: 'review_item',
      entityId: result.id,
      payload: {
        previousState: item.state,
        newState: to,
        reason: options.reason ?? null,
      },
    });

    return { result, sourceRecordId: item.sourceRecordId };
  }).then(async ({ result, sourceRecordId }) => {
    // After commit, feed the decision into the learning layer so future
    // qualifications can auto-approve / auto-reject similar records.
    // Best-effort — failure logs but does not undo the state change.
    if (to === 'approved' || to === 'rejected') {
      try {
        await feedDecisionIntoLearning(ctx, {
          reviewItemId: result.id,
          sourceRecordId,
          decision: to,
          reason: options.reason ?? null,
        });
      } catch (err) {
        console.error(`[review.${to}] feedDecisionIntoLearning failed:`, err);
      }
    }
    return result;
  });
}

/**
 * For each product the qualifier matched against this source record, emit a
 * learning event scoped to that product. When no qualifications exist (record
 * predates Phase 7 or classification hasn't run), emit one workspace-scoped
 * event with productProfileId=null so the signal isn't lost.
 *
 * actionType maps to lesson categories the heuristic / AI extractor recognise:
 *   approved → qualification_positive
 *   rejected → qualification_negative
 */
async function feedDecisionIntoLearning(
  ctx: WorkspaceContext,
  args: {
    reviewItemId: bigint;
    sourceRecordId: bigint;
    decision: 'approved' | 'rejected';
    reason: string | null;
  },
): Promise<void> {
  const actionType =
    args.decision === 'approved' ? 'qualification_positive' : 'qualification_negative';
  const confidence = args.reason && args.reason.trim().length > 0 ? 75 : 60;

  const quals = await db
    .select({ productProfileId: qualifications.productProfileId })
    .from(qualifications)
    .where(
      and(
        eq(qualifications.workspaceId, ctx.workspaceId),
        eq(qualifications.sourceRecordId, args.sourceRecordId),
      ),
    );

  if (quals.length === 0) {
    await recordFeedback(ctx, {
      entityType: 'review_item',
      entityId: args.reviewItemId.toString(),
      productProfileId: null,
      actionType,
      originalComment: args.reason,
      confidence,
    });
    return;
  }

  for (const q of quals) {
    await recordFeedback(ctx, {
      entityType: 'review_item',
      entityId: args.reviewItemId.toString(),
      productProfileId: q.productProfileId,
      actionType,
      originalComment: args.reason,
      confidence,
    });
  }
}

export const approveReviewItem = (
  ctx: WorkspaceContext,
  id: bigint,
  reason?: string | null,
) => applyStateChange(ctx, id, 'approved', { reason: reason ?? null });

export const rejectReviewItem = (
  ctx: WorkspaceContext,
  id: bigint,
  reason?: string | null,
) => applyStateChange(ctx, id, 'rejected', { reason: reason ?? null });

export const ignoreReviewItem = (ctx: WorkspaceContext, id: bigint) =>
  applyStateChange(ctx, id, 'ignored');

export const flagForReview = (ctx: WorkspaceContext, id: bigint) =>
  applyStateChange(ctx, id, 'needs_review');

/** Archiving requires admin permission since it removes from active queue. */
export async function archiveReviewItem(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<ReviewItem> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('archive review item');
  return applyStateChangeForceAdmin(ctx, id, 'archived');
}

async function applyStateChangeForceAdmin(
  ctx: WorkspaceContext,
  id: bigint,
  to: ReviewItemState,
): Promise<ReviewItem> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(reviewItems)
      .where(and(eq(reviewItems.workspaceId, ctx.workspaceId), eq(reviewItems.id, id)));
    const item = existing[0];
    if (!item) throw notFound();
    const updated = await tx
      .update(reviewItems)
      .set({ state: to, updatedAt: new Date() })
      .where(and(eq(reviewItems.workspaceId, ctx.workspaceId), eq(reviewItems.id, id)))
      .returning();
    const result = updated[0];
    if (!result) throw invariant('review_items update returned no row');
    await recordAuditEvent(ctx, {
      kind: `review.${to}`,
      entityType: 'review_item',
      entityId: result.id,
      payload: { previousState: item.state, newState: to },
    });
    return result;
  });
}

// ---- assignment --------------------------------------------------------

export async function assignReviewItem(
  ctx: WorkspaceContext,
  id: bigint,
  toUserId: string | null,
): Promise<ReviewItem> {
  if (!canWrite(ctx)) throw permissionDenied('assign review item');

  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(reviewItems)
      .where(and(eq(reviewItems.workspaceId, ctx.workspaceId), eq(reviewItems.id, id)));
    const item = existing[0];
    if (!item) throw notFound();

    const updated = await tx
      .update(reviewItems)
      .set({ assignedToUserId: toUserId, updatedAt: new Date() })
      .where(and(eq(reviewItems.workspaceId, ctx.workspaceId), eq(reviewItems.id, id)))
      .returning();
    const result = updated[0];
    if (!result) throw invariant('review_items update returned no row');

    await recordAuditEvent(ctx, {
      kind: 'review.assign',
      entityType: 'review_item',
      entityId: result.id,
      payload: { previousAssignee: item.assignedToUserId, newAssignee: toUserId },
    });

    return result;
  });
}

// ---- comments ----------------------------------------------------------

/** Phase 5 will hook this into the learning layer; for now it just records. */
export async function commentOnReviewItem(
  ctx: WorkspaceContext,
  id: bigint,
  text: string,
): Promise<ReviewComment> {
  if (!canWrite(ctx)) throw permissionDenied('comment on review item');
  const trimmed = text.trim();
  if (!trimmed) throw invalid('comment cannot be empty');
  if (trimmed.length > 5000) throw invalid('comment too long (5000 char max)');

  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(reviewItems)
      .where(and(eq(reviewItems.workspaceId, ctx.workspaceId), eq(reviewItems.id, id)));
    if (!existing[0]) throw notFound();

    const inserted = await tx
      .insert(reviewComments)
      .values({
        workspaceId: ctx.workspaceId,
        reviewItemId: id,
        userId: ctx.userId,
        comment: trimmed,
      })
      .returning();
    const comment = inserted[0];
    if (!comment) throw invariant('review_comments insert returned no row');

    // Touch the parent so list ordering reflects activity.
    await tx
      .update(reviewItems)
      .set({ updatedAt: new Date() })
      .where(eq(reviewItems.id, id));

    await recordAuditEvent(ctx, {
      kind: 'review.comment',
      entityType: 'review_item',
      entityId: id,
      payload: { commentId: comment.id.toString(), preview: trimmed.slice(0, 120) },
    });

    return comment;
  }).then(async (comment) => {
    // Outside the transaction: feed the comment to the learning layer so
    // structured lessons can be extracted. Best-effort — failure here logs
    // but does not undo the comment write.
    try {
      await recordFeedback(ctx, {
        entityType: 'review_item',
        entityId: id.toString(),
        actionType: 'general_instruction',
        originalComment: text.trim(),
        confidence: 50,
      });
    } catch (err) {
      console.error('[review.comment] recordFeedback failed:', err);
    }
    return comment;
  });
}

// ---- counts (for dashboards) -------------------------------------------

export interface StateCounts {
  new: number;
  needs_review: number;
  approved: number;
  rejected: number;
  ignored: number;
  duplicate: number;
  archived: number;
  total: number;
}

export async function getStateCounts(ctx: WorkspaceContext): Promise<StateCounts> {
  const rows = await db
    .select({
      state: reviewItems.state,
      count: sql<number>`count(*)::int`,
    })
    .from(reviewItems)
    .where(eq(reviewItems.workspaceId, ctx.workspaceId))
    .groupBy(reviewItems.state);

  const init: StateCounts = {
    new: 0,
    needs_review: 0,
    approved: 0,
    rejected: 0,
    ignored: 0,
    duplicate: 0,
    archived: 0,
    total: 0,
  };
  return rows.reduce<StateCounts>((acc, row) => {
    acc[row.state as keyof Omit<StateCounts, 'total'>] = row.count;
    acc.total += row.count;
    return acc;
  }, init);
}

// ---- helpers -----------------------------------------------------------

function clamp(input: number | undefined, fallback: number, max: number): number {
  if (input === undefined) return fallback;
  if (!Number.isFinite(input) || input <= 0) return fallback;
  return Math.min(Math.floor(input), max);
}
