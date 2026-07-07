// Qualification service. Persists rule-engine verdicts to the
// `qualifications` table, scoped to the workspace.

import { and, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  connectorRecipes,
  connectorRuns,
  sourceRecords,
  type SourceRecord,
} from '@/lib/db/schema/connectors';
import { productProfiles, type ProductProfile } from '@/lib/db/schema/products';
import {
  qualifications,
  type NewQualification,
  type Qualification,
} from '@/lib/db/schema/qualifications';
import { reviewItems, type ReviewItem } from '@/lib/db/schema/review';
import { recordAuditEvent } from './audit';
import { canAdminWorkspace, type WorkspaceContext } from './context';
import { applyGeoGate, normalizeCountry, type GeoStatus } from './geo';
import { getRelevantLessons, recordLessonsApplied } from './learning';

const BULK_LIMIT = 500;
import {
  classifyRecord,
  type ClassifiableRecord,
  type ClassificationVerdict,
} from './qualification-engine';

export class QualificationServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'QualificationServiceError';
    this.code = code;
  }
}

const notFound = (kind: string) =>
  new QualificationServiceError(`${kind} not found`, 'not_found');
const invariant = (msg: string) =>
  new QualificationServiceError(msg, 'invariant_violation');
const permissionDenied = (op: string) =>
  new QualificationServiceError(`Permission denied: ${op}`, 'permission_denied');

/**
 * Resolve the target country for a source record from the recipe that
 * discovered it. Prefers the live recipe (the recipe is the source of truth
 * for what qualifies — current operator intent), falling back to the frozen
 * run snapshot. Country is stored in the recipe's `selectors` jsonb and
 * flattened to the snapshot top level by freezeRecipe(). Returns null when no
 * country is set, which disables the geo gate.
 */
async function resolveRecipeCountry(
  record: Pick<SourceRecord, 'recipeId' | 'runId'>,
): Promise<string | null> {
  const pick = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null;

  if (record.recipeId != null) {
    const rows = await db
      .select({ selectors: connectorRecipes.selectors })
      .from(connectorRecipes)
      .where(eq(connectorRecipes.id, record.recipeId))
      .limit(1);
    const selectors = rows[0]?.selectors as Record<string, unknown> | undefined;
    const c = pick(selectors?.country);
    if (c) return c;
  }

  if (record.runId != null) {
    const rows = await db
      .select({ snapshot: connectorRuns.recipeSnapshot })
      .from(connectorRuns)
      .where(eq(connectorRuns.id, record.runId))
      .limit(1);
    const snapshot = rows[0]?.snapshot as Record<string, unknown> | null;
    const c = pick(snapshot?.country);
    if (c) return c;
  }

  return null;
}

/**
 * Run the rule engine for a single source record against ALL active product
 * profiles in the workspace. Persists one row per (record, product) pair.
 *
 * Designed to be called from the connector runner immediately after a new
 * source_record is inserted (best-effort; failures log but don't block).
 */
export async function classifySourceRecord(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  sourceRecordId: bigint,
): Promise<Qualification[]> {
  const recRows = await db
    .select()
    .from(sourceRecords)
    .where(
      and(
        eq(sourceRecords.workspaceId, ctx.workspaceId),
        eq(sourceRecords.id, sourceRecordId),
      ),
    );
  const sourceRecord = recRows[0];
  if (!sourceRecord) throw notFound('source_record');

  const products = await db
    .select()
    .from(productProfiles)
    .where(
      and(
        eq(productProfiles.workspaceId, ctx.workspaceId),
        eq(productProfiles.active, true),
      ),
    );

  if (products.length === 0) return [];

  const classifiable = extractClassifiable(sourceRecord.normalizedData as Record<string, unknown>);

  // Resolve the target country set on the recipe that discovered this record.
  // The recipe decides the geography; the geo gate below enforces it on every
  // verdict — AI and rules alike (grounded search can only bias sourcing).
  // Same value for every product, so resolve once before the per-product loop.
  const rawTargetCountry = await resolveRecipeCountry(sourceRecord);
  // Normalized form for the AI prompt; the gate itself takes the raw value
  // and handles unrecognisable targets (forces 'unverified', never no-gate).
  const targetCountry = normalizeCountry(rawTargetCountry);

  const inserted: Qualification[] = [];

  for (const product of products) {
    // Per-product lesson scope: workspace-wide + this product's lessons.
    const lessons = await getRelevantLessons(
      makeReadCtx(ctx),
      { productProfileId: product.id, taskType: 'classification' },
    );
    const wsLessons = await getRelevantLessons(
      makeReadCtx(ctx),
      { productProfileId: null, taskType: 'classification' },
    );
    const allLessons = [...lessons, ...wsLessons];

    // P62-08: try AI-based qualification first (Wandizz-style). Fall back
    // to the deterministic rules engine on any AI failure (provider down,
    // schema validation error, etc.) — never block lead creation on a
    // missing AI key or a transient outage.
    let verdict: ClassificationVerdict;
    let aiDetectedCountry: string | null = null;
    try {
      const { classifyRecordWithAI } = await import('./qualification-ai');
      const aiVerdict = await classifyRecordWithAI(
        ctx,
        classifiable,
        product,
        allLessons,
        { targetCountry },
      );
      aiDetectedCountry = aiVerdict.detectedCountry;
      verdict = aiVerdict;
    } catch (err) {
      console.error(
        `[qualification] AI classify failed (product=${product.id}), falling back to rules:`,
        err instanceof Error ? err.message : err,
      );
      const rulesVerdict = classifyRecord(classifiable, product, allLessons);
      verdict = { ...rulesVerdict, method: 'rules_fallback' };
    }

    // Locality gate — deterministic, applied to EVERY verdict regardless of
    // method, so an AI outage can never bypass the geography requirement.
    const gated = applyGeoGate(verdict, classifiable, rawTargetCountry, aiDetectedCountry);
    verdict = gated.verdict;
    const geo: { status: GeoStatus; inferredCountry: string | null; targetCountry: string | null } = {
      status: gated.geoStatus,
      inferredCountry: gated.inferredCountry,
      targetCountry: gated.targetCountry,
    };

    const row = await upsertQualification(ctx.workspaceId, sourceRecord.id, product, verdict, geo);
    inserted.push(row);

    // P60-06: mark the lessons we just consumed for scoring. Drives
    // compaction's "stale = low confidence + not applied recently" rule.
    if (allLessons.length > 0) {
      await recordLessonsApplied(
        ctx,
        allLessons.map((l) => l.id),
      );
    }
  }

  // A relevant lead whose location couldn't be verified must get explicit
  // human attention: escalate the backing review item from 'new' to
  // 'needs_review' so the queue surfaces the geo warning instead of letting
  // the item sail through as an ordinary approval.
  const needsGeoReview = inserted.some(
    (q) => q.isRelevant && q.geoStatus === 'unverified',
  );
  if (needsGeoReview) {
    await db
      .update(reviewItems)
      .set({ state: 'needs_review', updatedAt: new Date() })
      .where(
        and(
          eq(reviewItems.workspaceId, ctx.workspaceId),
          eq(reviewItems.sourceRecordId, sourceRecord.id),
          eq(reviewItems.state, 'new'),
        ),
      );
  }

  return inserted;
}

/** Re-classify every active source record in the workspace. Useful after
    product-profile edits. Returns the number of qualifications written. */
export async function reclassifyWorkspace(
  ctx: WorkspaceContext,
): Promise<{ recordCount: number; qualificationCount: number }> {
  const records = await db
    .select()
    .from(sourceRecords)
    .where(eq(sourceRecords.workspaceId, ctx.workspaceId));

  let qualificationCount = 0;
  for (const record of records) {
    const created = await classifySourceRecord(ctx, record.id);
    qualificationCount += created.length;
  }

  await recordAuditEvent(ctx, {
    kind: 'qualification.reclassify_workspace',
    entityType: 'workspace',
    entityId: ctx.workspaceId,
    payload: { recordCount: records.length, qualificationCount },
  });

  return { recordCount: records.length, qualificationCount };
}

// ---- read -----------------------------------------------------------

export async function listQualificationsForRecord(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  sourceRecordId: bigint,
): Promise<Array<{ qualification: Qualification; product: ProductProfile }>> {
  const rows = await db
    .select({
      qualification: qualifications,
      product: productProfiles,
    })
    .from(qualifications)
    .innerJoin(productProfiles, eq(productProfiles.id, qualifications.productProfileId))
    .where(
      and(
        eq(qualifications.workspaceId, ctx.workspaceId),
        eq(qualifications.sourceRecordId, sourceRecordId),
      ),
    )
    .orderBy(desc(qualifications.relevanceScore));
  return rows;
}

/** Top-1 qualification for a record (highest relevance), or null. */
export async function topQualification(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  sourceRecordId: bigint,
): Promise<{ qualification: Qualification; product: ProductProfile } | null> {
  const list = await listQualificationsForRecord(ctx, sourceRecordId);
  return list[0] ?? null;
}

/**
 * List qualifications across the workspace, joined to source record + product
 * profile + review item. Used by the `/leads` UI.
 *
 * Filters: optional product, optional `relevantOnly` (default true), with
 * stable ordering by relevance desc, then createdAt desc as tiebreak.
 */
export interface LeadsFilter {
  productProfileId?: bigint;
  relevantOnly?: boolean;
  limit?: number;
  offset?: number;
  createdAtFrom?: Date;
  createdAtTo?: Date;
  /** 'score' (default) sorts by relevance desc, then createdAt desc;
   *  'recent' sorts by createdAt desc, then relevance desc. */
  sort?: 'score' | 'recent';
}

export interface LeadRow {
  qualification: Qualification;
  product: ProductProfile;
  sourceRecord: SourceRecord;
  reviewItem: ReviewItem | null;
}

/**
 * Build the WHERE conditions shared by listLeads and countLeads — kept
 * in one place so the two queries always see the same data set. The
 * `(reviewItems.state IS NULL OR != 'archived')` predicate is the SQL
 * twin of the post-filter that used to live in JS; pushing it into the
 * query lets the count match the actual rendered list exactly.
 */
function buildLeadsConditions(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: LeadsFilter,
) {
  const relevantOnly = filter.relevantOnly ?? true;
  const conditions = [eq(qualifications.workspaceId, ctx.workspaceId)];
  if (relevantOnly) conditions.push(eq(qualifications.isRelevant, true));
  if (filter.productProfileId !== undefined) {
    conditions.push(eq(qualifications.productProfileId, filter.productProfileId));
  }
  if (filter.createdAtFrom !== undefined) {
    conditions.push(gte(qualifications.createdAt, filter.createdAtFrom));
  }
  if (filter.createdAtTo !== undefined) {
    conditions.push(lte(qualifications.createdAt, filter.createdAtTo));
  }
  const archivedFilter = or(
    isNull(reviewItems.state),
    ne(reviewItems.state, 'archived'),
  );
  if (archivedFilter !== undefined) conditions.push(archivedFilter);
  return conditions;
}

export async function listLeads(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: LeadsFilter = {},
): Promise<LeadRow[]> {
  const limit = Math.min(filter.limit ?? 200, 1000);
  const offset = Math.max(0, filter.offset ?? 0);

  const conditions = buildLeadsConditions(ctx, filter);

  const rows = await db
    .select({
      qualification: qualifications,
      product: productProfiles,
      sourceRecord: sourceRecords,
      reviewItem: reviewItems,
    })
    .from(qualifications)
    .innerJoin(productProfiles, eq(productProfiles.id, qualifications.productProfileId))
    .innerJoin(sourceRecords, eq(sourceRecords.id, qualifications.sourceRecordId))
    .leftJoin(
      reviewItems,
      and(
        eq(reviewItems.sourceRecordId, qualifications.sourceRecordId),
        eq(reviewItems.workspaceId, qualifications.workspaceId),
      ),
    )
    .where(and(...conditions))
    .orderBy(
      ...(filter.sort === 'recent'
        ? [desc(qualifications.createdAt), desc(qualifications.relevanceScore)]
        : [desc(qualifications.relevanceScore), desc(qualifications.createdAt)]),
    )
    .limit(limit)
    .offset(offset);

  return rows;
}

/**
 * Count leads matching the same filter as listLeads (excluding limit /
 * offset). Powers the pagination UI on /leads.
 */
export async function countLeads(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: Omit<LeadsFilter, 'limit' | 'offset'> = {},
): Promise<number> {
  const conditions = buildLeadsConditions(ctx, filter);
  const result = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(qualifications)
    .innerJoin(productProfiles, eq(productProfiles.id, qualifications.productProfileId))
    .innerJoin(sourceRecords, eq(sourceRecords.id, qualifications.sourceRecordId))
    .leftJoin(
      reviewItems,
      and(
        eq(reviewItems.sourceRecordId, qualifications.sourceRecordId),
        eq(reviewItems.workspaceId, qualifications.workspaceId),
      ),
    )
    .where(and(...conditions));
  return result[0]?.value ?? 0;
}

/**
 * Bulk-archive leads (workspace-scoped) by qualification id. Resolves each
 * qualification to its backing review_item and archives those that exist.
 * Qualifications without a review_item are silently skipped. Admin-only,
 * capped at 500 per call, single audit event per batch.
 */
export async function bulkArchiveLeads(
  ctx: WorkspaceContext,
  qualificationIds: readonly bigint[],
): Promise<{ archived: number; requested: number }> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('archive leads');
  const cappedIds = qualificationIds.slice(0, BULK_LIMIT);
  if (cappedIds.length === 0) return { archived: 0, requested: qualificationIds.length };
  return db.transaction(async (tx) => {
    // Find review_items via source_records joined through the qualifications.
    const rows = await tx
      .select({
        reviewItemId: reviewItems.id,
      })
      .from(qualifications)
      .innerJoin(
        reviewItems,
        and(
          eq(reviewItems.sourceRecordId, qualifications.sourceRecordId),
          eq(reviewItems.workspaceId, qualifications.workspaceId),
        ),
      )
      .where(
        and(
          eq(qualifications.workspaceId, ctx.workspaceId),
          inArray(qualifications.id, cappedIds as bigint[]),
        ),
      );
    const riIds = Array.from(new Set(rows.map((r) => r.reviewItemId)));
    if (riIds.length === 0) {
      return { archived: 0, requested: qualificationIds.length };
    }
    const updated = await tx
      .update(reviewItems)
      .set({ state: 'archived', updatedAt: new Date() })
      .where(
        and(
          eq(reviewItems.workspaceId, ctx.workspaceId),
          inArray(reviewItems.id, riIds),
        ),
      )
      .returning({ id: reviewItems.id });
    if (updated.length > 0) {
      await recordAuditEvent(ctx, {
        kind: 'lead.bulk_archive',
        entityType: 'qualification',
        entityId: null,
        payload: {
          qualificationIds: cappedIds.map((id) => id.toString()),
          archivedReviewItems: updated.map((u) => u.id.toString()),
        },
      });
    }
    return { archived: updated.length, requested: qualificationIds.length };
  });
}

/**
 * Bulk-delete leads (workspace-scoped) by qualification id. Deletes the
 * qualification row AND the matching review_item (when present), so the
 * lead truly disappears from /leads. Source records remain. Admin-only,
 * capped at 500 per call, single audit event per batch.
 */
export async function bulkDeleteLeads(
  ctx: WorkspaceContext,
  qualificationIds: readonly bigint[],
): Promise<{ deleted: number; requested: number }> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('delete leads');
  const cappedIds = qualificationIds.slice(0, BULK_LIMIT);
  if (cappedIds.length === 0) return { deleted: 0, requested: qualificationIds.length };
  return db.transaction(async (tx) => {
    const qualRows = await tx
      .select({ id: qualifications.id, sourceRecordId: qualifications.sourceRecordId })
      .from(qualifications)
      .where(
        and(
          eq(qualifications.workspaceId, ctx.workspaceId),
          inArray(qualifications.id, cappedIds as bigint[]),
        ),
      );
    if (qualRows.length === 0) {
      return { deleted: 0, requested: qualificationIds.length };
    }
    const sourceRecordIds = Array.from(new Set(qualRows.map((q) => q.sourceRecordId)));
    const qualIdsFound = qualRows.map((q) => q.id);
    // Delete the qualifications first so the leftover review_item rows can
    // be safely removed without orphan-FK juggling.
    const deletedQuals = await tx
      .delete(qualifications)
      .where(
        and(
          eq(qualifications.workspaceId, ctx.workspaceId),
          inArray(qualifications.id, qualIdsFound),
        ),
      )
      .returning({ id: qualifications.id });
    // Then the matching review_items — note that ONE review_item may back
    // multiple qualifications across products; we only delete the
    // review_item if every qualification for its source_record was just
    // removed. Easiest check: re-query qualifications for these source
    // records and drop review_items whose source_record has none left.
    const remaining = await tx
      .select({ sourceRecordId: qualifications.sourceRecordId })
      .from(qualifications)
      .where(
        and(
          eq(qualifications.workspaceId, ctx.workspaceId),
          inArray(qualifications.sourceRecordId, sourceRecordIds),
        ),
      );
    const stillReferenced = new Set(remaining.map((r) => r.sourceRecordId.toString()));
    const orphanedSourceRecords = sourceRecordIds.filter(
      (id) => !stillReferenced.has(id.toString()),
    );
    if (orphanedSourceRecords.length > 0) {
      await tx
        .delete(reviewItems)
        .where(
          and(
            eq(reviewItems.workspaceId, ctx.workspaceId),
            inArray(reviewItems.sourceRecordId, orphanedSourceRecords),
          ),
        );
    }
    await recordAuditEvent(ctx, {
      kind: 'lead.bulk_delete',
      entityType: 'qualification',
      entityId: null,
      payload: {
        qualificationIds: deletedQuals.map((d) => d.id.toString()),
        orphanedSourceRecords: orphanedSourceRecords.map((id) => id.toString()),
        count: deletedQuals.length,
      },
    });
    return { deleted: deletedQuals.length, requested: qualificationIds.length };
  });
}

// ---- internals ------------------------------------------------------

function extractClassifiable(normalized: Record<string, unknown>): ClassifiableRecord {
  return {
    title: typeof normalized.title === 'string' ? normalized.title : null,
    snippet: typeof normalized.snippet === 'string' ? normalized.snippet : null,
    url: typeof normalized.url === 'string' ? normalized.url : null,
    domain: typeof normalized.domain === 'string' ? normalized.domain : null,
    body: typeof normalized.body === 'string' ? normalized.body : null,
  };
}

async function upsertQualification(
  workspaceId: bigint,
  sourceRecordId: bigint,
  product: ProductProfile,
  verdict: ClassificationVerdict,
  geo: { status: GeoStatus; inferredCountry: string | null; targetCountry: string | null },
): Promise<Qualification> {
  const row: NewQualification = {
    workspaceId,
    sourceRecordId,
    productProfileId: product.id,
    isRelevant: verdict.isRelevant,
    relevanceScore: verdict.relevanceScore,
    confidence: verdict.confidence,
    qualificationReason: verdict.qualificationReason,
    rejectionReason: verdict.rejectionReason,
    matchedKeywords: verdict.matchedKeywords,
    disqualifyingSignals: verdict.disqualifyingSignals,
    evidence: serializeEvidence(verdict.evidence),
    method: verdict.method,
    targetCountry: geo.targetCountry,
    inferredCountry: geo.inferredCountry,
    geoStatus: geo.status,
  };

  await db
    .insert(qualifications)
    .values(row)
    .onConflictDoUpdate({
      target: [
        qualifications.workspaceId,
        qualifications.sourceRecordId,
        qualifications.productProfileId,
      ],
      set: {
        isRelevant: row.isRelevant,
        relevanceScore: row.relevanceScore,
        confidence: row.confidence,
        qualificationReason: row.qualificationReason,
        rejectionReason: row.rejectionReason,
        matchedKeywords: row.matchedKeywords,
        disqualifyingSignals: row.disqualifyingSignals,
        evidence: row.evidence,
        method: row.method,
        targetCountry: row.targetCountry,
        inferredCountry: row.inferredCountry,
        geoStatus: row.geoStatus,
        updatedAt: new Date(),
      },
    });

  const reloaded = await db
    .select()
    .from(qualifications)
    .where(
      and(
        eq(qualifications.workspaceId, workspaceId),
        eq(qualifications.sourceRecordId, sourceRecordId),
        eq(qualifications.productProfileId, product.id),
      ),
    );
  if (!reloaded[0]) throw invariant('qualification missing after upsert');
  return reloaded[0];
}

function serializeEvidence(evidence: ClassificationVerdict['evidence']): Record<string, unknown> {
  return {
    contributions: evidence.contributions,
    matchedLessonIds: evidence.matchedLessonIds.map((id) => id.toString()),
  };
}

/** Construct a minimal read context. The retrieval helpers don't enforce
    role for reads; we just need workspaceId + a userId placeholder. */
function makeReadCtx(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): WorkspaceContext {
  return {
    workspaceId: ctx.workspaceId,
    userId: 'system:qualification',
    role: 'super_admin',
  };
}

// re-export for convenience
export { classifyRecord } from './qualification-engine';
export type { ClassifiableRecord, ClassificationVerdict } from './qualification-engine';

void sql; // future SQL helpers planned for Phase 7+
