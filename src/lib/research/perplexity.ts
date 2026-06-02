// Perplexity Sonar implementation of IResearchProvider.
//
// Endpoint: POST https://api.perplexity.ai/chat/completions  (OpenAI-shape)
// Default model: 'sonar' (cheap, fast). 'sonar-pro' returns richer
// citations (title + url + snippet) and is recommended when available.
//
// The response shape is OpenAI-compatible chat completions PLUS:
//   citations: string[]                       — URLs grounded in
//   search_results: Array<{                    — Pro tier only
//     title?: string;
//     url: string;
//     snippet?: string;
//   }>;

import {
  dedupeAndRankCitations,
  extractDomain,
  type IResearchProvider,
  type ResearchCitation,
  type ResearchOptions,
  type ResearchOutcome,
} from './index';
import type { WorkspaceContext } from '@/lib/services/context';

export interface PerplexityResearchConfig {
  apiKey: string;
  /** Model id, default 'sonar'. */
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

interface PerplexityResponseShape {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  citations?: string[];
  search_results?: Array<{
    title?: string;
    url?: string;
    snippet?: string;
    content?: string;
  }>;
}

export class PerplexityResearchProvider implements IResearchProvider {
  public readonly id = 'perplexity';
  public readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;

  constructor(config: PerplexityResearchConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'sonar';
    this.baseUrl = config.baseUrl ?? 'https://api.perplexity.ai';
    this.defaultTimeoutMs = config.timeoutMs ?? 60_000;
  }

  static fromEnv(): PerplexityResearchProvider {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) {
      throw new Error(
        'RESEARCH_PROVIDER=perplexity requires PERPLEXITY_API_KEY.',
      );
    }
    return new PerplexityResearchProvider({
      apiKey,
      model: process.env.RESEARCH_MODEL,
      baseUrl: process.env.PERPLEXITY_BASE_URL,
    });
  }

  async research(
    ctx: Pick<WorkspaceContext, 'workspaceId'>,
    question: string,
    options: ResearchOptions = {},
  ): Promise<ResearchOutcome> {
    void ctx;
    const json = await this.callChat(question, options);
    const answer = json.choices?.[0]?.message?.content ?? '';

    // Prefer the Pro-tier `search_results` (with title + snippet); fall
    // back to bare `citations` (URL-only) on the base tier.
    const richResults = json.search_results ?? [];
    const bareCitations = json.citations ?? [];

    const rawCitations: ResearchCitation[] =
      richResults.length > 0
        ? richResults
            .filter((r): r is { url: string } & typeof r => Boolean(r.url))
            .map((r, i) => ({
              rank: i + 1,
              url: r.url,
              domain: extractDomain(r.url),
              title: r.title ?? extractDomain(r.url),
              snippet: r.snippet,
              excerpt: r.content,
            }))
        : bareCitations.map((url, i) => ({
            rank: i + 1,
            url,
            domain: extractDomain(url),
            title: extractDomain(url),
          }));
    const citations = dedupeAndRankCitations(rawCitations, options.maxCitations ?? 8);

    const inputTokens = json.usage?.prompt_tokens ?? 0;
    const outputTokens = json.usage?.completion_tokens ?? 0;
    const searchQueries = 1; // Perplexity hides the search-fan-out count

    return {
      answer,
      citations,
      queriesIssued: [question],
      providerId: this.id,
      raw: json,
      usage: {
        inputTokens,
        outputTokens,
        searchQueries,
        costEstimateCents: this.computeCost(inputTokens, outputTokens),
        keySource:
          this.apiKey === process.env.PERPLEXITY_API_KEY ? 'platform' : 'workspace',
      },
    };
  }

  async testConnection() {
    try {
      await this.research({ workspaceId: BigInt(0) }, 'ping', { maxCitations: 1 });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  estimateUsageCost(question: string): number {
    const inputTokens = 200 + Math.ceil(question.length / 4);
    const outputTokens = 600;
    return Math.round(this.computeCost(inputTokens, outputTokens));
  }

  /** Pricing as of late 2025 (cents per call). sonar (base): $1 / 1M
   *  input + $1 / 1M output + $5 / 1k requests. sonar-pro: $3 / 1M
   *  input + $15 / 1M output + $5 / 1k requests + $5 / 1k citation. */
  private computeCost(inputTokens: number, outputTokens: number): number {
    const isPro = this.model.includes('pro');
    const inputRate = isPro ? 0.0003 : 0.0001; // cents per token
    const outputRate = isPro ? 0.0015 : 0.0001;
    const perRequestCents = 0.5; // $0.005 per request rolled in
    return inputTokens * inputRate + outputTokens * outputRate + perRequestCents;
  }

  private async callChat(
    question: string,
    options: ResearchOptions,
  ): Promise<PerplexityResponseShape> {
    const messages = [
      { role: 'system' as const, content: buildSystemPrompt(options) },
      { role: 'user' as const, content: question },
    ];
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: 0.2,
      return_citations: true,
    };
    if (options.freshness && options.freshness !== 'any') {
      body.search_recency_filter = options.freshness; // 'day' | 'week' | 'month' | 'year'
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? this.defaultTimeoutMs,
    );
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`perplexity sonar ${res.status}: ${detail.slice(0, 600)}`);
    }
    return (await res.json()) as PerplexityResponseShape;
  }
}

function buildSystemPrompt(options: ResearchOptions): string {
  const lines: string[] = [
    'You are a B2B research assistant. Answer concisely (3–6 sentences) unless asked for depth.',
    'Cite every factual claim. Prefer primary sources over content farms.',
    'If the evidence is contradictory or insufficient, say so explicitly.',
  ];
  if (options.language) lines.push(`Respond in ${options.language}.`);
  if (options.country)
    lines.push(
      `IMPORTANT: Only return companies physically located in ${options.country}. ` +
        `Exclude companies from other countries even if they appear in search results.`,
    );
  if (options.systemPrompt) lines.push(options.systemPrompt);
  return lines.join('\n');
}
