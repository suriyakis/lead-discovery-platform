// Phase 62-09: Gemini AI provider for Wandizz-style qualification.
// Uses the same v1beta `generateContent` endpoint as the research
// provider but WITHOUT the google_search grounding tool — this one is
// a plain JSON / text generator, not a researcher.
//
// Default model: gemini-2.5-flash (currently the cheapest tool-capable
// Flash that supports JSON-mode + response_schema). gemini-2.5-pro
// available via constructor / workspace setting override.

import { z, type ZodSchema } from 'zod';
import type {
  AIGenInput,
  AIGenOptions,
  AIGenResult,
  AIUsage,
  IAIProvider,
} from './index';

interface GeminiResponseShape {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  promptFeedback?: {
    blockReason?: string;
    safetyRatings?: unknown;
  };
  error?: { message?: string; code?: number };
}

export interface GeminiAIConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TIMEOUT_MS = 60_000;

/** Gemini 3.x (and newer) are optimized for default sampling — Google
 *  recommends not setting temperature/top_p/top_k. Returns true for major
 *  version >= 3 (e.g. gemini-3.0-flash, gemini-3.5-flash), false for 2.x. */
function prefersDefaultSampling(model: string): boolean {
  const m = /gemini-(\d+)/i.exec(model);
  return m ? Number(m[1]) >= 3 : false;
}

/** Gemini 2.5+ models "think" before answering, and the thought tokens
 *  count against maxOutputTokens. A tight caller budget (600 tokens for a
 *  JSON verdict) gets consumed by thinking and the visible JSON arrives
 *  truncated mid-string — every parse fails. */
function isThinkingModel(model: string): boolean {
  const m = /gemini-(\d+)\.(\d+)/i.exec(model);
  if (!m) return false;
  return Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 5);
}

/** 2.5 flash variants accept thinkingBudget: 0 (thinking fully off);
 *  2.5 pro rejects 0 (minimum 128), so it only gets the headroom. */
function canDisableThinking(model: string): boolean {
  return /gemini-2\.5[\w-]*flash/i.test(model);
}

/** Extra output allowance so thoughts can't starve the answer on thinking
 *  models where thinking can't be turned off. */
const THINKING_HEADROOM_TOKENS = 2048;

export class GeminiAIProvider implements IAIProvider {
  public readonly id = 'gemini';
  public readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;

  constructor(config: GeminiAIConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODEL;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE;
    this.defaultTimeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  static fromEnv(): GeminiAIProvider {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('AI_PROVIDER=gemini requires GEMINI_API_KEY.');
    }
    return new GeminiAIProvider({
      apiKey,
      model: process.env.AI_MODEL,
      baseUrl: process.env.GEMINI_BASE_URL,
    });
  }

  async generateText(
    input: AIGenInput,
    options: AIGenOptions = {},
  ): Promise<AIGenResult> {
    const model = options.model ?? this.model;
    const json = await this.callGenerate(input, options, model, false);
    const text = (json.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('');
    if (!text) {
      const block = json.promptFeedback?.blockReason;
      if (block) {
        throw new Error(`gemini blocked: ${block}`);
      }
      throw new Error('gemini returned empty text');
    }
    return {
      text,
      model,
      usage: {
        inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }

  async generateJson<T>(
    input: AIGenInput,
    schema: ZodSchema<T>,
    options: AIGenOptions = {},
  ): Promise<T> {
    const model = options.model ?? this.model;
    // Gemini supports `responseMimeType: application/json` to force the
    // model into JSON-only output. We then validate with zod.
    const json = await this.callGenerate(input, options, model, true);
    const text = (json.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (!text) {
      const block = json.promptFeedback?.blockReason;
      throw new Error(
        `gemini json: empty response${block ? ` (blocked: ${block})` : ''}`,
      );
    }
    // The model occasionally wraps JSON in ```json fences — strip them.
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      throw new Error(
        `gemini json: invalid JSON output: ${err instanceof Error ? err.message : String(err)} — head=${cleaned.slice(0, 200)}`,
      );
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new z.ZodError(result.error.issues);
    }
    return result.data;
  }

  estimateCost(usage: AIUsage): number {
    // Pricing from Google docs, early 2026:
    //   gemini-2.5-flash: $0.30 / 1M input,  $2.50 / 1M output
    //   gemini-2.5-pro:   $1.25 / 1M input, $10.00 / 1M output
    //   gemini-2.0-flash: $0.10 / 1M input,  $0.40 / 1M output
    const m = usage.model.toLowerCase();
    const rates = m.includes('pro')
      ? { input: 0.000125, output: 0.001 }
      : m.includes('2.0')
        ? { input: 0.00001, output: 0.00004 }
        : { input: 0.00003, output: 0.00025 };
    return usage.inputTokens * rates.input + usage.outputTokens * rates.output;
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.generateText(
        { prompt: 'ping' },
        { maxTokens: 4, temperature: 0 },
      );
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async callGenerate(
    input: AIGenInput,
    options: AIGenOptions,
    model: string,
    jsonMode: boolean,
  ): Promise<GeminiResponseShape> {
    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
      generationConfig: {
        // Gemini 3.x is optimized for default sampling — Google recommends
        // not setting temperature/top_p/top_k. Pre-3.x keeps the explicit
        // low temperature for deterministic JSON/classification output.
        ...(prefersDefaultSampling(model)
          ? {}
          : { temperature: options.temperature ?? 0.2 }),
        // Thinking models spend output tokens on internal reasoning first;
        // pad the caller's budget so the visible answer can't be starved,
        // and in JSON mode turn thinking off entirely where the model
        // allows it — structured verdicts need output, not deliberation.
        maxOutputTokens:
          (options.maxTokens ?? 1024) +
          (isThinkingModel(model) ? THINKING_HEADROOM_TOKENS : 0),
        ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
        ...(jsonMode && canDisableThinking(model)
          ? { thinkingConfig: { thinkingBudget: 0 } }
          : {}),
      },
    };
    if (input.system) {
      body.systemInstruction = {
        role: 'system',
        parts: [{ text: input.system }],
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.defaultTimeoutMs,
    );
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
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
      throw new Error(
        `gemini ${res.status}: ${detail.slice(0, 600)}`,
      );
    }
    return (await res.json()) as GeminiResponseShape;
  }
}
