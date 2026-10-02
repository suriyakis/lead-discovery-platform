// PC-36 review: the web process notices that no worker consumes the job
// lanes. A deploy that recreates only `app` (the old ~/deploy-discover.sh)
// leaves ROLE=web enqueueing into lanes nothing reads; the watchdog now
// raises one critical `worker.absent` incident (and a loud log line) after
// the boot grace and two consecutive checks, alerts it, and resolves it
// when a worker is back. Driven through runWatchdogPass() with a fake
// clock, real ops_events and the real dispatcher (fetch mocked).

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import type { JobsOptions } from 'bullmq';
import { db } from '@/lib/db/client';
import { opsEvents } from '@/lib/db/schema/ops';
import { _setJobQueueForTests } from '@/lib/jobs';
import { BullMQJobQueue, type LaneQueue } from '@/lib/jobs/bullmq';
import { JOB_LANES, LANE_DEFINITIONS } from '@/lib/jobs/lanes';
import { readAlertConfig } from '@/lib/ops/alert-config';
import { StaleTickStreaks, WATCHDOG_INTERVAL_MS, runWatchdogPass } from '@/lib/ops/watchdog';
import {
  ABSENT_CHECKS_BEFORE_ALERT,
  WORKER_ABSENT_KIND,
  WORKER_PRESENCE_GRACE_MS,
  WorkerPresence,
  workerAbsentFingerprint,
} from '@/lib/ops/worker-presence';
import { raiseOpsEvent } from '@/lib/services/ops-events';
import { _setOpsAlertDepsForTests } from '@/lib/services/ops-alerts';
import { truncateAll } from './helpers/db';

const MIN = 60_000;
const HOUR = 60 * MIN;

let clock: Date;
const fetchMock = vi.fn(
  async (_url: string, _init: RequestInit): Promise<Response> =>
    new Response('{}', { status: 200 }),
);
const titles = () =>
  fetchMock.mock.calls.map(([, init]) => (JSON.parse(String(init.body)) as { title: string }).title);

const NONE = { ticks: 0, batch: 0, runs: 0 };
const ALL = { ticks: 1, batch: 1, runs: 1 };

function pass(
  presence: WorkerPresence,
  counts: () => Promise<Readonly<Record<string, number>> | null>,
  options: { bootedAt?: Date; logs?: string[] } = {},
) {
  return runWatchdogPass(
    new StaleTickStreaks(),
    {
      now: () => clock,
      processBootedAt: () => options.bootedAt ?? new Date(clock.getTime() - HOUR),
      loadHeartbeats: async () => [],
      dailyDigest: async () => null,
      workerCounts: counts,
      log: (m) => options.logs?.push(m),
    },
    presence,
  );
}

const tick = () => {
  clock = new Date(clock.getTime() + WATCHDOG_INTERVAL_MS);
};

async function openAbsent() {
  return db
    .select()
    .from(opsEvents)
    .where(and(eq(opsEvents.kind, WORKER_ABSENT_KIND), isNull(opsEvents.resolvedAt)));
}

beforeEach(async () => {
  await truncateAll();
  clock = new Date('2026-10-02T09:00:00.000Z');
  fetchMock.mockClear();
  _setOpsAlertDepsForTests({
    now: () => clock,
    config: () => readAlertConfig({ NTFY_TOPIC: 'ls-owner-K9q2Zr' }),
    fetch: fetchMock,
    log: () => undefined,
  });
});

afterEach(() => {
  _setOpsAlertDepsForTests(null);
  _setJobQueueForTests(null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('worker presence (PC-36 review): a web process with no worker raises a critical incident', () => {
  it('two consecutive checks without a worker: one critical incident, one alert, a loud log; back: resolved', async () => {
    expect(ABSENT_CHECKS_BEFORE_ALERT).toBe(2);
    const presence = new WorkerPresence();
    const logs: string[] = [];

    const first = await pass(presence, async () => NONE, { logs });
    expect(first.workers).toEqual({ state: 'absent', lanes: ['ticks', 'batch', 'runs'], checks: 1, raised: false });
    expect(await openAbsent()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logs).toEqual([]);

    tick();
    const second = await pass(presence, async () => NONE, { logs });
    expect(second.workers).toMatchObject({ state: 'absent', checks: 2, raised: true });
    const [incident] = await openAbsent();
    expect(incident).toMatchObject({
      scope: 'platform',
      severity: 'critical',
      source: 'ops.watchdog',
      fingerprint: workerAbsentFingerprint(),
      title: 'No background worker is running',
    });
    expect(incident!.message).toContain('No worker consumes the ticks, batch, runs lanes');
    expect(incident!.message).toContain('up -d worker');
    expect(incident!.payload).toMatchObject({ lanesWithoutWorker: ['ticks', 'batch', 'runs'], consecutiveChecks: 2 });
    expect(titles()).toEqual(['Leadsonar: No background worker is running']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[ops\] CRITICAL: no background worker consumes the ticks, batch, runs lanes/);

    // Still absent: the one incident counts on, the owner is not paged again;
    // the log says it on every check.
    tick();
    await pass(presence, async () => NONE, { logs });
    const [still] = await openAbsent();
    expect(still!.occurrences).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logs).toHaveLength(2);

    // The worker service starts: the next check resolves it.
    tick();
    const back = await pass(presence, async () => ALL, { logs });
    expect(back.workers).toEqual({ state: 'present', resolved: true });
    expect(await openAbsent()).toEqual([]);
    const [resolved] = await db.select().from(opsEvents).where(eq(opsEvents.kind, WORKER_ABSENT_KIND));
    expect(resolved).toMatchObject({ resolution: 'auto' });
    // And stays quiet while it is there.
    tick();
    expect((await pass(presence, async () => ALL)).workers).toEqual({ state: 'present', resolved: false });
  });

  it('names only the lane that has no worker', async () => {
    const presence = new WorkerPresence();
    const counts = async () => ({ ticks: 1, batch: 0, runs: 2 });
    await pass(presence, counts);
    tick();
    await pass(presence, counts);
    const [incident] = await openAbsent();
    expect(incident!.message).toContain('No worker consumes the batch lane');
    expect(incident!.payload).toMatchObject({ lanesWithoutWorker: ['batch'], workers: { ticks: 1, batch: 0, runs: 2 } });
  });

  it('within the boot grace a missing worker never counts (a deploy starts both together)', async () => {
    const presence = new WorkerPresence();
    const bootedAt = clock;
    // Checks at 0, 1 and 2 minutes after boot (the grace is 3).
    for (let i = 0; i < 3; i++) {
      if (i > 0) tick();
      expect((await pass(presence, async () => NONE, { bootedAt })).workers).toEqual({ state: 'grace' });
    }
    expect(presence.streak).toBe(0);
    // Past the grace it takes two more checks.
    clock = new Date(bootedAt.getTime() + WORKER_PRESENCE_GRACE_MS);
    await pass(presence, async () => NONE, { bootedAt });
    expect(await openAbsent()).toEqual([]);
    tick();
    await pass(presence, async () => NONE, { bootedAt });
    expect(await openAbsent()).toHaveLength(1);
  });

  it('a worker restart between two checks is not two CONSECUTIVE checks', async () => {
    const presence = new WorkerPresence();
    await pass(presence, async () => NONE);
    tick();
    await pass(presence, async () => ALL);
    tick();
    await pass(presence, async () => NONE);
    expect(await openAbsent()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the first healthy check after boot resolves an incident a previous web process left open', async () => {
    await raiseOpsEvent({
      scope: 'platform',
      kind: WORKER_ABSENT_KIND,
      severity: 'critical',
      source: 'ops.watchdog',
      dedupeKey: 'job-worker',
      title: 'No background worker is running',
    });
    const presence = new WorkerPresence();
    expect((await pass(presence, async () => ALL)).workers).toEqual({ state: 'present', resolved: true });
    expect(await openAbsent()).toEqual([]);
  });

  it('the in-memory queue (this process consumes) is not checked; a Redis that cannot count is logged once', async () => {
    const presence = new WorkerPresence();
    expect((await pass(presence, async () => null)).workers).toEqual({ state: 'not_applicable' });

    const logs: string[] = [];
    const broken = async () => {
      throw new Error('ERR unknown command CLIENT');
    };
    for (let i = 0; i < 3; i++) {
      tick();
      expect((await pass(presence, broken, { logs })).workers).toMatchObject({ state: 'unknown' });
    }
    expect(logs).toEqual([
      '[ops] watchdog cannot count the job workers (ERR unknown command CLIENT); the worker check is skipped while that lasts.',
    ]);
    expect(await openAbsent()).toEqual([]);
  });

  it('a failing worker check does not skip alert dispatch or the digest', async () => {
    const dispatch = vi.fn(async () => 'dispatched');
    const r = await runWatchdogPass(
      new StaleTickStreaks(),
      {
        now: () => clock,
        processBootedAt: () => new Date(clock.getTime() - HOUR),
        loadHeartbeats: async () => [],
        workerCounts: async () => NONE,
        raise: async () => {
          throw new Error('db down');
        },
        dispatch,
        dailyDigest: async () => 'digested',
        log: () => undefined,
      },
      Object.assign(new WorkerPresence(), { streak: 5 }),
    );
    expect(r.errors).toEqual(['worker check: db down']);
    expect(r.dispatch).toBe('dispatched');
    expect(r.dailyDigest).toBe('digested');
  });
});

describe('BullMQ worker counts (PC-36 review)', () => {
  function fakeLaneQueue(name: string, workers: number): LaneQueue {
    return {
      name,
      add: async (_n: string, _d: unknown, _o?: JobsOptions) => ({ id: '1' }),
      getJob: async () => undefined,
      getJobs: async () => [],
      getRepeatableJobs: async () => [],
      removeRepeatableByKey: async () => false,
      getWorkersCount: async () => workers,
      close: async () => undefined,
    };
  }

  it('laneWorkerCounts asks every lane queue, whatever process its workers live in', async () => {
    const perQueue: Record<string, number> = {
      [LANE_DEFINITIONS.ticks.queueName]: 1,
      [LANE_DEFINITIONS.batch.queueName]: 0,
      [LANE_DEFINITIONS.runs.queueName]: 2,
    };
    const q = new BullMQJobQueue({
      consume: false,
      env: {},
      factories: {
        queue: (name) => fakeLaneQueue(name, perQueue[name] ?? 0),
        worker: () => {
          throw new Error('a web process starts no worker');
        },
      },
    });
    expect(await q.laneWorkerCounts()).toEqual({ ticks: 1, batch: 0, runs: 2 });
    expect(Object.keys(await q.laneWorkerCounts())).toEqual([...JOB_LANES]);
  });

  it('the watchdog asks the process job queue by default: ROLE=web on bullmq with no worker alerts', async () => {
    const web = new BullMQJobQueue({
      consume: false,
      env: {},
      factories: {
        queue: (name) => fakeLaneQueue(name, 0),
        worker: () => {
          throw new Error('a web process starts no worker');
        },
      },
    });
    _setJobQueueForTests(web);
    const presence = new WorkerPresence();
    const run = () =>
      runWatchdogPass(
        new StaleTickStreaks(),
        {
          now: () => clock,
          processBootedAt: () => new Date(clock.getTime() - HOUR),
          loadHeartbeats: async () => [],
          dailyDigest: async () => null,
          log: () => undefined,
        },
        presence,
      );
    await run();
    tick();
    const r = await run();
    expect(r.workers).toMatchObject({ state: 'absent', raised: true, lanes: ['ticks', 'batch', 'runs'] });
    expect(await openAbsent()).toHaveLength(1);
  });
});
