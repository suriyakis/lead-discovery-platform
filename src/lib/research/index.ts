// Research provider abstraction.
//
// Distinct from `ISearchProvider` (raw SERP results) and `IAIProvider`
// (text/JSON completion). A research provider takes a question, performs
// web search internally, and returns an LLM-grounded answer with
// citations.
//
// Two real backends ship: Gemini grounding (Google's grounded
// generative AI) and Perplexity Sonar. A mock variant returns a
// deterministic stub for dev + tests.
//
// Selection happens at boot via `RESEARCH_PROVIDER` env var:
//   mock | gemini | perplexity (default: mock)
//
// Per-workspace BYOK is honoured the same way as the AI / SerpAPI
// providers (P32/P33): if AI_PROVIDER is real and the workspace has
// stored its own key in workspace_secrets, a fresh provider is built
// with that key; otherwise the env-cached singleton is used.

import { createHash } from 'node:crypto';
import type { WorkspaceContext } from '@/lib/services/context';
import { GeminiResearchProvider } from './gemini';
import { PerplexityResearchProvider } from './perplexity';

export { GeminiResearchProvider } from './gemini';
export { PerplexityResearchProvider } from './perplexity';

export interface ResearchOptions {
  /** Country bias for the underlying web search (ISO 3166-1 alpha-2). */
  country?: string;
  /** Output language for the answer (ISO 639-1). */
  language?: string;
  /** Recency filter — both Gemini and Perplexity support this. */
  freshness?: 'any' | 'day' | 'week' | 'month' | 'year';
  /** Cap on retained citations after dedup. Default 8. */
  maxCitations?: number;
  /** Extra instruction prepended to the system prompt. */
  systemPrompt?: string;
  /** Hard timeout in ms. Default 60_000. */
  timeoutMs?: number;
}

export interface ResearchCitation {
  rank: number;
  url: string;
  domain: string;
  title: string;
  snippet?: string;
  /** Some providers (Perplexity Pro) return matched passage text. */
  excerpt?: string;
}

export interface ResearchUsage {
  /** LLM token usage (the grounded-answer half). 0 when not exposed. */
  inputTokens: number;
  outputTokens: number;
  /** Underlying web-search hits the provider performed. */
  searchQueries: number;
  /** Estimated cost in cents based on the provider's published pricing. */
  costEstimateCents: number;
  keySource: 'workspace' | 'platform' | 'mock';
}

export interface ResearchOutcome {
  /** The grounded answer in markdown. May contain inline reference markers. */
  answer: string;
  citations: ResearchCitation[];
  /** Search queries the provider issued under the hood (Gemini exposes these). */
  queriesIssued: string[];
  /** Provider id that produced this outcome. */
  providerId: string;
  /** Provider-specific raw payload preserved for debugging. */
  raw?: unknown;
  usage: ResearchUsage;
}

export interface IResearchProvider {
  readonly id: string;
  /**
   * Answer a question by searching the web and grounding an LLM
   * response in the results.
   */
  research(
    ctx: Pick<WorkspaceContext, 'workspaceId'>,
    question: string,
    options?: ResearchOptions,
  ): Promise<ResearchOutcome>;
  testConnection(): Promise<{ ok: boolean; detail?: string }>;
  /** Cheap upfront cost estimate in cents — used to gate / display before run. */
  estimateUsageCost(question: string, options?: ResearchOptions): number;
}

// ---- Mock provider — deterministic, zero cost --------------------------

export class MockResearchProvider implements IResearchProvider {
  public readonly id = 'mock';

  async research(
    ctx: Pick<WorkspaceContext, 'workspaceId'>,
    question: string,
    options: ResearchOptions = {},
  ): Promise<ResearchOutcome> {
    void ctx;
    const seed = createHash('sha256').update(question).digest('hex');
    const tag = seed.slice(0, 8);
    const fakeDomain = `example-${tag}.test`;
    const citationsCount = Math.min(options.maxCitations ?? 3, 8);
    const citations: ResearchCitation[] = Array.from({ length: citationsCount }).map(
      (_, i) => ({
        rank: i + 1,
        url: `https://${fakeDomain}/article-${i + 1}`,
        domain: fakeDomain,
        title: `Mock result ${i + 1} for "${question.slice(0, 60)}"`,
        snippet: `Deterministic stub snippet ${i + 1} (seed=${tag}).`,
      }),
    );
    return {
      answer: `mock-research(${tag}): ${question.slice(0, 200)}`,
      citations,
      queriesIssued: [question],
      providerId: this.id,
      usage: {
        inputTokens: estimateTokens(question),
        outputTokens: estimateTokens(question) + 8,
        searchQueries: 1,
        costEstimateCents: 0,
        keySource: 'mock',
      },
    };
  }

  async testConnection() {
    return { ok: true };
  }

  estimateUsageCost(): number {
    return 0;
  }
}

// ---- Factory + BYOK ----------------------------------------------------

let cached: IResearchProvider | null = null;

export function getResearchProvider(): IResearchProvider {
  if (cached) return cached;
  const id = process.env.RESEARCH_PROVIDER ?? 'mock';
  switch (id) {
    case 'mock':
      cached = new MockResearchProvider();
      return cached;
    case 'gemini':
      cached = GeminiResearchProvider.fromEnv();
      return cached;
    case 'perplexity':
      cached = PerplexityResearchProvider.fromEnv();
      return cached;
    default:
      throw new Error(
        `Unknown RESEARCH_PROVIDER: ${id}. Supported: "mock" | "gemini" | "perplexity".`,
      );
  }
}

/**
 * Workspace-aware factory.
 *
 * Phase 45 cascade for the active provider id:
 *   1. workspace_provider_settings.research_provider (when set)
 *   2. process.env.RESEARCH_PROVIDER
 *   3. 'mock'
 *
 * Phase 44 cascade for the API key:
 *   1. workspace BYOK (`gemini.apiKey` / `perplexity.apiKey`)
 *   2. platform env (GEMINI_API_KEY / PERPLEXITY_API_KEY)
 *   3. throw — required when id is real
 */
export async function getResearchProviderForCtx(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<IResearchProvider> {
  // Test injection wins — `_setResearchProviderForTests(stub)`.
  if (cached) return cached;
  const { resolveActiveProvider } = await import('@/lib/services/provider-settings');
  const active = await resolveActiveProvider(ctx, 'research', process.env.RESEARCH_PROVIDER);
  const id = active.id;
  if (id === 'mock') return new MockResearchProvider();
  const { resolveProviderKey } = await import('@/lib/services/secrets');
  if (id === 'gemini') {
    const resolved = await resolveProviderKey(ctx, 'gemini.apiKey', 'GEMINI_API_KEY');
    if (!resolved) {
      throw new Error(
        'Research provider=gemini but no key configured (workspace or platform).',
      );
    }
    return new GeminiResearchProvider({
      apiKey: resolved.key,
      model: process.env.RESEARCH_MODEL,
    });
  }
  if (id === 'perplexity') {
    const resolved = await resolveProviderKey(
      ctx,
      'perplexity.apiKey',
      'PERPLEXITY_API_KEY',
    );
    if (!resolved) {
      throw new Error(
        'Research provider=perplexity but no key configured (workspace or platform).',
      );
    }
    return new PerplexityResearchProvider({
      apiKey: resolved.key,
      model: process.env.RESEARCH_MODEL,
    });
  }
  throw new Error(`Unknown research provider id from cascade: ${id}`);
}

/** For tests — inject a stub provider and reset between cases. */
export function _setResearchProviderForTests(
  provider: IResearchProvider | null,
): void {
  cached = provider;
}

// ---- shared helpers used by real providers ----------------------------

export function dedupeAndRankCitations(
  raw: ResearchCitation[],
  cap = 8,
): ResearchCitation[] {
  const seen = new Map<string, ResearchCitation>();
  for (const c of raw) {
    const key = c.url.toLowerCase();
    if (!seen.has(key)) seen.set(key, c);
  }
  const out = Array.from(seen.values()).slice(0, cap);
  return out.map((c, i) => ({ ...c, rank: i + 1 }));
}

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
