// Knowledge-sources service. A knowledge source wraps either a document, a
// URL, or a free-text excerpt. Its chunks (rag.ts) are what retrieval reads.
//
// KL-05 scope: a source is either workspace-wide (scope_kind 'workspace',
// every product) or scoped to exactly the products in
// knowledge_source_products (scope_kind 'products'). Callers state the
// scope explicitly; the composite FK refuses another tenant's product (the
// old pre-filter that silently dropped such ids is gone — a bad id is an
// error), and deleting a product cascades its rows, leaving a source with
// none "Needs a scope". A document is wrapped by at most one source: a
// second source for the same document would either duplicate its passages
// or keep it workspace-wide after the operator scoped it (I039).

import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  documents,
  knowledgeSourceProducts,
  knowledgeSources,
  type Document,
  type KnowledgeSource,
  type KnowledgeSourceKind,
  type NewKnowledgeSource,
} from '@/lib/db/schema/documents';
import { productProfiles, type ProductProfile } from '@/lib/db/schema/products';
import { recordAuditEvent } from './audit';
import {
  canAdminWorkspace,
  canWrite,
  type WorkspaceContext,
} from './context';
import {
  describeScope,
  knowledgeSourceForProduct,
  knowledgeSourceNeedsScope,
  knowledgeSourceWorkspaceWide,
  loadSourceProductIds,
  type KnowledgeScopeInput,
  type KnowledgeSourceScope,
} from './knowledge-scope';

export type KnowledgeSourceErrorCode =
  | 'permission_denied'
  | 'not_found'
  | 'invariant_violation'
  | 'invalid_input'
  | 'attach_failed'
  | 'product_not_found'
  | 'scope_required'
  | 'needs_scope'
  | 'document_has_source';

export class KnowledgeSourceServiceError extends Error {
  public readonly code: KnowledgeSourceErrorCode;
  /** document_has_source: the source that already wraps the document. */
  public readonly existingSourceId: bigint | null;
  constructor(
    message: string,
    code: KnowledgeSourceErrorCode,
    existingSourceId: bigint | null = null,
  ) {
    super(message);
    this.name = 'KnowledgeSourceServiceError';
    this.code = code;
    this.existingSourceId = existingSourceId;
  }
}

const permissionDenied = (op: string) =>
  new KnowledgeSourceServiceError(`Permission denied: ${op}`, 'permission_denied');
const notFound = () =>
  new KnowledgeSourceServiceError('knowledge_source not found', 'not_found');
const invariant = (msg: string) =>
  new KnowledgeSourceServiceError(msg, 'invariant_violation');
const invalid = (msg: string) =>
  new KnowledgeSourceServiceError(msg, 'invalid_input');

const MAX_TITLE_LEN = 240;
const MAX_SUMMARY_LEN = 4000;
const MAX_TEXT_LEN = 200_000;
const MAX_TAGS = 32;
const MAX_SCOPE_PRODUCTS = 100;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const KNOWLEDGE_SOURCE_ERROR_MESSAGES: Partial<Record<KnowledgeSourceErrorCode, string>> = {
  product_not_found: 'One of the ticked products no longer exists. Reload the page and try again.',
  scope_required:
    'Tick at least one product, or leave them all unticked to make it available to every product.',
  needs_scope:
    'This source needs a scope: its products were deleted. Tick products, or save with none ticked to make it available to every product.',
};

/** Human sentence for a service error a page caught; null when the error
 *  has no operator-facing explanation (the caller shows its own). */
export function knowledgeSourceErrorMessage(err: unknown): string | null {
  if (!(err instanceof KnowledgeSourceServiceError)) return null;
  if (err.code === 'document_has_source') {
    return `${err.message} Change its products on that knowledge source instead of adding it again.`;
  }
  if (err.code === 'invalid_input') return err.message;
  return KNOWLEDGE_SOURCE_ERROR_MESSAGES[err.code] ?? null;
}

// ---- scope -----------------------------------------------------------------

interface NormalizedScope {
  kind: 'workspace' | 'products';
  productProfileIds: bigint[];
}

function normalizeScope(scope: KnowledgeScopeInput | null | undefined): NormalizedScope {
  if (!scope) {
    throw new KnowledgeSourceServiceError(
      KNOWLEDGE_SOURCE_ERROR_MESSAGES.scope_required!,
      'scope_required',
    );
  }
  if (scope.kind === 'workspace') return { kind: 'workspace', productProfileIds: [] };
  if (scope.kind !== 'products') throw invalid('unknown scope kind');
  const ids = Array.from(new Set(scope.productProfileIds.map((id) => id.toString())))
    .map((s) => BigInt(s))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (ids.length === 0) {
    throw new KnowledgeSourceServiceError(
      KNOWLEDGE_SOURCE_ERROR_MESSAGES.scope_required!,
      'scope_required',
    );
  }
  if (ids.length > MAX_SCOPE_PRODUCTS) throw invalid('too many products in one scope');
  return { kind: 'products', productProfileIds: ids };
}

/** Postgres FK violation on knowledge_source_products → product (composite
 *  on workspace_id): the product is another tenant's or does not exist. */
function isScopeProductFkViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth++) {
    const e = cur as {
      code?: unknown;
      constraint_name?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (
      e.code === '23503' &&
      (e.constraint_name === 'knowledge_source_products_product_fk' ||
        e.constraint === 'knowledge_source_products_product_fk')
    ) {
      return true;
    }
    cur = e.cause;
  }
  return false;
}

function mapScopeError(err: unknown): unknown {
  return isScopeProductFkViolation(err)
    ? new KnowledgeSourceServiceError(
        KNOWLEDGE_SOURCE_ERROR_MESSAGES.product_not_found!,
        'product_not_found',
      )
    : err;
}

/** Replace a source's scope rows inside the caller's transaction. The
 *  composite FK refuses another tenant's (or a deleted) product. */
async function writeScopeRows(
  tx: Tx,
  workspaceId: bigint,
  sourceId: bigint,
  scope: NormalizedScope,
): Promise<void> {
  await tx
    .delete(knowledgeSourceProducts)
    .where(
      and(
        eq(knowledgeSourceProducts.workspaceId, workspaceId),
        eq(knowledgeSourceProducts.sourceId, sourceId),
      ),
    );
  if (scope.kind !== 'products' || scope.productProfileIds.length === 0) return;
  await tx.insert(knowledgeSourceProducts).values(
    scope.productProfileIds.map((productProfileId) => ({
      sourceId,
      workspaceId,
      productProfileId,
    })),
  );
}

// ---- create ---------------------------------------------------------

export interface CreateKnowledgeSourceInput {
  kind: KnowledgeSourceKind;
  title: string;
  documentId?: bigint | null;
  url?: string | null;
  textExcerpt?: string | null;
  summary?: string | null;
  language?: string;
  /** Phase 22: filter axis for RAG retrieval. */
  purposeCategory?:
    | 'technical'
    | 'marketing'
    | 'case_study'
    | 'internal_note'
    | 'objection_handling'
    | 'general';
  tags?: ReadonlyArray<string>;
  /** KL-05: required. { kind: 'workspace' } = every product. */
  scope: KnowledgeScopeInput;
}

export async function createKnowledgeSource(
  ctx: WorkspaceContext,
  input: CreateKnowledgeSourceInput,
): Promise<KnowledgeSource> {
  if (!canWrite(ctx)) throw permissionDenied('knowledge_source.create');
  const title = input.title.trim();
  if (!title || title.length > MAX_TITLE_LEN) throw invalid('invalid title');

  const documentId = input.documentId ?? null;
  const url = (input.url ?? '').trim() || null;
  const textExcerpt = (input.textExcerpt ?? '').trim() || null;

  // Kind-specific shape enforcement.
  if (input.kind === 'document') {
    if (!documentId) throw invalid('kind=document requires documentId');
  } else if (input.kind === 'url') {
    if (!url) throw invalid('kind=url requires url');
    if (!/^https?:\/\//i.test(url)) throw invalid('url must start with http(s)://');
  } else if (input.kind === 'text') {
    if (!textExcerpt) throw invalid('kind=text requires textExcerpt');
    if (textExcerpt.length > MAX_TEXT_LEN) throw invalid('textExcerpt too long');
  }

  const summary = (input.summary ?? '').trim();
  if (summary.length > MAX_SUMMARY_LEN) throw invalid('summary too long');

  const scope = normalizeScope(input.scope);
  const tags = sanitizeTags(input.tags);

  const row: NewKnowledgeSource = {
    workspaceId: ctx.workspaceId,
    kind: input.kind,
    documentId: input.kind === 'document' ? documentId : null,
    url,
    textExcerpt,
    title,
    summary: summary || null,
    language: (input.language ?? 'en').slice(0, 8),
    purposeCategory: input.purposeCategory ?? 'general',
    tags,
    scopeKind: scope.kind,
    createdBy: ctx.userId,
  };

  let created: KnowledgeSource;
  try {
    created = await db.transaction(async (tx) => {
      if (input.kind === 'document' && documentId) {
        await lockDocumentWithoutSource(tx, ctx.workspaceId, documentId);
      }
      const [inserted] = await tx.insert(knowledgeSources).values(row).returning();
      if (!inserted) throw invariant('knowledge_source insert returned no row');
      await writeScopeRows(tx, ctx.workspaceId, inserted.id, scope);
      return inserted;
    });
  } catch (err) {
    throw mapScopeError(err);
  }

  await recordAuditEvent(ctx, {
    kind: 'knowledge_source.create',
    entityType: 'knowledge_source',
    entityId: created.id,
    payload: {
      kind: input.kind,
      documentId: documentId?.toString() ?? null,
      scopeKind: scope.kind,
      productProfileIds: scope.productProfileIds.map((id) => id.toString()),
    },
  });

  // Phase 50: auto-attach to the workspace's active Vector Storage
  // provider as soon as the row exists. Best-effort — failure does NOT
  // undo the create (the operator can re-trigger from /knowledge/[id]).
  // A workspace-wide source has no per-product store to push into: the
  // callers index it (rag.indexKnowledgeSource) and retrieval reads its
  // chunks for every product.
  if (scope.kind === 'products') {
    try {
      await attachKnowledgeSourceViaProvider(ctx, created.id);
    } catch (err) {
      console.error('[knowledge-sources] auto-attach failed:', err);
    }
  }

  // Re-read so the caller sees external_status from the auto-attach.
  const [refreshed] = await db
    .select()
    .from(knowledgeSources)
    .where(eq(knowledgeSources.id, created.id))
    .limit(1);
  return refreshed ?? created;
}

/** Locks the document row (serialising concurrent creates for it) and
 *  refuses a second source for the same document. */
async function lockDocumentWithoutSource(
  tx: Tx,
  workspaceId: bigint,
  documentId: bigint,
): Promise<void> {
  const [doc] = await tx
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.workspaceId, workspaceId), eq(documents.id, documentId)))
    .for('update')
    .limit(1);
  if (!doc) throw invalid('documentId does not belong to this workspace');
  const [existing] = await tx
    .select({ id: knowledgeSources.id, title: knowledgeSources.title })
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.workspaceId, workspaceId),
        eq(knowledgeSources.documentId, documentId),
      ),
    )
    .orderBy(knowledgeSources.id)
    .limit(1);
  if (existing) {
    throw new KnowledgeSourceServiceError(
      `This document is already in the knowledge base as “${existing.title}”.`,
      'document_has_source',
      existing.id,
    );
  }
}

// ---- attach (Phase 50) ---------------------------------------------

/**
 * Push the source through the workspace's active Vector Storage
 * provider — one attach per product the source is scoped to.
 * Idempotent: re-running detaches first when the source is already
 * indexed, so callers can use this as both "first attach" and
 * "re-index".
 *
 * KL-05: a workspace-wide source is tied to no product store, so it is
 * indexed locally (its chunks are what retrieval reads for every product)
 * instead of being refused (I104); a 'products' source with no product
 * left is refused as 'needs_scope'.
 *
 * Writes the aggregate state back to the row:
 *   - external_provider_id = the provider id that performed the attach
 *   - external_file_id     = the first provider-returned file id
 *   - external_status      = 'indexed' on any success, 'failed' on
 *                            total failure
 *   - external_indexed_at  = now() on success
 *   - external_error       = joined error messages on failure
 */
export async function attachKnowledgeSourceViaProvider(
  ctx: WorkspaceContext,
  knowledgeSourceId: bigint,
): Promise<KnowledgeSource> {
  if (!canWrite(ctx)) throw permissionDenied('knowledge_source.attach');
  const source = await loadKs(ctx, knowledgeSourceId);
  if (source.scopeKind === 'workspace') {
    return indexWorkspaceSourceLocally(ctx, source);
  }
  const productIds =
    (await loadSourceProductIds(ctx.workspaceId, [source.id])).get(source.id.toString()) ?? [];
  if (productIds.length === 0) {
    throw new KnowledgeSourceServiceError(
      KNOWLEDGE_SOURCE_ERROR_MESSAGES.needs_scope!,
      'needs_scope',
    );
  }

  const { getVectorStorageProviderForCtx } = await import('@/lib/vector-storage');
  const provider = await getVectorStorageProviderForCtx(ctx);

  // Detach prior attachment when re-indexing under the same provider.
  if (
    source.externalProviderId === provider.id &&
    source.externalStatus === 'indexed'
  ) {
    try {
      await provider.detachKnowledgeSource(ctx, source.id);
    } catch (err) {
      console.error('[knowledge-sources] pre-attach detach failed:', err);
    }
  }

  // Materialize input shape — bytes for documents, plain text for the
  // other two kinds. The provider may or may not need the bytes; we
  // load them once and share across product attaches.
  let fileBytes: Buffer | undefined;
  let filename: string | undefined;
  let mimeType: string | undefined;
  let text: string | undefined;
  let url: string | undefined;
  if (source.kind === 'document' && source.documentId) {
    const [doc] = await db
      .select()
      .from(documents)
      .where(
        and(eq(documents.workspaceId, ctx.workspaceId), eq(documents.id, source.documentId)),
      )
      .limit(1);
    if (doc) {
      const { getStorage } = await import('@/lib/storage');
      const storage = getStorage();
      const stream = await storage.get(doc.storageKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer | string>) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      fileBytes = Buffer.concat(chunks);
      filename = doc.filename;
      mimeType = doc.mimeType;
    }
  } else if (source.kind === 'text') {
    text = source.textExcerpt ?? '';
  } else if (source.kind === 'url') {
    url = source.url ?? '';
  }

  const errors: string[] = [];
  let firstFileId: string | null = null;
  for (const productId of productIds) {
    try {
      const r = await provider.attachKnowledgeSource(ctx, productId, {
        knowledgeSource: source,
        fileBytes,
        filename,
        mimeType,
        text,
        url,
      });
      if (firstFileId === null) firstFileId = r.externalFileId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`product ${productId}: ${msg}`);
    }
  }

  const allFailed = errors.length === productIds.length;
  const updated = await writeExternalStatus(ctx, source.id, {
    providerId: provider.id,
    fileId: firstFileId,
    failed: allFailed,
    error: errors.length > 0 ? errors.join('; ') : null,
  });

  await recordAuditEvent(ctx, {
    kind: 'knowledge_source.attach',
    entityType: 'knowledge_source',
    entityId: source.id,
    payload: {
      providerId: provider.id,
      status: updated.externalStatus,
      errorCount: errors.length,
      productCount: productIds.length,
    },
  });

  if (allFailed) {
    throw new KnowledgeSourceServiceError(
      `attach failed for all ${productIds.length} product(s): ${errors.join('; ')}`,
      'attach_failed',
    );
  }
  return updated;
}

async function indexWorkspaceSourceLocally(
  ctx: WorkspaceContext,
  source: KnowledgeSource,
): Promise<KnowledgeSource> {
  // indexKnowledgeSource records the outcome on the row (external_status
  // 'indexed' / 'failed', provider 'pgvector') for a workspace-wide source.
  const { indexKnowledgeSource } = await import('./rag');
  let error: string | null = null;
  try {
    await indexKnowledgeSource(ctx, source.id);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const updated = await loadKs(ctx, source.id);
  await recordAuditEvent(ctx, {
    kind: 'knowledge_source.attach',
    entityType: 'knowledge_source',
    entityId: source.id,
    payload: { providerId: 'pgvector', status: updated.externalStatus, scopeKind: 'workspace' },
  });
  if (error !== null) {
    throw new KnowledgeSourceServiceError(`indexing failed: ${error}`, 'attach_failed');
  }
  return updated;
}

async function writeExternalStatus(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  sourceId: bigint,
  input: { providerId: string; fileId: string | null; failed: boolean; error: string | null },
): Promise<KnowledgeSource> {
  const [updated] = await db
    .update(knowledgeSources)
    .set({
      externalProviderId: input.providerId,
      externalFileId: input.fileId,
      externalStatus: input.failed ? 'failed' : 'indexed',
      externalError: input.error,
      externalIndexedAt: input.failed ? null : new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(knowledgeSources.workspaceId, ctx.workspaceId),
        eq(knowledgeSources.id, sourceId),
      ),
    )
    .returning();
  if (!updated) throw invariant('knowledge_source update lost row');
  return updated;
}

// ---- read -----------------------------------------------------------

export interface ListKnowledgeSourcesFilter {
  kind?: KnowledgeSourceKind;
  /** Sources scoped to this product. Workspace-wide sources are not
   *  included (list them with scope: 'workspace'). */
  productProfileId?: bigint;
  scope?: 'workspace' | 'needs_scope';
  /** Sources wrapping this document. */
  documentId?: bigint;
  limit?: number;
}

export interface KnowledgeSourceRow {
  source: KnowledgeSource;
  document: Document | null;
  scope: KnowledgeSourceScope;
}

export async function listKnowledgeSources(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: ListKnowledgeSourcesFilter = {},
): Promise<KnowledgeSourceRow[]> {
  const conditions: SQL[] = [eq(knowledgeSources.workspaceId, ctx.workspaceId)];
  if (filter.kind) conditions.push(eq(knowledgeSources.kind, filter.kind));
  if (filter.productProfileId !== undefined) {
    conditions.push(knowledgeSourceForProduct(filter.productProfileId));
  }
  if (filter.scope === 'workspace') conditions.push(knowledgeSourceWorkspaceWide());
  if (filter.scope === 'needs_scope') conditions.push(knowledgeSourceNeedsScope());
  if (filter.documentId !== undefined) {
    conditions.push(eq(knowledgeSources.documentId, filter.documentId));
  }
  const limit = Math.min(filter.limit ?? 200, 1000);
  const rows = await db
    .select({ source: knowledgeSources, document: documents })
    .from(knowledgeSources)
    .leftJoin(
      documents,
      and(
        eq(documents.id, knowledgeSources.documentId),
        eq(documents.workspaceId, knowledgeSources.workspaceId),
      ),
    )
    .where(and(...conditions))
    .orderBy(desc(knowledgeSources.createdAt), desc(knowledgeSources.id))
    .limit(limit);
  const products = await loadSourceProductIds(
    ctx.workspaceId,
    rows.map((r) => r.source.id),
  );
  return rows.map((r) => ({
    ...r,
    scope: describeScope(r.source.scopeKind, products.get(r.source.id.toString()) ?? []),
  }));
}

/** The sources wrapping a document (normally one; data from before KL-05
 *  may hold more), oldest first. */
export async function listDocumentSources(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  documentId: bigint,
): Promise<KnowledgeSourceRow[]> {
  const rows = await listKnowledgeSources(ctx, { documentId, kind: 'document', limit: 1000 });
  return rows.reverse();
}

export async function getKnowledgeSource(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<KnowledgeSourceRow & { products: ProductProfile[] }> {
  const rows = await db
    .select({ source: knowledgeSources, document: documents })
    .from(knowledgeSources)
    .leftJoin(
      documents,
      and(
        eq(documents.id, knowledgeSources.documentId),
        eq(documents.workspaceId, knowledgeSources.workspaceId),
      ),
    )
    .where(
      and(
        eq(knowledgeSources.workspaceId, ctx.workspaceId),
        eq(knowledgeSources.id, id),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound();
  const ids = (await loadSourceProductIds(ctx.workspaceId, [id])).get(id.toString()) ?? [];
  const products =
    ids.length > 0
      ? await db
          .select()
          .from(productProfiles)
          .where(
            and(
              eq(productProfiles.workspaceId, ctx.workspaceId),
              inArray(productProfiles.id, ids),
            ),
          )
          .orderBy(productProfiles.name)
      : [];
  return { ...rows[0], scope: describeScope(rows[0].source.scopeKind, ids), products };
}

// ---- mutate ---------------------------------------------------------

export interface UpdateKnowledgeSourceInput {
  title?: string;
  summary?: string | null;
  url?: string;
  textExcerpt?: string;
  language?: string;
  purposeCategory?:
    | 'technical'
    | 'marketing'
    | 'case_study'
    | 'internal_note'
    | 'objection_handling'
    | 'general';
  tags?: ReadonlyArray<string>;
  /** KL-05: replaces the scope. Chunks are untouched — scope lives on the
   *  source, so re-scoping needs no re-index. */
  scope?: KnowledgeScopeInput;
}

export async function updateKnowledgeSource(
  ctx: WorkspaceContext,
  id: bigint,
  input: UpdateKnowledgeSourceInput,
): Promise<KnowledgeSource> {
  if (!canWrite(ctx)) throw permissionDenied('knowledge_source.update');
  const existing = await loadKs(ctx, id);

  const updates: Partial<KnowledgeSource> & { updatedAt: Date } = { updatedAt: new Date() };

  if (input.title !== undefined) {
    const t = input.title.trim();
    if (!t || t.length > MAX_TITLE_LEN) throw invalid('invalid title');
    updates.title = t;
  }
  if (input.summary !== undefined) {
    if (input.summary === null || input.summary === '') {
      updates.summary = null;
    } else {
      const s = input.summary.trim();
      if (s.length > MAX_SUMMARY_LEN) throw invalid('summary too long');
      updates.summary = s || null;
    }
  }
  if (input.url !== undefined) {
    if (existing.kind !== 'url') throw invalid('cannot set url on non-url source');
    if (!/^https?:\/\//i.test(input.url)) throw invalid('url must start with http(s)://');
    updates.url = input.url;
  }
  if (input.textExcerpt !== undefined) {
    if (existing.kind !== 'text') throw invalid('cannot set textExcerpt on non-text source');
    if (input.textExcerpt.length > MAX_TEXT_LEN) throw invalid('textExcerpt too long');
    updates.textExcerpt = input.textExcerpt;
  }
  if (input.language !== undefined) updates.language = input.language.slice(0, 8);
  if (input.purposeCategory !== undefined) updates.purposeCategory = input.purposeCategory;
  if (input.tags !== undefined) updates.tags = sanitizeTags(input.tags);
  const scope = input.scope !== undefined ? normalizeScope(input.scope) : null;
  if (scope) updates.scopeKind = scope.kind;

  let updated: KnowledgeSource;
  try {
    updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(knowledgeSources)
        .set(updates)
        .where(
          and(
            eq(knowledgeSources.workspaceId, ctx.workspaceId),
            eq(knowledgeSources.id, id),
          ),
        )
        .returning();
      if (!row) throw invariant('knowledge_source update returned no row');
      if (scope) await writeScopeRows(tx, ctx.workspaceId, id, scope);
      return row;
    });
  } catch (err) {
    throw mapScopeError(err);
  }

  await recordAuditEvent(ctx, {
    kind: 'knowledge_source.update',
    entityType: 'knowledge_source',
    entityId: id,
    payload: scope
      ? {
          scopeKind: scope.kind,
          productProfileIds: scope.productProfileIds.map((p) => p.toString()),
        }
      : {},
  });

  return updated;
}

export async function deleteKnowledgeSource(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<void> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('knowledge_source.delete');
  await loadKs(ctx, id);
  await db
    .delete(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.workspaceId, ctx.workspaceId),
        eq(knowledgeSources.id, id),
      ),
    );
  await recordAuditEvent(ctx, {
    kind: 'knowledge_source.delete',
    entityType: 'knowledge_source',
    entityId: id,
  });
}

// ---- internals ------------------------------------------------------

async function loadKs(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<KnowledgeSource> {
  const rows = await db
    .select()
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.workspaceId, ctx.workspaceId),
        eq(knowledgeSources.id, id),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound();
  return rows[0];
}

function sanitizeTags(input: ReadonlyArray<string> | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const t = raw.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}
