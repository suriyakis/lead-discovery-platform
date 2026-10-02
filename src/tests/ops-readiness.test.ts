// PC-07 acceptance (4): /api/ready answers 503 on a database or Redis
// failure (mocked), on pending migrations and on a stale tick outside the
// boot grace; the detail (checks, ticks, queue provider, build SHA) is
// hidden without the token; /api/health is unchanged and I/O-free.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db/client';
import { jobHeartbeats } from '@/lib/db/schema/ops';
import { _setBootInfoForTests } from '@/lib/jobs/boot';
import { DRAIN_TICK_MS } from '@/lib/jobs/tick-catalog';
import {
  _setReadinessDepsForTests,
  checkReadiness,
  isReadinessDetailAuthorized,
  type ReadinessReport,
} from '@/lib/services/readiness';
import { GET as readyGET } from '@/app/api/ready/route';
import { GET as healthGET } from '@/app/api/health/route';
import { truncateAll } from './helpers/db';

const TOKEN = 'ready-token-for-tests-0123456789';
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

const savedEnv = {
  token: process.env.OPS_READY_TOKEN,
  provider: process.env.JOB_QUEUE_PROVIDER,
  sha: process.env.BUILD_SHA,
};

beforeEach(async () => {
  await truncateAll();
  process.env.OPS_READY_TOKEN = TOKEN;
  // Booted long ago unless a test says otherwise: no boot grace.
  _setBootInfoForTests({ id: 'boot-old', startedAt: new Date(Date.now() - DAY) });
});

afterEach(() => {
  _setReadinessDepsForTests(null);
  _setBootInfoForTests(null);
  for (const [key, value] of [
    ['OPS_READY_TOKEN', savedEnv.token],
    ['JOB_QUEUE_PROVIDER', savedEnv.provider],
    ['BUILD_SHA', savedEnv.sha],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

function request(authorization?: string): Request {
  return new Request('http://localhost/api/ready', {
    headers: authorization ? { authorization } : {},
  });
}

async function ready(
  authorization?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await readyGET(request(authorization));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('/api/ready', () => {
  it('is 200 against the real database with every check passing (memory queue)', async () => {
    process.env.JOB_QUEUE_PROVIDER = 'memory';
    const { status, body } = await ready();
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['checkedAt', 'ok']);
    expect(body.ok).toBe(true);

    const detail = (await ready(`Bearer ${TOKEN}`)).body as unknown as ReadinessReport;
    expect(detail.checks.database.ok).toBe(true);
    expect(detail.checks.redis).toEqual({ ok: true, skipped: true });
    expect(detail.checks.migrations.ok).toBe(true);
    expect(detail.checks.migrations.pending).toEqual([]);
    expect(detail.checks.ticks.ok).toBe(true);
    expect(detail.queueProvider).toBe('memory');
    expect(detail.boot.id).toBe('boot-old');
  });

  it('is 503 when the database fails, and hides why without the token', async () => {
    _setReadinessDepsForTests({
      pingDatabase: async () => {
        throw new Error('connect ECONNREFUSED postgres://lead:pw-secret@postgres:5432/lead');
      },
    });
    const anonymous = await ready();
    expect(anonymous.status).toBe(503);
    expect(anonymous.body).toEqual({ ok: false, checkedAt: expect.any(String) });

    const detail = (await ready(`Bearer ${TOKEN}`)).body as unknown as ReadinessReport;
    expect(detail.ok).toBe(false);
    expect(detail.checks.database.ok).toBe(false);
    expect(detail.checks.database.error).toContain('ECONNREFUSED');
    expect(detail.checks.database.error).not.toContain('pw-secret');
    expect(detail.checks.migrations.skipped).toBe(true);
    expect(detail.checks.ticks.skipped).toBe(true);
  });

  it('is 503 when Redis fails under bullmq; Redis is not touched under the memory queue', async () => {
    const pingRedis = vi.fn(async () => {
      throw new Error('Redis not ready (status reconnecting)');
    });
    _setReadinessDepsForTests({ queueProvider: () => 'bullmq', pingRedis });
    const down = await ready(`Bearer ${TOKEN}`);
    expect(down.status).toBe(503);
    const detail = down.body as unknown as ReadinessReport;
    expect(detail.checks.redis.ok).toBe(false);
    expect(detail.checks.redis.error).toContain('Redis not ready');
    expect(detail.checks.database.ok).toBe(true);
    expect(detail.queueProvider).toBe('bullmq');

    pingRedis.mockClear();
    _setReadinessDepsForTests({ queueProvider: () => 'memory', pingRedis });
    expect((await ready()).status).toBe(200);
    expect(pingRedis).not.toHaveBeenCalled();
  });

  it('treats a hung dependency as a failed check (timeout)', async () => {
    _setReadinessDepsForTests({
      queueProvider: () => 'bullmq',
      pingRedis: () => new Promise<void>(() => undefined),
      timeoutMs: 50,
    });
    const res = await ready(`Bearer ${TOKEN}`);
    expect(res.status).toBe(503);
    expect((res.body as unknown as ReadinessReport).checks.redis.error).toMatch(/timed out/);
  });

  it('is 503 while a migration of this build is not applied', async () => {
    _setReadinessDepsForTests({
      appliedMigrations: async () => ({ count: 66, latestCreatedAt: 1_000 }),
      expectedMigrations: () => [
        { tag: '0000_first', when: 900 },
        { tag: '0066_new', when: 2_000 },
      ],
    });
    const res = await ready(`Bearer ${TOKEN}`);
    expect(res.status).toBe(503);
    const migrations = (res.body as unknown as ReadinessReport).checks.migrations;
    expect(migrations).toMatchObject({
      ok: false,
      pending: ['0066_new'],
      expected: 2,
      applied: 66,
    });
  });

  it('accepts a database ahead of the code (rolled-back deploy)', async () => {
    const report = await checkReadiness({
      appliedMigrations: async () => ({ count: 70, latestCreatedAt: 5_000 }),
      expectedMigrations: () => [{ tag: '0001', when: 1_000 }],
    });
    expect(report.checks.migrations.ok).toBe(true);
  });

  it('is 503 for a stale tick, but not within the boot grace', async () => {
    const now = Date.now();
    await db.insert(jobHeartbeats).values({
      name: 'outreach.drain.tick',
      kind: 'tick',
      intervalMs: DRAIN_TICK_MS,
      queueProvider: 'memory',
      bootId: 'boot-old',
      registeredAt: new Date(now - DAY),
      lastStartedAt: new Date(now - 10 * MIN),
      lastStatus: 'ok',
    });
    const stale = await ready(`Bearer ${TOKEN}`);
    expect(stale.status).toBe(503);
    const ticks = (stale.body as unknown as ReadinessReport).checks.ticks;
    expect(ticks.stale).toEqual(['outreach.drain.tick']);
    const drain = ticks.items!.find((t) => t.name === 'outreach.drain.tick')!;
    expect(drain).toMatchObject({ state: 'stale', failsReadiness: true, label: 'Send queue' });

    // A deploy 3 minutes ago: same stale heartbeat, but readiness holds.
    _setBootInfoForTests({ id: 'boot-new', startedAt: new Date(now - 3 * MIN) });
    const grace = await ready(`Bearer ${TOKEN}`);
    expect(grace.status).toBe(200);
    const report = grace.body as unknown as ReadinessReport;
    expect(report.boot.inGrace).toBe(true);
    expect(report.checks.ticks.items!.find((t) => t.name === 'outreach.drain.tick')).toMatchObject({
      state: 'stale',
      inBootGrace: true,
      failsReadiness: false,
    });
  });

  it('the token-protected detail reports the queue provider and the build SHA', async () => {
    process.env.BUILD_SHA = 'abc1234';
    process.env.JOB_QUEUE_PROVIDER = 'memory';
    const detail = (await ready(`Bearer ${TOKEN}`)).body as unknown as ReadinessReport;
    expect(detail.buildSha).toBe('abc1234');
    expect(detail.queueProvider).toBe('memory');
    expect(detail.incidents).toEqual({ open: { info: 0, warning: 0, error: 0, critical: 0 } });

    const anonymous = (await ready()).body;
    expect(anonymous).not.toHaveProperty('buildSha');
    expect(anonymous).not.toHaveProperty('queueProvider');
    expect(anonymous).not.toHaveProperty('checks');
  });

  it('only the exact, long-enough token unlocks the detail', async () => {
    expect((await ready('Bearer wrong-token-wrong-token-wrong')).body).not.toHaveProperty('checks');
    expect((await ready(TOKEN)).body).not.toHaveProperty('checks');
    expect(isReadinessDetailAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isReadinessDetailAuthorized(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isReadinessDetailAuthorized(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(isReadinessDetailAuthorized('Bearer short', 'short')).toBe(false);
    expect(isReadinessDetailAuthorized(`Bearer ${TOKEN}`, '')).toBe(false);
    expect(isReadinessDetailAuthorized(null, TOKEN)).toBe(false);

    delete process.env.OPS_READY_TOKEN;
    expect((await ready(`Bearer ${TOKEN}`)).body).not.toHaveProperty('checks');
  });

  it('is never cached', async () => {
    const res = await readyGET(request());
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('/api/health', () => {
  it('is unchanged: 200 { ok: true } even when every readiness dependency is down', async () => {
    _setReadinessDepsForTests({
      pingDatabase: async () => {
        throw new Error('db down');
      },
      queueProvider: () => 'bullmq',
      pingRedis: async () => {
        throw new Error('redis down');
      },
    });
    const res = healthGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('stays I/O-free: it imports nothing but next/server', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'app', 'api', 'health', 'route.ts'),
      'utf8',
    );
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['next/server']);
  });
});
