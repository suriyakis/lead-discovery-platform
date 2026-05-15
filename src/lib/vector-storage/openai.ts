/**
 * Phase 50 — OpenAIVectorStorageProvider.
 *
 * Per-product OpenAI Vector Store. Mirrors the Wandizz pattern:
 *   - One vector store per (workspace, product) pair, lazy-created on
 *     first attach via POST /v1/vector_stores.
 *   - Knowledge sources are uploaded as Files (POST /v1/files,
 *     purpose=assistants) then attached via
 *     POST /v1/vector_stores/{vsId}/files.
 *   - Queries go through the Responses API with the `file_search` tool
 *     (POST /v1/responses), which returns a synthesized answer plus
 *     file_citation annotations.
 *
 * OpenAI handles chunking, embedding, retrieval, and ranking on its end
 * — the local DB only carries the references (vector store id, file ids).
 *
 * Pricing (as of 2026-04):
 *   - File search tool call: $2.50 per 1K queries
 *   - Storage: first 1 GB free, then $0.10/GB/day
 *   - Generation: standard input/output token rates for the chosen model
 * Storage cost isn't priced per attach (it's a daily line item) so we
 * only emit per-call cost estimates here.
 */

import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { knowledgeSources } from '@/lib/db/schema/documents';
import { workspaces } from '@/lib/db/schema/workspaces';
import { productVectorStores, type ProductVectorStore } from '@/lib/db/schema/vector-stores';
import type { WorkspaceContext } from '@/lib/services/context';
import { recordAuditEvent } from '@/lib/services/audit';
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

export class OpenAIVectorStorageError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'OpenAIVectorStorageError';
    this.code = code;
  }
}

export interface OpenAIVectorStorageConfig {
  apiKey: string;
  /** Model used by the Responses API for synthesizing file_search
   *  answers. Default `gpt-4o-mini` matches Wandizz's cheap-but-capable
   *  default; operators can override per query via the systemPrompt + the
   *  workspace's active AI model selection in a future iteration. */
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  keySource: 'workspace' | 'platform';
}

const DEFAULT_BASE = 'https://api.openai.com';
const DEFAULT_TIMEOUT_MS = 60_000;
const FILE_SEARCH_COST_PER_1K_QUERIES_CENTS = 250; // $2.50

export class OpenAIVectorStorageProvider implements IVectorStorageProvider {
  public readonly id = 'openai';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly keySource: 'workspace' | 'platform';

  constructor(config: OpenAIVectorStorageConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'gpt-4o-mini';
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.keySource = config.keySource;
  }

  async ensureProductStore(
    ctx: WorkspaceContext,
    productProfileId: bigint,
  ): Promise<ProductVectorStore> {
    const existing = await db
      .select()
      .from(productVectorStores)
      .where(eq(productVectorStores.workspaceId, ctx.workspaceId))
      .limit(50);
    const found = existing.find(
      (r) =>
        r.productProfileId === productProfileId &&
        r.providerId === this.id &&
        r.externalStoreId.startsWith('vs_'),
    );
    if (found) return found;

    const name = `LeadDiscovery-${ctx.workspaceId}-product-${productProfileId}`;
    const created = await this.openaiRequest({
      method: 'POST',
      path: '/v1/vector_stores',
      body: { name },
    });
    const externalStoreId = String((created as { id?: string }).id ?? '');
    if (!externalStoreId.startsWith('vs_')) {
      throw new OpenAIVectorStorageError(
        `openai vector_store create returned unexpected id: ${externalStoreId}`,
        'vector_store_create_failed',
      );
    }
    return upsertProductVectorStore(ctx, {
      productProfileId,
      providerId: this.id,
      externalStoreId,
    });
  }

  async attachKnowledgeSource(
    ctx: WorkspaceContext,
    productProfileId: bigint,
    input: AttachKnowledgeInput,
  ): Promise<AttachKnowledgeResult> {
    const store = await this.ensureProductStore(ctx, productProfileId);
    const { bytes, blob, filename } = await this.materializeForUpload(input);

    // Per-product cap. The workspace-level setting is the default; later
    // iterations can override per-product. Refuse the upload BEFORE the
    // OpenAI calls so we don't pay for a file we can't keep.
    const cap = await this.readPerProductByteCap(ctx);
    if (cap > 0 && store.usageBytes + bytes > cap) {
      throw new OpenAIVectorStorageError(
        `attach would exceed per-product cap (${formatMb(store.usageBytes + bytes)} of ${formatMb(cap)})`,
        'quota_exceeded',
      );
    }

    // 1. Upload the bytes.
    const form = new FormData();
    form.append('file', blob, filename);
    form.append('purpose', 'assistants');
    const fileResp = (await this.openaiRequest({
      method: 'POST',
      path: '/v1/files',
      formData: form,
    })) as { id?: string; bytes?: number };
    if (!fileResp.id) {
      throw new OpenAIVectorStorageError(
        'openai files upload returned no id',
        'file_upload_failed',
      );
    }

    // 2. Attach the file to the product's vector store.
    await this.openaiRequest({
      method: 'POST',
      path: `/v1/vector_stores/${store.externalStoreId}/files`,
      body: { file_id: fileResp.id },
    });

    await bumpProductVectorStoreUsage(store.id, bytes, 1);
    await recordAuditEvent(ctx, {
      kind: 'vector_storage.attach',
      entityType: 'knowledge_source',
      entityId: input.knowledgeSource.id,
      payload: {
        providerId: this.id,
        externalStoreId: store.externalStoreId,
        externalFileId: fileResp.id,
        bytes,
        keySource: this.keySource,
      },
    });

    return {
      externalFileId: fileResp.id,
      bytesAttached: bytes,
      usage: { keySource: this.keySource, costEstimateCents: 0 },
    };
  }

  async detachKnowledgeSource(
    ctx: WorkspaceContext,
    knowledgeSourceId: bigint,
  ): Promise<void> {
    const [src] = await db
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, knowledgeSourceId))
      .limit(1);
    if (!src) return;
    if (src.externalProviderId !== this.id || !src.externalFileId) return;

    // Find the binding to know which vector store to detach from.
    const bindings = await db
      .select()
      .from(productVectorStores)
      .where(eq(productVectorStores.workspaceId, ctx.workspaceId))
      .limit(200);
    for (const ks of src.productProfileIds) {
      const binding = bindings.find(
        (b) => b.productProfileId === ks && b.providerId === this.id,
      );
      if (!binding) continue;
      try {
        await this.openaiRequest({
          method: 'DELETE',
          path: `/v1/vector_stores/${binding.externalStoreId}/files/${src.externalFileId}`,
        });
      } catch (err) {
        console.error('[openai-vs] detach from vector store failed:', err);
      }
    }

    // Delete the underlying file too. Best-effort — a missing file is
    // not an error (idempotent detach).
    try {
      await this.openaiRequest({
        method: 'DELETE',
        path: `/v1/files/${src.externalFileId}`,
      });
    } catch (err) {
      console.error('[openai-vs] file delete failed:', err);
    }

    await recordAuditEvent(ctx, {
      kind: 'vector_storage.detach',
      entityType: 'knowledge_source',
      entityId: knowledgeSourceId,
      payload: {
        providerId: this.id,
        externalFileId: src.externalFileId,
      },
    });
  }

  async query(
    ctx: WorkspaceContext,
    productProfileId: bigint,
    question: string,
    options: VectorQueryOptions = {},
  ): Promise<VectorSearchResult> {
    const store = await this.ensureProductStore(ctx, productProfileId);

    const body = {
      model: this.model,
      input: question,
      ...(options.systemPrompt
        ? { instructions: options.systemPrompt }
        : {}),
      tools: [
        {
          type: 'file_search',
          vector_store_ids: [store.externalStoreId],
          ...(options.topK ? { max_num_results: options.topK } : {}),
        },
      ],
    };
    const result = (await this.openaiRequest({
      method: 'POST',
      path: '/v1/responses',
      body,
    })) as ResponsesApiPayload;

    let answer = '';
    const chunks: VectorSearchChunk[] = [];
    for (const item of result.output ?? []) {
      if (item.type !== 'message') continue;
      for (const content of item.content ?? []) {
        if (content.type === 'output_text') {
          answer += content.text ?? '';
          for (const ann of content.annotations ?? []) {
            if (ann.type === 'file_citation' && ann.file_citation) {
              chunks.push({
                knowledgeSourceId: null,
                documentId: null,
                content: ann.file_citation.quote ?? '',
                citationFileId: ann.file_citation.file_id,
                citationFilename: ann.file_citation.filename,
              });
            }
          }
        }
      }
    }

    const inputTokens = result.usage?.input_tokens ?? 0;
    const outputTokens = result.usage?.output_tokens ?? 0;
    return {
      answer,
      chunks,
      usage: {
        inputTokens,
        outputTokens,
        // One file_search call per query at $2.50 / 1K = 0.25¢ per call.
        // Token spend on the generation model is separate; we don't
        // price it here because the workspace's AI provider has its own
        // pricing model.
        costEstimateCents: FILE_SEARCH_COST_PER_1K_QUERIES_CENTS / 1000,
        keySource: this.keySource,
      },
    };
  }

  async testConnection(): Promise<
    { ok: true } | { ok: false; reason: string }
  > {
    try {
      await this.openaiRequest({ method: 'GET', path: '/v1/models' });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ─── helpers ────────────────────────────────────────────────────────

  private async readPerProductByteCap(ctx: WorkspaceContext): Promise<number> {
    const [row] = await db
      .select({
        quotaMb: workspaces.vectorStorageQuotaMbPerProduct,
      })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId))
      .limit(1);
    const mb = row?.quotaMb ?? 20;
    return mb * 1024 * 1024;
  }

  private async materializeForUpload(
    input: AttachKnowledgeInput,
  ): Promise<{ bytes: number; blob: Blob; filename: string }> {
    if (input.fileBytes && input.filename) {
      const bytes = input.fileBytes.length;
      // Copy into a fresh Uint8Array<ArrayBuffer> so the Blob
      // constructor's BlobPart type (which requires plain ArrayBuffer,
      // not SharedArrayBuffer) is satisfied.
      const u8 = new Uint8Array(bytes);
      u8.set(input.fileBytes);
      return {
        bytes,
        blob: new Blob([u8], {
          type: input.mimeType ?? 'application/octet-stream',
        }),
        filename: input.filename,
      };
    }
    // For text + url knowledge sources, synthesize a small text file so
    // OpenAI can chunk + embed it. The title becomes the filename so
    // citations are recognisable.
    const ks = input.knowledgeSource;
    let body = '';
    if (input.text) body = input.text;
    else if (ks.textExcerpt) body = ks.textExcerpt;
    else if (input.url || ks.url) {
      body = `URL: ${input.url ?? ks.url}\n\nTitle: ${ks.title}\n\nSummary: ${ks.summary ?? ''}`;
    } else {
      body = ks.title;
    }
    const filename = `${slugifyFilename(ks.title)}-${ks.id}.txt`;
    const bytes = Buffer.byteLength(body, 'utf8');
    return {
      bytes,
      blob: new Blob([body], { type: 'text/plain; charset=utf-8' }),
      filename,
    };
  }

  private async openaiRequest(opts: {
    method: string;
    path: string;
    body?: Record<string, unknown>;
    formData?: FormData;
  }): Promise<unknown> {
    const url = `${this.baseUrl}${opts.path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    let fetchBody: BodyInit | undefined;
    if (opts.formData) {
      fetchBody = opts.formData;
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      fetchBody = JSON.stringify(opts.body);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method,
        headers,
        body: fetchBody,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let parsed = '';
      try {
        const j = JSON.parse(detail);
        parsed = (j as { error?: { message?: string } }).error?.message ?? '';
      } catch {
        // not JSON
      }
      throw new OpenAIVectorStorageError(
        `openai ${opts.method} ${opts.path} ${res.status}: ${parsed || detail.slice(0, 400)}`,
        res.status === 401 || res.status === 403 ? 'auth_failed' : 'request_failed',
      );
    }
    if (res.status === 204) return null;
    return res.json();
  }
}

// ─── shape of the Responses API payload we care about ─────────────────

interface ResponsesApiPayload {
  output?: Array<{
    type: string;
    content?: Array<{
      type: string;
      text?: string;
      annotations?: Array<{
        type: string;
        file_citation?: {
          file_id?: string;
          filename?: string;
          quote?: string;
        };
      }>;
    }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

function slugifyFilename(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'knowledge'
  );
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
