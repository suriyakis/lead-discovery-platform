import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db/client';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import { setSecret } from '@/lib/services/secrets';
import { SerpAPIError, SerpAPIProvider } from '@/lib/search/serpapi';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  ownerB: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const ownerB = await seedUser({ email: 'ownerB@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  return { workspaceA, workspaceB, ownerA, ownerB };
}

function ctx(workspaceId: bigint, userId: string): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role: 'owner' });
}

/** Build a fake fetch that returns a fixed JSON response. */
function fakeFetch(
  bodyOrError:
    | { ok: true; status?: number; json: unknown }
    | { ok: false; status: number; text: string },
): typeof fetch {
  return (async () => {
    if (bodyOrError.ok === false) {
      return new Response(bodyOrError.text, {
        status: bodyOrError.status,
        statusText: 'error',
      });
    }
    return new Response(JSON.stringify(bodyOrError.json), {
      status: bodyOrError.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const SAMPLE_BODY = {
  search_metadata: { status: 'Success', id: 'sample' },
  organic_results: [
    {
      position: 1,
      title: 'Example One',
      link: 'https://example.com/one',
      snippet: 'first result',
    },
    {
      position: 2,
      title: 'Example Two',
      link: 'https://www.example.org/two',
      snippet: 'second result',
    },
  ],
};

beforeEach(async () => {
  await truncateAll();
  delete process.env.SERPAPI_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- key resolution ----------------------------------------------------

describe('SerpAPIProvider — key resolution', () => {
  it('uses workspace-supplied key (source=workspace)', async () => {
    const s = await setup();
    await setSecret(ctx(s.workspaceA, s.ownerA), 'serpapi.apiKey', 'WS-KEY');
    const provider = new SerpAPIProvider({ fetchImpl: fakeFetch({ ok: true, json: SAMPLE_BODY }) });
    const out = await provider.search(ctx(s.workspaceA, s.ownerA), 'foo');
    expect(out.usage.keySource).toBe('workspace');
    expect(out.results).toHaveLength(2);
  });

  it('falls back to platform env key (source=platform)', async () => {
    const s = await setup();
    process.env.SERPAPI_KEY = 'PLATFORM-KEY';
    const provider = new SerpAPIProvider({ fetchImpl: fakeFetch({ ok: true, json: SAMPLE_BODY }) });
    const out = await provider.search(ctx(s.workspaceA, s.ownerA), 'foo');
    expect(out.usage.keySource).toBe('platform');
  });

  it('throws no_key when neither configured', async () => {
    const s = await setup();
    const provider = new SerpAPIProvider({ fetchImpl: fakeFetch({ ok: true, json: SAMPLE_BODY }) });
    await expect(provider.search(ctx(s.workspaceA, s.ownerA), 'foo')).rejects.toMatchObject({
      code: 'no_key',
    });
  });

  it('workspace key isolated per workspace', async () => {
    const s = await setup();
    await setSecret(ctx(s.workspaceA, s.ownerA), 'serpapi.apiKey', 'A-KEY');
    const provider = new SerpAPIProvider({ fetchImpl: fakeFetch({ ok: true, json: SAMPLE_BODY }) });
    // workspace B has no key and no env fallback → should fail
    await expect(provider.search(ctx(s.workspaceB, s.ownerB), 'foo')).rejects.toMatchObject({
      code: 'no_key',
    });
    // workspace A succeeds
    const out = await provider.search(ctx(s.workspaceA, s.ownerA), 'foo');
    expect(out.usage.keySource).toBe('workspace');
  });
});

// ---- result mapping ----------------------------------------------------

describe('SerpAPIProvider — result mapping', () => {
  it('maps organic_results to SearchResult shape with rank/title/url/domain/snippet', async () => {
    const s = await setup();
    await setSecret(ctx(s.workspaceA, s.ownerA), 'serpapi.apiKey', 'K');
    const provider = new SerpAPIProvider({ fetchImpl: fakeFetch({ ok: true, json: SAMPLE_BODY }) });
    const out = await provider.search(ctx(s.workspaceA, s.ownerA), 'foo');
    expect(out.results[0]).toMatchObject({
      rank: 1,
      title: 'Example One',
      url: 'https://example.com/one',
      domain: 'example.com',
      snippet: 'first result',
    });
    expect(out.results[1]?.domain).toBe('www.example.org');
  });

  it('caps results at maxResults', async () => {
    const s = await setup();
    await setSecret(ctx(s.workspaceA, s.ownerA), 'serpapi.apiKey', 'K');
    const big = {
      organic_results: Array.from({ length: 20 }, (_, i) => ({
        position: i + 1,
        title: `T${i}`,
        link: `https://example.com/${i}`,
        snippet: `s${i}`,
      })),
    };
    const provider = new SerpAPIProvider({ fetchImpl: fakeFetch({ ok: true, json: big }) });
    const out = await provider.search(ctx(s.workspaceA, s.ownerA), 'foo', { maxResults: 5 });
    expect(out.results).toHaveLength(5);
  });

  it('survives missing organic_results (empty result set)', async () => {
    const s = await setup();
    await setSecret(ctx(s.workspaceA, s.ownerA), 'serpapi.apiKey', 'K');
    const provider = new SerpAPIProvider({
      fetchImpl: fakeFetch({ ok: true, json: { search_metadata: { status: 'ok' } } }),
    });
    const out = await provider.search(ctx(s.workspaceA, s.ownerA), 'foo');
    expect(out.results).toEqual([]);
  });
});

// ---- error mapping -----------------------------------------------------

describe('SerpAPIProvider — error mapping', () => {
  it('401 maps to unauthorized', async () => {
    const s = await setup();
    await setSecret(ctx(s.workspaceA, s.ownerA), 'serpapi.apiKey', 'K');
    const provider = new SerpAPIProvider({
      fetchImpl: fakeFetch({ ok: false, status: 401, text: 'invalid api key' }),
    });
    await expect(provider.search(ctx(s.workspaceA, s.ownerA), 'foo')).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
    });
  });

  it('429 maps to rate_limited', async () => {
    const s = await setup();
    await setSecret(ctx(s.workspaceA, s.ownerA), 'serpapi.apiKey', 'K');
    const provider = new SerpAPIProvider({
      fetchImpl: fakeFetch({ ok: false, status: 429, text: 'too many' }),
    });
    await expect(provider.search(ctx(s.workspaceA, s.ownerA), 'foo')).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('500 maps to upstream_error', async () => {
    const s = await setup();
    await setSecret(ctx(s.workspaceA, s.ownerA), 'serpapi.apiKey', 'K');
    const provider = new SerpAPIProvider({
      fetchImpl: fakeFetch({ ok: false, status: 503, text: 'service unavailable' }),
    });
    await expect(provider.search(ctx(s.workspaceA, s.ownerA), 'foo')).rejects.toMatchObject({
      code: 'upstream_error',
    });
  });

  it('body-level error field maps to provider_error', async () => {
    const s = await setup();
    await setSecret(ctx(s.workspaceA, s.ownerA), 'serpapi.apiKey', 'K');
    const provider = new SerpAPIProvider({
      fetchImpl: fakeFetch({ ok: true, json: { error: 'No results.' } }),
    });
    await expect(provider.search(ctx(s.workspaceA, s.ownerA), 'foo')).rejects.toMatchObject({
      code: 'provider_error',
    });
  });

  it('rejects empty query', async () => {
    const s = await setup();
    await setSecret(ctx(s.workspaceA, s.ownerA), 'serpapi.apiKey', 'K');
    const provider = new SerpAPIProvider({ fetchImpl: fakeFetch({ ok: true, json: SAMPLE_BODY }) });
    await expect(provider.search(ctx(s.workspaceA, s.ownerA), '   ')).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

// ---- testConnection ----------------------------------------------------

describe('SerpAPIProvider — testConnection', () => {
  it('returns ok=true on success', async () => {
    const s = await setup();
    await setSecret(ctx(s.workspaceA, s.ownerA), 'serpapi.apiKey', 'K');
    const provider = new SerpAPIProvider({ fetchImpl: fakeFetch({ ok: true, json: SAMPLE_BODY }) });
    const r = await provider.testConnection(ctx(s.workspaceA, s.ownerA));
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('workspace');
  });

  it('returns ok=false with detail on failure', async () => {
    const s = await setup();
    const provider = new SerpAPIProvider({ fetchImpl: fakeFetch({ ok: true, json: SAMPLE_BODY }) });
    const r = await provider.testConnection(ctx(s.workspaceA, s.ownerA));
    expect(r.ok).toBe(false);
    expect(r.detail).toBeTruthy();
  });
});

// ---- error type --------------------------------------------------------

describe('SerpAPIError', () => {
  it('all thrown errors are SerpAPIError instances', async () => {
    const s = await setup();
    const provider = new SerpAPIProvider({ fetchImpl: fakeFetch({ ok: true, json: SAMPLE_BODY }) });
    try {
      await provider.search(ctx(s.workspaceA, s.ownerA), 'foo');
      expect.unreachable('should have thrown no_key');
    } catch (err) {
      expect(err).toBeInstanceOf(SerpAPIError);
    }
  });
});
