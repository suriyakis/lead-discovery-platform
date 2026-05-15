// Knowledge-sources service. A knowledge source wraps either a document, a
// URL, or a free-text excerpt, optionally attached to one or more product
// profiles. Future RAG phases will read these rows.

import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  documents,
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

export class KnowledgeSourceServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'KnowledgeSourceServiceError';
    this.code = code;
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
  productProfileIds?: ReadonlyArray<bigint>;
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
    await assertDocumentInWorkspace(ctx, documentId);
  } else if (input.kind === 'url') {
    if (!url) throw invalid('kind=url requires url');
    if (!/^https?:\/\//i.test(url)) throw invalid('url must start with http(s)://');
  } else if (input.kind === 'text') {
    if (!textExcerpt) throw invalid('kind=text requires textExcerpt');
    if (textExcerpt.length > MAX_TEXT_LEN) throw invalid('textExcerpt too long');
  }

  const summary = (input.summary ?? '').trim();
  if (summary.length > MAX_SUMMARY_LEN) throw invalid('summary too long');

  const productIds = await sanitizeProductIds(ctx, input.productProfileIds);
  const tags = sanitizeTags(input.tags);

  const row: NewKnowledgeSource = {
    workspaceId: ctx.workspaceId,
    kind: input.kind,
    documentId,
    url,
    textExcerpt,
    title,
    summary: summary || null,
    language: (input.language ?? 'en').slice(0, 8),
    purposeCategory: input.purposeCategory ?? 'general',
    tags,
    productProfileIds: productIds,
    createdBy: ctx.userId,
  };

  const [created] = await db.insert(knowledgeSources).values(row).returning();
  if (!created) throw invariant('knowledge_source insert returned no row');

  await recordAuditEvent(ctx, {
    kind: 'knowledge_source.create',
    entityType: 'knowledge_source',
    entityId: created.id,
    payload: {
      kind: input.kind,
      documentId: documentId?.toString() ?? null,
      productProfileIds: productIds.map((id) => id.toString()),
    },
  });

  // Phase 50: auto-attach to the workspace's active Vector Storage
  // provider as soon as the row exists. Best-effort — failure does NOT
  // undo the create (the operator can re-trigger from /knowledge/[id]).
  // Sources with zero product associations stay 'pending' until the
  // operator attaches them to a product, since there's no per-product
  // vector store to push them into yet.
  if (productIds.length > 0) {
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

// ---- attach (Phase 50) ---------------------------------------------

/**
 * Push the source through the workspace's active Vector Storage
 * provider — one attach per product the source is associated with.
 * Idempotent: re-running detaches first when the source is already
 * indexed, so callers can use this as both "first attach" and
 * "re-index".
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
  const [source] = await db
    .select()
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.workspaceId, ctx.workspaceId),
        eq(knowledgeSources.id, knowledgeSourceId),
      ),
    )
    .limit(1);
  if (!source) throw notFound();
  if (source.productProfileIds.length === 0) {
    throw invalid('cannot attach: source has no product associations');
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
      .where(eq(documents.id, source.documentId))
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
  for (const productId of source.productProfileIds) {
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

  const allFailed = errors.length === source.productProfileIds.length;
  const [updated] = await db
    .update(knowledgeSources)
    .set({
      externalProviderId: provider.id,
      externalFileId: firstFileId,
      externalStatus: allFailed ? 'failed' : 'indexed',
      externalError: errors.length > 0 ? errors.join('; ') : null,
      externalIndexedAt: allFailed ? null : new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(knowledgeSources.workspaceId, ctx.workspaceId),
        eq(knowledgeSources.id, source.id),
      ),
    )
    .returning();
  if (!updated) throw invariant('knowledge_source update lost row');

  await recordAuditEvent(ctx, {
    kind: 'knowledge_source.attach',
    entityType: 'knowledge_source',
    entityId: source.id,
    payload: {
      providerId: provider.id,
      status: updated.externalStatus,
      errorCount: errors.length,
      productCount: source.productProfileIds.length,
    },
  });

  if (allFailed) {
    throw new KnowledgeSourceServiceError(
      `attach failed for all ${source.productProfileIds.length} product(s): ${errors.join('; ')}`,
      'attach_failed',
    );
  }
  return updated;
}

// ---- read -----------------------------------------------------------

export interface ListKnowledgeSourcesFilter {
  kind?: KnowledgeSourceKind;
  productProfileId?: bigint;
  limit?: number;
}

export interface KnowledgeSourceRow {
  source: KnowledgeSource;
  document: Document | null;
}

export async function listKnowledgeSources(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: ListKnowledgeSourcesFilter = {},
): Promise<KnowledgeSourceRow[]> {
  const conditions: SQL[] = [eq(knowledgeSources.workspaceId, ctx.workspaceId)];
  if (filter.kind) conditions.push(eq(knowledgeSources.kind, filter.kind));
  if (filter.productProfileId !== undefined) {
    conditions.push(
      sql`${filter.productProfileId} = ANY(${knowledgeSources.productProfileIds})`,
    );
  }
  const limit = Math.min(filter.limit ?? 200, 1000);
  const rows = await db
    .select({ source: knowledgeSources, document: documents })
    .from(knowledgeSources)
    .leftJoin(documents, eq(documents.id, knowledgeSources.documentId))
    .where(and(...conditions))
    .orderBy(desc(knowledgeSources.createdAt))
    .limit(limit);
  return rows;
}

export async function getKnowledgeSource(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<KnowledgeSourceRow & { products: ProductProfile[] }> {
  const rows = await db
    .select({ source: knowledgeSources, document: documents })
    .from(knowledgeSources)
    .leftJoin(documents, eq(documents.id, knowledgeSources.documentId))
    .where(
      and(
        eq(knowledgeSources.workspaceId, ctx.workspaceId),
        eq(knowledgeSources.id, id),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound();
  const products =
    rows[0].source.productProfileIds.length > 0
      ? await db
          .select()
          .from(productProfiles)
          .where(
            and(
              eq(productProfiles.workspaceId, ctx.workspaceId),
              inArray(productProfiles.id, [...rows[0].source.productProfileIds]),
            ),
          )
      : [];
  return { ...rows[0], products };
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
  productProfileIds?: ReadonlyArray<bigint>;
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
  if (input.productProfileIds !== undefined) {
    updates.productProfileIds = await sanitizeProductIds(ctx, input.productProfileIds);
  }

  const [updated] = await db
    .update(knowledgeSources)
    .set(updates)
    .where(
      and(
        eq(knowledgeSources.workspaceId, ctx.workspaceId),
        eq(knowledgeSources.id, id),
      ),
    )
    .returning();
  if (!updated) throw invariant('knowledge_source update returned no row');

  await recordAuditEvent(ctx, {
    kind: 'knowledge_source.update',
    entityType: 'knowledge_source',
    entityId: id,
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

async function assertDocumentInWorkspace(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  documentId: bigint,
): Promise<void> {
  const rows = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.workspaceId, ctx.workspaceId),
        eq(documents.id, documentId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw invalid('documentId does not belong to this workspace');
}

async function sanitizeProductIds(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  ids: ReadonlyArray<bigint> | undefined,
): Promise<bigint[]> {
  if (!ids || ids.length === 0) return [];
  const rows = await db
    .select({ id: productProfiles.id })
    .from(productProfiles)
    .where(
      and(
        eq(productProfiles.workspaceId, ctx.workspaceId),
        inArray(productProfiles.id, [...ids]),
      ),
    );
  // Preserve ordering + dedup; only ids that actually exist in the workspace.
  const valid = new Set(rows.map((r) => r.id.toString()));
  const seen = new Set<string>();
  const out: bigint[] = [];
  for (const id of ids) {
    const key = id.toString();
    if (valid.has(key) && !seen.has(key)) {
      seen.add(key);
      out.push(id);
    }
  }
  return out;
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
