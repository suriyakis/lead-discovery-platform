import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { productProfiles, type NewProductProfile, type ProductProfile } from '@/lib/db/schema/products';
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
  language?: string;
}

export async function createProductProfile(
  ctx: WorkspaceContext,
  input: CreateProductProfileInput,
): Promise<ProductProfile> {
  if (!canWrite(ctx)) throw permissionDenied('create product profile');

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
      language: input.language ?? 'en',
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
    if (patch.language !== undefined) updates.language = patch.language;
    if (patch.active !== undefined) updates.active = patch.active;

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
