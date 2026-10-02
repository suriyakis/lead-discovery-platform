// Phase 10 — retrieval-augmented composers. Given a query (typically
// the most recent inbound message) + a product profile id, pull the
// top-k matching chunks from the workspace's active Vector Storage
// provider and format them for inclusion in the engagement / pitch
// system prompts.
//
// Phase 50 — routes through getVectorStorageProviderForCtx so the
// workspace's vector_storage_provider selection (pgvector / openai /
// mock) is honored at the read path too, not just the write path.
// In practice the workspace is on pgvector (cheaper), but going
// through the abstraction keeps both rails symmetric.
//
// Best-effort: zero indexed chunks → empty string, never throws into
// the composer.

import { getVectorStorageProviderForCtx } from '@/lib/vector-storage';
import type { WorkspaceContext } from './context';

export interface KnowledgeBlock {
  /** Pre-formatted text to inject into the prompt. Empty when no
   *  matches. */
  formatted: string;
  /** Number of chunks actually returned. */
  chunkCount: number;
  /** Cosine similarity of the top result (0-1, pgvector only). 0
   *  when the provider doesn't surface similarity (e.g. openai
   *  file_search returns citations without scores). */
  topSimilarity: number;
}

export async function buildProductKnowledgeBlock(
  ctx: WorkspaceContext,
  productProfileId: bigint,
  query: string,
  options: { topK?: number; minSimilarity?: number; stageHint?: 'engagement' | 'pitch' } = {},
): Promise<KnowledgeBlock> {
  const topK = options.topK ?? 3;
  const minSimilarity = options.minSimilarity ?? 0.45;
  const trimmed = query.trim();
  if (!trimmed) {
    return { formatted: '', chunkCount: 0, topSimilarity: 0 };
  }
  let provider;
  let result;
  try {
    provider = await getVectorStorageProviderForCtx(ctx);
    result = await provider.query(ctx, productProfileId, trimmed, {
      topK,
      minSimilarity,
    });
  } catch (err) {
    console.warn('[outreach-knowledge] retrieve failed (best-effort):', err);
    return { formatted: '', chunkCount: 0, topSimilarity: 0 };
  }

  const chunks = result.chunks;
  if (chunks.length === 0) {
    return { formatted: '', chunkCount: 0, topSimilarity: 0 };
  }

  void options.stageHint;

  const blocks = chunks.map((c, i) => {
    const source = c.citationFilename ?? `chunk ${i + 1}`;
    // Truncate to keep the prompt budget reasonable.
    const text =
      c.content.length > 1200 ? `${c.content.slice(0, 1200)}…` : c.content;
    const sim = c.similarity ?? 0;
    const simLabel = sim > 0 ? ` (similarity ${sim.toFixed(2)})` : '';
    return `[${i + 1}] from "${source}"${simLabel}:\n${text}`;
  });

  const formatted = [
    'Product knowledge (from indexed datasheets / docs — quote facts from these where they fit, never invent):',
    blocks.join('\n\n'),
  ].join('\n\n');

  return {
    formatted,
    chunkCount: chunks.length,
    topSimilarity: chunks[0]?.similarity ?? 0,
  };
}

export interface KnowledgeCoverageCount {
  /** Live sources (document not archived). */
  sources: number;
  /** Their embedded chunks. */
  chunks: number;
}

export interface ProductKnowledgeCoverage {
  /** Sources scoped to this product. */
  product: KnowledgeCoverageCount;
  /** Workspace-wide sources, which this product's drafts also read. */
  workspace: KnowledgeCoverageCount;
}

/** Per-product coverage signal for the UI (KL-05, I104): what this
 *  product's drafts can actually retrieve, with the product's own sources
 *  and the workspace-wide ones counted separately. Same predicate as
 *  retrieve() (knowledge-scope.ts), so a 'products' source with no product
 *  left, another product's source or an archived document never counts. */
export async function getProductKnowledgeCoverage(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  productProfileId: bigint,
): Promise<ProductKnowledgeCoverage> {
  const { db } = await import('@/lib/db/client');
  const { documentChunks } = await import('@/lib/db/schema/rag');
  const { knowledgeSources } = await import('@/lib/db/schema/documents');
  const { knowledgeSourceRetrievable } = await import('./knowledge-scope');
  const { and, eq, sql } = await import('drizzle-orm');
  const empty = (): ProductKnowledgeCoverage => ({
    product: { sources: 0, chunks: 0 },
    workspace: { sources: 0, chunks: 0 },
  });
  try {
    const rows = await db
      .select({
        scopeKind: knowledgeSources.scopeKind,
        sources: sql<number>`count(DISTINCT ${knowledgeSources.id})::int`,
        chunks: sql<number>`count(${documentChunks.id}) FILTER (WHERE ${documentChunks.embedding} IS NOT NULL)::int`,
      })
      .from(knowledgeSources)
      .leftJoin(
        documentChunks,
        and(
          eq(documentChunks.knowledgeSourceId, knowledgeSources.id),
          eq(documentChunks.workspaceId, knowledgeSources.workspaceId),
        ),
      )
      .where(knowledgeSourceRetrievable({ workspaceId: ctx.workspaceId, productProfileId }))
      .groupBy(knowledgeSources.scopeKind);
    const out = empty();
    for (const r of rows) {
      const bucket = r.scopeKind === 'workspace' ? out.workspace : out.product;
      bucket.sources = Number(r.sources);
      bucket.chunks = Number(r.chunks);
    }
    return out;
  } catch (err) {
    console.warn('[outreach-knowledge] coverage query failed:', err);
    return empty();
  }
}
