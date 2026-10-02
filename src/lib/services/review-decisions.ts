// Review decisions → decision record (KL-02).
//
// What a review decision means per product (§5 of the KL plan), the record
// snapshot every decision event carries (I036), and the operator verdict
// written back onto qualifications. review.ts calls these inside the
// decision's transaction; nothing here commits on its own.
//
// Which products a decision speaks for (I032):
//   - explicit per-product verdicts, when the caller passes them (the KL-20
//     decision panel);
//   - otherwise the defaults: the products the AI found relevant — method
//     'ai', relevant, score at or above the product's threshold — plus any
//     product an autopilot approval is live on (so overturning autopilot
//     always reaches the product it approved);
//   - with neither, one unscoped event with no verdict: the decision is
//     kept, but it is not pinned on a product the AI never matched.

import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { sourceRecords, type SourceRecord } from '@/lib/db/schema/connectors';
import { productProfiles } from '@/lib/db/schema/products';
import { qualifications, type Qualification } from '@/lib/db/schema/qualifications';
import { learningEvents, type LearningEvent, type OperatorVerdict } from '@/lib/db/schema/learning';
import type { ReviewItem } from '@/lib/db/schema/review';
import type { WorkspaceContext } from './context';
import type { LearningTx } from './learning';
import type {
  DecisionContext,
  DecisionEventInput,
  DecisionProductSnapshot,
  DecisionRecordSnapshot,
} from './learning-decisions';

export type ReviewDecisionAction = 'approve' | 'reject' | 'ignore' | 'archive';

export interface ReviewQualSnapshot {
  qualification: Qualification;
  product: { id: bigint; name: string; relevanceThreshold: number };
}

export interface ReviewRecordSnapshot {
  item: ReviewItem;
  sourceRecord: SourceRecord;
  quals: ReviewQualSnapshot[];
  /** Products with a live (not voided) autopilot verdict on this item. */
  autopilotProductIds: Set<string>;
  record: DecisionRecordSnapshot;
  products: DecisionProductSnapshot[];
}

/** The AI judged the record relevant to the product, by the AI method and
 *  at or above the product's threshold. Rules-fallback and below-threshold
 *  "relevant" rows are not defaults (§5): an operator has to decide them. */
export function isAiRelevant(q: Qualification, threshold: number): boolean {
  return q.method === 'ai' && q.isRelevant && q.relevanceScore >= threshold;
}

// ---- record snapshot ----------------------------------------------------------

const VERTEX_HOST = 'vertexaisearch.cloud.google.com';

/** A bare, lower-case company domain, or null. Never a Vertex grounding
 *  redirect host (all prod URLs are Vertex redirects; the true domain, when
 *  known, is normalized_data.domain). */
export function normalizeSnapshotDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let d = raw.trim().toLowerCase();
  if (!d) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(d)) {
    try {
      d = new URL(d).hostname;
    } catch {
      return null;
    }
  }
  d = d.replace(/^www\./, '').replace(/\.$/, '');
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(d)) return null;
  if (d === VERTEX_HOST || d.endsWith(`.${VERTEX_HOST}`)) return null;
  return d;
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

const GEO_RANK: Record<string, number> = { mismatch: 3, unverified: 2, match: 1, no_gate: 0 };

function recordSnapshot(sr: SourceRecord, quals: ReviewQualSnapshot[]): DecisionRecordSnapshot {
  const nd = (sr.normalizedData ?? {}) as Record<string, unknown>;
  const geo = quals
    .map((q) => q.qualification.geoStatus)
    .sort((a, b) => (GEO_RANK[b] ?? 0) - (GEO_RANK[a] ?? 0))[0];
  return {
    title: text(nd.title)?.slice(0, 200) ?? null,
    domain:
      normalizeSnapshotDomain(nd.domain) ??
      normalizeSnapshotDomain(nd.url) ??
      normalizeSnapshotDomain(sr.sourceUrl),
    sourceSystem: sr.sourceSystem,
    connectorId: sr.connectorId?.toString() ?? null,
    recipeId: sr.recipeId?.toString() ?? null,
    targetCountry:
      quals.find((q) => q.qualification.targetCountry)?.qualification.targetCountry ?? null,
    detectedCountry:
      quals.find((q) => q.qualification.inferredCountry)?.qualification.inferredCountry ?? null,
    geoStatus: geo ?? null,
    evidenceQuality: text(nd.body) ? 'body' : text(nd.snippet) ? 'snippet' : 'domain_only',
  };
}

function lessonIdStrings(v: unknown): string[] {
  return Array.isArray(v)
    ? v
        .map((x) => (typeof x === 'bigint' ? x.toString() : x))
        .filter((x): x is string => typeof x === 'string' && /^\d{1,19}$/.test(x))
    : [];
}

function productSnapshot(qs: ReviewQualSnapshot): DecisionProductSnapshot {
  const q = qs.qualification;
  const ev = (q.evidence ?? {}) as { matchedLessonIds?: unknown; citedLessons?: unknown };
  const cited = Array.isArray(ev.citedLessons)
    ? lessonIdStrings(
        ev.citedLessons.map((c) => (c && typeof c === 'object' ? (c as { id?: unknown }).id : c)),
      )
    : [];
  const reason =
    (q.isRelevant ? q.qualificationReason : (q.rejectionReason ?? q.qualificationReason)) ?? null;
  return {
    id: qs.product.id.toString(),
    name: qs.product.name,
    ai: {
      relevant: q.isRelevant,
      method: q.method,
      score: q.relevanceScore,
      threshold: qs.product.relevanceThreshold,
      belowThreshold: q.isRelevant && q.relevanceScore < qs.product.relevanceThreshold,
      reason: reason ? reason.slice(0, 300) : null,
      matchedLessonIds: lessonIdStrings(ev.matchedLessonIds),
      citedLessonIds: cited,
    },
    priorVerdict: q.operatorVerdict ?? null,
  };
}

/**
 * Everything a decision on these review items needs, read inside the
 * decision's transaction (after the items were locked): the source record,
 * every qualification with its product, and the live autopilot verdicts.
 */
export async function loadReviewSnapshots(
  tx: LearningTx,
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  items: readonly ReviewItem[],
): Promise<Map<string, ReviewRecordSnapshot>> {
  const out = new Map<string, ReviewRecordSnapshot>();
  if (items.length === 0) return out;
  const recordIds = Array.from(new Set(items.map((i) => i.sourceRecordId.toString()))).map((s) =>
    BigInt(s),
  );
  const records = await tx
    .select()
    .from(sourceRecords)
    .where(
      and(eq(sourceRecords.workspaceId, ctx.workspaceId), inArray(sourceRecords.id, recordIds)),
    );
  const quals = await tx
    .select({
      qualification: qualifications,
      product: {
        id: productProfiles.id,
        name: productProfiles.name,
        relevanceThreshold: productProfiles.relevanceThreshold,
      },
    })
    .from(qualifications)
    .innerJoin(
      productProfiles,
      and(
        eq(productProfiles.id, qualifications.productProfileId),
        eq(productProfiles.workspaceId, qualifications.workspaceId),
      ),
    )
    .where(
      and(
        eq(qualifications.workspaceId, ctx.workspaceId),
        inArray(qualifications.sourceRecordId, recordIds),
      ),
    )
    .orderBy(qualifications.productProfileId);
  const autopilot = await tx
    .select({
      entityId: learningEvents.entityId,
      productProfileId: learningEvents.productProfileId,
    })
    .from(learningEvents)
    .where(
      and(
        eq(learningEvents.workspaceId, ctx.workspaceId),
        eq(learningEvents.entityType, 'review_item'),
        inArray(
          learningEvents.entityId,
          items.map((i) => i.id.toString()),
        ),
        eq(learningEvents.origin, 'autopilot'),
        isNotNull(learningEvents.verdict),
        isNull(learningEvents.voidedAt),
      ),
    );

  const recordById = new Map(records.map((r) => [r.id.toString(), r]));
  for (const item of items) {
    const sr = recordById.get(item.sourceRecordId.toString());
    if (!sr) continue;
    const mine = quals.filter((q) => q.qualification.sourceRecordId === item.sourceRecordId);
    out.set(item.id.toString(), {
      item,
      sourceRecord: sr,
      quals: mine,
      autopilotProductIds: new Set(
        autopilot
          .filter((a) => a.entityId === item.id.toString() && a.productProfileId !== null)
          .map((a) => a.productProfileId!.toString()),
      ),
      record: recordSnapshot(sr, mine),
      products: mine.map(productSnapshot),
    });
  }
  return out;
}

export function reviewDecisionContext(
  snap: ReviewRecordSnapshot,
  outcome: string,
  extra: { commentId?: string } = {},
): DecisionContext {
  return {
    v: 1,
    subject: { type: 'review_item', id: snap.item.id.toString() },
    outcome,
    record: snap.record,
    products: snap.products,
    ...(extra.commentId ? { commentId: extra.commentId } : {}),
  };
}

// ---- verdict resolution -----------------------------------------------------------

export interface ResolvedVerdict {
  productProfileId: bigint | null;
  verdict: OperatorVerdict | null;
  polarity: -1 | 1;
  weight: number;
  explicit: boolean;
  actionType: string;
  outcome: string;
}

export interface ResolveOptions {
  origin: 'operator' | 'autopilot';
  /** Explicit verdicts by product id (string). */
  explicit?: ReadonlyMap<string, OperatorVerdict> | null;
  /** Same-state decision: only verdicts that change the stored one. */
  onlyChanges?: boolean;
  /** Autopilot: the products whose overlay + threshold the record passed. */
  autopilotProductIds?: readonly bigint[];
}

/**
 * The per-product verdicts one review decision records (see the header).
 * Weights (§5): an explicit verdict or a disagreement with the AI (or with
 * a live autopilot approval) is 1; a default the operator left untouched
 * that agrees with the AI is 0.5; archive and ignore are always 0.5.
 * Returns [] only for a same-state decision that changes nothing; every
 * other decision returns at least one verdict (an unscoped one if needed).
 */
export function resolveReviewVerdicts(
  snap: ReviewRecordSnapshot,
  action: ReviewDecisionAction,
  opts: ResolveOptions,
): ResolvedVerdict[] {
  const direction: OperatorVerdict = action === 'approve' ? 'fit' : 'not_fit';
  const dismissal = action === 'ignore' || action === 'archive';
  const out: ResolvedVerdict[] = [];

  if (opts.origin === 'autopilot') {
    const wanted = new Set((opts.autopilotProductIds ?? []).map((id) => id.toString()));
    for (const qs of snap.quals) {
      if (!wanted.has(qs.product.id.toString())) continue;
      out.push({
        productProfileId: qs.product.id,
        verdict: 'fit',
        polarity: 1,
        weight: 1,
        explicit: false,
        actionType: 'auto_approval',
        outcome: 'autopilot',
      });
    }
    if (out.length === 0) {
      out.push({
        productProfileId: null,
        verdict: null,
        polarity: 1,
        weight: 1,
        explicit: false,
        actionType: 'auto_approval',
        outcome: 'autopilot',
      });
    }
    return out;
  }

  for (const qs of snap.quals) {
    const pid = qs.product.id.toString();
    const aiRelevant = isAiRelevant(qs.qualification, qs.product.relevanceThreshold);
    const autopilotLive = snap.autopilotProductIds.has(pid);
    const chosen = opts.explicit?.get(pid);
    let verdict: OperatorVerdict;
    const explicit = chosen !== undefined;
    if (chosen !== undefined) {
      verdict = chosen;
    } else {
      if (opts.onlyChanges) continue;
      if (!aiRelevant && !autopilotLive) continue;
      verdict = direction;
    }
    if (opts.onlyChanges && qs.qualification.operatorVerdict === verdict) continue;
    const agreesWithAi = (verdict === 'fit') === aiRelevant;
    const overturnsAutopilot = autopilotLive && verdict === 'not_fit';
    const weight = dismissal ? 0.5 : explicit || !agreesWithAi || overturnsAutopilot ? 1 : 0.5;
    const outcome = dismissal
      ? 'dismissed'
      : verdict === 'fit'
        ? aiRelevant
          ? 'fit_confirmed'
          : 'false_negative'
        : aiRelevant
          ? 'false_positive'
          : 'not_fit_confirmed';
    out.push({
      productProfileId: qs.product.id,
      verdict,
      polarity: verdict === 'fit' ? 1 : -1,
      weight,
      explicit,
      actionType:
        verdict === 'fit'
          ? aiRelevant
            ? 'qualification_positive'
            : 'false_negative'
          : aiRelevant
            ? 'false_positive'
            : 'qualification_negative',
      outcome,
    });
  }

  if (out.length === 0 && !opts.onlyChanges) {
    out.push({
      productProfileId: null,
      verdict: null,
      polarity: direction === 'fit' ? 1 : -1,
      weight: dismissal ? 0.5 : 1,
      explicit: false,
      actionType: direction === 'fit' ? 'qualification_positive' : 'qualification_negative',
      outcome: 'unscoped',
    });
  }
  return out;
}

export function toDecisionEvents(
  snap: ReviewRecordSnapshot,
  verdicts: readonly ResolvedVerdict[],
  reason: string | null,
): DecisionEventInput[] {
  const confidence = reason && reason.trim() ? 75 : 60;
  return verdicts.map((v) => ({
    subject: { type: 'review_item', id: snap.item.id.toString() },
    productProfileId: v.productProfileId,
    verdict: v.verdict,
    polarity: v.polarity,
    weight: v.weight,
    explicit: v.explicit,
    actionType: v.actionType,
    confidence,
    context: reviewDecisionContext(snap, v.outcome),
  }));
}

/**
 * Write the operator's verdicts onto the qualifications (domain state),
 * linked to the events that carry them. A Fit on a geo-unverified product
 * is also the human location confirmation the send-time re-check needs.
 */
export async function writeOperatorVerdicts(
  tx: LearningTx,
  ctx: WorkspaceContext,
  snaps: ReadonlyMap<string, ReviewRecordSnapshot>,
  events: readonly LearningEvent[],
): Promise<void> {
  const now = new Date();
  for (const e of events) {
    if (e.origin !== 'operator' || !e.verdict || e.productProfileId === null || !e.entityId)
      continue;
    const snap = snaps.get(e.entityId);
    const qs = snap?.quals.find((q) => q.product.id === e.productProfileId);
    if (!snap || !qs) continue;
    const confirmGeo = e.verdict === 'fit' && qs.qualification.geoStatus === 'unverified';
    await tx
      .update(qualifications)
      .set({
        operatorVerdict: e.verdict,
        operatorDecidedBy: ctx.userId,
        operatorDecidedAt: now,
        operatorEventId: e.id,
        ...(confirmGeo ? { geoConfirmedBy: ctx.userId, geoConfirmedAt: now } : {}),
      })
      .where(
        and(
          eq(qualifications.workspaceId, ctx.workspaceId),
          eq(qualifications.sourceRecordId, snap.sourceRecord.id),
          eq(qualifications.productProfileId, e.productProfileId),
        ),
      );
  }
}
