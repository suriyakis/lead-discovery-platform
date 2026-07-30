// Platform-wide provider/model defaults + the DeepSeek provider.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db/client';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import {
  PlatformSettingsError,
  getPlatformSetting,
  getPlatformSettings,
  setPlatformSettings,
} from '@/lib/services/platform-settings';
import {
  resolveActiveProvider,
  resolvePlatformModel,
  updateProviderSettings,
} from '@/lib/services/provider-settings';
import { DeepSeekAIProvider } from '@/lib/ai';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  ownerA: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'platset@test.local' });
  const workspaceA = await seedWorkspace({ name: 'PS', ownerUserId: ownerA });
  return { workspaceA, ownerA };
}

function ctx(
  workspaceId: bigint,
  userId: string,
  role: WorkspaceContext['role'],
): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  delete process.env.TEST_AI_PROVIDER_FALLBACK;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('platform settings service', () => {
  it('super-admin gating + validation', async () => {
    const s = await setup();
    const owner = ctx(s.workspaceA, s.ownerA, 'owner');
    const sa = ctx(s.workspaceA, s.ownerA, 'super_admin');

    await expect(
      setPlatformSettings(owner, { 'ai.provider': 'anthropic' }),
    ).rejects.toThrow(/Permission denied/);
    await expect(
      setPlatformSettings(sa, { 'ai.provider': 'not-a-vendor' }),
    ).rejects.toThrow(PlatformSettingsError);
    await expect(
      setPlatformSettings(sa, { 'ai.provider': 'mock' }),
    ).rejects.toThrow(/invalid value/);
    await expect(
      setPlatformSettings(sa, { 'made.up': 'x' }),
    ).rejects.toThrow(/unknown platform setting/);

    await setPlatformSettings(sa, {
      'ai.provider': 'deepseek',
      'ai.model': 'deepseek-v4-flash',
    });
    expect(await getPlatformSetting('ai.provider')).toBe('deepseek');
    const all = await getPlatformSettings();
    expect(all['ai.model']).toBe('deepseek-v4-flash');

    // null clears
    await setPlatformSettings(sa, { 'ai.model': null });
    expect(await getPlatformSetting('ai.model')).toBeNull();
  });

  it('resolveActiveProvider: workspace > platform > env > default', async () => {
    const s = await setup();
    const owner = ctx(s.workspaceA, s.ownerA, 'owner');
    const sa = ctx(s.workspaceA, s.ownerA, 'super_admin');

    // env only
    let r = await resolveActiveProvider(owner, 'ai', 'openai');
    expect(r).toEqual({ id: 'openai', source: 'env' });

    // platform beats env
    await setPlatformSettings(sa, { 'ai.provider': 'deepseek' });
    r = await resolveActiveProvider(owner, 'ai', 'openai');
    expect(r).toEqual({ id: 'deepseek', source: 'platform' });

    // workspace beats platform
    await updateProviderSettings(owner, { aiProvider: 'anthropic' });
    r = await resolveActiveProvider(owner, 'ai', 'openai');
    expect(r).toEqual({ id: 'anthropic', source: 'workspace' });
  });

  it('resolvePlatformModel: platform model beats env, env is fallback', async () => {
    const s = await setup();
    const sa = ctx(s.workspaceA, s.ownerA, 'super_admin');

    expect(await resolvePlatformModel('ai', 'env-model')).toBe('env-model');
    await setPlatformSettings(sa, { 'ai.model': 'deepseek-v4-flash' });
    expect(await resolvePlatformModel('ai', 'env-model')).toBe('deepseek-v4-flash');
    expect(await resolvePlatformModel('research', undefined)).toBeUndefined();
  });

  it('auto-detect sees console keys, not just env vars', async () => {
    const s = await setup();
    const sa = ctx(s.workspaceA, s.ownerA, 'super_admin');
    const owner = ctx(s.workspaceA, s.ownerA, 'owner');
    const { setPlatformSecret, deletePlatformSecret } = await import(
      '@/lib/services/secrets'
    );
    const { detectSystemDefaultProvider } = await import(
      '@/lib/services/provider-settings'
    );

    // Nothing configured anywhere (vitest env blanks vendor keys) → mock.
    expect((await detectSystemDefaultProvider('ai')).id).toBe('mock');

    // ONLY an Anthropic key in the console: detection must pick anthropic,
    // not blindly return gemini (the preference-order head).
    await setPlatformSecret(sa, 'anthropic.apiKey', 'sk-ant-test');
    expect((await detectSystemDefaultProvider('ai')).id).toBe('anthropic');
    // resolveActiveProvider bottoms out in the same detection.
    expect((await resolveActiveProvider(owner, 'ai', undefined)).id).toBe('anthropic');

    // A gemini console key appears → preference order applies again.
    await setPlatformSecret(sa, 'gemini.apiKey', 'AIza-test');
    expect((await detectSystemDefaultProvider('ai')).id).toBe('gemini');

    await deletePlatformSecret(sa, 'anthropic.apiKey');
    await deletePlatformSecret(sa, 'gemini.apiKey');
  });
});

describe('DeepSeekAIProvider', () => {
  it('is OpenAI-compatible with its own id, defaults and pricing', () => {
    const p = new DeepSeekAIProvider({ apiKey: 'sk-test' });
    expect(p.id).toBe('deepseek');
    // deepseek-chat was RETIRED 2026-07-24; v4-flash is the default now.
    expect(p.model).toBe('deepseek-v4-flash');

    // $0.14/M in + $0.28/M out for v4-flash
    const flashCost = p.estimateCost({
      model: 'deepseek-v4-flash',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(flashCost).toBeCloseTo(0.14 + 0.28, 5);

    const proCost = p.estimateCost({
      model: 'deepseek-v4-pro',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(proCost).toBeGreaterThan(flashCost);
  });
});
