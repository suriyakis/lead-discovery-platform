// PC-07 (I022): readiness — is this deployment able to do its job?
//
// /api/health stays a cheap, I/O-free liveness probe (the process
// answers). /api/ready runs the checks below and answers 503 when any
// fails, so an external uptime monitor pointed at it notices a dead
// worker, a lost Redis or a missed migration — the cases that used to
// leave /api/health green while nothing ran:
//
//   database    SELECT 1
//   redis       PING on a dedicated connection — only with
//               JOB_QUEUE_PROVIDER=bullmq
//   migrations  every migration in the bundled drizzle journal is applied
//   ticks       no repeatable tick is stale by the expected-slot rule
//               (src/lib/jobs/tick-schedule.ts); within 10 minutes of a
//               new boot staleness is reported but does not fail
//
// The public body is only { ok, checkedAt }. The detail — every check,
// each tick's state, open incident counts, the queue provider and the
// build SHA — needs `Authorization: Bearer <OPS_READY_TOKEN>`.
// See docs/OPS_MONITORING.md.

import { createHash, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import type { JobHeartbeat } from '@/lib/db/schema/ops';
import { getBootInfo, type BootInfo } from '@/lib/jobs/boot';
import { BOOT_GRACE_MS } from '@/lib/jobs/tick-schedule';
import { describeError } from '@/lib/ops/mask';
import { buildTickStatuses, listJobHeartbeats } from './job-heartbeats';
import { countOpenOpsEventsBySeverity, type OpsEventSeverity } from './ops-events';
// Bundled at build time: the code being served knows which migrations it
// needs, whatever is on disk next to it.
import migrationJournal from '../../../drizzle/meta/_journal.json';

/** Per-check timeout: a hung dependency is a failed check, not a hung probe. */
export const READINESS_CHECK_TIMEOUT_MS = 3000;
/** Shortest OPS_READY_TOKEN that unlocks the detail. */
export const MIN_READY_TOKEN_LENGTH = 16;

export interface ReadinessDeps {
  now: () => Date;
  boot: () => BootInfo;
  queueProvider: () => string;
  buildSha: () => string | null;
  pingDatabase: () => Promise<void>;
  pingRedis: (timeoutMs: number) => Promise<void>;
  appliedMigrations: () => Promise<{ count: number; latestCreatedAt: number | null }>;
  expectedMigrations: () => ReadonlyArray<{ tag: string; when: number }>;
  loadHeartbeats: () => Promise<JobHeartbeat[]>;
  countOpenIncidents: () => Promise<Record<OpsEventSeverity, number>>;
  timeoutMs: number;
  bootGraceMs: number;
}

export interface ReadinessCheck {
  ok: boolean;
  /** Not run: not applicable (memory queue) or its dependency is down. */
  skipped?: boolean;
  latencyMs?: number;
  /** Masked. */
  error?: string;
}

export interface TickReadiness {
  name: string;
  label: string;
  state: string;
  failsReadiness: boolean;
  inBootGrace: boolean;
  failing: boolean;
  consecutiveFailures: number;
  intervalMs: number | null;
  queueProvider: string | null;
  bootId: string | null;
  registeredAt: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastOkAt: string | null;
  lastStatus: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  expectedAt: string | null;
  dueBy: string | null;
  runCount: number;
}

export interface ReadinessReport {
  ok: boolean;
  checkedAt: string;
  queueProvider: string;
  buildSha: string | null;
  boot: { id: string; startedAt: string; inGrace: boolean };
  checks: {
    database: ReadinessCheck;
    redis: ReadinessCheck;
    migrations: ReadinessCheck & { expected?: number; applied?: number; pending?: string[] };
    ticks: ReadinessCheck & { stale?: string[]; items?: TickReadiness[] };
  };
  incidents: { open: Record<OpsEventSeverity, number> } | { error: string } | null;
}

export interface PublicReadiness {
  ok: boolean;
  checkedAt: string;
}

// ---- default dependencies -------------------------------------------------

interface RedisLike {
  status: string;
  ping(): Promise<string>;
  connect(): Promise<void>;
  once(event: 'ready', listener: () => void): unknown;
  off(event: 'ready', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

const redisHolder = globalThis as unknown as { __leadPlatformReadyRedis?: RedisLike };

/** A dedicated connection: no offline queue (a PING while disconnected
 *  fails at once instead of waiting forever like the BullMQ connection's
 *  maxRetriesPerRequest: null would), one retry, short connect timeout. */
async function readinessRedis(): Promise<RedisLike> {
  if (!redisHolder.__leadPlatformReadyRedis) {
    const { default: IORedis } = await import('ioredis');
    const client = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy: (attempt: number) => Math.min(attempt * 1000, 10_000),
    });
    // Connection errors surface through the PING; without a listener
    // ioredis would log every reconnect attempt as unhandled.
    client.on('error', () => undefined);
    redisHolder.__leadPlatformReadyRedis = client as unknown as RedisLike;
  }
  return redisHolder.__leadPlatformReadyRedis;
}

function waitForReady(client: RedisLike, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onReady = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      client.off('ready', onReady);
      reject(new Error(`Redis not ready (status ${client.status})`));
    }, timeoutMs);
    client.once('ready', onReady);
  });
}

async function pingRedisDefault(timeoutMs: number): Promise<void> {
  const client = await readinessRedis();
  if (client.status === 'wait' || client.status === 'end') {
    client.connect().catch(() => undefined);
  }
  // Give up a little before the check's own timeout so the report names
  // the connection state instead of a bare timeout.
  if (client.status !== 'ready') await waitForReady(client, Math.max(100, timeoutMs - 250));
  const reply = await client.ping();
  if (reply !== 'PONG') throw new Error(`unexpected PING reply: ${reply}`);
}

async function appliedMigrationsDefault(): Promise<{
  count: number;
  latestCreatedAt: number | null;
}> {
  // Raw SQL: drizzle's own bookkeeping table is not part of our schema.
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS count, max(created_at)::text AS latest FROM drizzle.__drizzle_migrations`,
  )) as unknown as Array<{ count: number | string; latest: string | null }>;
  const row = rows[0];
  return {
    count: Number(row?.count ?? 0),
    latestCreatedAt: row?.latest != null ? Number(row.latest) : null,
  };
}

function defaultDeps(): ReadinessDeps {
  return {
    now: () => new Date(),
    boot: getBootInfo,
    queueProvider: () => process.env.JOB_QUEUE_PROVIDER ?? 'memory',
    buildSha: () => process.env.BUILD_SHA?.trim() || null,
    pingDatabase: async () => {
      await db.execute(sql`SELECT 1`);
    },
    pingRedis: pingRedisDefault,
    appliedMigrations: appliedMigrationsDefault,
    expectedMigrations: () =>
      (migrationJournal as { entries: Array<{ tag: string; when: number }> }).entries,
    loadHeartbeats: listJobHeartbeats,
    countOpenIncidents: countOpenOpsEventsBySeverity,
    timeoutMs: READINESS_CHECK_TIMEOUT_MS,
    bootGraceMs: BOOT_GRACE_MS,
  };
}

let testOverrides: Partial<ReadinessDeps> | null = null;

/** Tests: replace dependencies for every checkReadiness() call (the route
 *  included). Pass null to restore the defaults. */
export function _setReadinessDepsForTests(overrides: Partial<ReadinessDeps> | null): void {
  testOverrides = overrides;
}

// ---- checks -----------------------------------------------------------------

async function withTimeout<T>(work: () => Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function timedCheck(
  work: () => Promise<void>,
  timeoutMs: number,
  what: string,
): Promise<ReadinessCheck> {
  const started = Date.now();
  try {
    await withTimeout(work, timeoutMs, what);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: describeError(err).message };
  }
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export async function checkReadiness(
  overrides: Partial<ReadinessDeps> = {},
): Promise<ReadinessReport> {
  const d: ReadinessDeps = { ...defaultDeps(), ...(testOverrides ?? {}), ...overrides };
  const now = d.now();
  const boot = d.boot();
  const queueProvider = d.queueProvider();
  const inGrace = now.getTime() - boot.startedAt.getTime() < d.bootGraceMs;

  const [database, redis] = await Promise.all([
    timedCheck(d.pingDatabase, d.timeoutMs, 'database'),
    queueProvider === 'bullmq'
      ? timedCheck(() => d.pingRedis(d.timeoutMs), d.timeoutMs, 'redis')
      : Promise.resolve<ReadinessCheck>({ ok: true, skipped: true }),
  ]);

  let migrations: ReadinessReport['checks']['migrations'];
  let ticks: ReadinessReport['checks']['ticks'];
  let incidents: ReadinessReport['incidents'] = null;

  if (!database.ok) {
    migrations = { ok: false, skipped: true, error: 'database unavailable' };
    ticks = { ok: false, skipped: true, error: 'database unavailable' };
  } else {
    [migrations, ticks, incidents] = await Promise.all([
      checkMigrations(d),
      checkTicks(d, now, boot),
      withTimeout(d.countOpenIncidents, d.timeoutMs, 'incident count').then(
        (open) => ({ open }),
        (err: unknown) => ({ error: describeError(err).message }),
      ),
    ]);
  }

  return {
    ok: database.ok && redis.ok && migrations.ok && ticks.ok,
    checkedAt: now.toISOString(),
    queueProvider,
    buildSha: d.buildSha(),
    boot: { id: boot.id, startedAt: boot.startedAt.toISOString(), inGrace },
    checks: { database, redis, migrations, ticks },
    incidents,
  };
}

async function checkMigrations(d: ReadinessDeps): Promise<ReadinessReport['checks']['migrations']> {
  const expected = d.expectedMigrations();
  try {
    const applied = await withTimeout(d.appliedMigrations, d.timeoutMs, 'migrations');
    // drizzle's migrator applies every journal entry newer than the
    // latest applied one, so "newer than the latest" is exactly pending.
    // A database AHEAD of the code (rolled-back deploy) is fine.
    const latest = applied.latestCreatedAt ?? Number.NEGATIVE_INFINITY;
    const pending = expected.filter((m) => m.when > latest).map((m) => m.tag);
    return {
      ok: pending.length === 0,
      expected: expected.length,
      applied: applied.count,
      pending,
      ...(pending.length > 0 ? { error: `${pending.length} migration(s) not applied` } : {}),
    };
  } catch (err) {
    return { ok: false, expected: expected.length, error: describeError(err).message };
  }
}

async function checkTicks(
  d: ReadinessDeps,
  now: Date,
  boot: BootInfo,
): Promise<ReadinessReport['checks']['ticks']> {
  try {
    const rows = await withTimeout(d.loadHeartbeats, d.timeoutMs, 'heartbeats');
    const statuses = buildTickStatuses(rows, now, {
      processBootedAt: boot.startedAt,
      bootGraceMs: d.bootGraceMs,
    });
    const stale = statuses.filter((s) => s.failsReadiness).map((s) => s.name);
    return {
      ok: stale.length === 0,
      stale,
      items: statuses.map((s) => ({
        name: s.name,
        label: s.label,
        state: s.state,
        failsReadiness: s.failsReadiness,
        inBootGrace: s.inBootGrace,
        failing: s.failing,
        consecutiveFailures: s.consecutiveFailures,
        intervalMs: s.intervalMs,
        queueProvider: s.queueProvider,
        bootId: s.bootId,
        registeredAt: iso(s.registeredAt),
        lastStartedAt: iso(s.lastStartedAt),
        lastFinishedAt: iso(s.lastFinishedAt),
        lastOkAt: iso(s.lastOkAt),
        lastStatus: s.lastStatus,
        lastDurationMs: s.lastDurationMs,
        lastError: s.lastError,
        expectedAt: iso(s.expectedAt),
        dueBy: iso(s.dueBy),
        runCount: s.runCount,
      })),
      ...(stale.length > 0 ? { error: `stale: ${stale.join(', ')}` } : {}),
    };
  } catch (err) {
    return { ok: false, error: describeError(err).message };
  }
}

// ---- access -------------------------------------------------------------------

/** True when the request carries `Authorization: Bearer <OPS_READY_TOKEN>`.
 *  An unset or short token never unlocks the detail. Constant-time. */
export function isReadinessDetailAuthorized(
  authorization: string | null,
  token: string | undefined = process.env.OPS_READY_TOKEN,
): boolean {
  if (!token || token.length < MIN_READY_TOKEN_LENGTH) return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '');
  if (!match) return false;
  const given = createHash('sha256').update(match[1]!).digest();
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(given, expected);
}

/** What an anonymous caller may see. */
export function publicReadiness(report: ReadinessReport): PublicReadiness {
  return { ok: report.ok, checkedAt: report.checkedAt };
}
