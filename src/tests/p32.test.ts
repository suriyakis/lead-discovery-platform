import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db/client';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { setSecret } from '@/lib/services/secrets';
import {
  OpenAIEmbeddingProvider,
  _setEmbeddingProviderForTests,
  getEmbeddingProviderForCtx,
  MockEmbeddingProvider,
  unwrapEmbeddingProvider,
} from '@/lib/embeddings';
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
  // Reset cached singleton so EMBEDDING_PROVIDER changes apply per test.
  _setEmbeddingProviderForTests(null);
});

afterEach(() => {
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  _setEmbeddingProviderForTests(null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('getEmbeddingProviderForCtx', () => {
  it('returns the mock provider when EMBEDDING_PROVIDER=mock (BYOK has no effect)', async () => {
    const s = await setup();
    process.env.EMBEDDING_PROVIDER = 'mock';
    await setSecret(ctx(s.workspaceA, s.ownerA), 'openai.apiKey', 'sk-workspace');
    const provider = await getEmbeddingProviderForCtx({
      workspaceId: s.workspaceA,
    });
    expect(provider).toBeInstanceOf(MockEmbeddingProvider);
  });

  it('uses workspace-supplied OpenAI key when set', async () => {
    const s = await setup();
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-platform';
    await setSecret(ctx(s.workspaceA, s.ownerA), 'openai.apiKey', 'sk-workspace');
    const provider = unwrapEmbeddingProvider(
      await getEmbeddingProviderForCtx({ workspaceId: s.workspaceA }),
    );
    expect(provider).toBeInstanceOf(OpenAIEmbeddingProvider);
    // Reach in to verify the provider got the workspace key, not platform.
    expect(
      (provider as unknown as { apiKey: string }).apiKey,
    ).toBe('sk-workspace');
  });

  it('falls back to env when workspace has no key', async () => {
    const s = await setup();
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-platform';
    const provider = unwrapEmbeddingProvider(
      await getEmbeddingProviderForCtx({ workspaceId: s.workspaceA }),
    );
    expect(provider).toBeInstanceOf(OpenAIEmbeddingProvider);
    expect(
      (provider as unknown as { apiKey: string }).apiKey,
    ).toBe('sk-platform');
  });

  it('uses the platform env key when no workspace override (P45: builds fresh per call)', async () => {
    const s = await setup();
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-platform';
    const provider = unwrapEmbeddingProvider(
      await getEmbeddingProviderForCtx({ workspaceId: s.workspaceA }),
    );
    expect(provider).toBeInstanceOf(OpenAIEmbeddingProvider);
    expect((provider as unknown as { apiKey: string }).apiKey).toBe('sk-platform');
  });

  it('returns a NEW (uncached) instance per call when workspace overrides', async () => {
    const s = await setup();
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-platform';
    await setSecret(ctx(s.workspaceA, s.ownerA), 'openai.apiKey', 'sk-workspace');
    const a = unwrapEmbeddingProvider(
      await getEmbeddingProviderForCtx({ workspaceId: s.workspaceA }),
    );
    const b = unwrapEmbeddingProvider(
      await getEmbeddingProviderForCtx({ workspaceId: s.workspaceA }),
    );
    // Both use the workspace key, but the singleton cache isn't poisoned —
    // each call constructs a fresh provider so changing the secret takes
    // effect immediately.
    expect(a).not.toBe(b);
    expect((a as unknown as { apiKey: string }).apiKey).toBe('sk-workspace');
    expect((b as unknown as { apiKey: string }).apiKey).toBe('sk-workspace');
  });
});

describe('MeteredEmbeddingProvider', () => {
  it('records a usage_log row per embed() call (embedding spend was previously untracked)', async () => {
    const s = await setup();
    const { MeteredEmbeddingProvider } = await import('@/lib/embeddings');
    const { usageLog } = await import('@/lib/db/schema/audit');
    const { eq } = await import('drizzle-orm');
    // Inner stub with a non-mock id so the row is a realistic billable
    // shape (the mock id would skip the debit path anyway; we only
    // assert the tracking row here).
    const inner = {
      id: 'openai',
      model: 'text-embedding-3-small',
      dim: 1536,
      async embed() {
        return {
          embeddings: [[0, 1]],
          model: 'text-embedding-3-small',
          inputTokens: 2_000_000,
        };
      },
      estimateCost(inputTokens: number) {
        return (inputTokens / 1_000_000) * 0.02; // dollars
      },
      async healthCheck() {
        return { ok: true };
      },
    };
    const metered = new MeteredEmbeddingProvider(inner, s.workspaceA, 'platform');
    await metered.embed({ texts: ['a', 'b'] });

    const rows = await db
      .select()
      .from(usageLog)
      .where(eq(usageLog.workspaceId, s.workspaceA));
    const row = rows.find((r) => r.kind === 'embedding.embed');
    expect(row).toBeDefined();
    expect(row!.provider).toBe('openai');
    expect(row!.units).toBe(2_000_000n);
    // $0.04 for 2M tokens → 4 cents.
    expect(row!.costEstimateCents).toBe(4);
    expect((row!.payload as Record<string, unknown>).keySource).toBe('platform');
  });

  it('rounds micro-call costs to 0 cents instead of a 1-cent floor', async () => {
    const s = await setup();
    const { MeteredEmbeddingProvider } = await import('@/lib/embeddings');
    const { usageLog } = await import('@/lib/db/schema/audit');
    const { eq } = await import('drizzle-orm');
    const inner = {
      id: 'openai',
      model: 'text-embedding-3-small',
      dim: 1536,
      async embed() {
        return {
          embeddings: [[0, 1]],
          model: 'text-embedding-3-small',
          inputTokens: 50, // a single short lesson — fractions of a hundredth of a cent
        };
      },
      estimateCost(inputTokens: number) {
        return (inputTokens / 1_000_000) * 0.02;
      },
      async healthCheck() {
        return { ok: true };
      },
    };
    const metered = new MeteredEmbeddingProvider(inner, s.workspaceA, 'platform');
    await metered.embed({ texts: ['a'] });

    const rows = await db
      .select()
      .from(usageLog)
      .where(eq(usageLog.workspaceId, s.workspaceA));
    const row = rows.find((r) => r.kind === 'embedding.embed');
    expect(row).toBeDefined();
    expect(row!.costEstimateCents).toBe(0);
  });
});
