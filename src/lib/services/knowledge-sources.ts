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

  return created;
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
