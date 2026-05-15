/**
 * Phase 50 — Vector Storage provider abstraction.
 *
 * The 5th capability in the Phase 45 cascade. Where AI generates text,
 * Embedding turns text into vectors, Research grounds an answer with the
 * live web, and Search returns raw SERP hits, **Vector Storage** is the
 * indexed store of product knowledge that RAG retrieval reads from.
 *
 * Two real implementations land in P50-03 / P50-04:
 *   - `pgvector` — wraps the existing self-hosted RAG (P12). Chunks live
 *     in `document_chunks`, embeddings are OpenAI 1536-dim or mock.
 *   - `openai`   — Wandizz-style per-product OpenAI Vector Store. Files
 *     are uploaded via the Files API, attached to a `vs_xxx` store, and
 *     queried via the Responses API with the `file_search` tool. OpenAI
 *     manages chunking, embedding, retrieval, and citations server-side.
 *
 * `mock` is the always-available no-op for dev/CI.
 *
 * Resolution cascade (Phase 45):
 *   1. workspace_provider_settings.vector_storage_provider (when set)
 *   2. process.env.VECTOR_STORAGE_PROVIDER
 *   3. 'mock'
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import type { KnowledgeSource } from '@/lib/db/schema/documents';
import {
  productVectorStores,
  type NewProductVectorStore,
  type ProductVectorStore,
} from '@/lib/db/schema/vector-stores';
import type { WorkspaceContext } from '@/lib/services/context';

// ─── types ───────────────────────────────────────────────────────────

/**
 * What the caller hands the provider to attach a single knowledge source.
 * The caller is responsible for materializing bytes / text from the
 * source row (the provider doesn't reach into storage on its own).
 */
export interface AttachKnowledgeInput {
  /** The knowledge_sources row being attached. Carries id, kind, title,
   *  and product association. */
  knowledgeSource: KnowledgeSource;
  /** Required when kind='document' — raw file bytes from storage. */
  fileBytes?: Buffer;
  /** Original filename (with extension) — used by file-based providers
   *  for content-type detection and citation labels. */
  filename?: string;
  /** Mime type from the documents row. */
  mimeType?: string;
  /** Raw text content when kind='text'. */
  text?: string;
  /** Resolved URL when kind='url'. */
  url?: string;
}

export interface AttachKnowledgeResult {
  /** Provider-specific opaque id (e.g. OpenAI's `file-...`); NULL for
   *  providers that don't track per-file handles (e.g. pgvector). */
  externalFileId: string | null;
  /** Bytes counted against the per-product cap. Stored back on the
   *  knowledge_sources row so retroactive cap changes can be applied. */
  bytesAttached: number;
  usage: {
    keySource: 'workspace' | 'platform' | 'mock' | 'local';
    costEstimateCents: number;
    inputTokens?: number;
  };
}

export interface VectorQueryOptions {
  /** Up to N chunks / citations. Provider may clamp. */
  topK?: number;
  /** Drop matches below this cosine similarity (pgvector only). */
  minSimilarity?: number;
  /** Provider-specific system prompt for synthesis (openai uses this
   *  to steer the file_search tool's response). */
  systemPrompt?: string;
  /** Override the request-level timeout. */
  timeoutMs?: number;
}

export interface VectorSearchChunk {
  /** When pgvector matched a stored chunk row. */
  knowledgeSourceId: bigint | null;
  documentId: bigint | null;
  /** Chunk text (pgvector) or quoted snippet from file_search citation. */
  content: string;
  /** Cosine similarity [0,1] when pgvector; undefined when openai. */
  similarity?: number;
  /** OpenAI file id when citation came from file_search. */
  citationFileId?: string;
  citationFilename?: string;
}

export interface VectorSearchResult {
  /** Some providers (OpenAI file_search) return a synthesized answer
   *  with the chunks as supporting citations. Pgvector leaves this
   *  undefined and the caller composes the answer downstream. */
  answer?: string;
  chunks: VectorSearchChunk[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    costEstimateCents: number;
    keySource: 'workspace' | 'platform' | 'mock' | 'local';
  };
}

export interface IVectorStorageProvider {
  /** Stable id used in `product_vector_stores.provider_id` and audit
   *  payloads. 'mock' | 'pgvector' | 'openai'. */
  readonly id: string;

  /** Idempotent. Returns the existing binding when one already exists
   *  for (workspace, product, provider), else creates one. */
  ensureProductStore(
    ctx: WorkspaceContext,
    productProfileId: bigint,
  ): Promise<ProductVectorStore>;

  /** Push a knowledge source into the store. Caller persists the
   *  returned `externalFileId` / `bytesAttached` back to the
   *  knowledge_sources row. */
  attachKnowledgeSource(
    ctx: WorkspaceContext,
    productProfileId: bigint,
    input: AttachKnowledgeInput,
  ): Promise<AttachKnowledgeResult>;

  /** Remove a knowledge source from the store. Idempotent — a missing
   *  external file is treated as already-detached. */
  detachKnowledgeSource(
    ctx: WorkspaceContext,
    knowledgeSourceId: bigint,
  ): Promise<void>;

  /** Query the store for the given product. */
  query(
    ctx: WorkspaceContext,
    productProfileId: bigint,
    question: string,
    options?: VectorQueryOptions,
  ): Promise<VectorSearchResult>;

  /** Optional liveness probe — used by /settings/integrations to show
   *  green/red without performing a full indexing run. */
  testConnection?(
    ctx: WorkspaceContext,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
}

// ─── shared helpers ──────────────────────────────────────────────────

/**
 * Upsert the (workspace, product, provider) binding. Used by every
 * provider's `ensureProductStore`. `seed` is the external id to write
 * on first insert (e.g. an OpenAI `vs_xxx`); on conflict the row is
 * left alone so re-runs are idempotent.
 */
export async function upsertProductVectorStore(
  ctx: WorkspaceContext,
  input: {
    productProfileId: bigint;
    providerId: string;
    externalStoreId: string;
  },
): Promise<ProductVectorStore> {
  const existing = await db
    .select()
    .from(productVectorStores)
    .where(
      and(
        eq(productVectorStores.workspaceId, ctx.workspaceId),
        eq(productVectorStores.productProfileId, input.productProfileId),
        eq(productVectorStores.providerId, input.providerId),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];

  const row: NewProductVectorStore = {
    workspaceId: ctx.workspaceId,
    productProfileId: input.productProfileId,
    providerId: input.providerId,
    externalStoreId: input.externalStoreId,
    status: 'active',
    createdBy: ctx.userId ?? null,
  };
  const [created] = await db
    .insert(productVectorStores)
    .values(row)
    .returning();
  if (!created) {
    // Lost the race — re-read.
    const again = await db
      .select()
      .from(productVectorStores)
      .where(
        and(
          eq(productVectorStores.workspaceId, ctx.workspaceId),
          eq(productVectorStores.productProfileId, input.productProfileId),
          eq(productVectorStores.providerId, input.providerId),
        ),
      )
      .limit(1);
    if (!again[0]) throw new Error('product_vector_stores upsert lost row');
    return again[0];
  }
  return created;
}

/** Bump the running counters on a product binding. Used by every
 *  provider after a successful attach. Negative deltas are allowed
 *  (detach). */
export async function bumpProductVectorStoreUsage(
  storeId: bigint,
  deltaBytes: number,
  deltaFiles: number,
): Promise<void> {
  await db
    .update(productVectorStores)
    .set({
      usageBytes: sql`GREATEST(0, ${productVectorStores.usageBytes} + ${deltaBytes})`,
      fileCount: sql`GREATEST(0, ${productVectorStores.fileCount} + ${deltaFiles})`,
      updatedAt: new Date(),
    })
    .where(eq(productVectorStores.id, storeId));
}

// ─── mock impl ───────────────────────────────────────────────────────

/**
 * No-op provider for dev/CI. `ensureProductStore` persists a real
 * `product_vector_stores` row (so callers can read counters) but the
 * attach + query operations stay in-process.
 */
export class MockVectorStorageProvider implements IVectorStorageProvider {
  public readonly id = 'mock';

  async ensureProductStore(
    ctx: WorkspaceContext,
    productProfileId: bigint,
  ): Promise<ProductVectorStore> {
    return upsertProductVectorStore(ctx, {
      productProfileId,
      providerId: this.id,
      externalStoreId: `mock-vs-${ctx.workspaceId}-${productProfileId}`,
    });
  }

  async attachKnowledgeSource(
    ctx: WorkspaceContext,
    productProfileId: bigint,
    input: AttachKnowledgeInput,
  ): Promise<AttachKnowledgeResult> {
    const store = await this.ensureProductStore(ctx, productProfileId);
    const bytes =
      input.fileBytes?.length ??
      (input.text ? Buffer.byteLength(input.text, 'utf8') : 0);
    await bumpProductVectorStoreUsage(store.id, bytes, 1);
    return {
      externalFileId: `mock-file-${input.knowledgeSource.id}`,
      bytesAttached: bytes,
      usage: { keySource: 'mock', costEstimateCents: 0 },
    };
  }

  async detachKnowledgeSource(
    _ctx: WorkspaceContext,
    _knowledgeSourceId: bigint,
  ): Promise<void> {
    // Mock doesn't track detach (the bookkeeping decrement happens in
    // the caller after it reads bytesAttached from the row).
  }

  async query(
    _ctx: WorkspaceContext,
    productProfileId: bigint,
    question: string,
    options: VectorQueryOptions = {},
  ): Promise<VectorSearchResult> {
    const topK = Math.min(options.topK ?? 3, 10);
    const chunks: VectorSearchChunk[] = Array.from({ length: topK }, (_, i) => ({
      knowledgeSourceId: null,
      documentId: null,
      content: `[mock chunk ${i + 1}] product=${productProfileId} q="${question.slice(0, 40)}"`,
      similarity: 1 - i * 0.05,
    }));
    return {
      chunks,
      usage: {
        inputTokens: question.length,
        outputTokens: 0,
        costEstimateCents: 0,
        keySource: 'mock',
      },
    };
  }

  async testConnection(): Promise<{ ok: true }> {
    return { ok: true };
  }
}

// ─── factory ─────────────────────────────────────────────────────────

let cached: IVectorStorageProvider | null = null;

/**
 * Workspace-aware factory. Mirrors `getEmbeddingProviderForCtx`:
 *   1. test injection (`_setVectorStorageProviderForTests`) short-circuits
 *   2. workspace_provider_settings.vector_storage_provider
 *   3. process.env.VECTOR_STORAGE_PROVIDER
 *   4. 'mock'
 *
 * When the cascade resolves to `openai` the OpenAI provider builds an
 * authenticated client on construction — that throws when no key is
 * configured (workspace BYOK or platform env). The error surfaces at the
 * `/settings/integrations` page test-connection button.
 */
export async function getVectorStorageProviderForCtx(
  ctx: WorkspaceContext,
): Promise<IVectorStorageProvider> {
  if (cached) return cached;
  const { resolveActiveProvider } = await import(
    '@/lib/services/provider-settings'
  );
  const active = await resolveActiveProvider(
    ctx,
    'vector_storage',
    process.env.VECTOR_STORAGE_PROVIDER,
  );
  if (active.id === 'mock') return new MockVectorStorageProvider();
  if (active.id === 'pgvector') {
    const { PgvectorVectorStorageProvider } = await import('./pgvector');
    return new PgvectorVectorStorageProvider();
  }
  if (active.id === 'openai') {
    const { resolveProviderKey } = await import('@/lib/services/secrets');
    const resolved = await resolveProviderKey(
      ctx,
      'openai.apiKey',
      'OPENAI_API_KEY',
    );
    if (!resolved) {
      throw new Error(
        'Vector Storage provider=openai but no OpenAI key configured (workspace or platform).',
      );
    }
    const { OpenAIVectorStorageProvider } = await import('./openai');
    return new OpenAIVectorStorageProvider({
      apiKey: resolved.key,
      keySource: resolved.source,
    });
  }
  throw new Error(`Unknown vector_storage provider id from cascade: ${active.id}`);
}

export function _setVectorStorageProviderForTests(
  provider: IVectorStorageProvider | null,
): void {
  cached = provider;
}
