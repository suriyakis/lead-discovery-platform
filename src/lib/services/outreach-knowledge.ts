// Phase 10 — retrieval-augmented composers. Given a query (typically
// the most recent inbound message) + a product profile id, pull the
// top-k matching chunks from the existing RAG store and format them
// for inclusion in the engagement / pitch system prompts.
//
// Best-effort: zero indexed chunks → empty string, never throws into
// the composer.

import { retrieve } from './rag';
import type { WorkspaceContext } from './context';

export interface KnowledgeBlock {
  /** Pre-formatted text to inject into the prompt. Empty when no
   *  matches. */
  formatted: string;
  /** Number of chunks actually returned. */
  chunkCount: number;
  /** Cosine similarity of the top result (0-1). Useful for the
   *  draft evidence audit. */
  topSimilarity: number;
}

export async function buildProductKnowledgeBlock(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
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
  let chunks;
  try {
    chunks = await retrieve(ctx, trimmed, {
      productProfileId,
      limit: topK,
      // For pitch, prefer technical + case_study chunks. For engagement,
      // prefer objection_handling. Leave general available in both via
      // the no-filter fallback below.
      // We don't filter strictly here because indexed-on-purpose data
      // may be too sparse; better to surface anything relevant and let
      // the AI cherry-pick.
    });
  } catch (err) {
    console.warn('[outreach-knowledge] retrieve failed (best-effort):', err);
    return { formatted: '', chunkCount: 0, topSimilarity: 0 };
  }

  // Drop low-similarity hits — they'd just noise up the prompt.
  const filtered = chunks.filter((c) => c.similarity >= minSimilarity);
  if (filtered.length === 0) {
    return { formatted: '', chunkCount: 0, topSimilarity: chunks[0]?.similarity ?? 0 };
  }

  void options.stageHint;

  const blocks = filtered.map((c, i) => {
    const source =
      c.document?.name ??
      c.knowledgeSource?.title ??
      `chunk ${c.chunk.id}`;
    // Truncate to keep the prompt budget reasonable.
    const text = c.chunk.content.length > 1200
      ? `${c.chunk.content.slice(0, 1200)}…`
      : c.chunk.content;
    return `[${i + 1}] from "${source}" (similarity ${c.similarity.toFixed(2)}):\n${text}`;
  });

  const formatted = [
    'Product knowledge (from indexed datasheets / docs — quote facts from these where they fit, never invent):',
    blocks.join('\n\n'),
  ].join('\n\n');

  return {
    formatted,
    chunkCount: filtered.length,
    topSimilarity: filtered[0]!.similarity,
  };
}

/** Per-product coverage signal for the UI. Counts indexed chunks
 *  attached to a product (via knowledge_sources.productProfileIds). */
export async function getProductKnowledgeCoverage(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  productProfileId: bigint,
): Promise<{ docs: number; chunks: number }> {
  const { db } = await import('@/lib/db/client');
  const { documentChunks } = await import('@/lib/db/schema/rag');
  const { knowledgeSources } = await import('@/lib/db/schema/documents');
  const { and, eq, isNotNull, sql } = await import('drizzle-orm');
  try {
    const [chunksRow, docsRow] = await Promise.all([
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(documentChunks)
        .where(
          and(
            eq(documentChunks.workspaceId, ctx.workspaceId),
            isNotNull(documentChunks.embedding),
            sql`(${documentChunks.knowledgeSourceId} IS NULL OR EXISTS (
              SELECT 1 FROM ${knowledgeSources}
              WHERE ${knowledgeSources.id} = ${documentChunks.knowledgeSourceId}
                AND ${productProfileId} = ANY(${knowledgeSources.productProfileIds})
            ))`,
          ),
        ),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(knowledgeSources)
        .where(
          and(
            eq(knowledgeSources.workspaceId, ctx.workspaceId),
            sql`${productProfileId} = ANY(${knowledgeSources.productProfileIds})`,
          ),
        ),
    ]);
    return {
      docs: docsRow[0]?.n ?? 0,
      chunks: chunksRow[0]?.n ?? 0,
    };
  } catch (err) {
    console.warn('[outreach-knowledge] coverage query failed:', err);
    return { docs: 0, chunks: 0 };
  }
}
