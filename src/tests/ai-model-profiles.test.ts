// AP-02 — per-model parameter profiles for the vendor adapters.
//
// Two halves:
//   1. Byte-identity: with `reasoning` absent, every adapter sends EXACTLY
//      the request body it sent before AP-02 (these goldens were captured
//      from the pre-change adapters and are compared as raw strings, so
//      key order counts too). Every non-assistant caller is unaffected.
//   2. With `reasoning` set, each adapter maps it to its vendor's knob and
//      gives hidden reasoning enough output budget; empty / refused
//      answers surface as a typed AIOutputError instead of ''.
//
// fetch is stubbed — no live API calls.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AIOutputError,
  AnthropicAIProvider,
  DeepSeekAIProvider,
  OpenAIAIProvider,
  type AIGenOptions,
} from '@/lib/ai';
import { GeminiAIProvider } from '@/lib/ai/gemini';
import { reasoningProfile } from '@/lib/ai/model-profiles';

interface Captured {
  url: string;
  body: string;
}

function stubFetch(responseJson: unknown): Captured[] {
  const calls: Captured[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response(JSON.stringify(responseJson), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return calls;
}

const OPENAI_OK = {
  model: 'x',
  choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
};
const OPENAI_JSON_OK = {
  model: 'x',
  choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
};
const ANTHROPIC_OK = {
  model: 'x',
  content: [{ type: 'text', text: 'hello' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 2 },
};
const GEMINI_OK = {
  candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
};
const GEMINI_JSON_OK = {
  candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
};

const INPUT = { system: 'SYS', prompt: 'Q' };
const OPTS: AIGenOptions = { temperature: 0.3, maxTokens: 900 };
const OPENAI_MESSAGES = [
  { role: 'system', content: 'SYS' },
  { role: 'user', content: 'Q' },
];
const GEMINI_SYSTEM = { role: 'system', parts: [{ text: 'SYS' }] };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('request bodies are byte-identical to pre-AP-02 when `reasoning` is absent', () => {
  it('OpenAI chat model (temperature + max_tokens)', async () => {
    const calls = stubFetch(OPENAI_OK);
    await new OpenAIAIProvider({ apiKey: 'k', model: 'gpt-4o-mini' }).generateText(INPUT, OPTS);
    expect(calls[0]!.body).toBe(
      JSON.stringify({
        model: 'gpt-4o-mini',
        messages: OPENAI_MESSAGES,
        temperature: 0.3,
        max_tokens: 900,
      }),
    );
  });

  it('OpenAI gpt-5.x (max_completion_tokens, no temperature)', async () => {
    const calls = stubFetch(OPENAI_OK);
    await new OpenAIAIProvider({ apiKey: 'k', model: 'gpt-5.5' }).generateText(INPUT, OPTS);
    expect(calls[0]!.body).toBe(
      JSON.stringify({ model: 'gpt-5.5', messages: OPENAI_MESSAGES, max_completion_tokens: 900 }),
    );
  });

  it('OpenAI gpt-5.x JSON mode', async () => {
    const calls = stubFetch(OPENAI_JSON_OK);
    await new OpenAIAIProvider({ apiKey: 'k', model: 'gpt-5.5' }).generateJson(
      INPUT,
      z.object({}),
      OPTS,
    );
    expect(calls[0]!.body).toBe(
      JSON.stringify({
        model: 'gpt-5.5',
        messages: [
          { role: 'system', content: 'SYS' },
          { role: 'user', content: 'Q\n\nReturn the response as JSON.' },
        ],
        max_completion_tokens: 900,
        response_format: { type: 'json_object' },
      }),
    );
  });

  it('DeepSeek v4-pro and the v4-flash default', async () => {
    const calls = stubFetch(OPENAI_OK);
    await new DeepSeekAIProvider({ apiKey: 'k', model: 'deepseek-v4-pro' }).generateText(INPUT, OPTS);
    await new DeepSeekAIProvider({ apiKey: 'k' }).generateText(INPUT, OPTS);
    expect(calls[0]!.body).toBe(
      JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: OPENAI_MESSAGES,
        temperature: 0.3,
        max_tokens: 900,
      }),
    );
    expect(calls[1]!.body).toBe(
      JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: OPENAI_MESSAGES,
        temperature: 0.3,
        max_tokens: 900,
      }),
    );
  });

  it('Anthropic haiku-4-5 (temperature) and sonnet-5-5 (no temperature)', async () => {
    const calls = stubFetch(ANTHROPIC_OK);
    await new AnthropicAIProvider({ apiKey: 'k', model: 'claude-haiku-4-5' }).generateText(INPUT, OPTS);
    await new AnthropicAIProvider({ apiKey: 'k', model: 'claude-sonnet-5-5' }).generateText(INPUT, OPTS);
    await new AnthropicAIProvider({ apiKey: 'k', model: 'claude-opus-5-5' }).generateText(INPUT, {});
    expect(calls[0]!.body).toBe(
      JSON.stringify({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'Q' }],
        max_tokens: 900,
        temperature: 0.3,
        system: 'SYS',
      }),
    );
    expect(calls[1]!.body).toBe(
      JSON.stringify({
        model: 'claude-sonnet-5-5',
        messages: [{ role: 'user', content: 'Q' }],
        max_tokens: 900,
        system: 'SYS',
      }),
    );
    expect(calls[2]!.body).toBe(
      JSON.stringify({
        model: 'claude-opus-5-5',
        messages: [{ role: 'user', content: 'Q' }],
        max_tokens: 4096,
        system: 'SYS',
      }),
    );
  });

  it('Gemini 2.5 flash text + JSON, Gemini 3.x JSON', async () => {
    const calls = stubFetch(GEMINI_OK);
    await new GeminiAIProvider({ apiKey: 'k', model: 'gemini-2.5-flash' }).generateText(INPUT, OPTS);
    vi.restoreAllMocks();
    const jsonCalls = stubFetch(GEMINI_JSON_OK);
    await new GeminiAIProvider({ apiKey: 'k', model: 'gemini-2.5-flash' }).generateJson(
      INPUT,
      z.object({}),
      OPTS,
    );
    await new GeminiAIProvider({ apiKey: 'k', model: 'gemini-3.5-flash' }).generateJson(
      INPUT,
      z.object({}),
      OPTS,
    );
    expect(calls[0]!.body).toBe(
      JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Q' }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 2948 },
        systemInstruction: GEMINI_SYSTEM,
      }),
    );
    expect(jsonCalls[0]!.body).toBe(
      JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Q' }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2948,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 0 },
        },
        systemInstruction: GEMINI_SYSTEM,
      }),
    );
    expect(jsonCalls[1]!.body).toBe(
      JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Q' }] }],
        generationConfig: { maxOutputTokens: 2948, responseMimeType: 'application/json' },
        systemInstruction: GEMINI_SYSTEM,
      }),
    );
  });
});

const REASONING: AIGenOptions = { ...OPTS, reasoning: 'low' };

function parsed(c: Captured): Record<string, unknown> {
  return JSON.parse(c.body) as Record<string, unknown>;
}

describe('with `reasoning`: Anthropic', () => {
  it('claude-haiku-4-5 gets answer room but no output_config (it would 400)', async () => {
    const calls = stubFetch(ANTHROPIC_OK);
    await new AnthropicAIProvider({ apiKey: 'k', model: 'claude-haiku-4-5' }).generateText(
      INPUT,
      REASONING,
    );
    const body = parsed(calls[0]!);
    expect(body).not.toHaveProperty('output_config');
    expect(body).not.toHaveProperty('thinking');
    expect(body.max_tokens).toBe(1500);
    expect(body.temperature).toBe(0.3); // haiku still accepts sampling params
  });

  it('claude-sonnet-5-5: effort low, >= 4000 output tokens, no thinking and no temperature', async () => {
    const calls = stubFetch(ANTHROPIC_OK);
    await new AnthropicAIProvider({ apiKey: 'k', model: 'claude-sonnet-5-5' }).generateText(
      INPUT,
      REASONING,
    );
    const body = parsed(calls[0]!);
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.max_tokens as number).toBeGreaterThanOrEqual(4000);
    // {type:'disabled'} is a 400 on Sonnet 5.5 — never sent; omitted = adaptive.
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('temperature');
  });

  it('pre-4.6 models get no effort; 4.6+ and Opus 5.5 do', () => {
    expect(reasoningProfile('anthropic', 'claude-sonnet-4-5-20250929').effort).toBeNull();
    expect(reasoningProfile('anthropic', 'claude-sonnet-4-20250514').effort).toBeNull();
    expect(reasoningProfile('anthropic', 'claude-opus-4-1').effort).toBeNull();
    expect(reasoningProfile('anthropic', 'claude-3-5-haiku-latest').effort).toBeNull();
    expect(reasoningProfile('anthropic', 'claude-haiku-4-5').effort).toBeNull();
    expect(reasoningProfile('anthropic', 'claude-sonnet-4-6').effort).toBe('output_config');
    expect(reasoningProfile('anthropic', 'claude-opus-4-8').effort).toBe('output_config');
    expect(reasoningProfile('anthropic', 'claude-sonnet-5').effort).toBe('output_config');
    expect(reasoningProfile('anthropic', 'claude-opus-5-5').effort).toBe('output_config');
    expect(reasoningProfile('anthropic', 'claude-fable-5-1').effort).toBe('output_config');
  });

  it('a thinking-only response that hit max_tokens throws empty, not ""', async () => {
    stubFetch({
      model: 'claude-sonnet-5-5',
      content: [{ type: 'thinking', thinking: '' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 7000, output_tokens: 4000 },
    });
    const err = await new AnthropicAIProvider({ apiKey: 'k', model: 'claude-sonnet-5-5' })
      .generateText(INPUT, REASONING)
      .catch((e) => e);
    expect(err).toBeInstanceOf(AIOutputError);
    expect(err.kind).toBe('empty');
    expect(err.stopReason).toBe('max_tokens');
    expect(err.usage).toEqual({ inputTokens: 7000, outputTokens: 4000 });
  });

  it("stop_reason 'refusal' is a typed refusal even with partial text", async () => {
    stubFetch({
      model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text: 'Sure, here' }],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber' },
      usage: { input_tokens: 10, output_tokens: 3 },
    });
    const err = await new AnthropicAIProvider({ apiKey: 'k', model: 'claude-sonnet-5-5' })
      .generateText(INPUT, OPTS)
      .catch((e) => e);
    expect(err).toBeInstanceOf(AIOutputError);
    expect(err.kind).toBe('refusal');
  });

  it('healthCheck still passes when a 1-token ping comes back thinking-only', async () => {
    stubFetch({
      model: 'claude-opus-5-5',
      content: [{ type: 'thinking', thinking: '' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    const r = await new AnthropicAIProvider({ apiKey: 'k', model: 'claude-opus-5-5' }).healthCheck();
    expect(r.ok).toBe(true);
  });
});

describe('with `reasoning`: OpenAI and DeepSeek', () => {
  it('gpt-5.x: reasoning_effort low, max_completion_tokens >= 2500, no temperature', async () => {
    const calls = stubFetch(OPENAI_OK);
    await new OpenAIAIProvider({ apiKey: 'k', model: 'gpt-5.6-luna' }).generateText(
      INPUT,
      REASONING,
    );
    const body = parsed(calls[0]!);
    expect(body.reasoning_effort).toBe('low');
    expect(body.max_completion_tokens as number).toBeGreaterThanOrEqual(2500);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
  });

  it('a non-reasoning OpenAI model is unchanged by `reasoning`', async () => {
    const calls = stubFetch(OPENAI_OK);
    const ai = new OpenAIAIProvider({ apiKey: 'k', model: 'gpt-4o-mini' });
    await ai.generateText(INPUT, OPTS);
    await ai.generateText(INPUT, REASONING);
    expect(calls[1]!.body).toBe(calls[0]!.body);
  });

  it('content:null with finish_reason length throws empty instead of returning ""', async () => {
    stubFetch({
      model: 'gpt-5.6-luna',
      choices: [{ message: { content: null }, finish_reason: 'length' }],
      usage: { prompt_tokens: 7000, completion_tokens: 2500 },
    });
    const err = await new OpenAIAIProvider({ apiKey: 'k', model: 'gpt-5.6-luna' })
      .generateText(INPUT, REASONING)
      .catch((e) => e);
    expect(err).toBeInstanceOf(AIOutputError);
    expect(err.kind).toBe('empty');
    expect(err.stopReason).toBe('length');
    expect(err.usage).toEqual({ inputTokens: 7000, outputTokens: 2500 });
  });

  it('a refusal message is a typed refusal', async () => {
    stubFetch({
      model: 'gpt-5.5',
      choices: [{ message: { content: null, refusal: 'I cannot help.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    });
    const err = await new OpenAIAIProvider({ apiKey: 'k', model: 'gpt-5.5' })
      .generateText(INPUT, OPTS)
      .catch((e) => e);
    expect(err).toBeInstanceOf(AIOutputError);
    expect(err.kind).toBe('refusal');
  });

  it('healthCheck on gpt-5.x passes when the 1-token ping is spent reasoning', async () => {
    stubFetch({
      model: 'gpt-5.5',
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    });
    const r = await new OpenAIAIProvider({ apiKey: 'k', model: 'gpt-5.5' }).healthCheck();
    expect(r.ok).toBe(true);
  });

  it('deepseek-v4-pro gets >= 3000 output tokens and no reasoning_effort; flash is unchanged', async () => {
    const calls = stubFetch(OPENAI_OK);
    await new DeepSeekAIProvider({ apiKey: 'k', model: 'deepseek-v4-pro' }).generateText(
      INPUT,
      REASONING,
    );
    await new DeepSeekAIProvider({ apiKey: 'k' }).generateText(INPUT, REASONING);
    const pro = parsed(calls[0]!);
    expect(pro.max_tokens as number).toBeGreaterThanOrEqual(3000);
    expect(pro).not.toHaveProperty('reasoning_effort');
    expect(parsed(calls[1]!).max_tokens).toBe(900);
  });

  it('deepseek-v4-pro: empty content (thought in reasoning_content) at the cap throws empty', async () => {
    stubFetch({
      model: 'deepseek-v4-pro',
      choices: [
        { message: { content: '', reasoning_content: 'thinking…' }, finish_reason: 'length' },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 3000 },
    });
    const err = await new DeepSeekAIProvider({ apiKey: 'k', model: 'deepseek-v4-pro' })
      .generateText(INPUT, REASONING)
      .catch((e) => e);
    expect(err).toBeInstanceOf(AIOutputError);
    expect(err.provider).toBe('deepseek');
  });
});

describe('with `reasoning`: Gemini', () => {
  it('keeps its existing thinking headroom — the body is unchanged', async () => {
    const calls = stubFetch(GEMINI_OK);
    const ai = new GeminiAIProvider({ apiKey: 'k', model: 'gemini-3.5-flash' });
    await ai.generateText(INPUT, OPTS);
    await ai.generateText(INPUT, REASONING);
    expect(calls[1]!.body).toBe(calls[0]!.body);
  });

  it('an empty candidate is a typed empty error; a safety stop is a refusal', async () => {
    stubFetch({
      candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0 },
    });
    const ai = new GeminiAIProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });
    const empty = await ai.generateText(INPUT, OPTS).catch((e) => e);
    expect(empty).toBeInstanceOf(AIOutputError);
    expect(empty.kind).toBe('empty');
    expect(empty.message).toBe('gemini returned empty text');

    vi.restoreAllMocks();
    stubFetch({
      candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0 },
    });
    const refused = await ai.generateText(INPUT, OPTS).catch((e) => e);
    expect(refused.kind).toBe('refusal');
  });
});
