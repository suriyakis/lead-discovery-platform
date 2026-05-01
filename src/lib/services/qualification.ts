// Qualification service. Persists rule-engine verdicts to the
// `qualifications` table, scoped to the workspace.

import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { sourceRecords, type SourceRecord } from '@/lib/db/schema/connectors';
import { productProfiles, type ProductProfile } from '@/lib/db/schema/products';
import {
  qualifications,
  type NewQualification,
  type Qualification,
} from '@/lib/db/schema/qualifications';
import { reviewItems, type ReviewItem } from '@/lib/db/schema/review';
import { recordAuditEvent } from './audit';
import type { WorkspaceContext } from './context';
import { getRelevantLessons } from './learning';
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

    const verdict = classifyRecord(classifiable, product, allLessons);
    const row = await upsertQualification(ctx.workspaceId, sourceRecord.id, product, verdict);
    inserted.push(row);
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
}

export interface LeadRow {
  qualification: Qualification;
  product: ProductProfile;
  sourceRecord: SourceRecord;
  reviewItem: ReviewItem | null;
}

export async function listLeads(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: LeadsFilter = {},
): Promise<LeadRow[]> {
  const relevantOnly = filter.relevantOnly ?? true;
  const limit = Math.min(filter.limit ?? 200, 1000);

  const conditions = [eq(qualifications.workspaceId, ctx.workspaceId)];
  if (relevantOnly) conditions.push(eq(qualifications.isRelevant, true));
  if (filter.productProfileId !== undefined) {
    conditions.push(eq(qualifications.productProfileId, filter.productProfileId));
  }

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
    .orderBy(desc(qualifications.relevanceScore), desc(qualifications.createdAt))
    .limit(limit);

  return rows;
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
