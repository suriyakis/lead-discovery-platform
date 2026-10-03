// PC-36 (I065) on a real Redis: the lanes, retries, dedupe and the move
// off the pre-lane queue with real BullMQ queues and workers.
//
// Opt-in: set TEST_REDIS_URL to a THROWAWAY Redis (each test FLUSHDBs its
// database), e.g.
//   docker run -d --rm --name ldp-test-redis -p 127.0.0.1:6390:6379 redis:7-alpine
//   TEST_REDIS_URL=redis://127.0.0.1:6390/15 pnpm vitest run src/tests/bullmq-redis-pc36.test.ts
// Without it the suite is skipped; job-lanes-pc36.test.ts covers the same
// wiring against in-memory fakes of Queue / Worker.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import { connectorRuns, type ConnectorRun } from '@/lib/db/schema/connectors';
import { registerConnector } from '@/lib/connectors/registry';
import type { ConnectorRunRequest, HarvesterEvent, ISourceConnector } from '@/lib/connectors/types';
import { BullMQJobQueue } from '@/lib/jobs/bullmq';
import { handleConnectorRun, type ConnectorRunJobPayload } from '@/lib/jobs/bootstrap';
import { BATCH_TICKS, LANE_DEFINITIONS, LEGACY_QUEUE_NAME } from '@/lib/jobs/lanes';
import type { WorkspaceContext } from '@/lib/services/context';
import { createConnector } from '@/lib/services/connector-run';
import { LEARNING_PROCESS_JOB } from '@/lib/services/learning-decisions';
import { reapStuckRuns } from '@/lib/services/stuck-work';
import { truncateAll } from './helpers/db';
import { queueCtx as ctx, setupQueueWorkspace as setup } from './helpers/outreach-fixtures';

const REDIS_URL = process.env.TEST_REDIS_URL;

const counting = { runs: 0 };
class CountingConnector implements ISourceConnector {
  readonly id = 'pc36-redis-counting';
  readonly name = 'Counting (PC-36 Redis test)';
  readonly type = 'directory_harvester' as const;
  readonly configSchema = z.object({}).passthrough();
  readonly credentialsSchema = z.object({});
  async testConnection() {
    return { ok: true };
  }
  async *run(_ctx: WorkspaceContext, _request: ConnectorRunRequest): AsyncIterable<HarvesterEvent> {
    counting.runs += 1;
  }
}
registerConnector(new CountingConnector());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(25);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe.skipIf(!REDIS_URL)('BullMQ lanes on a real Redis (PC-36)', () => {
  let redis: IORedis;
  const open: BullMQJobQueue[] = [];
  const queue = (opts: ConstructorParameters<typeof BullMQJobQueue>[0] = {}) => {
    const q = new BullMQJobQueue({ redisUrl: REDIS_URL, env: {}, ...opts });
    open.push(q);
    return q;
  };
  const rawQueue = (name: string) => new Queue(name, { connection: redis });

  beforeEach(async () => {
    redis ??= new IORedis(REDIS_URL!, { maxRetriesPerRequest: null });
    await redis.flushdb();
    counting.runs = 0;
  });
  afterEach(async () => {
    while (open.length) await open.pop()!.close({ graceMs: 2000 });
  });
  afterAll(async () => {
    await redis?.quit();
    await (db.$client as unknown as { end: () => Promise<void> }).end();
  });

  it('(1) drain ticks stay on schedule while long runs fill the runs lane', async () => {
    const q = queue();
    const longRuns = deferred();
    let runsStarted = 0;
    q.on('connector.run', async () => {
      runsStarted++;
      await longRuns.promise;
    });
    const drains: number[] = [];
    q.on('outreach.drain.tick', async () => {
      drains.push(Date.now());
    });

    for (const runId of ['1', '2', '3']) await q.enqueue('connector.run', { runId });
    await waitFor(() => runsStarted === 2);
    await q.enqueueRepeatable('outreach.drain.tick', {}, { everyMs: 400, jobId: 'drain' });
    await sleep(2500);

    // Both runs-lane slots stay taken (the third run waits) and the drain
    // tick still fires on every 400 ms slot.
    expect(runsStarted).toBe(2);
    expect(drains.length).toBeGreaterThanOrEqual(5);
    const gaps = drains.slice(1).map((t, i) => t - drains[i]!);
    expect(Math.max(...gaps)).toBeLessThan(900);

    longRuns.resolve();
    await waitFor(() => runsStarted === 3);
  });

  it('(1) drain ticks stay on schedule while four long AI ticks fill the batch lane', async () => {
    const q = queue();
    const longTicks = deferred();
    const started: string[] = [];
    for (const name of BATCH_TICKS) {
      q.on(name, async () => {
        started.push(name);
        await longTicks.promise;
      });
    }
    const drains: number[] = [];
    q.on('outreach.drain.tick', async () => {
      drains.push(Date.now());
    });

    for (const name of BATCH_TICKS) await q.enqueue(name, {});
    await waitFor(() => started.length === 3);
    await q.enqueueRepeatable('outreach.drain.tick', {}, { everyMs: 400, jobId: 'drain' });
    await sleep(2500);

    // Three long AI ticks take every batch slot (the fourth waits) and the
    // drain tick still fires on every 400 ms slot of its own lane.
    expect(started).toHaveLength(3);
    expect(drains.length).toBeGreaterThanOrEqual(5);
    const gaps = drains.slice(1).map((t, i) => t - drains[i]!);
    expect(Math.max(...gaps)).toBeLessThan(900);
    expect(await rawQueue(LANE_DEFINITIONS.batch.queueName).getWaitingCount()).toBe(1);

    longTicks.resolve();
    await waitFor(() => started.length === 4);
  });

  it('(3) a ROLE=web queue registers no worker: its jobs wait for the worker service', async () => {
    const web = queue({ consume: false });
    let ran = 0;
    web.on('connector.run', async () => {
      ran++;
    });
    const id = await web.enqueue('connector.run', { runId: '1' });
    await sleep(300);
    expect(ran).toBe(0);
    expect(await web.status(id)).toEqual({ state: 'pending' });
    expect(await rawQueue(LANE_DEFINITIONS.runs.queueName).getWorkersCount()).toBe(0);

    // The worker service picks it up.
    const worker = queue();
    worker.on('connector.run', async () => {
      ran++;
      return 'done';
    });
    await waitFor(async () => (await web.status(id)).state === 'succeeded');
    expect(ran).toBe(1);
  });

  it('a web process counts the workers of every lane, in whatever process they run', async () => {
    const web = queue({ consume: false });
    expect(await web.laneWorkerCounts()).toEqual({ ticks: 0, batch: 0, runs: 0 });

    // The worker service registers its handlers: one worker per lane.
    const worker = queue();
    worker.on('outreach.drain.tick', async () => 'ok');
    worker.on('autopilot.tick', async () => 'ok');
    worker.on('connector.run', async () => 'ok');
    await waitFor(async () => {
      const c = await web.laneWorkerCounts();
      return c.ticks >= 1 && c.batch >= 1 && c.runs >= 1;
    });

    // It stops: the web process sees the lanes empty again.
    await worker.close({ graceMs: 1000 });
    open.splice(open.indexOf(worker), 1);
    await waitFor(async () => {
      const c = await web.laneWorkerCounts();
      return c.ticks === 0 && c.batch === 0 && c.runs === 0;
    });
  });

  it('(4) a retried connector.run whose row was reaped is skipped (real retry with backoff)', async () => {
    await truncateAll();
    const s = await setup();
    const connector = await createConnector(ctx(s), {
      templateType: 'directory_harvester',
      name: 'Counting',
      config: {},
    });
    const [run] = await db
      .insert(connectorRuns)
      .values({ workspaceId: s.workspaceId, connectorId: connector.id, status: 'pending' })
      .returning();
    const payload: ConnectorRunJobPayload = {
      runId: run!.id.toString(),
      workspaceId: s.workspaceId.toString(),
      userId: s.ownerId,
      role: 'owner',
    };

    const q = queue({
      retryPolicies: {
        'connector.run': { attempts: 3, backoff: { type: 'exponential', delayMs: 200 } },
      },
    });
    const attempts: number[] = [];
    q.on<ConnectorRunJobPayload>('connector.run', async (p, jobCtx) => {
      attempts.push(jobCtx.attempt ?? 0);
      if (jobCtx.attempt === 1) {
        // The first attempt claims the run and dies mid-way; the reaper
        // then fails it for lack of progress.
        await db
          .update(connectorRuns)
          .set({ status: 'running', startedAt: minutesAgo(30), lastProgressAt: minutesAgo(30) })
          .where(eq(connectorRuns.id, run!.id));
        expect((await reapStuckRuns(ctx(s))).failed).toEqual([run!.id]);
        throw new Error('the worker lost its database connection');
      }
      return handleConnectorRun(p, jobCtx);
    });

    const id = await q.enqueue('connector.run', payload);
    await waitFor(async () => (await q.status(id)).state === 'succeeded');
    const status = (await q.status(id)) as { state: 'succeeded'; result: unknown };
    expect(status.result).toMatchObject({ status: 'skipped', currentStatus: 'failed' });
    expect(attempts).toEqual([1, 2]);
    expect(counting.runs).toBe(0);
    const [after] = await db.select().from(connectorRuns).where(eq(connectorRuns.id, run!.id));
    expect((after as ConnectorRun).status).toBe('failed');
    expect((after as ConnectorRun).errorPayload).toMatchObject({ reason: 'no_progress' });
  });

  it('a dedupe key enqueued again while its job waits adds nothing', async () => {
    const web = queue({ consume: false });
    const a = await web.enqueue(
      LEARNING_PROCESS_JOB,
      { decisionId: 'd' },
      { dedupeKey: 'learning:d' },
    );
    const b = await web.enqueue(
      LEARNING_PROCESS_JOB,
      { decisionId: 'd' },
      { dedupeKey: 'learning:d' },
    );
    const c = await web.enqueue(
      LEARNING_PROCESS_JOB,
      { decisionId: 'e' },
      { dedupeKey: 'learning:e' },
    );
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(await rawQueue(LANE_DEFINITIONS.runs.queueName).getWaitingCount()).toBe(2);
  });

  it('moves the pre-lane queue onto the lanes at worker boot', async () => {
    const legacy = rawQueue(LEGACY_QUEUE_NAME);
    await legacy.add('outreach.drain.tick', {}, { repeat: { every: 30_000 } });
    await legacy.add('connector.run', { runId: '42' });
    await legacy.add(LEARNING_PROCESS_JOB, { decisionId: 'd' });

    const q = queue({ consume: false });
    const result = await q.migrateLegacyQueue();
    expect(result).toEqual({ schedulesRemoved: 1, jobsMoved: 2, jobsSkipped: 0 });
    expect(await legacy.getRepeatableJobs()).toEqual([]);
    expect(await legacy.getWaitingCount()).toBe(0);
    expect(await legacy.getDelayedCount()).toBe(0);

    const runs = rawQueue(LANE_DEFINITIONS.runs.queueName);
    const moved = await runs.getJobs(['waiting']);
    // Tries per job: the lane's retry policy (BullMQ stores 0 for "once").
    const tries = (n: number | undefined) => Math.max(1, n ?? 1);
    expect(moved.map((j) => [j.name, j.data, tries(j.opts.attempts)]).sort()).toEqual(
      [
        ['connector.run', { runId: '42' }, 3],
        [LEARNING_PROCESS_JOB, { decisionId: 'd' }, 1],
      ].sort(),
    );
    // Idempotent.
    expect(await q.migrateLegacyQueue()).toEqual({
      schedulesRemoved: 0,
      jobsMoved: 0,
      jobsSkipped: 0,
    });
  });
});
