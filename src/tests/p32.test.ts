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
  getEmbeddingProvider,
  getEmbeddingProviderForCtx,
  MockEmbeddingProvider,
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
    const provider = await getEmbeddingProviderForCtx({
      workspaceId: s.workspaceA,
    });
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
    const provider = await getEmbeddingProviderForCtx({
      workspaceId: s.workspaceA,
    });
    expect(provider).toBeInstanceOf(OpenAIEmbeddingProvider);
    expect(
      (provider as unknown as { apiKey: string }).apiKey,
    ).toBe('sk-platform');
  });

  it('returns the cached provider (singleton) when no workspace override', async () => {
    const s = await setup();
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-platform';
    const a = await getEmbeddingProviderForCtx({ workspaceId: s.workspaceA });
    const b = getEmbeddingProvider();
    expect(a).toBe(b); // same singleton instance
  });

  it('returns a NEW (uncached) instance per call when workspace overrides', async () => {
    const s = await setup();
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-platform';
    await setSecret(ctx(s.workspaceA, s.ownerA), 'openai.apiKey', 'sk-workspace');
    const a = await getEmbeddingProviderForCtx({ workspaceId: s.workspaceA });
    const b = await getEmbeddingProviderForCtx({ workspaceId: s.workspaceA });
    // Both use the workspace key, but the singleton cache isn't poisoned —
    // each call constructs a fresh provider so changing the secret takes
    // effect immediately.
    expect(a).not.toBe(b);
    expect((a as unknown as { apiKey: string }).apiKey).toBe('sk-workspace');
    expect((b as unknown as { apiKey: string }).apiKey).toBe('sk-workspace');
  });
});
