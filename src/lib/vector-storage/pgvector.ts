/**
 * Phase 50 — PgvectorVectorStorageProvider.
 *
 * Wraps the existing self-hosted RAG path so the operator can pick
 * `pgvector` from /settings/integrations and get the same behaviour the
 * platform has shipped since P12: chunks in `document_chunks`, embeddings
 * via the configured Embedding provider (OpenAI text-embedding-3-small
 * or mock), cosine retrieval via pgvector's `<=>` operator.
 *
 * No external store id — chunks reference the knowledge_source row
 * directly. `externalStoreId` is stored as an empty string so the
 * (workspace, product, provider) unique index still resolves.
 *
 * KL-06 (I040): indexesPerSource. The knowledge.index job builds a
 * source's chunks ONCE (not once per product), so attach is bookkeeping
 * only: the product binding exists and its counters are recomputed from
 * the chunks (recomputePgvectorProductUsage) — re-indexing never inflates
 * them and deleting a source brings them down.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { documentChunks } from '@/lib/db/schema/rag';
import type { ProductVectorStore } from '@/lib/db/schema/vector-stores';
import { retrieve } from '@/lib/services/rag';
import { getEmbeddingProviderForCtx } from '@/lib/embeddings';
import type { WorkspaceContext } from '@/lib/services/context';
import {
  recomputePgvectorProductUsage,
  upsertProductVectorStore,
  type AttachKnowledgeInput,
  type AttachKnowledgeResult,
  type IVectorStorageProvider,
  type VectorQueryOptions,
  type VectorSearchChunk,
  type VectorSearchResult,
} from './index';

export class PgvectorVectorStorageProvider implements IVectorStorageProvider {
  public readonly id = 'pgvector';
  public readonly indexesPerSource = true;

  async ensureProductStore(
    ctx: WorkspaceContext,
    productProfileId: bigint,
  ): Promise<ProductVectorStore> {
    return upsertProductVectorStore(ctx, {
      productProfileId,
      providerId: this.id,
      externalStoreId: '',
    });
  }

  /** Bookkeeping only: the chunks were built once for the source. */
  async attachKnowledgeSource(
    ctx: WorkspaceContext,
    productProfileId: bigint,
    input: AttachKnowledgeInput,
  ): Promise<AttachKnowledgeResult> {
    await this.ensureProductStore(ctx, productProfileId);
    await recomputePgvectorProductUsage(ctx);
    return {
      externalFileId: null,
      bytesAttached: await sourceChunkBytes(ctx, input.knowledgeSource.id),
      usage: { keySource: 'local', costEstimateCents: 0 },
    };
  }

  /** Drops the source's chunks and recomputes the product counters. */
  async detachKnowledgeSource(
    ctx: WorkspaceContext,
    knowledgeSourceId: bigint,
  ): Promise<void> {
    await db
      .delete(documentChunks)
      .where(
        and(
          eq(documentChunks.workspaceId, ctx.workspaceId),
          eq(documentChunks.knowledgeSourceId, knowledgeSourceId),
        ),
      );
    await recomputePgvectorProductUsage(ctx);
  }

  async query(
    ctx: WorkspaceContext,
    productProfileId: bigint,
    question: string,
    options: VectorQueryOptions = {},
  ): Promise<VectorSearchResult> {
    const limit = Math.min(options.topK ?? 8, 50);
    // KL-05: retrieve() applies THE scope predicate (knowledge-scope.ts) —
    // workspace-wide sources plus this product's, never another product's
    // and never an archived document's.
    const rows = await retrieve(ctx, question, {
      productProfileId,
      limit,
    });
    const minSim = options.minSimilarity ?? 0;
    const chunks: VectorSearchChunk[] = rows
      .filter((r) => r.similarity >= minSim)
      .map((r) => ({
        knowledgeSourceId: r.knowledgeSource.id,
        documentId: r.document?.id ?? null,
        content: r.chunk.content,
        similarity: r.similarity,
        citationFilename: r.document?.filename ?? r.knowledgeSource.title,
      }));
    return {
      chunks,
      usage: {
        inputTokens: question.length,
        outputTokens: 0,
        costEstimateCents: 0,
        keySource: 'local',
      },
    };
  }

  async testConnection(
    ctx: WorkspaceContext,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      // The embedding provider is what does the actual work; if it
      // isn't reachable, RAG will fail. Health-check it through the
      // workspace-aware factory so BYOK keys are honoured.
      const embedder = await getEmbeddingProviderForCtx(ctx);
      if (typeof embedder.healthCheck === 'function') {
        const res = await embedder.healthCheck();
        if (!res.ok) {
          return { ok: false, reason: res.detail ?? 'embedder unhealthy' };
        }
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/** Bytes of the text a source holds in pgvector (its chunks). */
async function sourceChunkBytes(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  knowledgeSourceId: bigint,
): Promise<number> {
  const [row] = await db
    .select({ bytes: sql<number>`COALESCE(SUM(octet_length(${documentChunks.content})), 0)::bigint` })
    .from(documentChunks)
    .where(
      and(
        eq(documentChunks.workspaceId, ctx.workspaceId),
        eq(documentChunks.knowledgeSourceId, knowledgeSourceId),
      ),
    );
  return Number(row?.bytes ?? 0);
}
