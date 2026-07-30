import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import { workspaceProviderSettings } from '@/lib/db/schema/workspaces';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  ProviderSettingsError,
  getProviderSettings,
  resolveActiveProvider,
  systemDefaultProvider,
  updateProviderSettings,
} from '@/lib/services/provider-settings';
import { setSecret } from '@/lib/services/secrets';
import {
  AnthropicAIProvider,
  MockAIProvider,
  OpenAIAIProvider,
  _setAIProviderForTests,
  getAIProviderForCtx,
  unwrapAIProvider,
} from '@/lib/ai';
import {
  GeminiResearchProvider,
  PerplexityResearchProvider,
  MockResearchProvider,
  _setResearchProviderForTests,
  getResearchProviderForCtx,
} from '@/lib/research';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  ownerA: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'owner-ps@test.local' });
  const workspaceA = await seedWorkspace({ name: 'Aps', ownerUserId: ownerA });
  return { workspaceA, ownerA };
}

function ctx(workspaceId: bigint, userId: string, role: WorkspaceContext['role'] = 'owner'): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

beforeEach(async () => {
  // Make sure no test injection leaks between tests.
  _setAIProviderForTests(null);
  _setResearchProviderForTests(null);
  await truncateAll();
});

afterEach(() => {
  _setAIProviderForTests(null);
  _setResearchProviderForTests(null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ─── resolveActiveProvider cascade ────────────────────────────────────

describe('resolveActiveProvider', () => {
  it('returns workspace setting when populated', async () => {
    const s = await setup();
    await db
      .insert(workspaceProviderSettings)
      .values({ workspaceId: s.workspaceA, aiProvider: 'anthropic' });
    const out = await resolveActiveProvider(
      ctx(s.workspaceA, s.ownerA),
      'ai',
      'openai',
    );
    expect(out.id).toBe('anthropic');
    expect(out.source).toBe('workspace');
  });

  it('falls back to env when workspace value is null', async () => {
    const s = await setup();
    await db
      .insert(workspaceProviderSettings)
      .values({ workspaceId: s.workspaceA, aiProvider: null });
    const out = await resolveActiveProvider(
      ctx(s.workspaceA, s.ownerA),
      'ai',
      'openai',
    );
    expect(out.id).toBe('openai');
    expect(out.source).toBe('env');
  });

  it('falls back to env when no workspace row exists', async () => {
    const s = await setup();
    const out = await resolveActiveProvider(
      ctx(s.workspaceA, s.ownerA),
      'research',
      'gemini',
    );
    expect(out.id).toBe('gemini');
    expect(out.source).toBe('env');
  });

  it('returns mock as ultimate default in dev/test when no platform key exists', async () => {
    const s = await setup();
    delete process.env.OPENAI_API_KEY;
    const out = await resolveActiveProvider(
      ctx(s.workspaceA, s.ownerA),
      'embedding',
      undefined,
    );
    expect(out.id).toBe('mock');
    expect(out.source).toBe('default');
  });

  it('system default auto-detects the first vendor with a platform key', async () => {
    const s = await setup();
    delete process.env.GEMINI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-platform';
    try {
      const out = await resolveActiveProvider(
        ctx(s.workspaceA, s.ownerA),
        'ai',
        undefined,
      );
      expect(out.id).toBe('openai');
      expect(out.source).toBe('default');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('preferred vendor wins the auto-detect when its key exists', async () => {
    const s = await setup();
    process.env.GEMINI_API_KEY = 'gm-platform';
    process.env.OPENAI_API_KEY = 'sk-platform';
    try {
      const out = await resolveActiveProvider(
        ctx(s.workspaceA, s.ownerA),
        'ai',
        undefined,
      );
      expect(out.id).toBe('gemini');
      expect(out.source).toBe('default');
    } finally {
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('vector storage defaults to pgvector (keyless), never mock', async () => {
    const s = await setup();
    const out = await resolveActiveProvider(
      ctx(s.workspaceA, s.ownerA),
      'vector_storage',
      undefined,
    );
    expect(out.id).toBe('pgvector');
    expect(out.source).toBe('default');
  });

  it('production with no keys surfaces the real vendor (loud failure) instead of mock', () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(systemDefaultProvider('ai')).toEqual({
        id: 'gemini',
        source: 'default',
      });
      // search is the exception: grounded research is its real fallback,
      // so it stays mock rather than masking that path with a serpapi error.
      expect(systemDefaultProvider('search').id).toBe('mock');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ─── updateProviderSettings ──────────────────────────────────────────

describe('updateProviderSettings', () => {
  it('upserts a row with the requested values', async () => {
    const s = await setup();
    await updateProviderSettings(ctx(s.workspaceA, s.ownerA), {
      aiProvider: 'anthropic',
      researchProvider: 'gemini',
    });
    const got = await getProviderSettings(ctx(s.workspaceA, s.ownerA));
    expect(got.aiProvider).toBe('anthropic');
    expect(got.researchProvider).toBe('gemini');
    expect(got.embeddingProvider).toBeNull();
    expect(got.searchProvider).toBeNull();
  });

  it('null clears the override (resets to env fallback)', async () => {
    const s = await setup();
    await updateProviderSettings(ctx(s.workspaceA, s.ownerA), {
      aiProvider: 'anthropic',
    });
    await updateProviderSettings(ctx(s.workspaceA, s.ownerA), {
      aiProvider: null,
    });
    const got = await getProviderSettings(ctx(s.workspaceA, s.ownerA));
    expect(got.aiProvider).toBeNull();
  });

  it('preserves untouched fields on partial update', async () => {
    const s = await setup();
    await updateProviderSettings(ctx(s.workspaceA, s.ownerA), {
      aiProvider: 'anthropic',
      researchProvider: 'gemini',
    });
    await updateProviderSettings(ctx(s.workspaceA, s.ownerA), {
      researchProvider: 'perplexity',
    });
    const got = await getProviderSettings(ctx(s.workspaceA, s.ownerA));
    expect(got.aiProvider).toBe('anthropic');
    expect(got.researchProvider).toBe('perplexity');
  });

  it('rejects unknown provider ids', async () => {
    const s = await setup();
    await expect(
      updateProviderSettings(ctx(s.workspaceA, s.ownerA), {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        aiProvider: 'banana' as any,
      }),
    ).rejects.toThrow(ProviderSettingsError);
  });

  it('viewer role cannot update', async () => {
    const s = await setup();
    const viewer = ctx(s.workspaceA, s.ownerA, 'viewer');
    await expect(
      updateProviderSettings(viewer, { aiProvider: 'openai' }),
    ).rejects.toThrow(/Permission denied/);
  });

  it('emits an audit event', async () => {
    const s = await setup();
    await updateProviderSettings(ctx(s.workspaceA, s.ownerA), {
      researchProvider: 'gemini',
    });
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.workspaceId, s.workspaceA));
    expect(rows.some((r) => r.kind === 'provider_settings.update')).toBe(true);
  });
});

// ─── getAIProviderForCtx with cascade ────────────────────────────────

describe('getAIProviderForCtx (cascade)', () => {
  it('workspace anthropic + env openai → returns AnthropicAIProvider', async () => {
    const s = await setup();
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-platform';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-platform';
    await updateProviderSettings(ctx(s.workspaceA, s.ownerA), {
      aiProvider: 'anthropic',
    });
    const p = await getAIProviderForCtx({ workspaceId: s.workspaceA });
    expect(unwrapAIProvider(p)).toBeInstanceOf(AnthropicAIProvider);
  });

  it('workspace mock overrides env real provider', async () => {
    const s = await setup();
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-platform';
    await updateProviderSettings(ctx(s.workspaceA, s.ownerA), {
      aiProvider: 'mock',
    });
    const p = await getAIProviderForCtx({ workspaceId: s.workspaceA });
    expect(p).toBeInstanceOf(MockAIProvider);
  });

  it('no workspace setting + env openai → uses platform key', async () => {
    const s = await setup();
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-platform';
    const p = await getAIProviderForCtx({ workspaceId: s.workspaceA });
    expect(unwrapAIProvider(p)).toBeInstanceOf(OpenAIAIProvider);
    expect((unwrapAIProvider(p) as unknown as { apiKey: string }).apiKey).toBe('sk-platform');
  });

  it('workspace BYOK key wins over platform key', async () => {
    const s = await setup();
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-platform';
    await setSecret(ctx(s.workspaceA, s.ownerA), 'openai.apiKey', 'sk-workspace');
    const p = await getAIProviderForCtx({ workspaceId: s.workspaceA });
    expect((unwrapAIProvider(p) as unknown as { apiKey: string }).apiKey).toBe('sk-workspace');
  });

  it('throws when real provider id has no key configured', async () => {
    const s = await setup();
    delete process.env.OPENAI_API_KEY;
    await updateProviderSettings(ctx(s.workspaceA, s.ownerA), {
      aiProvider: 'openai',
    });
    await expect(
      getAIProviderForCtx({ workspaceId: s.workspaceA }),
    ).rejects.toThrow(/no key configured/);
  });
});

// ─── getResearchProviderForCtx with cascade ──────────────────────────

describe('getResearchProviderForCtx (cascade)', () => {
  it('workspace gemini + env perplexity → returns GeminiResearchProvider', async () => {
    const s = await setup();
    process.env.RESEARCH_PROVIDER = 'perplexity';
    process.env.PERPLEXITY_API_KEY = 'pplx-platform';
    process.env.GEMINI_API_KEY = 'gemini-platform';
    await updateProviderSettings(ctx(s.workspaceA, s.ownerA), {
      researchProvider: 'gemini',
    });
    const p = await getResearchProviderForCtx({ workspaceId: s.workspaceA });
    expect(p).toBeInstanceOf(GeminiResearchProvider);
  });

  it('falls back to env when workspace setting is null', async () => {
    const s = await setup();
    process.env.RESEARCH_PROVIDER = 'perplexity';
    process.env.PERPLEXITY_API_KEY = 'pplx-platform';
    const p = await getResearchProviderForCtx({ workspaceId: s.workspaceA });
    expect(p).toBeInstanceOf(PerplexityResearchProvider);
  });

  it('mock id short-circuits without needing keys', async () => {
    const s = await setup();
    delete process.env.GEMINI_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    await updateProviderSettings(ctx(s.workspaceA, s.ownerA), {
      researchProvider: 'mock',
    });
    const p = await getResearchProviderForCtx({ workspaceId: s.workspaceA });
    expect(p).toBeInstanceOf(MockResearchProvider);
  });
});
