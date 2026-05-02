// Embeddings provider abstraction.
//
// One IEmbeddingProvider per workspace context. Mock + OpenAI implementations
// ship in this phase. Selection at boot via EMBEDDING_PROVIDER env (`mock`
// | `openai`); per-workspace BYOK keys land later through workspace_secrets.
//
// All embeddings are normalized 1536-dimension float32 unit vectors so
// cosine similarity is consistent across providers.

import { createHash } from 'node:crypto';

export const EMBEDDING_DIM = 1536;

export interface EmbedInput {
  /** Texts to embed in a single batch. */
  texts: ReadonlyArray<string>;
  /** Caller-supplied stable seed (mock honors; real providers ignore). */
  mockSeed?: string;
}

export interface EmbedResult {
  embeddings: number[][];
  model: string;
  /** Approximate input tokens consumed (sum across batch). */
  inputTokens: number;
}

export interface IEmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dim: number;
  embed(input: EmbedInput): Promise<EmbedResult>;
  estimateCost(inputTokens: number): number;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

// ---- mock implementation ----------------------------------------------

export class MockEmbeddingProvider implements IEmbeddingProvider {
  public readonly id = 'mock';
  public readonly model = 'mock-embed-1';
  public readonly dim = EMBEDDING_DIM;

  async embed(input: EmbedInput): Promise<EmbedResult> {
    // Deterministic: each text -> a unit vector seeded from sha256(text).
    // Tests use this to assert similarity properties (same input -> same
    // vector; different inputs -> different vectors; cosine is stable).
    const embeddings = input.texts.map((t) => deterministicVector(t, this.dim));
    const tokens = input.texts.reduce((sum, t) => sum + estimateTokens(t), 0);
    return { embeddings, model: this.model, inputTokens: tokens };
  }

  estimateCost(_inputTokens: number): number {
    void _inputTokens;
    return 0;
  }

  async healthCheck() {
    return { ok: true, detail: 'mock embedding provider always healthy' };
  }
}

function deterministicVector(text: string, dim: number): number[] {
  // Hash to a 32-byte digest, then expand into `dim` floats by repeated
  // hashing. The result is L2-normalized to a unit vector so cosine
  // similarity is well-behaved.
  const out = new Float64Array(dim);
  let buf = createHash('sha256').update(text).digest();
  let written = 0;
  while (written < dim) {
    for (let i = 0; i + 4 <= buf.length && written < dim; i += 4) {
      // signed 32-bit -> [-1, 1)
      const v = buf.readInt32BE(i) / 0x80000000;
      out[written++] = v;
    }
    buf = createHash('sha256').update(buf).digest();
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += out[i]! * out[i]!;
  norm = Math.sqrt(norm) || 1;
  const result: number[] = new Array(dim);
  for (let i = 0; i < dim; i++) result[i] = out[i]! / norm;
  return result;
}

function estimateTokens(text: string): number {
  // 4 chars per token rough heuristic. Real providers count via tokenizer.
  return Math.ceil(text.length / 4);
}

// ---- OpenAI implementation --------------------------------------------

export interface OpenAIEmbeddingConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class OpenAIEmbeddingProvider implements IEmbeddingProvider {
  public readonly id = 'openai';
  public readonly model: string;
  public readonly dim = EMBEDDING_DIM;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: OpenAIEmbeddingConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'text-embedding-3-small';
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com';
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  static fromEnv(): OpenAIEmbeddingProvider {
    const apiKey = process.env.OPENAI_API_KEY ?? process.env.EMBEDDING_API_KEY;
    if (!apiKey) {
      throw new Error(
        'EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY (or EMBEDDING_API_KEY).',
      );
    }
    return new OpenAIEmbeddingProvider({
      apiKey,
      model: process.env.EMBEDDING_MODEL,
      baseUrl: process.env.OPENAI_BASE_URL,
    });
  }

  async embed(input: EmbedInput): Promise<EmbedResult> {
    if (input.texts.length === 0) {
      return { embeddings: [], model: this.model, inputTokens: 0 };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: input.texts,
          dimensions: this.dim,
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`openai embeddings ${res.status}: ${detail.slice(0, 400)}`);
    }
    const json = (await res.json()) as {
      model: string;
      data: Array<{ embedding: number[]; index: number }>;
      usage: { prompt_tokens: number; total_tokens: number };
    };
    // Sort by index to align with input order (the API guarantees order but
    // be defensive).
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return {
      embeddings: sorted.map((e) => e.embedding),
      model: json.model ?? this.model,
      inputTokens: json.usage?.prompt_tokens ?? 0,
    };
  }

  estimateCost(inputTokens: number): number {
    // text-embedding-3-small: $0.02 per 1M tokens (2025-12 pricing). Very
    // cheap; surface as cents anyway so the usage_log totals can show it.
    return (inputTokens / 1_000_000) * 0.02;
  }

  async healthCheck() {
    try {
      await this.embed({ texts: ['ping'] });
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ---- factory ---------------------------------------------------------

let cached: IEmbeddingProvider | null = null;

export function getEmbeddingProvider(): IEmbeddingProvider {
  if (cached) return cached;
  const id = process.env.EMBEDDING_PROVIDER ?? 'mock';
  switch (id) {
    case 'mock':
      cached = new MockEmbeddingProvider();
      return cached;
    case 'openai':
      cached = OpenAIEmbeddingProvider.fromEnv();
      return cached;
    default:
      throw new Error(`Unknown EMBEDDING_PROVIDER: ${id}. Supported: "mock" | "openai".`);
  }
}

export function _setEmbeddingProviderForTests(provider: IEmbeddingProvider | null): void {
  cached = provider;
}

// ---- helpers exported for service callers ---------------------------

/** Cosine similarity in [-1, 1]. Inputs assumed to be the same dimension. */
export function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
