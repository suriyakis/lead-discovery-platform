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
//
// KL-06: indexing is a job. Creating a source, and editing its content,
// URL, summary or products, write a queued knowledge.index run (and the
// source's index_status: 'queued', or 'stale' after an edit) in the same
// transaction, then enqueue it; nothing is extracted or embedded inside
// the request (knowledge-index-queue.ts, knowledge-indexing.ts). Deleting
// needs the source's title typed as confirmation and detaches it from the
// vector-storage provider that holds it first.

import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  documents,
  knowledgeSourceProducts,
  knowledgeSources,
  type Document,
  type DocumentMeta,
  type KnowledgeSource,
  type KnowledgeSourceKind,
  type NewKnowledgeSource,
} from '@/lib/db/schema/documents';
import { productProfiles, type ProductProfile } from '@/lib/db/schema/products';
import type { IndexingJob } from '@/lib/db/schema/rag';
import { recordAuditEvent } from './audit';
import { isIndexableDocument } from './document-extraction';
import { documentMetaColumns } from './documents';
import { enqueueKnowledgeIndexJobs, queueKnowledgeIndexTx } from './knowledge-index-queue';
import { resolveNotifications } from './notifications';
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
  | 'document_has_source'
  | 'confirmation_required';

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
  if (err.code === 'invalid_input' || err.code === 'confirmation_required') return err.message;
  return KNOWLEDGE_SOURCE_ERROR_MESSAGES[err.code] ?? null;
}

/** A 'products' source with no product left cannot be indexed or used. */
export function needsScopeError(): KnowledgeSourceServiceError {
  return new KnowledgeSourceServiceError(KNOWLEDGE_SOURCE_ERROR_MESSAGES.needs_scope!, 'needs_scope');
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
  let job: IndexingJob | null = null;
  try {
    ({ created, job } = await db.transaction(async (tx) => {
      // KL-06: auto-indexing is queued for every source except a document
      // whose type has no text to extract (an image, a spreadsheet):
      // that one is marked failed with the reason and "Index now" tries
      // anyway.
      let notIndexable: string | null = null;
      if (input.kind === 'document' && documentId) {
        const doc = await lockDocumentWithoutSource(tx, ctx.workspaceId, documentId);
        if (!isIndexableDocument(doc)) {
          notIndexable = `Not indexed automatically: ${doc.filename} (${doc.mimeType}) has no text to extract. Use Index now to try anyway.`;
        }
      }
      const [inserted] = await tx
        .insert(knowledgeSources)
        .values(
          notIndexable === null
            ? { ...row, indexStatus: 'queued' }
            : { ...row, indexStatus: 'failed', lastIndexError: notIndexable },
        )
        .returning();
      if (!inserted) throw invariant('knowledge_source insert returned no row');
      await writeScopeRows(tx, ctx.workspaceId, inserted.id, scope);
      const queued =
        notIndexable === null
          ? await queueKnowledgeIndexTx(tx, ctx, inserted.id, { reason: 'create' })
          : null;
      return { created: inserted, job: queued };
    }));
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
      indexJobId: job?.id.toString() ?? null,
    },
  });

  // The queued run is durable; the job only makes it start now. No
  // extraction, OCR or embedding happens inside this request (I108), and
  // the run indexes the source ONCE however many products it has (I040).
  if (job) await enqueueKnowledgeIndexJobs(ctx, [job.id]);

  // Re-read so the caller sees the queued status.
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
): Promise<Pick<Document, 'id' | 'filename' | 'mimeType'>> {
  const [doc] = await tx
    .select({ id: documents.id, filename: documents.filename, mimeType: documents.mimeType })
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
  return doc;
}

// ---- attach (Phase 50) ---------------------------------------------

/**
 * Index the source NOW, in this process, through the knowledge.index job
 * (knowledge-indexing.ts): its text is extracted (cached) and embedded
 * ONCE, then attached per product through the workspace's active Vector
 * Storage provider — bookkeeping only on pgvector (indexesPerSource).
 * Pages queue the run instead (requestKnowledgeIndex); this inline form
 * is for scripts and tests that need the result at once.
 *
 * KL-05: a workspace-wide source is tied to no product store, so it is
 * indexed locally (its chunks are what retrieval reads for every product)
 * instead of being refused (I104); a 'products' source with no product
 * left is refused as 'needs_scope'.
 */
export async function attachKnowledgeSourceViaProvider(
  ctx: WorkspaceContext,
  knowledgeSourceId: bigint,
): Promise<KnowledgeSource> {
  if (!canWrite(ctx)) throw permissionDenied('knowledge_source.attach');
  const source = await loadKs(ctx, knowledgeSourceId);
  if (source.scopeKind === 'products') {
    const productIds =
      (await loadSourceProductIds(ctx.workspaceId, [source.id])).get(source.id.toString()) ?? [];
    if (productIds.length === 0) throw needsScopeError();
  }
  const { indexKnowledgeSourceNow } = await import('./knowledge-indexing');
  let error: string | null = null;
  try {
    await indexKnowledgeSourceNow(ctx, source.id);
  } catch (err) {
    error = knowledgeSourceErrorMessage(err) ?? (err instanceof Error ? err.message : String(err));
  }
  const updated = await loadKs(ctx, source.id);
  await recordAuditEvent(ctx, {
    kind: 'knowledge_source.attach',
    entityType: 'knowledge_source',
    entityId: source.id,
    payload: {
      providerId: updated.externalProviderId,
      status: updated.indexStatus,
      scopeKind: source.scopeKind,
    },
  });
  if (error !== null) {
    throw new KnowledgeSourceServiceError(`indexing failed: ${error}`, 'attach_failed');
  }
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
  /** Without its extraction cache (KL-06). */
  document: DocumentMeta | null;
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
    .select({ source: knowledgeSources, document: documentMetaColumns })
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
    .select({ source: knowledgeSources, document: documentMetaColumns })
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
  /** KL-05: replaces the scope. Retrieval reads scope from the source, so
   *  re-scoping takes effect at once; KL-06 still queues a run so the
   *  per-product attachments follow (no re-embed: the text is unchanged). */
  scope?: KnowledgeScopeInput;
}

/** What an edit changed that the index depends on (KL-06, I103). */
export type IndexAffectingChange = 'content' | 'url' | 'summary' | 'title' | 'products';

function sameIds(a: readonly bigint[], b: readonly bigint[]): boolean {
  if (a.length !== b.length) return false;
  const sa = a.map(String).sort();
  const sb = b.map(String).sort();
  return sa.every((v, i) => v === sb[i]);
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

  // KL-06 (I103): an edit the index depends on marks the source stale and
  // queues a run in the same transaction. The text a run embeds is the
  // excerpt (text), or title + summary + URL (url); a summary or product
  // change is queued too, so attachments and the stamp follow — the run
  // re-embeds nothing when the text it hashes did not change.
  const changes: IndexAffectingChange[] = [];
  if (updates.textExcerpt !== undefined && updates.textExcerpt !== existing.textExcerpt) {
    changes.push('content');
  }
  if (updates.url !== undefined && updates.url !== existing.url) changes.push('url');
  if (updates.summary !== undefined && (updates.summary ?? null) !== (existing.summary ?? null)) {
    changes.push('summary');
  }
  if (existing.kind === 'url' && updates.title !== undefined && updates.title !== existing.title) {
    changes.push('title');
  }
  if (scope) {
    const current =
      (await loadSourceProductIds(ctx.workspaceId, [id])).get(id.toString()) ?? [];
    if (scope.kind !== existing.scopeKind || !sameIds(scope.productProfileIds, current)) {
      changes.push('products');
    }
  }

  let updated: KnowledgeSource;
  let job: IndexingJob | null = null;
  try {
    ({ updated, job } = await db.transaction(async (tx) => {
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
      if (changes.length === 0) return { updated: row, job: null };
      const queued = await queueKnowledgeIndexTx(tx, ctx, id, { reason: 'edit', markStale: true });
      return { updated: { ...row, indexStatus: 'stale' as const }, job: queued };
    }));
  } catch (err) {
    throw mapScopeError(err);
  }

  await recordAuditEvent(ctx, {
    kind: 'knowledge_source.update',
    entityType: 'knowledge_source',
    entityId: id,
    payload: {
      ...(scope
        ? {
            scopeKind: scope.kind,
            productProfileIds: scope.productProfileIds.map((p) => p.toString()),
          }
        : {}),
      ...(job ? { stale: true, changed: changes, indexJobId: job.id.toString() } : {}),
    },
  });
  if (job) await enqueueKnowledgeIndexJobs(ctx, [job.id]);

  return updated;
}

export interface DeleteKnowledgeSourceOptions {
  /** The source's title, typed by the operator. Deleting is permanent, so
   *  it never happens without it (KL-06, I103). */
  confirm: string;
}

/**
 * Admin only, and only with the source's title typed as confirmation.
 * Detaches the source from the vector-storage provider that holds it
 * (its external_provider_id; the active one otherwise) before the row
 * goes: on pgvector that drops the chunks and brings the product counters
 * down; on OpenAI it deletes the uploaded files. A detach failure is
 * recorded in the audit event and does not block the delete.
 */
export async function deleteKnowledgeSource(
  ctx: WorkspaceContext,
  id: bigint,
  options: DeleteKnowledgeSourceOptions,
): Promise<void> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('knowledge_source.delete');
  const existing = await loadKs(ctx, id);
  if ((options?.confirm ?? '').trim() !== existing.title.trim()) {
    throw new KnowledgeSourceServiceError(
      `Type the source title “${existing.title}” to confirm the permanent delete.`,
      'confirmation_required',
    );
  }

  const {
    getVectorStorageProviderByIdForCtx,
    getVectorStorageProviderForCtx,
    recomputePgvectorProductUsage,
  } = await import('@/lib/vector-storage');
  let detach: string;
  try {
    const provider = existing.externalProviderId
      ? await getVectorStorageProviderByIdForCtx(ctx, existing.externalProviderId)
      : await getVectorStorageProviderForCtx(ctx);
    await provider.detachKnowledgeSource(ctx, id);
    detach = provider.id;
  } catch (err) {
    detach = `failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
    console.error('[knowledge-sources] detach before delete failed:', err);
  }

  await db
    .delete(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.workspaceId, ctx.workspaceId),
        eq(knowledgeSources.id, id),
      ),
    );
  try {
    // Its chunks are gone (detach, or the FK cascade): derive the pgvector
    // product counters again so they go down.
    await recomputePgvectorProductUsage(ctx);
  } catch (err) {
    console.error('[knowledge-sources] usage recompute after delete failed:', err);
  }
  const { knowledgeIndexFailedKey } = await import('./knowledge-indexing');
  await resolveNotifications(ctx.workspaceId, knowledgeIndexFailedKey(id));
  await recordAuditEvent(ctx, {
    kind: 'knowledge_source.delete',
    entityType: 'knowledge_source',
    entityId: id,
    payload: { title: existing.title, kind: existing.kind, detach },
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
