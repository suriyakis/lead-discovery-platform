import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import type { AuditKind } from '@/lib/kinds/audit';
import { users } from '@/lib/db/schema/auth';
import { sourceRecords, type SourceRecord } from '@/lib/db/schema/connectors';
import { learningEvents, type OperatorVerdict } from '@/lib/db/schema/learning';
import { productProfiles } from '@/lib/db/schema/products';
import {
  reviewComments,
  reviewItems,
  type NewReviewItem,
  type ReviewComment,
  type ReviewItem,
  type ReviewItemState,
} from '@/lib/db/schema/review';
import { recordAuditEvent } from './audit';
import { canAdminWorkspace, canWrite, type WorkspaceContext } from './context';
import { runDecisionHooks } from './decision-hooks';
import {
  DecisionReplayedError,
  DecisionServiceError,
  MIN_TEACHABLE_TEXT,
  enqueueDecisionProcessing,
  findDecisionByKey,
  newDecisionKey,
  parseDecisionKey,
  recordDecision,
  stripMentions,
  type DecisionEventInput,
  type DecisionKind,
  type DecisionOrigin,
  type RecordedDecision,
} from './learning-decisions';
import {
  isAiRelevant,
  loadReviewSnapshots,
  resolveReviewVerdicts,
  reviewDecisionContext,
  toDecisionEvents,
  writeOperatorVerdicts,
  type ResolvedVerdict,
  type ReviewDecisionAction,
  type ReviewRecordSnapshot,
} from './review-decisions';

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
  offset?: number;
  createdAtFrom?: Date;
  createdAtTo?: Date;
}

/**
 * Build the WHERE conditions shared by listReviewItems and
 * countReviewItems. Returning null means "no rows can match this
 * filter" (currently only when state is an empty array).
 */
function buildReviewConditions(
  ctx: WorkspaceContext,
  filter: ListReviewFilter,
): SQL[] | null {
  const conds: SQL[] = [eq(reviewItems.workspaceId, ctx.workspaceId)];
  if (filter.state !== undefined) {
    if (Array.isArray(filter.state)) {
      if (filter.state.length === 0) return null;
      conds.push(inArray(reviewItems.state, filter.state as ReviewItemState[]));
    } else {
      conds.push(eq(reviewItems.state, filter.state as ReviewItemState));
    }
  }
  if (filter.assignedToUserId !== undefined) {
    conds.push(eq(reviewItems.assignedToUserId, filter.assignedToUserId));
  }
  if (filter.createdAtFrom !== undefined) {
    conds.push(gte(reviewItems.createdAt, filter.createdAtFrom));
  }
  if (filter.createdAtTo !== undefined) {
    conds.push(lte(reviewItems.createdAt, filter.createdAtTo));
  }
  return conds;
}

export async function listReviewItems(
  ctx: WorkspaceContext,
  filter: ListReviewFilter = {},
): Promise<Array<{ item: ReviewItem; sourceRecord: SourceRecord }>> {
  const conds = buildReviewConditions(ctx, filter);
  if (conds === null) return [];

  const limit = clamp(filter.limit, 100, 1000);
  const offset = Math.max(0, filter.offset ?? 0);

  const rows = await db
    .select({
      item: reviewItems,
      sourceRecord: sourceRecords,
    })
    .from(reviewItems)
    .innerJoin(sourceRecords, eq(sourceRecords.id, reviewItems.sourceRecordId))
    .where(and(...conds))
    .orderBy(desc(reviewItems.createdAt))
    .limit(limit)
    .offset(offset);

  return rows;
}

/**
 * Count review items matching the same filter as listReviewItems
 * (excluding limit / offset). Powers the pagination UI on /review.
 */
export async function countReviewItems(
  ctx: WorkspaceContext,
  filter: Omit<ListReviewFilter, 'limit' | 'offset'> = {},
): Promise<number> {
  const conds = buildReviewConditions(ctx, filter);
  if (conds === null) return 0;
  const result = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(reviewItems)
    .where(and(...conds));
  return result[0]?.value ?? 0;
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

// ---- decisions -----------------------------------------------------------
//
// KL-02. Every review state change that is a decision (approve, reject,
// ignore, archive — single or bulk — and autopilot's approve) runs through
// decideReviewItems(), which in ONE transaction:
//   1. locks the items (FOR UPDATE), so concurrent decisions serialize;
//   2. returns a replay when the decision key was already used — nothing is
//      written, not even audit;
//   3. treats a same-state transition as a no-op (no audit, no events) unless
//      explicit per-product verdicts change a stored one;
//   4. writes the state change, the decision record (learning-decisions.ts:
//      events, supersession, outbox), the operator verdicts on the
//      qualifications and the audit row.
// After the commit it enqueues learning.process and runs the post-commit
// decision hooks. It replaces the after-commit, best-effort
// feedDecisionIntoLearning: a decision can no longer exist without its
// events, nor events without their decision. Flag (needs_review) is a
// deferral, not a verdict: it records no decision.

export interface ReviewDecisionOptions {
  /** Idempotency key — the form's nonce. A repeat is a no-op. Omitted: a
   *  fresh key (no idempotency). */
  decisionKey?: string | null;
  /** Explicit per-product verdicts (the KL-20 decision panel). Products not
   *  listed take the defaults (see review-decisions.ts). */
  productVerdicts?: ReadonlyArray<{ productProfileId: bigint; verdict: OperatorVerdict }>;
  /** Machine-readable reason chips (KL-20). */
  reasonCodes?: readonly string[];
}

export interface TransitionOptions extends ReviewDecisionOptions {
  /** The operator's note: why it fits / does not fit. */
  reason?: string | null;
}

const ACTION_KIND: Record<ReviewDecisionAction, DecisionKind> = {
  approve: 'review.approve',
  reject: 'review.reject',
  ignore: 'review.ignore',
  archive: 'review.archive',
};

interface DecideInput {
  ids: readonly bigint[];
  to: ReviewItemState;
  /** null: a state change that is not a decision (flag). */
  action: ReviewDecisionAction | null;
  origin: Extract<DecisionOrigin, 'operator' | 'autopilot'>;
  reason: string | null;
  decisionKey: string | null;
  explicit: ReadonlyMap<string, OperatorVerdict> | null;
  reasonCodes: readonly string[];
  /** Skip missing / terminal items instead of failing (bulk, autopilot). */
  lenient: boolean;
  /** Act only on items still in this state (autopilot's conditional
   *  approve); others are skipped. */
  expectState?: ReviewItemState;
  autopilotProductIds?: readonly bigint[];
  /** One audit row for the whole call instead of one per item. */
  bulkAudit?: { kind: AuditKind; entityType: string; payload: Record<string, unknown> };
  /** PC-11: extra fields on each item's audit row (autopilot: the run and
   *  the products it approved the item for). */
  auditPayload?: Record<string, unknown>;
}

interface DecideOutcome {
  status: 'changed' | 'noop' | 'replayed' | 'skipped';
  /** Current rows of the requested items found in the workspace. */
  items: ReviewItem[];
  changedIds: bigint[];
  decision: RecordedDecision | null;
}

function resolveDecisionKey(raw: string | null | undefined): string {
  if (raw === undefined || raw === null || raw === '') return newDecisionKey();
  const key = parseDecisionKey(raw);
  if (!key) throw invalid('invalid decision key');
  return key;
}

function explicitVerdictMap(
  verdicts: TransitionOptions['productVerdicts'],
): Map<string, OperatorVerdict> | null {
  if (!verdicts || verdicts.length === 0) return null;
  const out = new Map<string, OperatorVerdict>();
  for (const v of verdicts) {
    if (v.verdict !== 'fit' && v.verdict !== 'not_fit') throw invalid('verdict must be fit or not_fit');
    const key = v.productProfileId.toString();
    if (out.has(key) && out.get(key) !== v.verdict) {
      throw invalid('conflicting verdicts for one product');
    }
    out.set(key, v.verdict);
  }
  return out;
}

function validateExplicit(
  snap: ReviewRecordSnapshot,
  action: ReviewDecisionAction,
  explicit: ReadonlyMap<string, OperatorVerdict>,
): void {
  if (action === 'ignore' || action === 'archive') {
    throw invalid('archive and ignore take no per-product verdicts');
  }
  for (const pid of explicit.keys()) {
    if (!snap.quals.some((q) => q.product.id.toString() === pid)) {
      throw invalid('that product has not been classified for this record');
    }
  }
  if (action === 'reject' && [...explicit.values()].includes('fit')) {
    throw invalid('a rejection cannot mark a product Fit');
  }
}

function stateUpdates(
  input: DecideInput,
  ctx: WorkspaceContext,
  now: Date,
): Partial<NewReviewItem> & { updatedAt: Date } {
  const updates: Partial<NewReviewItem> & { updatedAt: Date } = {
    state: input.to,
    updatedAt: now,
  };
  if (input.to === 'approved') {
    // Autopilot approvals are machine decisions: no person's name (I034).
    updates.approvedByUserId = input.origin === 'autopilot' ? null : ctx.userId;
    updates.approvedAt = now;
    updates.approvalReason = input.origin === 'autopilot' ? 'autopilot' : input.reason;
  } else if (input.to === 'rejected') {
    updates.rejectedByUserId = ctx.userId;
    updates.rejectedAt = now;
    updates.rejectionReason = input.reason;
  }
  return updates;
}

async function decideReviewItems(
  ctx: WorkspaceContext,
  input: DecideInput,
): Promise<DecideOutcome> {
  const ids = Array.from(new Set(input.ids.map((i) => i.toString()))).map((s) => BigInt(s));
  if (ids.length === 0) return { status: 'noop', items: [], changedIds: [], decision: null };

  let outcome: DecideOutcome;
  try {
    outcome = await db.transaction(async (tx): Promise<DecideOutcome> => {
      const locked = await tx
        .select()
        .from(reviewItems)
        .where(and(eq(reviewItems.workspaceId, ctx.workspaceId), inArray(reviewItems.id, ids)))
        .orderBy(asc(reviewItems.id))
        .for('update');
      if (locked.length === 0 && !input.lenient) throw notFound();
      const none = (status: DecideOutcome['status']): DecideOutcome => ({
        status,
        items: locked,
        changedIds: [],
        decision: null,
      });
      if (input.decisionKey && (await findDecisionByKey(tx, ctx, input.decisionKey))) {
        return none('replayed');
      }

      const candidates: ReviewItem[] = [];
      for (const item of locked) {
        if (input.expectState && item.state !== input.expectState) continue;
        if (TERMINAL_STATES.has(item.state) && input.to !== item.state) {
          if (input.lenient) continue;
          throw conflict(`review item is in terminal state '${item.state}'`);
        }
        candidates.push(item);
      }
      if (candidates.length === 0) return none(input.expectState ? 'skipped' : 'noop');

      const snaps = input.action
        ? await loadReviewSnapshots(tx, ctx, candidates)
        : new Map<string, ReviewRecordSnapshot>();
      const plans: Array<{ item: ReviewItem; same: boolean; snap: ReviewRecordSnapshot | null; verdicts: ResolvedVerdict[] }> = [];
      for (const item of candidates) {
        const same = item.state === input.to;
        const snap = snaps.get(item.id.toString()) ?? null;
        let verdicts: ResolvedVerdict[] = [];
        if (input.action && snap) {
          if (input.explicit) validateExplicit(snap, input.action, input.explicit);
          verdicts = resolveReviewVerdicts(snap, input.action, {
            origin: input.origin,
            explicit: input.explicit,
            onlyChanges: same,
            autopilotProductIds: input.autopilotProductIds,
          });
          // Mixed verdicts approve the item when any product is Fit (§5);
          // an approve that leaves no product Fit is a rejection.
          if (input.action === 'approve' && input.explicit) {
            const after = new Map<string, OperatorVerdict>();
            for (const q of snap.quals) {
              if (q.qualification.operatorVerdict) {
                after.set(q.product.id.toString(), q.qualification.operatorVerdict);
              }
            }
            for (const v of verdicts) {
              if (v.productProfileId !== null && v.verdict) after.set(v.productProfileId.toString(), v.verdict);
            }
            if (after.size > 0 && ![...after.values()].includes('fit')) {
              throw invalid('Approve needs at least one product marked Fit; use Reject instead.');
            }
          }
        }
        // Same state and no verdict changes: nothing happened (I018).
        if (same && verdicts.length === 0) continue;
        plans.push({ item, same, snap, verdicts });
      }
      if (plans.length === 0) return none('noop');

      const now = new Date();
      const moving = plans.filter((p) => !p.same).map((p) => p.item.id);
      const updatedRows =
        moving.length > 0
          ? await tx
              .update(reviewItems)
              .set(stateUpdates(input, ctx, now))
              .where(
                and(
                  eq(reviewItems.workspaceId, ctx.workspaceId),
                  inArray(reviewItems.id, moving),
                  // Autopilot's approve is conditional on the item still
                  // being 'new' (the row lock already guarantees it).
                  input.expectState ? eq(reviewItems.state, input.expectState) : undefined,
                ),
              )
              .returning()
          : [];
      if (updatedRows.length !== moving.length) throw invariant('review_items update missed rows');

      let decision: RecordedDecision | null = null;
      if (input.action && input.decisionKey) {
        const events: DecisionEventInput[] = plans.flatMap((p) =>
          p.snap ? toDecisionEvents(p.snap, p.verdicts, input.reason) : [],
        );
        decision = await recordDecision(tx, ctx, {
          kind: ACTION_KIND[input.action],
          origin: input.origin,
          decisionKey: input.decisionKey,
          subject: { type: 'review_item', id: ids.length === 1 ? ids[0]!.toString() : null },
          events,
          reasonText: input.reason,
          reasonCodes: input.reasonCodes,
        });
        if (input.origin === 'operator') {
          await writeOperatorVerdicts(tx, ctx, snaps, decision.events);
        }
      }

      if (input.bulkAudit) {
        await recordAuditEvent(
          ctx,
          {
            kind: input.bulkAudit.kind,
            entityType: input.bulkAudit.entityType,
            entityId: null,
            payload: {
              ...input.bulkAudit.payload,
              ids: plans.map((p) => p.item.id.toString()),
              count: plans.length,
              decisionId: decision?.decisionId ?? null,
            },
          },
          tx,
        );
      } else {
        for (const p of plans) {
          await recordAuditEvent(
            ctx,
            {
              kind: p.same ? 'review.verdicts_changed' : `review.${input.to}`,
              entityType: 'review_item',
              entityId: p.item.id,
              payload: {
                ...input.auditPayload,
                previousState: p.item.state,
                newState: input.to,
                reason: input.reason,
                origin: input.origin,
                decisionId: decision?.decisionId ?? null,
              },
            },
            tx,
          );
        }
      }

      const byId = new Map(updatedRows.map((r) => [r.id.toString(), r]));
      return {
        status: 'changed',
        items: locked.map((i) => byId.get(i.id.toString()) ?? i),
        changedIds: plans.map((p) => p.item.id),
        decision,
      };
    });
  } catch (err) {
    if (err instanceof DecisionReplayedError) {
      // A concurrent submit with the same key won; ours rolled back.
      const items = await db
        .select()
        .from(reviewItems)
        .where(and(eq(reviewItems.workspaceId, ctx.workspaceId), inArray(reviewItems.id, ids)));
      return { status: 'replayed', items, changedIds: [], decision: null };
    }
    if (err instanceof DecisionServiceError) throw invalid(err.message);
    throw err;
  }

  if (outcome.status === 'changed' && outcome.decision && input.action) {
    await afterReviewDecision(ctx, ACTION_KIND[input.action], input.origin, outcome);
  }
  return outcome;
}

/** After commit: wake the learning job, then the post-commit hooks. */
async function afterReviewDecision(
  ctx: WorkspaceContext,
  kind: DecisionKind,
  origin: DecisionOrigin,
  outcome: DecideOutcome,
): Promise<void> {
  const decision = outcome.decision;
  if (!decision) return;
  if (decision.pending) await enqueueDecisionProcessing(ctx, decision.decisionId);
  const itemsById = new Map(outcome.items.map((i) => [i.id.toString(), i]));
  for (const id of outcome.changedIds) {
    const item = itemsById.get(id.toString());
    if (!item) continue;
    const mine = decision.events.filter((e) => e.entityId === id.toString() && e.productProfileId !== null);
    const base = {
      ctx,
      decisionId: decision.decisionId,
      kind,
      origin,
      reviewItemId: id,
      sourceRecordId: item.sourceRecordId,
    };
    const fit = mine.filter((e) => e.verdict === 'fit').map((e) => e.productProfileId!);
    const notFit = mine.filter((e) => e.verdict === 'not_fit').map((e) => e.productProfileId!);
    if (fit.length > 0) await runDecisionHooks('onApprovedProducts', { ...base, productProfileIds: fit });
    if (notFit.length > 0) {
      await runDecisionHooks('onRejectedProducts', { ...base, productProfileIds: notFit });
    }
  }
}

async function decideOne(
  ctx: WorkspaceContext,
  id: bigint,
  to: ReviewItemState,
  action: ReviewDecisionAction | null,
  options: TransitionOptions,
): Promise<ReviewItem> {
  const outcome = await decideReviewItems(ctx, {
    ids: [id],
    to,
    action,
    origin: 'operator',
    reason: options.reason?.trim() || null,
    decisionKey: action ? resolveDecisionKey(options.decisionKey) : null,
    explicit: action ? explicitVerdictMap(options.productVerdicts) : null,
    reasonCodes: options.reasonCodes ?? [],
    lenient: false,
  });
  const item = outcome.items.find((i) => i.id === id);
  if (!item) throw notFound();
  return item;
}

export async function approveReviewItem(
  ctx: WorkspaceContext,
  id: bigint,
  reason?: string | null,
  options: ReviewDecisionOptions = {},
): Promise<ReviewItem> {
  if (!canWrite(ctx)) throw permissionDenied('set review state -> approved');
  return decideOne(ctx, id, 'approved', 'approve', { ...options, reason: reason ?? null });
}

export async function rejectReviewItem(
  ctx: WorkspaceContext,
  id: bigint,
  reason?: string | null,
  options: ReviewDecisionOptions = {},
): Promise<ReviewItem> {
  if (!canWrite(ctx)) throw permissionDenied('set review state -> rejected');
  return decideOne(ctx, id, 'rejected', 'reject', { ...options, reason: reason ?? null });
}

/** Ignore = "not interested": a half-weight Not a fit (§5). */
export async function ignoreReviewItem(
  ctx: WorkspaceContext,
  id: bigint,
  options: Pick<ReviewDecisionOptions, 'decisionKey' | 'reasonCodes'> = {},
): Promise<ReviewItem> {
  if (!canWrite(ctx)) throw permissionDenied('set review state -> ignored');
  return decideOne(ctx, id, 'ignored', 'ignore', options);
}

/** Flag for review is a deferral, not a verdict: no decision recorded. */
export async function flagForReview(ctx: WorkspaceContext, id: bigint): Promise<ReviewItem> {
  if (!canWrite(ctx)) throw permissionDenied('set review state -> needs_review');
  return decideOne(ctx, id, 'needs_review', null, {});
}

/** Archiving requires admin permission since it removes from active queue.
 *  A half-weight Not a fit (§5). */
export async function archiveReviewItem(
  ctx: WorkspaceContext,
  id: bigint,
  options: Pick<ReviewDecisionOptions, 'decisionKey' | 'reasonCodes'> = {},
): Promise<ReviewItem> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('archive review item');
  return decideOne(ctx, id, 'archived', 'archive', options);
}

/**
 * Autopilot's approve (stepAutoApproveProjects). Recorded with origin
 * 'autopilot' — approvedByUserId NULL, approvalReason 'autopilot' — so it
 * is never mistaken for, or learned from as, the owner's decision (I034).
 * Conditional: only an item still 'new' is approved; anything an operator
 * touched in the meantime is left alone. Idempotent per (run, item).
 */
export async function autopilotApproveReviewItem(
  ctx: WorkspaceContext,
  id: bigint,
  input: { runId: string; productProfileIds: readonly bigint[] },
): Promise<{ approved: boolean }> {
  if (!canWrite(ctx)) throw permissionDenied('autopilot approve');
  const outcome = await decideReviewItems(ctx, {
    ids: [id],
    to: 'approved',
    action: 'approve',
    origin: 'autopilot',
    reason: null,
    decisionKey: `autopilot:${input.runId}:${id}`,
    explicit: null,
    reasonCodes: [],
    lenient: true,
    expectState: 'new',
    autopilotProductIds: input.productProfileIds,
    auditPayload: {
      runId: input.runId,
      productProfileIds: input.productProfileIds.map((p) => p.toString()),
    },
  });
  return { approved: outcome.status === 'changed' };
}

const BULK_LIMIT = 500;

export interface BulkArchiveOptions {
  decisionKey?: string | null;
  /** Audit row for the call (default: review.bulk_archive). */
  audit?: { kind: AuditKind; entityType: string; payload: Record<string, unknown> };
  /** Shared reason chips (learning-chips.ts). A generalisable chip makes
   *  learning.process extract one rule per product-group (KL-03). */
  reasonCodes?: readonly string[];
}

/**
 * Bulk-archive review items by id. Skips ids that don't belong to the
 * workspace and items already archived. Caps at BULK_LIMIT per call to
 * avoid runaway audit payloads. Admin-only, like single-item archive. One
 * decision for the whole call: a half-weight Not a fit per item (§5).
 */
export async function bulkArchiveReviewItems(
  ctx: WorkspaceContext,
  ids: readonly bigint[],
  options: BulkArchiveOptions = {},
): Promise<{ archived: number; requested: number }> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('archive review items');
  const cappedIds = ids.slice(0, BULK_LIMIT);
  if (cappedIds.length === 0) return { archived: 0, requested: ids.length };
  const outcome = await decideReviewItems(ctx, {
    ids: cappedIds,
    to: 'archived',
    action: 'archive',
    origin: 'operator',
    reason: null,
    decisionKey: resolveDecisionKey(options.decisionKey),
    explicit: null,
    reasonCodes: options.reasonCodes ?? [],
    lenient: true,
    bulkAudit: options.audit ?? { kind: 'review.bulk_archive', entityType: 'review_item', payload: {} },
  });
  return { archived: outcome.changedIds.length, requested: ids.length };
}

/**
 * Bulk-delete review items by id (hard delete). Admin-only. Audit-logged.
 *
 * Items that carry learning events (decisions or comments) are KEPT and
 * reported: deleting them would orphan the decision record the learning
 * layer and the rule evidence point at (I030). Archive those instead.
 * Note the delete still cascades to the item's pipeline leads, drafts and
 * comments (Discovery I030 owns that guard).
 */
export async function bulkDeleteReviewItems(
  ctx: WorkspaceContext,
  ids: readonly bigint[],
): Promise<{ deleted: number; requested: number; kept: bigint[] }> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('delete review items');
  const cappedIds = ids.slice(0, BULK_LIMIT);
  if (cappedIds.length === 0) return { deleted: 0, requested: ids.length, kept: [] };
  return db.transaction(async (tx) => {
    // Lock first: a decision on one of these items holds the same lock, so
    // nothing can gain a decision between the check and the delete.
    const locked = await tx
      .select({ id: reviewItems.id })
      .from(reviewItems)
      .where(
        and(
          eq(reviewItems.workspaceId, ctx.workspaceId),
          inArray(reviewItems.id, cappedIds as bigint[]),
        ),
      )
      .for('update');
    if (locked.length === 0) return { deleted: 0, requested: ids.length, kept: [] };
    const withEvents = await tx
      .selectDistinct({ entityId: learningEvents.entityId })
      .from(learningEvents)
      .where(
        and(
          eq(learningEvents.workspaceId, ctx.workspaceId),
          eq(learningEvents.entityType, 'review_item'),
          inArray(
            learningEvents.entityId,
            locked.map((l) => l.id.toString()),
          ),
        ),
      );
    const keep = new Set(withEvents.map((r) => r.entityId));
    const kept = locked.filter((l) => keep.has(l.id.toString())).map((l) => l.id);
    const deletable = locked.filter((l) => !keep.has(l.id.toString())).map((l) => l.id);
    const deleted =
      deletable.length > 0
        ? await tx
            .delete(reviewItems)
            .where(
              and(eq(reviewItems.workspaceId, ctx.workspaceId), inArray(reviewItems.id, deletable)),
            )
            .returning({ id: reviewItems.id })
        : [];
    if (deleted.length > 0 || kept.length > 0) {
      await recordAuditEvent(
        ctx,
        {
          kind: 'review.bulk_delete',
          entityType: 'review_item',
          entityId: null,
          payload: {
            ids: deleted.map((d) => d.id.toString()),
            count: deleted.length,
            keptWithDecisions: kept.map((k) => k.toString()),
          },
        },
        tx,
      );
    }
    return { deleted: deleted.length, requested: ids.length, kept };
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
  }).then(async (result) => {
    // Targeted nudge for the new assignee (not for self-assignment).
    // Outside the transaction — notify is best-effort by contract.
    if (toUserId && toUserId !== ctx.userId) {
      const { notify } = await import('./notifications');
      await notify(ctx.workspaceId, {
        kind: 'assignment',
        title: 'A review item was assigned to you',
        href: `/review/${result.id}`,
        userId: toUserId,
        dedupeKey: `assignment:${result.id}:${toUserId}`,
      });
    }
    return result;
  });
}

// ---- comments ----------------------------------------------------------

export interface CommentOptions {
  /** Idempotency key — the form's nonce. A repeat posts nothing. */
  decisionKey?: string | null;
  /** Which products the instruction applies to. Default: the products the
   *  AI found the record relevant to (none → an unscoped event, which the
   *  processor scopes to the products the record was qualified against, or
   *  proposes as "Needs a scope" — never workspace-wide). 'workspace' =
   *  every product, chosen explicitly (the only way to a workspace rule). */
  appliesTo?: 'workspace' | readonly bigint[];
}

/**
 * Post a comment. A teachable comment (more than an @mention) is also a
 * decision: an 'instruction' event per product it applies to, recorded in
 * the same transaction and learned from by learning.process (one rule,
 * scoped to those products). With no relevant product and no explicit
 * choice the event is unscoped and the rule is scoped to the products the
 * record was qualified against (none: a proposed rule that "Needs a
 * scope"); only an explicit appliesTo 'workspace' makes a workspace-wide
 * rule. Comments never supersede verdicts.
 */
export async function commentOnReviewItem(
  ctx: WorkspaceContext,
  id: bigint,
  text: string,
  options: CommentOptions = {},
): Promise<ReviewComment> {
  if (!canWrite(ctx)) throw permissionDenied('comment on review item');
  const trimmed = text.trim();
  if (!trimmed) throw invalid('comment cannot be empty');
  if (trimmed.length > 5000) throw invalid('comment too long (5000 char max)');
  const decisionKey = resolveDecisionKey(options.decisionKey);
  const appliesTo = options.appliesTo ?? null;
  if (Array.isArray(appliesTo) && appliesTo.length === 0) {
    throw invalid('choose at least one product, or all products');
  }

  const latestComment = async (): Promise<ReviewComment> => {
    const rows = await db
      .select()
      .from(reviewComments)
      .where(
        and(
          eq(reviewComments.workspaceId, ctx.workspaceId),
          eq(reviewComments.reviewItemId, id),
          eq(reviewComments.userId, ctx.userId),
        ),
      )
      .orderBy(desc(reviewComments.id))
      .limit(1);
    if (!rows[0]) throw notFound();
    return rows[0];
  };

  let written: { comment: ReviewComment; decision: RecordedDecision } | null;
  try {
    written = await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(reviewItems)
        .where(and(eq(reviewItems.workspaceId, ctx.workspaceId), eq(reviewItems.id, id)))
        .for('update');
      const item = existing[0];
      if (!item) throw notFound();
      if (await findDecisionByKey(tx, ctx, decisionKey)) return null;

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
        .where(and(eq(reviewItems.workspaceId, ctx.workspaceId), eq(reviewItems.id, id)));

      const events: DecisionEventInput[] = [];
      if (stripMentions(trimmed).length >= MIN_TEACHABLE_TEXT) {
        const snap = (await loadReviewSnapshots(tx, ctx, [item])).get(id.toString());
        if (!snap) throw invariant('review snapshot missing');
        let productIds: Array<bigint | null>;
        let explicit = true;
        if (appliesTo === 'workspace') {
          productIds = [null];
        } else if (Array.isArray(appliesTo)) {
          const wanted = Array.from(new Set(appliesTo.map((p) => p.toString()))).map((s) => BigInt(s));
          const found = await tx
            .select({ id: productProfiles.id })
            .from(productProfiles)
            .where(
              and(
                eq(productProfiles.workspaceId, ctx.workspaceId),
                inArray(productProfiles.id, wanted),
              ),
            );
          if (found.length !== wanted.length) throw invalid('Product not found');
          productIds = wanted;
        } else {
          explicit = false;
          const relevant = snap.quals
            .filter((q) => isAiRelevant(q.qualification, q.product.relevanceThreshold))
            .map((q) => q.product.id);
          productIds = relevant.length > 0 ? relevant : [null];
        }
        for (const pid of productIds) {
          events.push({
            subject: { type: 'review_item', id: id.toString() },
            productProfileId: pid,
            verdict: null,
            polarity: 0,
            weight: 1,
            explicit,
            actionType: 'general_instruction',
            confidence: 50,
            context: reviewDecisionContext(snap, 'instruction', { commentId: comment.id.toString() }),
          });
        }
      }
      // The decision row is written even for a mention-only comment (no
      // events): it is what makes a repeated submit a no-op.
      const decision = await recordDecision(tx, ctx, {
        kind: 'review.comment',
        origin: 'operator',
        decisionKey,
        subject: { type: 'review_item', id: id.toString() },
        events,
        reasonText: trimmed,
      });

      await recordAuditEvent(
        ctx,
        {
          kind: 'review.comment',
          entityType: 'review_item',
          entityId: id,
          payload: {
            commentId: comment.id.toString(),
            preview: trimmed.slice(0, 120),
            decisionId: decision.decisionId,
          },
        },
        tx,
      );

      return { comment, decision };
    });
  } catch (err) {
    if (err instanceof DecisionReplayedError) return latestComment();
    if (err instanceof DecisionServiceError) throw invalid(err.message);
    throw err;
  }
  // Replay: the comment was already posted; nobody is notified twice.
  if (!written) return latestComment();
  const { comment, decision } = written;

  // Outside the transaction: the learning job extracts the rule.
  if (decision.pending) await enqueueDecisionProcessing(ctx, decision.decisionId);

  // @mentions: "@user@example.com" in a comment pings that member with
  // a targeted notification. Only resolves users who are actually
  // members of THIS workspace — mentioning an outsider does nothing.
  try {
    const mentioned = [
      ...new Set(
        (text.match(/@([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi) ?? []).map((m) =>
          m.slice(1).toLowerCase(),
        ),
      ),
    ];
    if (mentioned.length > 0) {
      const { workspaceMembers } = await import('@/lib/db/schema/workspaces');
      const members = await db
        .select({ userId: users.id, email: users.email })
        .from(users)
        .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
        .where(
          and(
            eq(workspaceMembers.workspaceId, ctx.workspaceId),
            inArray(users.email, mentioned),
          ),
        );
      const { notify } = await import('./notifications');
      for (const m of members) {
        if (m.userId === ctx.userId) continue;
        await notify(ctx.workspaceId, {
          kind: 'mention',
          title: 'You were mentioned on a review item',
          body: text.trim().slice(0, 200),
          href: `/review/${id}`,
          userId: m.userId,
          dedupeKey: `mention:${comment.id}:${m.userId}`,
        });
      }
    }
  } catch (err) {
    console.error('[review.comment] mention notify failed:', err);
  }
  return comment;
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
