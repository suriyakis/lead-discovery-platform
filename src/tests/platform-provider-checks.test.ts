// PC-02 / I124: the /admin/providers live checks test the PLATFORM tier
// only. A tenant's own (BYOK) key or provider override in the admin's
// current workspace must never make a broken platform key, vendor or
// model look healthy.
//
// Fixtures are written straight into the tables (not through the
// super-admin services) so the test does not depend on how those
// services are authorised. No live vendor is called: fetch is stubbed
// and answers by key.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/auth';
import { platformSettings } from '@/lib/db/schema/platform-settings';
import { platformSecrets, workspaceSecrets } from '@/lib/db/schema/secrets';
import { workspaceProviderSettings } from '@/lib/db/schema/workspaces';
import { MockAIProvider, _setAIProviderForTests, getPlatformAIProvider } from '@/lib/ai';
import { encryptValue } from '@/lib/services/crypto';
import {
  PLATFORM_PROVIDER_KEYS,
  PlatformProviderKeySchema,
  checkPlatformAIProvider,
  checkPlatformProviderKey,
  describePlatformAICheck,
  describePlatformKeyCheck,
  type PlatformProviderSecretKey,
} from '@/lib/services/platform-provider-checks';
import {
  resolveActiveProvider,
  resolvePlatformProvider,
} from '@/lib/services/provider-settings';
import { resolvePlatformProviderKey, resolveProviderKey } from '@/lib/services/secrets';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

// ---- env hygiene ----------------------------------------------------------

const ENV_KEYS = [
  'AI_PROVIDER',
  'AI_MODEL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'SERPAPI_KEY',
  'PERPLEXITY_API_KEY',
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'GEMINI_BASE_URL',
  'DEEPSEEK_BASE_URL',
] as const;
let savedEnv: Record<string, string | undefined> = {};

// ---- fixtures -------------------------------------------------------------

interface Setup {
  /** The super-admin running the console. */
  admin: string;
  /** Tenant A: the admin's switcher points here (god mode), and it has
   *  its own keys and provider override. */
  workspaceA: bigint;
}

async function setup(): Promise<Setup> {
  const admin = await seedUser({ email: 'console-admin@test.local', role: 'super_admin' });
  const tenantOwner = await seedUser({ email: 'tenant-owner@test.local' });
  const workspaceA = await seedWorkspace({ name: 'Tenant A', ownerUserId: tenantOwner });
  await db.update(users).set({ activeWorkspaceId: workspaceA }).where(eq(users.id, admin));
  return { admin, workspaceA };
}

async function seedPlatformKey(key: string, value: string): Promise<void> {
  await db.insert(platformSecrets).values({
    key,
    encryptedValue: encryptValue(value),
    scope: key.split('.')[0]!,
  });
}

async function seedByokKey(workspaceId: bigint, key: string, value: string): Promise<void> {
  await db.insert(workspaceSecrets).values({
    workspaceId,
    key,
    encryptedValue: encryptValue(value),
    scope: key.split('.')[0]!,
  });
}

async function seedPlatformSetting(key: string, value: string): Promise<void> {
  await db.insert(platformSettings).values({ key, value });
}

// ---- fetch stub -----------------------------------------------------------

interface SeenRequest {
  url: string;
  /** Everything a key could hide in: url, headers and body. */
  raw: string;
  key: string | null;
  body: Record<string, unknown> | null;
}

let seen: SeenRequest[] = [];
/** Keys the stubbed vendors accept. Anything else gets a 401. */
let acceptedKeys = new Set<string>();
let networkDown = false;

function keyOf(url: string, headers: Record<string, string>): string | null {
  const auth = headers.authorization ?? headers.Authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  const xApiKey = headers['x-api-key'];
  if (xApiKey) return xApiKey;
  const u = new URL(url);
  return u.searchParams.get('key') ?? u.searchParams.get('api_key');
}

const OK_BODY = {
  model: 'stub-model',
  // Anthropic messages
  content: [{ type: 'text', text: 'pong' }],
  // OpenAI / DeepSeek chat completions
  choices: [{ message: { content: 'pong' } }],
  // Gemini generateContent
  candidates: [{ content: { parts: [{ text: 'pong' }] } }],
  usage: {},
};

function installFetchStub(): void {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const key = keyOf(url, headers);
    seen.push({
      url,
      raw: `${url} ${JSON.stringify(headers)} ${bodyText}`,
      key,
      body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null,
    });
    if (networkDown) throw new TypeError('fetch failed');
    if (key && acceptedKeys.has(key)) {
      return new Response(JSON.stringify(OK_BODY), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{"error":{"message":"invalid x-api-key"}}', { status: 401 });
  });
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  _setAIProviderForTests(null);
  seen = [];
  acceptedKeys = new Set();
  networkDown = false;
  installFetchStub();
  await truncateAll();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  _setAIProviderForTests(null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- platform-only key resolution ------------------------------------------

describe('resolvePlatformProviderKey', () => {
  it('reads the console key, then the env var, and never a workspace key', async () => {
    const s = await setup();
    const K = 'anthropic.apiKey';
    await seedByokKey(s.workspaceA, K, 'byok-a');
    expect(await resolvePlatformProviderKey(K, 'ANTHROPIC_API_KEY')).toBeNull();

    process.env.ANTHROPIC_API_KEY = '  env-key  ';
    expect(await resolvePlatformProviderKey(K, 'ANTHROPIC_API_KEY')).toEqual({
      key: 'env-key',
      source: 'env',
    });

    await seedPlatformKey(K, 'console-key');
    expect(await resolvePlatformProviderKey(K, 'ANTHROPIC_API_KEY')).toEqual({
      key: 'console-key',
      source: 'console',
    });

    // The runtime resolver still puts the tenant's own key first.
    expect(await resolveProviderKey({ workspaceId: s.workspaceA }, K, 'ANTHROPIC_API_KEY')).toEqual(
      { key: 'byok-a', source: 'workspace' },
    );
  });

  it('treats a blank env var as not set', async () => {
    process.env.ANTHROPIC_API_KEY = '   ';
    expect(await resolvePlatformProviderKey('anthropic.apiKey', 'ANTHROPIC_API_KEY')).toBeNull();
  });
});

// ---- per-vendor "Test key" -------------------------------------------------

describe('checkPlatformProviderKey', () => {
  it('the catalogue covers exactly the keys the schema accepts', () => {
    expect(PLATFORM_PROVIDER_KEYS.map((p) => p.secretKey).sort()).toEqual(
      [...PlatformProviderKeySchema.options].sort(),
    );
  });

  it.each(PlatformProviderKeySchema.options)(
    '%s: a valid tenant BYOK key does not hide a broken platform key',
    async (secretKey: PlatformProviderSecretKey) => {
      const s = await setup();
      const byok = `byok-valid-${secretKey}`;
      const platform = `platform-broken-${secretKey}`;
      await seedByokKey(s.workspaceA, secretKey, byok);
      await seedPlatformKey(secretKey, platform);
      acceptedKeys.add(byok);

      const r = await checkPlatformProviderKey(secretKey);

      expect(r.status).toBe('failed');
      expect(r.source).toBe('console');
      expect(r.httpStatus).toBe(401);
      expect(r.authRejected).toBe(true);
      expect(seen.length).toBeGreaterThan(0);
      for (const req of seen) {
        expect(req.key).toBe(platform);
        expect(req.raw).not.toContain(byok);
      }
      const banner = describePlatformKeyCheck(r);
      expect(banner.ok).toBe(false);
      expect(banner.message).toContain('platform key FAILED (console key)');
      expect(banner.message).toContain('every workspace without its own key is affected');
    },
  );

  it('falls back to the env var and says so', async () => {
    const s = await setup();
    await seedByokKey(s.workspaceA, 'openai.apiKey', 'byok-openai');
    process.env.OPENAI_API_KEY = 'env-openai';
    acceptedKeys.add('env-openai');

    const r = await checkPlatformProviderKey('openai.apiKey');

    expect(r).toMatchObject({ status: 'ok', source: 'env', authRejected: false });
    expect(seen.map((q) => q.key)).toEqual(['env-openai']);
    expect(describePlatformKeyCheck(r)).toEqual({
      ok: true,
      message: 'OpenAI platform key OK (server env var OPENAI_API_KEY).',
    });
  });

  it('prefers the console key over the env var', async () => {
    await seedPlatformKey('mistral.apiKey', 'console-mistral');
    process.env.MISTRAL_API_KEY = 'env-mistral';
    acceptedKeys.add('console-mistral');

    const r = await checkPlatformProviderKey('mistral.apiKey');

    expect(r).toMatchObject({ status: 'ok', source: 'console' });
    expect(seen.map((q) => q.key)).toEqual(['console-mistral']);
  });

  it('reports a missing platform key without calling the vendor, even when a tenant has one', async () => {
    const s = await setup();
    await seedByokKey(s.workspaceA, 'deepseek.apiKey', 'byok-deepseek');
    acceptedKeys.add('byok-deepseek');

    const r = await checkPlatformProviderKey('deepseek.apiKey');

    expect(r).toMatchObject({ status: 'missing', source: null });
    expect(seen).toEqual([]);
    const banner = describePlatformKeyCheck(r);
    expect(banner.ok).toBe(false);
    expect(banner.message).toContain('no platform key');
    expect(banner.message).toContain('DEEPSEEK_API_KEY');
    expect(banner.message).toContain('Workspace keys (BYOK) are never tested here');
  });

  it('a network failure is a failure, not a rejected key', async () => {
    await seedPlatformKey('serpapi.apiKey', 'console-serp');
    networkDown = true;

    const r = await checkPlatformProviderKey('serpapi.apiKey');

    expect(r).toMatchObject({ status: 'failed', httpStatus: null, authRejected: false });
    expect(r.detail).toContain('fetch failed');
    expect(describePlatformKeyCheck(r).message).not.toContain('rejected the key');
  });

  it("recognises Gemini's 400 API_KEY_INVALID as a rejected key", async () => {
    await seedPlatformKey('gemini.apiKey', 'console-gemini');
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}',
          { status: 400 },
        ),
    );

    const r = await checkPlatformProviderKey('gemini.apiKey');

    expect(r).toMatchObject({ status: 'failed', httpStatus: 400, authRejected: true });
  });

  it('rejects an unknown key name', async () => {
    await expect(
      checkPlatformProviderKey('cohere.apiKey' as PlatformProviderSecretKey),
    ).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});

// ---- "Test platform AI default" --------------------------------------------

describe('checkPlatformAIProvider', () => {
  it("uses the platform default vendor and model, not the admin's active workspace", async () => {
    const s = await setup();
    // Platform default: Anthropic + Sonnet 5, console key.
    await seedPlatformSetting('ai.provider', 'anthropic');
    await seedPlatformSetting('ai.model', 'claude-sonnet-5');
    await seedPlatformKey('anthropic.apiKey', 'platform-anthropic');
    // Tenant A (where the admin's switcher points) runs OpenAI on its own
    // key, and also carries its own Anthropic key.
    await db
      .insert(workspaceProviderSettings)
      .values({ workspaceId: s.workspaceA, aiProvider: 'openai', aiModel: 'gpt-5.5' });
    await seedByokKey(s.workspaceA, 'openai.apiKey', 'byok-openai');
    await seedByokKey(s.workspaceA, 'anthropic.apiKey', 'byok-anthropic');
    acceptedKeys = new Set(['platform-anthropic', 'byok-openai', 'byok-anthropic']);

    // The runtime would run tenant A on its own override...
    expect(await resolveActiveProvider({ workspaceId: s.workspaceA }, 'ai', undefined)).toEqual({
      id: 'openai',
      source: 'workspace',
    });

    // ...but the console tests the platform default.
    const r = await checkPlatformAIProvider();

    expect(r).toMatchObject({
      status: 'ok',
      vendor: 'anthropic',
      vendorSource: 'platform',
      model: 'claude-sonnet-5',
      keySource: 'console',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain('api.anthropic.com');
    expect(seen[0]!.key).toBe('platform-anthropic');
    expect(seen[0]!.body?.model).toBe('claude-sonnet-5');
    expect(describePlatformAICheck(r)).toEqual({
      ok: true,
      message:
        'Platform AI default OK: anthropic / claude-sonnet-5 (vendor set here in the console; console key).',
    });
  });

  it('reports a broken platform key even when the tenant key for the same vendor works', async () => {
    const s = await setup();
    await seedPlatformSetting('ai.provider', 'anthropic');
    await seedPlatformKey('anthropic.apiKey', 'platform-broken');
    await seedByokKey(s.workspaceA, 'anthropic.apiKey', 'byok-anthropic');
    acceptedKeys.add('byok-anthropic');

    const r = await checkPlatformAIProvider();

    expect(r).toMatchObject({ status: 'failed', httpStatus: 401, authRejected: true });
    expect(seen.map((q) => q.key)).toEqual(['platform-broken']);
    const banner = describePlatformAICheck(r);
    expect(banner.ok).toBe(false);
    expect(banner.message).toContain('Platform AI default FAILED: anthropic / claude-haiku-4-5');
    expect(banner.message).toContain('every workspace without its own key is affected');
  });

  it('follows the env tier when the console sets nothing', async () => {
    process.env.AI_PROVIDER = 'openai';
    process.env.AI_MODEL = 'gpt-5.5';
    process.env.OPENAI_API_KEY = 'env-openai';
    acceptedKeys.add('env-openai');

    const r = await checkPlatformAIProvider();

    expect(r).toMatchObject({
      status: 'ok',
      vendor: 'openai',
      vendorSource: 'env',
      model: 'gpt-5.5',
      keySource: 'env',
      keyEnvVar: 'OPENAI_API_KEY',
    });
    expect(seen[0]!.body?.model).toBe('gpt-5.5');
    expect(describePlatformAICheck(r).message).toContain(
      'vendor server env var AI_PROVIDER; server env var OPENAI_API_KEY',
    );
  });

  it("skips a model that belongs to another vendor, like the status table", async () => {
    await seedPlatformSetting('ai.provider', 'anthropic');
    await seedPlatformKey('anthropic.apiKey', 'platform-anthropic');
    process.env.AI_MODEL = 'gpt-5.5';
    acceptedKeys.add('platform-anthropic');

    const r = await checkPlatformAIProvider();

    expect(r).toMatchObject({ status: 'ok', vendor: 'anthropic', model: 'claude-haiku-4-5' });
    expect(seen[0]!.body?.model).toBe('claude-haiku-4-5');
  });

  it('reports a missing platform key without falling back to a tenant key', async () => {
    const s = await setup();
    await seedPlatformSetting('ai.provider', 'deepseek');
    await seedByokKey(s.workspaceA, 'deepseek.apiKey', 'byok-deepseek');
    acceptedKeys.add('byok-deepseek');

    const r = await checkPlatformAIProvider();

    expect(r).toMatchObject({ status: 'missing', vendor: 'deepseek', keyEnvVar: 'DEEPSEEK_API_KEY' });
    expect(seen).toEqual([]);
    expect(describePlatformAICheck(r)).toEqual({
      ok: false,
      message:
        'Platform AI default deepseek (vendor set here in the console) has no platform key (console or server env var DEEPSEEK_API_KEY).',
    });
  });

  it('an unknown vendor in the env selector is a readable failure', async () => {
    process.env.AI_PROVIDER = 'cohere';

    const r = await checkPlatformAIProvider();

    expect(r).toMatchObject({ status: 'failed', vendor: null });
    expect(describePlatformAICheck(r).message).toContain(
      'Platform AI default could not be resolved: Unknown AI provider id from the platform cascade: cohere',
    );
  });

  it('is the keyless mock when nothing is configured outside production', async () => {
    const r = await checkPlatformAIProvider();
    expect(r).toMatchObject({ status: 'ok', vendor: 'mock', vendorSource: 'default', keySource: null });
    expect(describePlatformAICheck(r).message).toContain('mock / mock-1');
    expect(describePlatformAICheck(r).message).toContain('no key needed');
    expect(seen).toEqual([]);
  });

  it('ignores the test-injected provider stub (always resolves the real platform tier)', async () => {
    _setAIProviderForTests(new MockAIProvider());
    await seedPlatformSetting('ai.provider', 'gemini');
    await seedPlatformKey('gemini.apiKey', 'platform-gemini');
    acceptedKeys.add('platform-gemini');

    const res = await getPlatformAIProvider();

    expect(res.vendor).toBe('gemini');
    expect(res.provider?.id).toBe('gemini');
  });
});

describe('resolvePlatformProvider', () => {
  it('is the cascade below the workspace tier', async () => {
    const s = await setup();
    await db
      .insert(workspaceProviderSettings)
      .values({ workspaceId: s.workspaceA, aiProvider: 'openai' });

    expect(await resolvePlatformProvider('ai', 'gemini')).toEqual({ id: 'gemini', source: 'env' });
    await seedPlatformSetting('ai.provider', 'anthropic');
    expect(await resolvePlatformProvider('ai', 'gemini')).toEqual({
      id: 'anthropic',
      source: 'platform',
    });
    // The workspace tier still wins at runtime.
    expect(await resolveActiveProvider({ workspaceId: s.workspaceA }, 'ai', 'gemini')).toEqual({
      id: 'openai',
      source: 'workspace',
    });
  });
});

// ---- the console page -------------------------------------------------------

describe('/admin/providers live checks (static)', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const src = readFileSync(path.join(repoRoot, 'src/app/admin/providers/page.tsx'), 'utf8');

  /** Source of one inline server action, up to the next one / the JSX. */
  function actionBody(name: string): string {
    const start = src.indexOf(`async function ${name}(`);
    expect(start, `${name} not found in providers/page.tsx`).toBeGreaterThan(-1);
    const rest = src.slice(start + 1);
    const end = rest.search(/\n {2}(async function |\/\/ |return \()/);
    return rest.slice(0, end === -1 ? undefined : end);
  }

  it('the page does not reach for workspace-scoped resolvers', () => {
    expect(src).not.toMatch(/\bgetAIProviderForCtx\b/);
    expect(src).not.toMatch(/\bresolveProviderKey\b/);
    expect(src).not.toMatch(/\bresolveActiveProvider\b/);
  });

  it.each(['testAI', 'testVendorKey'])(
    '%s is guarded by requirePlatformAdmin and never resolves a workspace',
    (name) => {
      const body = actionBody(name);
      expect(body).toContain("'use server'");
      expect(body).toMatch(/await requirePlatformAdmin\(\)/);
      expect(body).not.toMatch(/getWorkspaceContext|isSuperAdmin|resolveProviderKey/);
    },
  );

  it('the status table uses the same platform resolver as the AI check', () => {
    expect(src).toMatch(/await resolvePlatformProvider\(cap, ENV_SELECTORS\[cap\]\)/);
  });
});
