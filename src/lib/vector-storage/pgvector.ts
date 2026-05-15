/**
 * Phase 50 — PgvectorVectorStorageProvider.
 *
 * Wraps the existing self-hosted RAG path so the operator can pick
 * `pgvector` from /settings/integrations and get the same behaviour the
 * platform has shipped since P12: chunks in `document_chunks`, embeddings
 * via the configured Embedding provider (OpenAI text-embedding-3-small
 * or mock), cosine retrieval via pgvector's `<=>` operator.
 *
 * No external store id — chunks reference the knowledge_source / document
 * row directly. `externalStoreId` is stored as an empty string so the
 * (workspace, product, provider) unique index still resolves.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { documentChunks } from '@/lib/db/schema/rag';
import type { ProductVectorStore } from '@/lib/db/schema/vector-stores';
import { indexKnowledgeSource, retrieve } from '@/lib/services/rag';
import { getEmbeddingProviderForCtx } from '@/lib/embeddings';
import type { WorkspaceContext } from '@/lib/services/context';
import {
  bumpProductVectorStoreUsage,
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

  async attachKnowledgeSource(
    ctx: WorkspaceContext,
    productProfileId: bigint,
    input: AttachKnowledgeInput,
  ): Promise<AttachKnowledgeResult> {
    const store = await this.ensureProductStore(ctx, productProfileId);
    const bytes = computeAttachBytes(input);
    // The existing service handles all three kinds (document / url /
    // text) — it pulls bytes from `documents` when kind=document, runs
    // the chunker, embeds via the workspace's active Embedding
    // provider, and writes `document_chunks` rows.
    await indexKnowledgeSource(ctx, input.knowledgeSource.id);
    await bumpProductVectorStoreUsage(store.id, bytes, 1);
    return {
      externalFileId: null,
      bytesAttached: bytes,
      usage: { keySource: 'local', costEstimateCents: 0 },
    };
  }

  async detachKnowledgeSource(
    ctx: WorkspaceContext,
    knowledgeSourceId: bigint,
  ): Promise<void> {
    // Drop chunks owned by this knowledge_source. The
    // `product_vector_stores` counter decrement is the caller's job —
    // it has the original `bytesAttached` from the row.
    await db
      .delete(documentChunks)
      .where(
        and(
          eq(documentChunks.workspaceId, ctx.workspaceId),
          eq(documentChunks.knowledgeSourceId, knowledgeSourceId),
        ),
      );
  }

  async query(
    ctx: WorkspaceContext,
    productProfileId: bigint,
    question: string,
    options: VectorQueryOptions = {},
  ): Promise<VectorSearchResult> {
    const limit = Math.min(options.topK ?? 8, 50);
    const rows = await retrieve(ctx, question, {
      productProfileId,
      limit,
    });
    const minSim = options.minSimilarity ?? 0;
    const chunks: VectorSearchChunk[] = rows
      .filter((r) => r.similarity >= minSim)
      .map((r) => ({
        knowledgeSourceId: r.knowledgeSource?.id ?? null,
        documentId: r.document?.id ?? null,
        content: r.chunk.content,
        similarity: r.similarity,
        citationFilename: r.document?.filename ?? r.knowledgeSource?.title,
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

function computeAttachBytes(input: AttachKnowledgeInput): number {
  if (input.fileBytes) return input.fileBytes.length;
  if (input.text) return Buffer.byteLength(input.text, 'utf8');
  if (input.url) return Buffer.byteLength(input.url, 'utf8');
  const ks = input.knowledgeSource;
  if (ks.textExcerpt) return Buffer.byteLength(ks.textExcerpt, 'utf8');
  if (ks.url) return Buffer.byteLength(ks.url, 'utf8');
  return 0;
}

