// KL-05 — knowledge scope and THE retrieval predicate.
//
// A knowledge source applies either to every product (scope_kind
// 'workspace') or to exactly the products in knowledge_source_products
// (scope_kind 'products'). NULL or an empty list never means "everywhere":
// a 'products' source whose products were all deleted "Needs a scope" and
// reaches no prompt. Every chunk belongs to exactly one source
// (document_chunks.knowledge_source_id NOT NULL), so whether a chunk may
// reach a prompt is decided here, once, for retrieve(), the product
// coverage counts, Suggest reply and the pgvector provider query:
//
//   ks.workspace_id = $ws
//   AND NOT EXISTS (documents d WHERE d.id = ks.document_id AND d.status = 'archived')
//   AND (ks.scope_kind = 'workspace'
//        OR EXISTS (knowledge_source_products p
//                   WHERE p.source_id = ks.id [AND p.product_profile_id = $pid]))
//
// url and text sources have document_id NULL and stay retrievable;
// archiving a document excludes its sources' chunks at once and restoring
// it brings them back without re-indexing (I101). The design's
// embedding-model clause arrives with KL-09 and a source-level archive
// status with the Library (KL-23); both belong in this file.
//
// The SQL helpers reference the un-aliased `knowledge_sources` table, so
// the calling query must have it in scope (joined, or as the FROM table).

import { and, eq, exists, inArray, notExists, sql, or, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/lib/db/client';
import {
  documents,
  knowledgeSourceProducts,
  knowledgeSources,
  type KnowledgeScopeKind,
} from '@/lib/db/schema/documents';

export type KnowledgeScopeInput =
  | { kind: 'workspace' }
  | { kind: 'products'; productProfileIds: readonly bigint[] };

export const WORKSPACE_KNOWLEDGE_SCOPE: KnowledgeScopeInput = { kind: 'workspace' };

/** The upload and edit forms' rule, said on the form itself: no product
 *  ticked = available to every product. */
export const NO_PRODUCT_TICKED_COPY = 'No product ticked = available to every product';

export function knowledgeScopeFromTicks(productProfileIds: readonly bigint[]): KnowledgeScopeInput {
  return productProfileIds.length > 0
    ? { kind: 'products', productProfileIds }
    : WORKSPACE_KNOWLEDGE_SCOPE;
}

/** A source's scope as read back: kind + the products it has rows for. */
export interface KnowledgeSourceScope {
  kind: KnowledgeScopeKind;
  productProfileIds: bigint[];
  /** 'products' with no row left: retrieved nowhere until re-scoped. */
  needsScope: boolean;
}

export function describeScope(
  kind: KnowledgeScopeKind,
  productProfileIds: readonly bigint[],
): KnowledgeSourceScope {
  return {
    kind,
    productProfileIds: [...productProfileIds],
    needsScope: kind === 'products' && productProfileIds.length === 0,
  };
}

// ---- the predicate ---------------------------------------------------------

const archivedDocument = alias(documents, 'ks_archived_document');

/** Source belongs to the workspace and its document (if any) is not
 *  archived. */
export function knowledgeSourceLive(workspaceId: bigint): SQL {
  return and(
    eq(knowledgeSources.workspaceId, workspaceId),
    notExists(
      db
        .select({ one: sql`1` })
        .from(archivedDocument)
        .where(
          and(
            eq(archivedDocument.id, knowledgeSources.documentId),
            eq(archivedDocument.status, 'archived'),
          ),
        ),
    ),
  )!;
}

function scopeRowExists(productProfileId?: bigint): SQL {
  const conds: SQL[] = [
    eq(knowledgeSourceProducts.workspaceId, knowledgeSources.workspaceId),
    eq(knowledgeSourceProducts.sourceId, knowledgeSources.id),
  ];
  if (productProfileId !== undefined) {
    conds.push(eq(knowledgeSourceProducts.productProfileId, productProfileId));
  }
  return exists(
    db
      .select({ one: sql`1` })
      .from(knowledgeSourceProducts)
      .where(and(...conds)),
  );
}

/** Scoped to this product (a scope row; workspace-wide sources excluded). */
export function knowledgeSourceForProduct(productProfileId: bigint): SQL {
  return and(eq(knowledgeSources.scopeKind, 'products'), scopeRowExists(productProfileId))!;
}

/** Workspace-wide sources only. */
export function knowledgeSourceWorkspaceWide(): SQL {
  return eq(knowledgeSources.scopeKind, 'workspace');
}

/**
 * With a product: workspace-wide sources plus that product's. Without one
 * (Suggest reply on a thread with no lead product): workspace-wide sources
 * plus every source that still has a product — mirroring lessonInScope().
 * A 'products' source with no row left matches neither.
 */
export function knowledgeSourceInScope(productProfileId?: bigint): SQL {
  return or(knowledgeSourceWorkspaceWide(), scopeRowExists(productProfileId))!;
}

/** 'products' sources with no product left ("Needs a scope"). */
export function knowledgeSourceNeedsScope(): SQL {
  return and(
    eq(knowledgeSources.scopeKind, 'products'),
    notExists(
      db
        .select({ one: sql`1` })
        .from(knowledgeSourceProducts)
        .where(
          and(
            eq(knowledgeSourceProducts.workspaceId, knowledgeSources.workspaceId),
            eq(knowledgeSourceProducts.sourceId, knowledgeSources.id),
          ),
        ),
    ),
  )!;
}

export interface KnowledgeRetrievalScope {
  workspaceId: bigint;
  /** Omitted: workspace-wide + every source that still has a product. */
  productProfileId?: bigint;
}

/** THE predicate: may a chunk owned by `knowledge_sources` reach a prompt
 *  for this scope? */
export function knowledgeSourceRetrievable(scope: KnowledgeRetrievalScope): SQL {
  return and(
    knowledgeSourceLive(scope.workspaceId),
    knowledgeSourceInScope(scope.productProfileId),
  )!;
}

// ---- reads -----------------------------------------------------------------

/** Scope rows for a set of sources, keyed by source id (ids sorted). */
export async function loadSourceProductIds(
  workspaceId: bigint,
  sourceIds: readonly bigint[],
): Promise<Map<string, bigint[]>> {
  const out = new Map<string, bigint[]>();
  if (sourceIds.length === 0) return out;
  const rows = await db
    .select({
      sourceId: knowledgeSourceProducts.sourceId,
      productProfileId: knowledgeSourceProducts.productProfileId,
    })
    .from(knowledgeSourceProducts)
    .where(
      and(
        eq(knowledgeSourceProducts.workspaceId, workspaceId),
        inArray(knowledgeSourceProducts.sourceId, [...sourceIds]),
      ),
    )
    .orderBy(knowledgeSourceProducts.sourceId, knowledgeSourceProducts.productProfileId);
  for (const r of rows) {
    const key = r.sourceId.toString();
    const list = out.get(key) ?? [];
    list.push(r.productProfileId);
    out.set(key, list);
  }
  return out;
}
