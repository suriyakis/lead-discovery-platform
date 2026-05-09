// AI provider abstraction.
//
// Selection happens at boot via the `AI_PROVIDER` env var. Three providers
// ship: `mock` (deterministic, free, dev-only), `openai` (gpt-4o-mini /
// gpt-4o family), `anthropic` (claude-haiku-4-5 / claude-sonnet-4 family).
// All three implement IAIProvider so call sites stay provider-agnostic.
//
// Tests inject the mock directly. Production code calls
// `getAIProvider()` for the env-defaulted singleton, or
// `getAIProviderForCtx(ctx)` to honor a workspace-supplied BYOK key.

import { createHash } from 'node:crypto';
import type { ZodSchema } from 'zod';

export interface AIGenInput {
  /** System prompt + messages, OpenAI-style. */
  system?: string;
  prompt: string;
}

export interface AIGenOptions {
  temperature?: number;
  maxTokens?: number;
  /** Override the provider's default model for this single call. Useful
   *  when a specific feature needs a stronger model than the workspace
   *  default — e.g. autofill needs Sonnet/gpt-4o, not Haiku/mini, to
   *  populate dense JSON schemas reliably. */
  model?: string;
  /** Caller-supplied deterministic seed. Honored by the mock; ignored by real providers. */
  mockSeed?: string;
}

export interface AIGenResult {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface AIUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface IAIProvider {
  readonly id: string;
  /** The workspace-default model name. Callers can read this to decide
   *  whether to override per-call (e.g. autofill upgrades small models
   *  to dense-output models). */
  readonly model: string;
  generateText(input: AIGenInput, options?: AIGenOptions): Promise<AIGenResult>;
  generateJson<T>(input: AIGenInput, schema: ZodSchema<T>, options?: AIGenOptions): Promise<T>;
  estimateCost(usage: AIUsage): number;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

// ---- mock implementation ------------------------------------------------

export class MockAIProvider implements IAIProvider {
  public readonly id = 'mock';
  public readonly model = 'mock-1';

  async generateText(input: AIGenInput, options: AIGenOptions = {}): Promise<AIGenResult> {
    const seed = options.mockSeed ?? `${input.system ?? ''}\n${input.prompt}`;
    const digest = createHash('sha256').update(seed).digest('hex');
    const text = `mock(${digest.slice(0, 8)}): ${input.prompt.slice(0, 80)}`;
    return {
      text,
      model: 'mock-1',
      usage: {
        inputTokens: estimateTokens(input.prompt) + estimateTokens(input.system ?? ''),
        outputTokens: estimateTokens(text),
      },
    };
  }

  async generateJson<T>(
    input: AIGenInput,
    schema: ZodSchema<T>,
    options: AIGenOptions = {},
  ): Promise<T> {
    const seed = options.mockSeed ?? input.prompt;
    let candidate: unknown;
    try {
      candidate = JSON.parse(seed);
    } catch {
      candidate = {};
    }
    const result = schema.safeParse(candidate);
    if (result.success) return result.data;
    return schema.parse({});
  }

  estimateCost(usage: AIUsage): number {
    void usage;
    return 0;
  }

  async healthCheck() {
    return { ok: true, detail: 'mock provider is always healthy' };
  }
}

// ---- OpenAI implementation --------------------------------------------

export interface OpenAIAIConfig {
  apiKey: string;
  /** Model id, default 'gpt-4o-mini'. */
  model?: string;
  /** Override base URL — useful for proxies / Azure-OpenAI. */
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * OpenAI Chat Completions adapter. Uses gpt-4o-mini by default for cost;
 * caller can override. generateJson uses the API's JSON mode
 * (response_format=json_object) and validates the response with Zod.
 */
export class OpenAIAIProvider implements IAIProvider {
  public readonly id = 'openai';
  public readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: OpenAIAIConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'gpt-4o-mini';
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com';
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  static fromEnv(): OpenAIAIProvider {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('AI_PROVIDER=openai requires OPENAI_API_KEY.');
    }
    return new OpenAIAIProvider({
      apiKey,
      model: process.env.AI_MODEL,
      baseUrl: process.env.OPENAI_BASE_URL,
    });
  }

  async generateText(input: AIGenInput, options: AIGenOptions = {}): Promise<AIGenResult> {
    const json = await this.callChat(input, options, false);
    const text = json.choices?.[0]?.message?.content ?? '';
    return {
      text,
      model: json.model ?? this.model,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      },
    };
  }

  async generateJson<T>(
    input: AIGenInput,
    schema: ZodSchema<T>,
    options: AIGenOptions = {},
  ): Promise<T> {
    // OpenAI's JSON mode requires the literal token "json" in the
    // system or user prompt. Inject one defensively.
    const promptHasJson = /\bjson\b/i.test(input.prompt) || /\bjson\b/i.test(input.system ?? '');
    const augmented = promptHasJson
      ? input
      : { ...input, prompt: `${input.prompt}\n\nReturn the response as JSON.` };
    const json = await this.callChat(augmented, options, true);
    const raw = json.choices?.[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw);
    return schema.parse(parsed);
  }

  estimateCost(usage: AIUsage): number {
    // gpt-4o-mini (Dec 2025): $0.15 / 1M input, $0.60 / 1M output.
    // gpt-4o:                   $2.50 / 1M input, $10.00 / 1M output.
    const isMini = usage.model.startsWith('gpt-4o-mini');
    const inputRate = isMini ? 0.00015 : 0.0025;
    const outputRate = isMini ? 0.0006 : 0.01;
    return (usage.inputTokens / 1000) * inputRate + (usage.outputTokens / 1000) * outputRate;
  }

  async healthCheck() {
    try {
      const result = await this.generateText(
        { prompt: 'ping' },
        { maxTokens: 1, temperature: 0 },
      );
      void result;
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private async callChat(
    input: AIGenInput,
    options: AIGenOptions,
    asJson: boolean,
  ): Promise<{
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (input.system) messages.push({ role: 'system', content: input.system });
    messages.push({ role: 'user', content: input.prompt });

    const body: Record<string, unknown> = {
      model: options.model ?? this.model,
      messages,
      temperature: options.temperature ?? 0.4,
    };
    if (options.maxTokens) body.max_tokens = options.maxTokens;
    if (asJson) body.response_format = { type: 'json_object' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`openai chat ${res.status}: ${detail.slice(0, 400)}`);
    }
    return res.json();
  }
}

// ---- Anthropic implementation -----------------------------------------

export interface AnthropicAIConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * Anthropic Messages API adapter. Defaults to claude-haiku-4-5 (fast +
 * cheap). generateJson asks the model to return JSON and validates with
 * Zod — Anthropic doesn't expose a strict JSON-mode boolean but in
 * practice Haiku/Sonnet 4 reliably returns valid JSON when instructed.
 */
export class AnthropicAIProvider implements IAIProvider {
  public readonly id = 'anthropic';
  public readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: AnthropicAIConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'claude-haiku-4-5';
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  static fromEnv(): AnthropicAIProvider {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY.');
    }
    return new AnthropicAIProvider({
      apiKey,
      model: process.env.AI_MODEL,
      baseUrl: process.env.ANTHROPIC_BASE_URL,
    });
  }

  async generateText(input: AIGenInput, options: AIGenOptions = {}): Promise<AIGenResult> {
    const json = await this.callMessages(input, options);
    // content is an array of blocks; concatenate the text-typed ones.
    const text = (json.content ?? [])
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return {
      text,
      model: json.model ?? this.model,
      usage: {
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
      },
    };
  }

  async generateJson<T>(
    input: AIGenInput,
    schema: ZodSchema<T>,
    options: AIGenOptions = {},
  ): Promise<T> {
    const augmented: AIGenInput = {
      system: `${input.system ?? ''}\nRespond with a single JSON object only — no prose, no code fence.`.trim(),
      prompt: input.prompt,
    };
    const result = await this.generateText(augmented, options);
    // Strip a fenced ```json ... ``` if the model still wrapped it.
    const raw = result.text.replace(/^```(?:json)?\s*|\s*```\s*$/g, '').trim();
    const parsed = JSON.parse(raw);
    return schema.parse(parsed);
  }

  estimateCost(usage: AIUsage): number {
    // Claude Haiku 4.5 (Dec 2025): $1.00 / 1M input, $5.00 / 1M output.
    // Claude Sonnet 4:              $3.00 / 1M input, $15.00 / 1M output.
    const isHaiku = usage.model.toLowerCase().includes('haiku');
    const inputRate = isHaiku ? 0.001 : 0.003;
    const outputRate = isHaiku ? 0.005 : 0.015;
    return (usage.inputTokens / 1000) * inputRate + (usage.outputTokens / 1000) * outputRate;
  }

  async healthCheck() {
    try {
      const result = await this.generateText(
        { prompt: 'ping' },
        { maxTokens: 1, temperature: 0 },
      );
      void result;
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private async callMessages(
    input: AIGenInput,
    options: AIGenOptions,
  ): Promise<{
    model?: string;
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  }> {
    const body: Record<string, unknown> = {
      model: options.model ?? this.model,
      messages: [{ role: 'user', content: input.prompt }],
      // Anthropic's Messages API requires max_tokens. 4096 is a safer
      // default than 1024 — most callers (drafts, translations,
      // autofill) want longer-than-1024 output and silent truncation
      // produces cryptic JSON-parse failures downstream.
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.4,
    };
    if (input.system) body.system = input.system;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`anthropic messages ${res.status}: ${detail.slice(0, 400)}`);
    }
    return res.json();
  }
}

// ---- factory -----------------------------------------------------------

let cached: IAIProvider | null = null;

export function getAIProvider(): IAIProvider {
  if (cached) return cached;
  const id = process.env.AI_PROVIDER ?? 'mock';
  switch (id) {
    case 'mock':
      cached = new MockAIProvider();
      return cached;
    case 'openai':
      cached = OpenAIAIProvider.fromEnv();
      return cached;
    case 'anthropic':
      cached = AnthropicAIProvider.fromEnv();
      return cached;
    default:
      throw new Error(
        `Unknown AI_PROVIDER: ${id}. Supported: "mock" | "openai" | "anthropic".`,
      );
  }
}

/**
 * Workspace-aware factory.
 *
 * Phase 45 cascade for the active provider id:
 *   1. workspace_provider_settings.ai_provider (when set)
 *   2. process.env.AI_PROVIDER
 *   3. 'mock'
 *
 * Phase 32/33 cascade for the API key (after the id is resolved):
 *   1. workspace BYOK secret (`openai.apiKey` / `anthropic.apiKey`)
 *   2. platform env (OPENAI_API_KEY / ANTHROPIC_API_KEY)
 *   3. throw — required when id is real
 *
 * Mock id short-circuits both: returns the env-cached mock singleton.
 */
export async function getAIProviderForCtx(
  ctx: { workspaceId: bigint },
): Promise<IAIProvider> {
  // Test injection wins — `_setAIProviderForTests(stub)` writes `cached`,
  // and tests rely on getAIProviderForCtx returning the same stub.
  if (cached) return cached;
  const { resolveActiveProvider } = await import('@/lib/services/provider-settings');
  const active = await resolveActiveProvider(ctx, 'ai', process.env.AI_PROVIDER);
  const id = active.id;
  if (id === 'mock') return new MockAIProvider();
  const { resolveProviderKey } = await import('@/lib/services/secrets');
  if (id === 'openai') {
    const resolved = await resolveProviderKey(ctx, 'openai.apiKey', 'OPENAI_API_KEY');
    if (!resolved) {
      throw new Error(
        'AI provider=openai but no key configured (workspace or platform).',
      );
    }
    return new OpenAIAIProvider({
      apiKey: resolved.key,
      model: process.env.AI_MODEL,
      baseUrl: process.env.OPENAI_BASE_URL,
    });
  }
  if (id === 'anthropic') {
    const resolved = await resolveProviderKey(
      ctx,
      'anthropic.apiKey',
      'ANTHROPIC_API_KEY',
    );
    if (!resolved) {
      throw new Error(
        'AI provider=anthropic but no key configured (workspace or platform).',
      );
    }
    return new AnthropicAIProvider({
      apiKey: resolved.key,
      model: process.env.AI_MODEL,
      baseUrl: process.env.ANTHROPIC_BASE_URL,
    });
  }
  throw new Error(`Unknown AI provider id from cascade: ${id}`);
}

/** For tests — inject a stub provider and reset between cases. */
export function _setAIProviderForTests(provider: IAIProvider | null): void {
  cached = provider;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
