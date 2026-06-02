// Gemini grounded-search implementation of IResearchProvider.
//
// Endpoint: POST https://generativelanguage.googleapis.com/v1beta/models/
//   {model}:generateContent?key={apiKey}
//
// Tool: `google_search` (2.x series). On a successful call the response
// surfaces `candidates[0].groundingMetadata.{groundingChunks,
// webSearchQueries, groundingSupports}` which we map into ResearchCitations
// + queriesIssued.
//
// Default model: gemini-2.0-flash. Caller can override via constructor
// or RESEARCH_MODEL env var. Token usage exposed via `usageMetadata`.

import {
  dedupeAndRankCitations,
  extractDomain,
  type IResearchProvider,
  type ResearchCitation,
  type ResearchOptions,
  type ResearchOutcome,
} from './index';
import type { WorkspaceContext } from '@/lib/services/context';

export interface GeminiResearchConfig {
  apiKey: string;
  /** Model id, default 'gemini-2.0-flash'. */
  model?: string;
  /** Override base URL — useful for proxies. */
  baseUrl?: string;
  timeoutMs?: number;
}

interface GeminiResponseShape {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: {
      groundingChunks?: Array<{
        web?: { uri?: string; title?: string };
      }>;
      webSearchQueries?: string[];
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

export class GeminiResearchProvider implements IResearchProvider {
  public readonly id = 'gemini';
  public readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;

  constructor(config: GeminiResearchConfig) {
    this.apiKey = config.apiKey;
    // gemini-2.5-flash is the current Flash generation that supports
    // the google_search grounding tool. gemini-2.0-flash was retired
    // for new users early 2026.
    this.model = config.model ?? 'gemini-2.5-flash';
    this.baseUrl =
      config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    this.defaultTimeoutMs = config.timeoutMs ?? 60_000;
  }

  static fromEnv(): GeminiResearchProvider {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('RESEARCH_PROVIDER=gemini requires GEMINI_API_KEY.');
    }
    return new GeminiResearchProvider({
      apiKey,
      model: process.env.RESEARCH_MODEL,
      baseUrl: process.env.GEMINI_BASE_URL,
    });
  }

  async research(
    ctx: Pick<WorkspaceContext, 'workspaceId'>,
    question: string,
    options: ResearchOptions = {},
  ): Promise<ResearchOutcome> {
    void ctx;
    const json = await this.callGenerate(question, options);
    const cand = json.candidates?.[0];
    const answer = (cand?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('');
    const meta = cand?.groundingMetadata ?? {};
    const queriesIssued = meta.webSearchQueries ?? [];

    const rawCitations: ResearchCitation[] = (meta.groundingChunks ?? [])
      .map((c, i): ResearchCitation | null => {
        const url = c.web?.uri;
        if (!url) return null;
        return {
          rank: i + 1,
          url,
          domain: extractDomain(url),
          title: c.web?.title ?? extractDomain(url),
        };
      })
      .filter((c): c is ResearchCitation => c !== null);
    const citations = dedupeAndRankCitations(rawCitations, options.maxCitations ?? 8);

    const inputTokens = json.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = json.usageMetadata?.candidatesTokenCount ?? 0;
    const searchQueries = Math.max(1, queriesIssued.length);

    return {
      answer,
      citations,
      queriesIssued,
      providerId: this.id,
      raw: json,
      usage: {
        inputTokens,
        outputTokens,
        searchQueries,
        costEstimateCents: this.computeCost(
          inputTokens,
          outputTokens,
          searchQueries,
        ),
        keySource: this.apiKey === process.env.GEMINI_API_KEY ? 'platform' : 'workspace',
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
    // Rough: 250 input tokens ambient + 4 chars per token for the question
    // + 800 output tokens of grounded answer. Plus 1 grounded query.
    const inputTokens = 250 + Math.ceil(question.length / 4);
    const outputTokens = 800;
    return Math.round(this.computeCost(inputTokens, outputTokens, 1));
  }

  /** Pricing as of early 2026 (cents per token / per query).
   *  gemini-2.5-flash: $0.30 / 1M input, $2.50 / 1M output.
   *  gemini-2.5-pro:   $1.25 / 1M input, $10.00 / 1M output.
   *  Grounding via google_search: $35 per 1k grounded queries. */
  private computeCost(
    inputTokens: number,
    outputTokens: number,
    searchQueries: number,
  ): number {
    const isPro = this.model.includes('pro');
    const inputRate = isPro ? 0.000125 : 0.00003; // cents per token
    const outputRate = isPro ? 0.001 : 0.00025;
    const searchRate = 3.5; // cents per grounded query
    return (
      inputTokens * inputRate +
      outputTokens * outputRate +
      searchQueries * searchRate
    );
  }

  private async callGenerate(
    question: string,
    options: ResearchOptions,
  ): Promise<GeminiResponseShape> {
    const systemPrompt = buildSystemPrompt(options);
    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ text: question }],
        },
      ],
      systemInstruction: systemPrompt
        ? { role: 'system', parts: [{ text: systemPrompt }] }
        : undefined,
      tools: [{ google_search: {} }],
      generationConfig: {
        // Gemini 3.x reasoning is tuned for the default sampling params;
        // Google recommends NOT overriding temperature/top_p/top_k for 3.x.
        // Older Flash/Pro generations keep the explicit low temperature.
        ...(prefersDefaultSampling(this.model) ? {} : { temperature: 0.2 }),
        maxOutputTokens: 1024,
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? this.defaultTimeoutMs,
    );
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/models/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`gemini grounding ${res.status}: ${detail.slice(0, 600)}`);
    }
    return (await res.json()) as GeminiResponseShape;
  }
}

/** Gemini 3.x (and newer) are optimized for default sampling — Google
 *  recommends not setting temperature/top_p/top_k. Returns true for major
 *  version >= 3 (e.g. gemini-3.0-flash, gemini-3.5-flash), false for 2.x. */
function prefersDefaultSampling(model: string): boolean {
  const m = /gemini-(\d+)/i.exec(model);
  return m ? Number(m[1]) >= 3 : false;
}

function buildSystemPrompt(options: ResearchOptions): string {
  const lines: string[] = [
    'You are a B2B research assistant. Answer the user question using fresh web information.',
    'Cite every factual claim. Keep answers concise (3–6 sentences) unless the question asks for depth.',
    'Prefer primary sources (company website, regulatory filings, named publications) over content farms.',
    'If the available evidence is contradictory or insufficient, say so explicitly.',
  ];
  if (options.language) {
    lines.push(`Respond in ${options.language}.`);
  }
  if (options.country) {
    // The google_search grounding tool has no API-level geo restriction, so
    // this prompt directive is the only lever. Keep it strong — a soft "bias
    // toward" still returned mostly out-of-country companies. This reduces
    // (but cannot fully enforce) leakage; the AI qualifier is the real gate.
    lines.push(
      `IMPORTANT: Only return companies physically located in ${options.country}. ` +
        `Exclude companies from other countries even if they appear in search results.`,
    );
  }
  if (options.freshness && options.freshness !== 'any') {
    lines.push(`Prefer information from the past ${options.freshness}.`);
  }
  if (options.systemPrompt) {
    lines.push(options.systemPrompt);
  }
  return lines.join('\n');
}
