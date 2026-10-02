// PC-38 (I184, X10): the shared rate limiter.
//
// Acceptance covered here:
//   (1) limiter state survives a process restart: two limiter instances
//       (two processes, or one before and one after a deploy) share the
//       rate_limit_buckets table;
//   (4) the existing API thresholds are unchanged: /api/assistant 20 per
//       workspace and 10 per user a minute, /api/translate 30 and
//       /api/communication/suggest-reply 20 per workspace a minute.
// Plus: the window semantics (rejections are not counted, a window ends),
// concurrency, the in-process fallback when the database is unreachable,
// the new /api/signatures/redesign limit, the retention policy and the
// nginx snippet for the owner.
//
// The routes run for real against the lane's test database; only next-auth
// is mocked (like assistant-route.test.ts) and the AI is a stub.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { ZodSchema } from 'zod';
import { db } from '@/lib/db/client';
import { rateLimitBuckets } from '@/lib/db/schema/rate-limits';
import {
  _setAIProviderForTests,
  type AIGenInput,
  type AIGenOptions,
  type AIGenResult,
  type IAIProvider,
} from '@/lib/ai';
import {
  MemoryRateLimitStore,
  PostgresRateLimitStore,
  RateLimiter,
  _resetRateLimitsForTests,
  rateLimitCheck,
  retryAfterHeaders,
  type RateLimitStore,
} from '@/lib/rate-limit';
import { RETENTION_POLICIES } from '@/lib/services/retention';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

import { auth } from '@/lib/auth';
import { POST as assistantPOST } from '@/app/api/assistant/route';
import { POST as translatePOST } from '@/app/api/translate/route';
import { POST as suggestReplyPOST } from '@/app/api/communication/suggest-reply/route';
import { POST as redesignPOST } from '@/app/api/signatures/redesign/route';

const ROOT = path.resolve(__dirname, '../..');

type SessionUser = {
  id: string;
  role: 'member' | 'super_admin';
  accountStatus: 'pending' | 'active' | 'suspended' | 'rejected';
};
const authMock = auth as unknown as Mock<() => Promise<{ user: SessionUser } | null>>;

function signIn(id: string): void {
  authMock.mockResolvedValue({ user: { id, role: 'member', accountStatus: 'active' } });
}

function post(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

class StubAI implements IAIProvider {
  public readonly id = 'stub';
  public readonly model = 'stub-1';
  public calls = 0;
  async generateText(_input: AIGenInput, _options?: AIGenOptions): Promise<AIGenResult> {
    this.calls += 1;
    return { text: 'Hallo Welt', model: this.model, usage: { inputTokens: 1, outputTokens: 1 } };
  }
  async generateJson<T>(_input: AIGenInput, schema: ZodSchema<T>): Promise<T> {
    this.calls += 1;
    return schema.parse({ html: '<p>sig</p>' });
  }
  estimateCost(): number {
    return 0;
  }
  async healthCheck() {
    return { ok: true };
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function bucket(key: string) {
  const [row] = await db.select().from(rateLimitBuckets).where(eq(rateLimitBuckets.key, key));
  return row ?? null;
}

let seq = 0;
async function world(extraMembers = 0) {
  seq += 1;
  const ownerId = await seedUser({ email: `rl-owner-${seq}@test.local` });
  const memberIds: string[] = [];
  for (let i = 0; i < extraMembers; i++) {
    memberIds.push(await seedUser({ email: `rl-member-${seq}-${i}@test.local` }));
  }
  const workspaceId = await seedWorkspace({
    name: `RL ${seq}`,
    ownerUserId: ownerId,
    extraMembers: memberIds.map((userId) => ({ userId, role: 'member' as const })),
  });
  return { workspaceId, ownerId, memberIds };
}

beforeEach(async () => {
  await truncateAll();
  await _resetRateLimitsForTests();
  authMock.mockReset();
});

afterEach(() => {
  _setAIProviderForTests(null);
  vi.restoreAllMocks();
});

/** One check through a limiter instance: was it let in? */
async function allowed(l: RateLimiter, key: string, limit: number, windowMs: number) {
  return (await l.check(key, limit, windowMs)).allowed;
}

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- (1) shared state ------------------------------------------------------

describe('the limiter state lives in Postgres (PC-38 (1))', () => {
  it('two limiter instances share one window: a "restarted" process sees the old count', async () => {
    const before = new RateLimiter(new PostgresRateLimitStore());
    for (let i = 0; i < 3; i++) expect(await allowed(before, 't:restart', 3, 60_000)).toBe(true);
    expect(await allowed(before, 't:restart', 3, 60_000)).toBe(false);

    // A new process (after a deploy): a fresh instance with fresh memory.
    const after = new RateLimiter(new PostgresRateLimitStore());
    const d = await after.check('t:restart', 3, 60_000);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBeGreaterThan(55_000);
    expect(d.retryAfterMs).toBeLessThanOrEqual(60_000);

    // And the window is one row with the count it let through.
    const row = await bucket('t:restart');
    expect(row?.count).toBe(3);
    expect(row!.expiresAt.getTime() - row!.windowStart.getTime()).toBe(60_000);
  });

  it('the two instances count together while the window is open', async () => {
    const web = new RateLimiter(new PostgresRateLimitStore());
    const worker = new RateLimiter(new PostgresRateLimitStore());
    expect(await allowed(web, 't:pair', 4, 60_000)).toBe(true);
    expect(await allowed(worker, 't:pair', 4, 60_000)).toBe(true);
    expect(await allowed(web, 't:pair', 4, 60_000)).toBe(true);
    expect(await allowed(worker, 't:pair', 4, 60_000)).toBe(true);
    expect(await allowed(web, 't:pair', 4, 60_000)).toBe(false);
    expect(await allowed(worker, 't:pair', 4, 60_000)).toBe(false);
  });

  it('concurrent checks across instances let exactly `limit` through', async () => {
    const a = new RateLimiter(new PostgresRateLimitStore());
    const b = new RateLimiter(new PostgresRateLimitStore());
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => allowed(i % 2 === 0 ? a : b, 't:race', 5, 60_000)),
    );
    expect(results.filter(Boolean)).toHaveLength(5);
    expect((await bucket('t:race'))?.count).toBe(5);
  });

  it('a rejected request is not counted, and a new window opens when the old one ends', async () => {
    const l = new RateLimiter(new PostgresRateLimitStore());
    expect(await allowed(l, 't:window', 2, 400)).toBe(true);
    expect(await allowed(l, 't:window', 2, 400)).toBe(true);
    for (let i = 0; i < 5; i++) expect(await allowed(l, 't:window', 2, 400)).toBe(false);
    expect((await bucket('t:window'))?.count).toBe(2);
    await sleep(450);
    expect(await allowed(l, 't:window', 2, 400)).toBe(true);
    expect((await bucket('t:window'))?.count).toBe(1);
  });

  it('keys are independent', async () => {
    expect((await rateLimitCheck('t:a', 1, 60_000)).allowed).toBe(true);
    expect((await rateLimitCheck('t:a', 1, 60_000)).allowed).toBe(false);
    expect((await rateLimitCheck('t:b', 1, 60_000)).allowed).toBe(true);
  });

  it('the module function uses the shared table and says how long to wait', async () => {
    expect(await rateLimitCheck('t:module', 1, 120_000)).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(await bucket('t:module')).not.toBeNull();
    const d = await rateLimitCheck('t:module', 1, 120_000);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBeGreaterThan(110_000);
    expect(Number(retryAfterHeaders(d)['Retry-After'])).toBeGreaterThan(110);
    expect(retryAfterHeaders({ retryAfterMs: 0 })).toEqual({ 'Retry-After': '1' });
    expect(retryAfterHeaders({ retryAfterMs: 1001 })).toEqual({ 'Retry-After': '2' });
  });

  it('a call written the synchronous way does not compile (review: a Promise is always truthy)', () => {
    // Never called: this is a typecheck assertion (`pnpm typecheck` covers
    // the tests). If rateLimitCheck ever answered a bare boolean Promise
    // again, `!rateLimitCheck(...)` would compile and never limit; reading
    // `.allowed` off the un-awaited Promise is a type error instead.
    const staleCallSite = () =>
      // @ts-expect-error -- .allowed is not a property of Promise<RateLimitDecision>
      rateLimitCheck('t:stale', 1, 1000).allowed;
    expect(typeof staleCallSite).toBe('function');
  });

  it('rejects malformed input instead of writing a bad row', async () => {
    await expect(rateLimitCheck('', 1, 1000)).rejects.toThrow();
    await expect(rateLimitCheck('t:x', 0, 1000)).rejects.toThrow();
    await expect(rateLimitCheck('t:x', 1, 0)).rejects.toThrow();
    await expect(rateLimitCheck('k'.repeat(201), 1, 1000)).rejects.toThrow();
  });

  it('the CHECK constraints guard the table for any writer', async () => {
    const insert = (count: number, windowMs: number) =>
      db.execute(
        sql`INSERT INTO rate_limit_buckets (key, window_start, count, expires_at)
            VALUES ('t:check', now(), ${count}, now() + (${windowMs}::integer * interval '1 millisecond'))`,
      );
    await expect(insert(0, 1000)).rejects.toThrow(/rate_limit_buckets_count_check/);
    await expect(insert(1, 0)).rejects.toThrow(/rate_limit_buckets_window_check/);
  });

  it('falls back to an in-process window (never fails open) when the database is unreachable', async () => {
    const broken: RateLimitStore = {
      id: 'broken',
      hit: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      },
      reset: async () => {},
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const l = new RateLimiter(broken);
    expect(await allowed(l, 't:down', 2, 60_000)).toBe(true);
    expect(await allowed(l, 't:down', 2, 60_000)).toBe(true);
    expect(await allowed(l, 't:down', 2, 60_000)).toBe(false);
    // Logged once, not per request.
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).toMatch(/limiting in-process/);
  });

  it('the in-process store keeps the old semantics', async () => {
    let now = 1_000_000;
    const m = new MemoryRateLimitStore(() => now);
    expect((await m.hit('k', 2, 1000)).allowed).toBe(true);
    expect((await m.hit('k', 2, 1000)).allowed).toBe(true);
    const third = await m.hit('k', 2, 1000);
    expect(third).toEqual({ allowed: false, retryAfterMs: 1000 });
    now += 999;
    expect((await m.hit('k', 2, 1000)).allowed).toBe(false);
    now += 1;
    expect((await m.hit('k', 2, 1000)).allowed).toBe(true);
  });

  it('retention deletes windows that ended more than a day ago, nothing live', async () => {
    await db.execute(sql`
      INSERT INTO rate_limit_buckets (key, window_start, count, expires_at) VALUES
        ('t:ancient', now() - interval '3 days', 1, now() - interval '2 days'),
        ('t:recent', now() - interval '2 hours', 1, now() - interval '1 hour'),
        ('t:live', now(), 1, now() + interval '1 minute')
    `);
    const policy = RETENTION_POLICIES.find((p) => p.name === 'rate_limit_buckets.expired')!;
    expect(policy.retentionDays).toBe(1);
    const cutoff = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000);
    expect(await policy.deleteBatch(cutoff, 100)).toBe(1);
    const left = await db.select({ key: rateLimitBuckets.key }).from(rateLimitBuckets);
    expect(left.map((r) => r.key).sort()).toEqual(['t:live', 't:recent']);
  });
});

// ---- (4) the API thresholds -------------------------------------------------

describe('the API thresholds are unchanged (PC-38 (4))', { timeout: 120_000 }, () => {
  it('/api/assistant: 10 questions a minute per user', async () => {
    _setAIProviderForTests(new StubAI());
    const w = await world();
    signIn(w.ownerId);
    for (let i = 0; i < 10; i++) {
      const res = await assistantPOST(post('/api/assistant', { question: `q${i}` }));
      expect(res.status, `question ${i + 1}`).toBe(200);
    }
    const res = await assistantPOST(post('/api/assistant', { question: 'one more' }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('rate_limited');
    expect(res.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect((await bucket(`assistant:user:${w.ownerId}`))?.count).toBe(10);
  });

  it('/api/assistant: 20 questions a minute per workspace, whoever asks', async () => {
    _setAIProviderForTests(new StubAI());
    const w = await world(2);
    const [m1, m2] = w.memberIds as [string, string];
    for (const user of [w.ownerId, m1]) {
      signIn(user);
      for (let i = 0; i < 10; i++) {
        const res = await assistantPOST(post('/api/assistant', { question: `q${i}` }));
        expect(res.status).toBe(200);
      }
    }
    // The third person's first question: their own quota is untouched, the
    // workspace's is spent.
    signIn(m2);
    const res = await assistantPOST(post('/api/assistant', { question: 'mine' }));
    expect(res.status).toBe(429);
    const ws = await bucket(`assistant:ws:${w.workspaceId}`);
    expect(ws?.count).toBe(20);
    // The workspace said no first: m2's own window was never opened.
    expect(await bucket(`assistant:user:${m2}`)).toBeNull();
    expect(ws!.expiresAt.getTime() - ws!.windowStart.getTime()).toBe(60_000);
  });

  it('/api/translate: 30 translations a minute per workspace', async () => {
    _setAIProviderForTests(new StubAI());
    const w = await world();
    signIn(w.ownerId);
    for (let i = 0; i < 30; i++) {
      const res = await translatePOST(
        post('/api/translate', { body: `hello ${i}`, targetLanguage: 'de' }),
      );
      expect(res.status, `translation ${i + 1}`).not.toBe(429);
    }
    const res = await translatePOST(
      post('/api/translate', { body: 'hello', targetLanguage: 'de' }),
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'rate_limited' });
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(Number(res.headers.get('Retry-After'))).toBeLessThanOrEqual(60);
    // A rejected request is not counted.
    expect((await bucket(`translate:ws:${w.workspaceId}`))?.count).toBe(30);
  });

  it('/api/communication/suggest-reply: 20 suggestions a minute per workspace', async () => {
    _setAIProviderForTests(new StubAI());
    const w = await world();
    signIn(w.ownerId);
    for (let i = 0; i < 20; i++) {
      // No such thread: the limiter counts before the lookup refuses it.
      const res = await suggestReplyPOST(
        post('/api/communication/suggest-reply', { threadId: '1' }),
      );
      expect(res.status, `suggestion ${i + 1}`).not.toBe(429);
    }
    const res = await suggestReplyPOST(post('/api/communication/suggest-reply', { threadId: '1' }));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'rate_limited' });
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(Number(res.headers.get('Retry-After'))).toBeLessThanOrEqual(60);
    expect((await bucket(`suggest-reply:ws:${w.workspaceId}`))?.count).toBe(20);
  });

  it('a deploy does not reset a route window: the count is in the table, not the process', async () => {
    _setAIProviderForTests(new StubAI());
    const w = await world();
    signIn(w.ownerId);
    // Ten questions counted by "the old process" straight into the table.
    const old = new RateLimiter(new PostgresRateLimitStore());
    for (let i = 0; i < 10; i++) await allowed(old, `assistant:user:${w.ownerId}`, 10, 60_000);
    const res = await assistantPOST(post('/api/assistant', { question: 'after the deploy' }));
    expect(res.status).toBe(429);
  });

  it('new: /api/signatures/redesign allows 10 redesigns a minute per workspace', async () => {
    _setAIProviderForTests(new StubAI());
    const w = await world();
    signIn(w.ownerId);
    for (let i = 0; i < 10; i++) {
      const res = await redesignPOST(post('/api/signatures/redesign', { fullName: `N ${i}` }));
      expect(res.status, `redesign ${i + 1}`).not.toBe(429);
    }
    const res = await redesignPOST(post('/api/signatures/redesign', { fullName: 'N' }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('rate_limited');
  });
});

// ---- the nginx snippet (X10) -------------------------------------------------

describe('the nginx limit_req snippet for agregat (X10)', () => {
  const zones = readFileSync(
    path.join(ROOT, 'scripts/deploy/nginx/leadsonar-rate-limit-zones.conf'),
    'utf8',
  );
  const server = readFileSync(
    path.join(ROOT, 'scripts/deploy/nginx/leadsonar-rate-limit.conf'),
    'utf8',
  );

  it('limits /api/ and server-action POSTs (the Next-Action header) per client IP', () => {
    expect(zones).toMatch(/limit_req_zone \$leadsonar_api_key\s+zone=leadsonar_api:/);
    expect(zones).toMatch(/limit_req_zone \$leadsonar_action_key\s+zone=leadsonar_actions:/);
    expect(zones).toMatch(/map \$http_next_action \$leadsonar_action_key/);
    expect(server).toMatch(/limit_req zone=leadsonar_api burst=\d+ nodelay;/);
    expect(server).toMatch(/limit_req zone=leadsonar_actions burst=\d+ nodelay;/);
    expect(server).toMatch(/limit_req_status 429;/);
  });

  it('exempts the endpoints that mail clients, Stripe, monitors and sign-in call', () => {
    // Each is called by someone other than a signed-in person in a browser,
    // often many times from one address (an image proxy, a webhook sender,
    // the uptime monitor). The exemption regex names each route that exists.
    const exemptLine = zones.split('\n').find((l) => l.trim().startsWith('~^/api/('));
    expect(exemptLine, 'the exemption line of the /api/ key map').toBeTruthy();
    const group = /~\^\/api\/\(([^)]*)\)/.exec(exemptLine!)?.[1]?.split('|') ?? [];
    const routes: Record<string, string> = {
      track: 'track/[token]/route.ts',
      unsubscribe: 'unsubscribe/[token]/route.ts',
      'stripe/webhook': 'stripe/webhook/route.ts',
      health: 'health/route.ts',
      ready: 'ready/route.ts',
      auth: 'auth/[...nextauth]/route.ts',
    };
    expect(group.sort()).toEqual(Object.keys(routes).sort());
    for (const file of Object.values(routes)) {
      expect(() => readFileSync(path.join(ROOT, 'src/app/api', file))).not.toThrow();
    }
    // The exemption comes before the catch-all, so it wins.
    expect(zones.indexOf('~^/api/(')).toBeLessThan(zones.indexOf('~^/api/  '));
  });
});
