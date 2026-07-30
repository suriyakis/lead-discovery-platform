import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { setSecret } from '@/lib/services/secrets';
import {
  AnthropicAIProvider,
  DeepSeekAIProvider,
  MockAIProvider,
  OpenAIAIProvider,
  _setAIProviderForTests,
  getAIProvider,
  getAIProviderForCtx,
  unwrapAIProvider,
} from '@/lib/ai';
import { GeminiAIProvider } from '@/lib/ai/gemini';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  ownerA: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  return { workspaceA, ownerA };
}

function ctx(
  workspaceId: bigint,
  userId: string,
  role: WorkspaceContext['role'] = 'owner',
): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

beforeEach(async () => {
  await truncateAll();
  _setAIProviderForTests(null);
});

afterEach(() => {
  delete process.env.AI_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.AI_MODEL;
  _setAIProviderForTests(null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ============ provider factories ====================================

describe('getAIProvider factory', () => {
  it('returns mock by default', () => {
    expect(getAIProvider()).toBeInstanceOf(MockAIProvider);
  });

  it('returns OpenAIAIProvider when AI_PROVIDER=openai and key is set', () => {
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(getAIProvider()).toBeInstanceOf(OpenAIAIProvider);
  });

  it('throws when AI_PROVIDER=openai but key is missing', () => {
    process.env.AI_PROVIDER = 'openai';
    expect(() => getAIProvider()).toThrow(/OPENAI_API_KEY/);
  });

  it('returns AnthropicAIProvider when AI_PROVIDER=anthropic and key is set', () => {
    process.env.AI_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    expect(getAIProvider()).toBeInstanceOf(AnthropicAIProvider);
  });

  it('throws on unknown AI_PROVIDER', () => {
    process.env.AI_PROVIDER = 'cohere';
    expect(() => getAIProvider()).toThrow(/Unknown AI_PROVIDER/);
  });

  it('returns GeminiAIProvider when AI_PROVIDER=gemini and key is set (P62-09)', async () => {
    process.env.AI_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    const provider = getAIProvider();
    expect(provider.id).toBe('gemini');
    const { GeminiAIProvider } = await import('@/lib/ai/gemini');
    expect(provider).toBeInstanceOf(GeminiAIProvider);
  });
});

// ============ ctx-aware factory =====================================

describe('getAIProviderForCtx', () => {
  it('returns mock when AI_PROVIDER=mock (BYOK has no effect)', async () => {
    const s = await setup();
    process.env.AI_PROVIDER = 'mock';
    await setSecret(ctx(s.workspaceA, s.ownerA), 'openai.apiKey', 'sk-workspace');
    const provider = await getAIProviderForCtx({ workspaceId: s.workspaceA });
    expect(provider).toBeInstanceOf(MockAIProvider);
  });

  it('uses workspace OpenAI key when AI_PROVIDER=openai', async () => {
    const s = await setup();
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-platform';
    await setSecret(ctx(s.workspaceA, s.ownerA), 'openai.apiKey', 'sk-workspace');
    const provider = await getAIProviderForCtx({ workspaceId: s.workspaceA });
    expect(unwrapAIProvider(provider)).toBeInstanceOf(OpenAIAIProvider);
    expect((unwrapAIProvider(provider) as unknown as { apiKey: string }).apiKey).toBe('sk-workspace');
  });

  it('uses workspace Anthropic key when AI_PROVIDER=anthropic', async () => {
    const s = await setup();
    process.env.AI_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-platform';
    await setSecret(ctx(s.workspaceA, s.ownerA), 'anthropic.apiKey', 'sk-ant-workspace');
    const provider = await getAIProviderForCtx({ workspaceId: s.workspaceA });
    expect(unwrapAIProvider(provider)).toBeInstanceOf(AnthropicAIProvider);
    expect((unwrapAIProvider(provider) as unknown as { apiKey: string }).apiKey).toBe('sk-ant-workspace');
  });

  it('falls back to platform key when no workspace key (P45: now builds fresh provider per call)', async () => {
    const s = await setup();
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-platform';
    const provider = await getAIProviderForCtx({ workspaceId: s.workspaceA });
    expect(unwrapAIProvider(provider)).toBeInstanceOf(OpenAIAIProvider);
    expect((unwrapAIProvider(provider) as unknown as { apiKey: string }).apiKey).toBe('sk-platform');
  });
});

// ============ cost estimation =======================================

describe('OpenAIAIProvider.estimateCost', () => {
  it('charges gpt-4o-mini at $0.15 / 1M input + $0.60 / 1M output', () => {
    const p = new OpenAIAIProvider({ apiKey: 'x' });
    const cost = p.estimateCost({
      model: 'gpt-4o-mini',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // 0.15 + 0.60 = 0.75 dollars
    expect(cost).toBeCloseTo(0.75, 4);
  });

  it('charges gpt-4o more', () => {
    const p = new OpenAIAIProvider({ apiKey: 'x' });
    const cost = p.estimateCost({
      model: 'gpt-4o',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(12.5, 4);
  });
});

describe('AnthropicAIProvider.estimateCost', () => {
  it('charges Haiku at $1 / 1M input + $5 / 1M output', () => {
    const p = new AnthropicAIProvider({ apiKey: 'x' });
    const cost = p.estimateCost({
      model: 'claude-haiku-4-5',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(6, 4);
  });

  it('charges Sonnet more', () => {
    const p = new AnthropicAIProvider({ apiKey: 'x' });
    const cost = p.estimateCost({
      model: 'claude-sonnet-4',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(18, 4);
  });
});

// The estimateCost contract is DOLLARS for every vendor adapter —
// MeteredAIProvider multiplies by 100 for cents. The Gemini adapter
// once returned cents-scale values (copied from the research provider's
// computeCost) and every Gemini AI call billed 100× too high in
// production. These tests pin the unit for the two adapters that had
// no cost coverage.
describe('GeminiAIProvider.estimateCost', () => {
  it('charges flash at $0.30 / 1M input + $2.50 / 1M output — DOLLARS, not cents', () => {
    const p = new GeminiAIProvider({ apiKey: 'x' });
    const cost = p.estimateCost({
      model: 'gemini-2.5-flash',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(2.8, 4);
  });

  it('charges 3.x flash at the flash tier', () => {
    const p = new GeminiAIProvider({ apiKey: 'x' });
    const cost = p.estimateCost({
      model: 'gemini-3.6-flash',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(2.8, 4);
  });

  it('charges pro at $1.25 / 1M input + $10 / 1M output', () => {
    const p = new GeminiAIProvider({ apiKey: 'x' });
    const cost = p.estimateCost({
      model: 'gemini-3.0-pro',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(11.25, 4);
  });

  it('charges lite at $0.10 / 1M input + $0.40 / 1M output', () => {
    const p = new GeminiAIProvider({ apiKey: 'x' });
    const cost = p.estimateCost({
      model: 'gemini-3.1-flash-lite',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.5, 4);
  });
});

describe('DeepSeekAIProvider.estimateCost', () => {
  it('charges v4-flash at $0.14 / 1M input + $0.28 / 1M output', () => {
    const p = new DeepSeekAIProvider({ apiKey: 'x' });
    const cost = p.estimateCost({
      model: 'deepseek-v4-flash',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.42, 4);
  });

  it('charges v4-pro at $0.435 / 1M input + $0.87 / 1M output', () => {
    const p = new DeepSeekAIProvider({ apiKey: 'x' });
    const cost = p.estimateCost({
      model: 'deepseek-v4-pro',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(1.305, 4);
  });
});

// ============ JSON parsing strips fences ============================

describe('AnthropicAIProvider.generateJson', () => {
  it('strips a ```json fence the model might add', async () => {
    // Stub the network call by subclassing.
    class Stub extends AnthropicAIProvider {
      override async generateText() {
        return {
          text: '```json\n{"name": "ok"}\n```',
          model: 'claude-haiku-4-5',
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
    }
    const p = new Stub({ apiKey: 'x' });
    const schema = z.object({ name: z.string() });
    const out = await p.generateJson({ prompt: 'x' }, schema);
    expect(out).toEqual({ name: 'ok' });
  });
});
