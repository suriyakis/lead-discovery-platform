// AI provider abstraction.
//
// The platform must remain useful when no real AI is configured. Selection
// happens at boot via the `AI_PROVIDER` env var; in Phase 1 only `mock` is
// implemented. Real providers (anthropic, openai, gemini, deepseek) ship
// in later phases — they conform to this same interface.
//
// Tests inject the mock directly. Production code calls `getAIProvider()`.

import { createHash } from 'node:crypto';
import type { ZodSchema } from 'zod';

export interface AIGenInput {
  /** System prompt + messages, OpenAI-style. Kept small for Phase 1. */
  system?: string;
  prompt: string;
}

export interface AIGenOptions {
  temperature?: number;
  maxTokens?: number;
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
  generateText(input: AIGenInput, options?: AIGenOptions): Promise<AIGenResult>;
  generateJson<T>(input: AIGenInput, schema: ZodSchema<T>, options?: AIGenOptions): Promise<T>;
  estimateCost(usage: AIUsage): number;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

// ---- mock implementation ------------------------------------------------

export class MockAIProvider implements IAIProvider {
  public readonly id = 'mock';

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
    // Strategy: try parsing the prompt as JSON first. If that fails, return
    // schema-default-shaped output the mock produces deterministically from
    // the input. For Phase 1 we keep this strict: the caller must give us a
    // prompt that parses, OR the schema must accept an empty object.
    const seed = options.mockSeed ?? input.prompt;
    let candidate: unknown;
    try {
      candidate = JSON.parse(seed);
    } catch {
      candidate = {};
    }
    const result = schema.safeParse(candidate);
    if (result.success) return result.data;
    // Fall back to empty object — fails for schemas that require fields.
    // That's a feature: tests catch when callers expect mock to produce
    // a populated object without configuring it.
    return schema.parse({});
  }

  estimateCost(usage: AIUsage): number {
    // Mock: $0 per token. Phase 1 platform must run without AI cost.
    void usage;
    return 0;
  }

  async healthCheck() {
    return { ok: true, detail: 'mock provider is always healthy' };
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
    default:
      throw new Error(`Unknown AI_PROVIDER: ${id}. Phase 1 supports only "mock".`);
  }
}

/** For tests — inject a stub provider and reset between cases. */
export function _setAIProviderForTests(provider: IAIProvider | null): void {
  cached = provider;
}

function estimateTokens(text: string): number {
  // Cheap placeholder. Real providers count via tokenizer; Phase 1 doesn't care.
  return Math.ceil(text.length / 4);
}
