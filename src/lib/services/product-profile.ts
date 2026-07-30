import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { productProfiles, type NewProductProfile, type ProductProfile } from '@/lib/db/schema/products';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { outreachDrafts } from '@/lib/db/schema/outreach';
import { qualifications } from '@/lib/db/schema/qualifications';
import { recordAuditEvent } from './audit';
import { canAdminWorkspace, canWrite, type WorkspaceContext } from './context';

export class ProductProfileServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ProductProfileServiceError';
    this.code = code;
  }
}

const permissionDenied = (op: string) =>
  new ProductProfileServiceError(`Permission denied: ${op}`, 'permission_denied');
const notFound = () => new ProductProfileServiceError('product_profile not found', 'not_found');
const invariant = (msg: string) =>
  new ProductProfileServiceError(msg, 'invariant_violation');
const invalid = (msg: string) => new ProductProfileServiceError(msg, 'invalid_input');

// ---- creation ---------------------------------------------------------

export interface CreateProductProfileInput {
  name: string;
  shortDescription?: string | null;
  fullDescription?: string | null;
  targetCustomerTypes?: readonly string[];
  targetSectors?: readonly string[];
  targetProjectTypes?: readonly string[];
  includeKeywords?: readonly string[];
  excludeKeywords?: readonly string[];
  qualificationCriteria?: string | null;
  disqualificationCriteria?: string | null;
  relevanceThreshold?: number;
  outreachInstructions?: string | null;
  negativeOutreachInstructions?: string | null;
  forbiddenPhrases?: readonly string[];
  discoveryAngle?: string | null;
  engagementAngle?: string | null;
  pitchAngle?: string | null;
  language?: string;
  enrichDraftsWithResearch?: boolean;
  researchQuestionTemplate?: string;
}

export async function createProductProfile(
  ctx: WorkspaceContext,
  input: CreateProductProfileInput,
): Promise<ProductProfile> {
  if (!canWrite(ctx)) throw permissionDenied('create product profile');

  // Plan ceiling — count-then-insert (no transaction needed: worst case
  // a race lets one extra profile through, which the next create blocks).
  const [countRow] = await db
    .select({ existing: sql<number>`count(*)::int` })
    .from(productProfiles)
    .where(eq(productProfiles.workspaceId, ctx.workspaceId));
  const { assertCanCreateProduct } = await import('./plan-limits');
  await assertCanCreateProduct(ctx, Number(countRow?.existing ?? 0));

  const name = input.name.trim();
  if (!name) throw invalid('name is required');
  const threshold = input.relevanceThreshold ?? 50;
  if (threshold < 0 || threshold > 100) {
    throw invalid('relevanceThreshold must be between 0 and 100');
  }

  return db.transaction(async (tx) => {
    const row: NewProductProfile = {
      workspaceId: ctx.workspaceId,
      name,
      shortDescription: input.shortDescription ?? null,
      fullDescription: input.fullDescription ?? null,
      targetCustomerTypes: [...(input.targetCustomerTypes ?? [])],
      targetSectors: [...(input.targetSectors ?? [])],
      targetProjectTypes: [...(input.targetProjectTypes ?? [])],
      includeKeywords: [...(input.includeKeywords ?? [])],
      excludeKeywords: [...(input.excludeKeywords ?? [])],
      qualificationCriteria: input.qualificationCriteria ?? null,
      disqualificationCriteria: input.disqualificationCriteria ?? null,
      relevanceThreshold: threshold,
      outreachInstructions: input.outreachInstructions ?? null,
      negativeOutreachInstructions: input.negativeOutreachInstructions ?? null,
      forbiddenPhrases: [...(input.forbiddenPhrases ?? [])],
      discoveryAngle: input.discoveryAngle ?? null,
      engagementAngle: input.engagementAngle ?? null,
      pitchAngle: input.pitchAngle ?? null,
      language: input.language ?? 'en',
      ...(input.enrichDraftsWithResearch !== undefined
        ? { enrichDraftsWithResearch: input.enrichDraftsWithResearch }
        : {}),
      ...(input.researchQuestionTemplate !== undefined
        ? { researchQuestionTemplate: input.researchQuestionTemplate }
        : {}),
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    };

    const inserted = await tx.insert(productProfiles).values(row).returning();
    const profile = inserted[0];
    if (!profile) throw invariant('product_profiles insert returned no row');

    await recordAuditEvent(ctx, {
      kind: 'product_profile.create',
      entityType: 'product_profile',
      entityId: profile.id,
      payload: { name: profile.name },
    });

    return profile;
  });
}

// ---- read -------------------------------------------------------------

export async function getProductProfile(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<ProductProfile> {
  const rows = await db
    .select()
    .from(productProfiles)
    .where(
      and(eq(productProfiles.workspaceId, ctx.workspaceId), eq(productProfiles.id, id)),
    );
  const profile = rows[0];
  if (!profile) throw notFound();
  return profile;
}

export interface ListProductProfilesFilter {
  /** Default: only active. Pass `true` to include archived. */
  includeArchived?: boolean;
}

export async function listProductProfiles(
  ctx: WorkspaceContext,
  filter: ListProductProfilesFilter = {},
): Promise<ProductProfile[]> {
  const conds = [eq(productProfiles.workspaceId, ctx.workspaceId)];
  if (!filter.includeArchived) conds.push(eq(productProfiles.active, true));
  return db
    .select()
    .from(productProfiles)
    .where(and(...conds))
    .orderBy(asc(productProfiles.name));
}

// ---- update -----------------------------------------------------------

export type UpdateProductProfileInput = Partial<CreateProductProfileInput> & {
  active?: boolean;
};

export async function updateProductProfile(
  ctx: WorkspaceContext,
  id: bigint,
  patch: UpdateProductProfileInput,
): Promise<ProductProfile> {
  if (!canWrite(ctx)) throw permissionDenied('update product profile');
  if (patch.relevanceThreshold !== undefined) {
    if (patch.relevanceThreshold < 0 || patch.relevanceThreshold > 100) {
      throw invalid('relevanceThreshold must be between 0 and 100');
    }
  }

  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(productProfiles)
      .where(
        and(eq(productProfiles.workspaceId, ctx.workspaceId), eq(productProfiles.id, id)),
      );
    if (!existing[0]) throw notFound();

    const updates: Partial<NewProductProfile> & { updatedAt: Date } = {
      updatedBy: ctx.userId,
      updatedAt: new Date(),
    };

    // Trim and validate `name` if present.
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (!trimmed) throw invalid('name cannot be empty');
      updates.name = trimmed;
    }
    if (patch.shortDescription !== undefined)
      updates.shortDescription = patch.shortDescription ?? null;
    if (patch.fullDescription !== undefined)
      updates.fullDescription = patch.fullDescription ?? null;
    if (patch.targetCustomerTypes !== undefined)
      updates.targetCustomerTypes = [...patch.targetCustomerTypes];
    if (patch.targetSectors !== undefined) updates.targetSectors = [...patch.targetSectors];
    if (patch.targetProjectTypes !== undefined)
      updates.targetProjectTypes = [...patch.targetProjectTypes];
    if (patch.includeKeywords !== undefined) updates.includeKeywords = [...patch.includeKeywords];
    if (patch.excludeKeywords !== undefined) updates.excludeKeywords = [...patch.excludeKeywords];
    if (patch.qualificationCriteria !== undefined)
      updates.qualificationCriteria = patch.qualificationCriteria ?? null;
    if (patch.disqualificationCriteria !== undefined)
      updates.disqualificationCriteria = patch.disqualificationCriteria ?? null;
    if (patch.relevanceThreshold !== undefined)
      updates.relevanceThreshold = patch.relevanceThreshold;
    if (patch.outreachInstructions !== undefined)
      updates.outreachInstructions = patch.outreachInstructions ?? null;
    if (patch.negativeOutreachInstructions !== undefined)
      updates.negativeOutreachInstructions = patch.negativeOutreachInstructions ?? null;
    if (patch.forbiddenPhrases !== undefined)
      updates.forbiddenPhrases = [...patch.forbiddenPhrases];
    if (patch.discoveryAngle !== undefined)
      updates.discoveryAngle = patch.discoveryAngle ?? null;
    if (patch.engagementAngle !== undefined)
      updates.engagementAngle = patch.engagementAngle ?? null;
    if (patch.pitchAngle !== undefined)
      updates.pitchAngle = patch.pitchAngle ?? null;
    if (patch.language !== undefined) updates.language = patch.language;
    if (patch.active !== undefined) updates.active = patch.active;
    if (patch.enrichDraftsWithResearch !== undefined)
      updates.enrichDraftsWithResearch = patch.enrichDraftsWithResearch;
    if (patch.researchQuestionTemplate !== undefined)
      updates.researchQuestionTemplate = patch.researchQuestionTemplate;

    const updated = await tx
      .update(productProfiles)
      .set(updates)
      .where(
        and(eq(productProfiles.workspaceId, ctx.workspaceId), eq(productProfiles.id, id)),
      )
      .returning();
    const profile = updated[0];
    if (!profile) throw invariant('product_profiles update returned no row');

    await recordAuditEvent(ctx, {
      kind: 'product_profile.update',
      entityType: 'product_profile',
      entityId: profile.id,
      payload: { changedKeys: Object.keys(updates).filter((k) => k !== 'updatedAt' && k !== 'updatedBy') },
    });

    return profile;
  });
}

// ---- archive / restore ------------------------------------------------

export async function archiveProductProfile(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<ProductProfile> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('archive product profile');
  return updateProductProfile(ctx, id, { active: false });
}

export async function restoreProductProfile(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<ProductProfile> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('restore product profile');
  return updateProductProfile(ctx, id, { active: true });
}

// ---- delete -----------------------------------------------------------

export interface ProductProfileDependencyCounts {
  qualifications: number;
  outreachDrafts: number;
  qualifiedLeads: number;
}

export async function countProductProfileDependencies(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<ProductProfileDependencyCounts> {
  const all = await batchCountProductProfileDependencies(ctx, [id]);
  return (
    all.get(id.toString()) ?? {
      qualifications: 0,
      outreachDrafts: 0,
      qualifiedLeads: 0,
    }
  );
}

/**
 * Batched dependency counts — one round-trip per dependency table
 * regardless of how many product ids you ask about. Returns a map
 * keyed by id.toString() so callers can look up by stringified id
 * without re-coercing bigints. Empty buckets default to all-zeros so
 * the consumer doesn't have to guard against undefined.
 *
 * Used by list pages (e.g. /products) which would otherwise issue
 * 3 * N queries. Three GROUP BY queries instead.
 */
export async function batchCountProductProfileDependencies(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  ids: ReadonlyArray<bigint>,
): Promise<Map<string, ProductProfileDependencyCounts>> {
  const out = new Map<string, ProductProfileDependencyCounts>();
  if (ids.length === 0) return out;
  for (const id of ids) {
    out.set(id.toString(), {
      qualifications: 0,
      outreachDrafts: 0,
      qualifiedLeads: 0,
    });
  }
  const idList = ids as bigint[];

  const [qRows, oRows, lRows] = await Promise.all([
    db
      .select({
        pid: qualifications.productProfileId,
        n: sql<number>`count(*)::int`,
      })
      .from(qualifications)
      .where(
        and(
          eq(qualifications.workspaceId, ctx.workspaceId),
          inArray(qualifications.productProfileId, idList),
        ),
      )
      .groupBy(qualifications.productProfileId),
    db
      .select({
        pid: outreachDrafts.productProfileId,
        n: sql<number>`count(*)::int`,
      })
      .from(outreachDrafts)
      .where(
        and(
          eq(outreachDrafts.workspaceId, ctx.workspaceId),
          inArray(outreachDrafts.productProfileId, idList),
        ),
      )
      .groupBy(outreachDrafts.productProfileId),
    db
      .select({
        pid: qualifiedLeads.productProfileId,
        n: sql<number>`count(*)::int`,
      })
      .from(qualifiedLeads)
      .where(
        and(
          eq(qualifiedLeads.workspaceId, ctx.workspaceId),
          inArray(qualifiedLeads.productProfileId, idList),
        ),
      )
      .groupBy(qualifiedLeads.productProfileId),
  ]);

  for (const r of qRows) {
    const key = r.pid.toString();
    const cur = out.get(key);
    if (cur) cur.qualifications = r.n;
  }
  for (const r of oRows) {
    const key = r.pid.toString();
    const cur = out.get(key);
    if (cur) cur.outreachDrafts = r.n;
  }
  for (const r of lRows) {
    const key = r.pid.toString();
    const cur = out.get(key);
    if (cur) cur.qualifiedLeads = r.n;
  }
  return out;
}

/**
 * Hard-delete a product profile.
 *
 * Default (force=false): refuses if there's any downstream activity
 * (pipeline rows, qualifications, drafts) so operators don't lose
 * work by accident. They can either archive instead, or call again
 * with force=true after a typed-name confirmation in the UI.
 *
 * Force (force=true): cascades. The FK from qualifications,
 * outreach_drafts, qualified_leads, hint_signals, vector_stores all
 * have ON DELETE CASCADE — those rows go with it. learning_examples
 * FK is set-null so workspace-level memory stays. document
 * product_profile_ids arrays don't FK and become harmless orphan
 * id entries.
 *
 * Audit log captures the dependency counts at delete time for
 * forensics.
 */
export async function deleteProductProfile(
  ctx: WorkspaceContext,
  id: bigint,
  opts: { force?: boolean } = {},
): Promise<{ name: string }> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('delete product profile');

  const profile = await getProductProfile(ctx, id);
  const deps = await countProductProfileDependencies(ctx, id);
  const blocking =
    deps.qualifications + deps.outreachDrafts + deps.qualifiedLeads;
  if (blocking > 0 && !opts.force) {
    throw invalid(
      `cannot delete: ${deps.qualifiedLeads} qualified leads, ${deps.qualifications} qualifications, ${deps.outreachDrafts} drafts reference this profile — archive it, or force-delete from the product page`,
    );
  }

  return db.transaction(async (tx) => {
    await tx
      .delete(productProfiles)
      .where(
        and(
          eq(productProfiles.workspaceId, ctx.workspaceId),
          eq(productProfiles.id, id),
        ),
      );
    await recordAuditEvent(ctx, {
      kind: 'product_profile.delete',
      entityType: 'product_profile',
      entityId: profile.id,
      payload: {
        name: profile.name,
        force: Boolean(opts.force),
        cascadedQualifications: deps.qualifications,
        cascadedOutreachDrafts: deps.outreachDrafts,
        cascadedQualifiedLeads: deps.qualifiedLeads,
      },
    });
    return { name: profile.name };
  });
}
