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
import { GeminiAIProvider } from './gemini';
import { AIOutputError } from './errors';
import {
  reasoningProfile,
  withOutputFloor,
  type AIReasoningEffort,
  type ReasoningVendor,
} from './model-profiles';
import type { ZodSchema } from 'zod';

export { AIOutputError, type AIOutputFailureKind } from './errors';
export type { AIReasoningEffort } from './model-profiles';

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
  /** Opt-in bounded reasoning for a visible-answer call (AP-02). Each
   *  adapter maps it through the per-model profile (./model-profiles):
   *  the vendor's effort knob where the model takes one, plus enough
   *  output budget that hidden reasoning can't starve the answer. When
   *  absent, request bodies are exactly what they were before. */
  reasoning?: AIReasoningEffort;
  /** Metering only, never sent to a vendor: a platform-support call (a
   *  super-admin acting inside a tenant). Logged with payload.support =
   *  true and never debited to the tenant's wallet. */
  support?: boolean;
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
  /** Widened to string so OpenAI-compatible subclasses (DeepSeek) can
   *  report their own id. */
  public readonly id: string = 'openai';
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
    const choice = json.choices?.[0];
    const text = choice?.message?.content ?? '';
    const model = json.model ?? this.model;
    const usage = {
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    };
    if (!text.trim()) {
      // A blank answer used to come back as '' and surface downstream as
      // a mystery (I135). Name the two causes we can see. DeepSeek's
      // reasoning_content is deliberately ignored — content only.
      const finish = choice?.finish_reason ?? null;
      if (choice?.message?.refusal || finish === 'content_filter') {
        throw new AIOutputError(
          { kind: 'refusal', provider: this.id, model, stopReason: finish, usage },
          `${this.id} declined to answer (finish_reason=${finish ?? 'n/a'})`,
        );
      }
      if (finish === 'length') {
        throw new AIOutputError(
          { kind: 'empty', provider: this.id, model, stopReason: finish, usage },
          `${this.id} returned no visible text: the output budget ran out (finish_reason=length)`,
        );
      }
    }
    return { text, model, usage };
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
    // OpenAI pricing (July 2026), $/1M in / out:
    //   gpt-5.6-sol / gpt-5.5: $5 / $30   gpt-5.6-terra: $2.50 / $15
    //   gpt-5.6-luna: $1 / $6             *nano tiers: $0.20 / $1.25
    //   gpt-4o-mini (legacy): $0.15 / $0.60   gpt-4o (legacy): $2.50 / $10
    const m = usage.model.toLowerCase();
    const [inputRate, outputRate] = m.includes('nano')
      ? [0.0002, 0.00125]
      : m.includes('luna') || m.includes('mini')
        ? m.startsWith('gpt-4o-mini')
          ? [0.00015, 0.0006]
          : [0.001, 0.006]
        : m.includes('terra')
          ? [0.0025, 0.015]
          : m.includes('sol') || m.startsWith('gpt-5')
            ? [0.005, 0.03]
            : [0.0025, 0.01];
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
      // A 1-token budget on a reasoning model legitimately comes back
      // empty — the key and model still answered, which is all this checks.
      if (err instanceof AIOutputError) return { ok: true };
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Which column of the per-model profile table this adapter reads.
   *  OpenAI-compatible subclasses (DeepSeek) override it. */
  protected reasoningVendor(): ReasoningVendor {
    return 'openai';
  }

  protected async callChat(
    input: AIGenInput,
    options: AIGenOptions,
    asJson: boolean,
  ): Promise<{
    model?: string;
    choices?: Array<{
      message?: { content?: string | null; refusal?: string | null };
      finish_reason?: string | null;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (input.system) messages.push({ role: 'system', content: input.system });
    messages.push({ role: 'user', content: input.prompt });

    const model = options.model ?? this.model;
    const body: Record<string, unknown> = { model, messages };
    // AP-02: only when the caller opts into `reasoning` does the profile
    // raise the output budget / add the effort knob; otherwise `profile`
    // is null and the body below is byte-identical to before.
    const profile = options.reasoning
      ? reasoningProfile(this.reasoningVendor(), model)
      : null;
    const maxTokens = profile ? withOutputFloor(options.maxTokens, profile) : options.maxTokens;
    // gpt-5 and o-series renamed `max_tokens` → `max_completion_tokens`,
    // and BOTH reject any custom temperature (only the default 1.0 is
    // accepted, returns 400 otherwise). Older chat models still take
    // both `max_tokens` and a custom temperature.
    const isReasoning = /^o[13]/.test(model);
    const isGpt5 = model.startsWith('gpt-5');
    if (isReasoning || isGpt5) {
      // max_completion_tokens includes the hidden reasoning tokens.
      if (maxTokens) body.max_completion_tokens = maxTokens;
      // No temperature on these models — API rejects anything ≠ 1.0.
      if (profile?.effort === 'reasoning_effort') body.reasoning_effort = options.reasoning;
    } else {
      body.temperature = options.temperature ?? 0.4;
      if (maxTokens) body.max_tokens = maxTokens;
    }
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

// ---- DeepSeek implementation ------------------------------------------

export interface DeepSeekAIConfig {
  apiKey: string;
  /** 'deepseek-v4-flash' (default, very cheap) or 'deepseek-v4-pro'. */
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * DeepSeek adapter. The API is OpenAI-Chat-Completions-compatible
 * (including response_format=json_object), so this rides the OpenAI
 * implementation with its own base URL, defaults and pricing. Very
 * cost-efficient — 10-100× cheaper than frontier models.
 *
 * Model era note: the legacy ids deepseek-chat / deepseek-reasoner were
 * RETIRED 2026-07-24; the current lineup is deepseek-v4-flash and
 * deepseek-v4-pro.
 */
export class DeepSeekAIProvider extends OpenAIAIProvider {
  public override readonly id: string = 'deepseek';

  constructor(config: DeepSeekAIConfig) {
    super({
      apiKey: config.apiKey,
      model: config.model ?? 'deepseek-v4-flash',
      baseUrl: config.baseUrl ?? 'https://api.deepseek.com',
      timeoutMs: config.timeoutMs,
    });
  }

  /** v4-pro thinks inside max_tokens (reasoning_content) — the profile
   *  gives it output headroom when the caller opts into `reasoning`. */
  protected override reasoningVendor(): ReasoningVendor {
    return 'deepseek';
  }

  override estimateCost(usage: AIUsage): number {
    // DeepSeek V4 (July 2026), cache-miss rates, $/1M in / out:
    //   v4-flash: $0.14 / $0.28    v4-pro: $0.435 / $0.87
    // 'pro' also matches the retired 'reasoner' tier conservatively.
    const m = usage.model.toLowerCase();
    const isPro = m.includes('pro') || m.includes('reasoner');
    const inputRate = isPro ? 0.000435 : 0.00014;
    const outputRate = isPro ? 0.00087 : 0.00028;
    return (usage.inputTokens / 1000) * inputRate + (usage.outputTokens / 1000) * outputRate;
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
    // content is an array of blocks; concatenate the text-typed ones
    // (thinking blocks are skipped).
    const text = (json.content ?? [])
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const model = json.model ?? this.model;
    const usage = {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
    };
    // Safety classifiers can decline with HTTP 200 + stop_reason
    // 'refusal' — any partial text is not an answer.
    if (json.stop_reason === 'refusal') {
      const category = json.stop_details?.category;
      throw new AIOutputError(
        { kind: 'refusal', provider: this.id, model, stopReason: 'refusal', usage },
        `anthropic declined to answer${category ? ` (category=${category})` : ''}`,
      );
    }
    // Only thinking blocks and the cap reached: the budget went to
    // thinking and there is no visible answer.
    if (!text.trim() && json.stop_reason === 'max_tokens') {
      throw new AIOutputError(
        { kind: 'empty', provider: this.id, model, stopReason: 'max_tokens', usage },
        'anthropic returned no visible text: max_tokens was reached before the answer',
      );
    }
    return { text, model, usage };
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
    // Anthropic pricing (Sept 2026), $/1M in / out:
    //   Haiku 4.5:      $1 / $5     Sonnet 5 / 5.5: $2 / $10
    //   Sonnet 4.6/4.x: $3 / $15    Opus 5.5:       $4 / $20
    //   Opus 5 / 4.x:   $5 / $25    Fable / Mythos: $10 / $50
    // Tier by model-name substring; unknown Claude models bill at the
    // Sonnet 4.x rate (the middle tier — least-wrong default).
    const m = usage.model.toLowerCase();
    const [inputRate, outputRate] = m.includes('haiku')
      ? [0.001, 0.005]
      : /opus-5[-.]5/.test(m)
        ? [0.004, 0.02]
        : m.includes('opus')
          ? [0.005, 0.025]
          : m.includes('fable') || m.includes('mythos')
            ? [0.01, 0.05]
            : /sonnet-5/.test(m)
              ? [0.002, 0.01]
              : [0.003, 0.015];
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
      // 1 token on a thinking model is spent thinking — the key and model
      // still answered, which is all this checks.
      if (err instanceof AIOutputError) return { ok: true };
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private async callMessages(
    input: AIGenInput,
    options: AIGenOptions,
  ): Promise<{
    model?: string;
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string | null;
    stop_details?: { category?: string | null } | null;
    usage?: { input_tokens?: number; output_tokens?: number };
  }> {
    const model = String(options.model ?? this.model);
    // AP-02: null unless the caller opts into `reasoning` — then the body
    // below is byte-identical to before.
    const profile = options.reasoning ? reasoningProfile('anthropic', model) : null;
    // Anthropic's Messages API requires max_tokens. 4096 is a safer
    // default than 1024 — most callers (drafts, translations,
    // autofill) want longer-than-1024 output and silent truncation
    // produces cryptic JSON-parse failures downstream.
    const requested = options.maxTokens ?? 4096;
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: 'user', content: input.prompt }],
      max_tokens: profile ? (withOutputFloor(requested, profile) ?? requested) : requested,
    };
    // Sampling params were REMOVED on Opus 4.7+ / Opus 5 / Sonnet 5 /
    // Fable — sending temperature there returns a 400. Only include it
    // for the older models that still accept it.
    if (!/(opus-5|opus-4-7|opus-4-8|sonnet-5|fable|mythos)/.test(model)) {
      body.temperature = options.temperature ?? 0.4;
    }
    // Effort is GA (no beta header) on 4.6+ models; Haiku 4.5 and older
    // models return a 400 for it. `thinking` is never sent: Sonnet 5.5 /
    // Opus 5.5 reject {type: 'disabled'}. With it omitted the 5-family and
    // Fable/Mythos think adaptively (the profile gives them a 4,000-token
    // floor) and Opus 4.6-4.8 / Sonnet 4.6 don't think at all (1,500).
    if (profile?.effort === 'output_config') body.output_config = { effort: options.reasoning };
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

// ---- usage metering -----------------------------------------------------

/**
 * Decorator that meters every generateText/generateJson call into
 * usage_log — which is also where prepaid-token debits happen (see
 * services/usage.ts). Wrapping at the factory means qualification,
 * drafting, translation, reply suggestions etc. are ALL metered without
 * each call site knowing about billing.
 *
 * generateJson doesn't surface token usage through the interface, so its
 * cost is approximated from prompt/output text length (chars / 4). That
 * is deliberately good enough: billing is cost-ESTIMATE based and the
 * markup absorbs estimator noise.
 *
 * Metering is best-effort — a usage-log failure never breaks the AI call
 * that already succeeded.
 *
 * AP-02 billing tags (both skip the token debit in services/usage.ts):
 *   - `support: true` when the caller marks a platform-support call
 *     (AIGenOptions.support — a super-admin asking inside a tenant);
 *   - `unbilled: 'empty_output' | 'refusal'` when the vendor answered
 *     with no usable text (blank result, or a typed AIOutputError). The
 *     row still records what the vendor billed us, for cost tracking.
 */
class MeteredAIProvider implements IAIProvider {
  constructor(
    /** Exposed for unwrapAIProvider (test seam) — treat as private. */
    public readonly inner: IAIProvider,
    private readonly workspaceId: bigint,
    private readonly kind: string,
    private readonly keySource: 'workspace' | 'platform',
  ) {}

  get id(): string {
    return this.inner.id;
  }
  get model(): string {
    return this.inner.model;
  }

  async generateText(input: AIGenInput, options?: AIGenOptions): Promise<AIGenResult> {
    let result: AIGenResult;
    try {
      result = await this.inner.generateText(input, options);
    } catch (err) {
      await this.recordOutputFailure(err, options);
      throw err;
    }
    const blank = !result.text.trim();
    await this.record(
      result.model,
      result.usage.inputTokens,
      result.usage.outputTokens,
      billingTags(options, blank ? 'empty_output' : null),
    );
    return result;
  }

  async generateJson<T>(
    input: AIGenInput,
    schema: ZodSchema<T>,
    options?: AIGenOptions,
  ): Promise<T> {
    let result: T;
    try {
      result = await this.inner.generateJson(input, schema, options);
    } catch (err) {
      await this.recordOutputFailure(err, options);
      throw err;
    }
    const inputTokens = estimateTokens(`${input.system ?? ''}\n${input.prompt}`);
    let outputTokens = 0;
    try {
      outputTokens = estimateTokens(JSON.stringify(result));
    } catch {
      outputTokens = 200; // circular/unstringifiable — charge a nominal floor
    }
    await this.record(
      options?.model ?? this.inner.model,
      inputTokens,
      outputTokens,
      billingTags(options, null),
    );
    return result;
  }

  estimateCost(usage: AIUsage): number {
    return this.inner.estimateCost(usage);
  }

  healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return this.inner.healthCheck();
  }

  /** The vendor answered but produced nothing usable: log what it cost
   *  us, never debit it. Any other error (network, 4xx/5xx) carries no
   *  usage and is not recorded, as before. */
  private async recordOutputFailure(err: unknown, options?: AIGenOptions): Promise<void> {
    if (!(err instanceof AIOutputError)) return;
    await this.record(
      err.model,
      err.usage.inputTokens,
      err.usage.outputTokens,
      billingTags(options, err.kind === 'refusal' ? 'refusal' : 'empty_output'),
    );
  }

  private async record(
    model: string,
    inputTokens: number,
    outputTokens: number,
    tags: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      const { recordUsage } = await import('@/lib/services/usage');
      const costDollars = this.inner.estimateCost({ model, inputTokens, outputTokens });
      await recordUsage(
        { workspaceId: this.workspaceId },
        {
          kind: this.kind,
          provider: this.inner.id,
          units: BigInt(inputTokens + outputTokens),
          costEstimateCents: Math.ceil(costDollars * 100),
          payload: { model, inputTokens, outputTokens, keySource: this.keySource, ...tags },
        },
      );
    } catch (err) {
      console.error(
        `[ai-metering] usage record failed (kind=${this.kind}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/** usage_log payload tags that exempt a call from the token debit (see
 *  maybeDebitForUsage). Empty for an ordinary billable call, so its
 *  payload is unchanged. */
function billingTags(
  options: AIGenOptions | undefined,
  unbilled: 'empty_output' | 'refusal' | null,
): Record<string, unknown> {
  return {
    ...(options?.support ? { support: true } : {}),
    ...(unbilled ? { unbilled } : {}),
  };
}

function metered(
  provider: IAIProvider,
  ctx: { workspaceId: bigint },
  kind: string,
  keySource: 'workspace' | 'platform',
): IAIProvider {
  return new MeteredAIProvider(provider, ctx.workspaceId, kind, keySource);
}

/** Test seam: peel the metering decorator off a provider so tests can
 *  assert on the concrete vendor adapter underneath. */
export function unwrapAIProvider(provider: IAIProvider): IAIProvider {
  return provider instanceof MeteredAIProvider ? provider.inner : provider;
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
    case 'gemini':
      cached = GeminiAIProvider.fromEnv();
      return cached;
    default:
      throw new Error(
        `Unknown AI_PROVIDER: ${id}. Supported: "mock" | "openai" | "anthropic" | "gemini".`,
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
  /** Usage-log kind for metering — lets callers keep billing itemization
   *  meaningful ('ai.qualification' vs generic 'ai.generate'). */
  usageKind: string = 'ai.generate',
): Promise<IAIProvider> {
  // Test injection wins — `_setAIProviderForTests(stub)` writes `cached`,
  // and tests rely on getAIProviderForCtx returning the same stub.
  if (cached) return cached;
  const { resolveActiveProvider } = await import('@/lib/services/provider-settings');
  const active = await resolveActiveProvider(ctx, 'ai', process.env.AI_PROVIDER);
  const id = active.id;
  if (id === 'mock') return new MockAIProvider();
  const { resolveProviderKey } = await import('@/lib/services/secrets');
  const { getProviderSettings, resolveTieredModel } = await import(
    '@/lib/services/provider-settings'
  );
  // Vendor-compatible model resolution — a saved model applies whenever
  // it belongs to the resolved vendor (see resolveTieredModel's doc
  // comment); mismatched-vendor models are skipped, never shipped to
  // the wrong API.
  const settings = await getProviderSettings(ctx);
  const wsModel = await resolveTieredModel(
    'ai',
    id,
    settings.aiModel,
    process.env.AI_MODEL,
  );
  if (id === 'openai') {
    const resolved = await resolveProviderKey(ctx, 'openai.apiKey', 'OPENAI_API_KEY');
    if (!resolved) {
      throw new Error(
        'AI provider=openai but no key configured (workspace or platform).',
      );
    }
    return metered(
      new OpenAIAIProvider({
        apiKey: resolved.key,
        model: wsModel ?? process.env.AI_MODEL,
        baseUrl: process.env.OPENAI_BASE_URL,
      }),
      ctx,
      usageKind,
      resolved.source,
    );
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
    return metered(
      new AnthropicAIProvider({
        apiKey: resolved.key,
        model: wsModel ?? process.env.AI_MODEL,
        baseUrl: process.env.ANTHROPIC_BASE_URL,
      }),
      ctx,
      usageKind,
      resolved.source,
    );
  }
  if (id === 'gemini') {
    const resolved = await resolveProviderKey(
      ctx,
      'gemini.apiKey',
      'GEMINI_API_KEY',
    );
    if (!resolved) {
      throw new Error(
        'AI provider=gemini but no key configured (workspace or platform).',
      );
    }
    return metered(
      new GeminiAIProvider({
        apiKey: resolved.key,
        model: wsModel ?? process.env.AI_MODEL,
        baseUrl: process.env.GEMINI_BASE_URL,
      }),
      ctx,
      usageKind,
      resolved.source,
    );
  }
  if (id === 'deepseek') {
    const resolved = await resolveProviderKey(
      ctx,
      'deepseek.apiKey',
      'DEEPSEEK_API_KEY',
    );
    if (!resolved) {
      throw new Error(
        'AI provider=deepseek but no key configured (workspace or platform).',
      );
    }
    return metered(
      new DeepSeekAIProvider({
        apiKey: resolved.key,
        model: wsModel,
        baseUrl: process.env.DEEPSEEK_BASE_URL,
      }),
      ctx,
      usageKind,
      resolved.source,
    );
  }
  throw new Error(`Unknown AI provider id from cascade: ${id}`);
}

/**
 * P62-11: qualification-specific provider. Qualification is its own
 * capability with a full independent cascade, deliberately separate
 * from the general `ai` capability (which drives drafting, replies,
 * and everything conversation-facing) so the two can run on different
 * vendors/models — cheap-and-fast for qualification's high-volume
 * scoring, stronger for anything a lead actually reads:
 *   1. workspace.qualificationProvider + qualificationModel
 *   2. platform 'qualification.provider' / 'qualification.model'
 *      (set from /admin/providers)
 *   3. auto-detect: first vendor with a key, cheapest-first
 *      (deepseek → gemini → openai → anthropic — see
 *      SYSTEM_DEFAULT_CANDIDATES.qualification)
 *   4. 'mock' (dev/test only — production loud-fails instead)
 *
 * Same API-key cascade as the general AI provider (workspace BYOK
 * `<vendor>.apiKey` → platform env). Returns the same IAIProvider so
 * call sites stay vendor-agnostic.
 */
export async function getQualificationProviderForCtx(
  ctx: { workspaceId: bigint },
): Promise<IAIProvider> {
  // Test injection wins (same as getAIProviderForCtx).
  if (cached) return cached;
  const { resolveActiveProvider } = await import('@/lib/services/provider-settings');
  const active = await resolveActiveProvider(ctx, 'qualification', undefined);
  const qpId = active.id;
  if (qpId === 'mock') return new MockAIProvider();
  const { resolveProviderKey } = await import('@/lib/services/secrets');
  const { getProviderSettings, resolveTieredModel } = await import(
    '@/lib/services/provider-settings'
  );
  // Same vendor-compatible resolution as getAIProviderForCtx — see
  // resolveTieredModel's doc comment. No fallback to the general `ai`
  // capability's model here: qualification is a fully independent
  // capability, and borrowing a model string from a DIFFERENT
  // capability (which may resolve to a different vendor) reproduces
  // the exact class of bug this function exists to avoid.
  const settings = await getProviderSettings(ctx);
  const qModel = await resolveTieredModel(
    'qualification',
    qpId,
    settings.qualificationModel,
    undefined,
  );
  if (qpId === 'openai') {
    const resolved = await resolveProviderKey(ctx, 'openai.apiKey', 'OPENAI_API_KEY');
    if (!resolved) {
      throw new Error(
        'Qualification provider=openai but no key configured (workspace or platform).',
      );
    }
    return metered(
      new OpenAIAIProvider({
        apiKey: resolved.key,
        model: qModel,
        baseUrl: process.env.OPENAI_BASE_URL,
      }),
      ctx,
      'ai.qualification',
      resolved.source,
    );
  }
  if (qpId === 'anthropic') {
    const resolved = await resolveProviderKey(
      ctx,
      'anthropic.apiKey',
      'ANTHROPIC_API_KEY',
    );
    if (!resolved) {
      throw new Error(
        'Qualification provider=anthropic but no key configured (workspace or platform).',
      );
    }
    return metered(
      new AnthropicAIProvider({
        apiKey: resolved.key,
        model: qModel,
        baseUrl: process.env.ANTHROPIC_BASE_URL,
      }),
      ctx,
      'ai.qualification',
      resolved.source,
    );
  }
  if (qpId === 'gemini') {
    const resolved = await resolveProviderKey(
      ctx,
      'gemini.apiKey',
      'GEMINI_API_KEY',
    );
    if (!resolved) {
      throw new Error(
        'Qualification provider=gemini but no key configured (workspace or platform).',
      );
    }
    return metered(
      new GeminiAIProvider({
        apiKey: resolved.key,
        model: qModel,
        baseUrl: process.env.GEMINI_BASE_URL,
      }),
      ctx,
      'ai.qualification',
      resolved.source,
    );
  }
  if (qpId === 'deepseek') {
    const resolved = await resolveProviderKey(
      ctx,
      'deepseek.apiKey',
      'DEEPSEEK_API_KEY',
    );
    if (!resolved) {
      throw new Error(
        'Qualification provider=deepseek but no key configured (workspace or platform).',
      );
    }
    return metered(
      new DeepSeekAIProvider({
        apiKey: resolved.key,
        model: qModel,
        baseUrl: process.env.DEEPSEEK_BASE_URL,
      }),
      ctx,
      'ai.qualification',
      resolved.source,
    );
  }
  throw new Error(`Unknown qualification provider id: ${qpId}`);
}

/** For tests — inject a stub provider and reset between cases. */
export function _setAIProviderForTests(provider: IAIProvider | null): void {
  cached = provider;
}

// ---- platform default (admin console) ------------------------------------

/** The vendors getPlatformAIProvider can build an AI provider for. Their
 *  key locations come from the shared platform key catalogue. */
const PLATFORM_AI_VENDORS: ReadonlySet<string> = new Set([
  'openai',
  'anthropic',
  'gemini',
  'deepseek',
]);

export interface PlatformAIProviderResolution {
  /** Vendor the platform tier resolves for the `ai` capability. */
  vendor: string;
  /** How it was chosen: console default, AI_PROVIDER env, or auto-detect. */
  vendorSource: 'platform' | 'env' | 'default';
  /** Configured model (console, then AI_MODEL env), vendor-compatible.
   *  undefined = the adapter's built-in default, which `provider.model`
   *  then names. */
  configuredModel: string | undefined;
  /** Where the platform key lives; null for the keyless mock or when the
   *  platform has no key for the vendor. */
  keySource: 'console' | 'env' | null;
  /** Env var that would hold the key (for messages); null for mock. */
  keyEnvVar: string | null;
  /** Ready adapter, or null when the vendor needs a key the platform does
   *  not have. Not metered: there is no workspace to bill. */
  provider: IAIProvider | null;
}

/**
 * The AI provider a workspace WITHOUT its own selection or BYOK key runs
 * on: platform vendor (console → AI_PROVIDER env → auto-detect), platform
 * model (console → AI_MODEL env, vendor-compatible, the same resolution
 * as the /admin/providers status table) and the platform key (console →
 * env). It takes no context on purpose: the admin console tests the
 * platform default with it, and the admin's current workspace (its
 * provider override or BYOK key) must not leak in (I124). For the same
 * reason it ignores the `_setAIProviderForTests` stub.
 */
export async function getPlatformAIProvider(): Promise<PlatformAIProviderResolution> {
  const { resolvePlatformProvider, resolveTieredModel } = await import(
    '@/lib/services/provider-settings'
  );
  const active = await resolvePlatformProvider('ai', process.env.AI_PROVIDER);
  const vendor = active.id;
  const vendorSource = active.source;
  if (vendor === 'mock') {
    return {
      vendor,
      vendorSource,
      configuredModel: undefined,
      keySource: null,
      keyEnvVar: null,
      provider: new MockAIProvider(),
    };
  }
  const { platformKeyForVendor } = await import('@/lib/platform-provider-keys');
  const keyMeta = PLATFORM_AI_VENDORS.has(vendor) ? platformKeyForVendor(vendor) : null;
  if (!keyMeta) {
    throw new Error(`Unknown AI provider id from the platform cascade: ${vendor}`);
  }
  const configuredModel = await resolveTieredModel('ai', vendor, null, process.env.AI_MODEL);
  const { resolvePlatformProviderKey } = await import('@/lib/services/secrets');
  const resolved = await resolvePlatformProviderKey(keyMeta.secretKey, keyMeta.envVar);
  if (!resolved) {
    return {
      vendor,
      vendorSource,
      configuredModel,
      keySource: null,
      keyEnvVar: keyMeta.envVar,
      provider: null,
    };
  }
  const apiKey = resolved.key;
  let provider: IAIProvider;
  if (vendor === 'openai') {
    provider = new OpenAIAIProvider({
      apiKey,
      model: configuredModel,
      baseUrl: process.env.OPENAI_BASE_URL,
    });
  } else if (vendor === 'anthropic') {
    provider = new AnthropicAIProvider({
      apiKey,
      model: configuredModel,
      baseUrl: process.env.ANTHROPIC_BASE_URL,
    });
  } else if (vendor === 'gemini') {
    provider = new GeminiAIProvider({
      apiKey,
      model: configuredModel,
      baseUrl: process.env.GEMINI_BASE_URL,
    });
  } else {
    provider = new DeepSeekAIProvider({
      apiKey,
      model: configuredModel,
      baseUrl: process.env.DEEPSEEK_BASE_URL,
    });
  }
  return {
    vendor,
    vendorSource,
    configuredModel,
    keySource: resolved.source,
    keyEnvVar: keyMeta.envVar,
    provider,
  };
}

/**
 * Construct a SPECIFIC AI provider regardless of the workspace's
 * selected default. Used by features that need cross-vendor model
 * picking (e.g. staged outreach: cheap stages on OpenAI gpt-5-nano,
 * important stages on Anthropic Opus). Resolves the API key via the
 * usual BYOK → env cascade for the requested vendor.
 *
 * Returns null when no key is configured for that vendor anywhere —
 * caller decides whether to fall back to the workspace default or
 * surface an error.
 */
export async function getAIProviderById(
  ctx: { workspaceId: bigint },
  providerId: 'openai' | 'anthropic',
  /** Usage-log kind for metering (billing itemization). */
  usageKind: string = 'ai.generate',
): Promise<IAIProvider | null> {
  // Test injection wins, same as getAIProviderForCtx, so unit tests
  // that stub the provider don't need to know which vendor a stage
  // expects.
  if (cached) return cached;
  const { resolveProviderKey } = await import('@/lib/services/secrets');
  if (providerId === 'openai') {
    const resolved = await resolveProviderKey(ctx, 'openai.apiKey', 'OPENAI_API_KEY');
    if (!resolved) return null;
    return metered(
      new OpenAIAIProvider({
        apiKey: resolved.key,
        model: process.env.AI_MODEL,
        baseUrl: process.env.OPENAI_BASE_URL,
      }),
      ctx,
      usageKind,
      resolved.source,
    );
  }
  if (providerId === 'anthropic') {
    const resolved = await resolveProviderKey(
      ctx,
      'anthropic.apiKey',
      'ANTHROPIC_API_KEY',
    );
    if (!resolved) return null;
    return metered(
      new AnthropicAIProvider({
        apiKey: resolved.key,
        model: process.env.AI_MODEL,
        baseUrl: process.env.ANTHROPIC_BASE_URL,
      }),
      ctx,
      usageKind,
      resolved.source,
    );
  }
  return null;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
