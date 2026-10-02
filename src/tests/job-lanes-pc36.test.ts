// PC-36 (I065) — a dedicated worker and split job lanes.
//
//   (1) drain ticks stay on schedule while a long fake run occupies the
//       runs lane, and while four long AI ticks occupy the batch lane
//       (memory queue here; real BullMQ in bullmq-redis-pc36);
//   (2) memory mode keeps at most one pending tick per type;
//   (3) ROLE=web registers no worker, and ROLE=worker serves no HTTP;
//   plus the lane routing, retry policy, dedupe keys, the BullMQ wiring
//   (with in-memory fakes of Queue / Worker) and the move off the
//   pre-lane queue.
// (4) is in connector-run-retry-pc36.test.ts, (5) in
// deploy-compose-pc36.test.ts.

import { EventEmitter } from 'node:events';
import net from 'node:net';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, JobsOptions, JobType, Processor } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { db } from '@/lib/db/client';
import {
  InMemoryJobQueue,
  NonRetryableJobError,
  _setJobQueueForTests,
  bullmqQueueOptionsFromEnv,
} from '@/lib/jobs';
import {
  BullMQJobQueue,
  decodeJobId,
  encodeJobId,
  type LaneQueue,
  type LaneWorker,
  type QueuedJob,
} from '@/lib/jobs/bullmq';
import { _resetHandlersForTests, registerJobHandlers } from '@/lib/jobs/bootstrap';
import {
  BATCH_TICKS,
  CONNECTOR_RUN_RETRY,
  LANE_DEFINITIONS,
  LaneConfigError,
  LEGACY_QUEUE_NAME,
  laneConcurrency,
  laneForJob,
  retryPolicyFor,
} from '@/lib/jobs/lanes';
import { _resetRepeatablesForTests } from '@/lib/jobs/repeatables';
import {
  ProcessRoleError,
  parseProcessRole,
  planWebProcess,
  planWorkerProcess,
  queueConsumesJobs,
} from '@/lib/jobs/role';
import { TICK_CATALOG } from '@/lib/jobs/tick-catalog';
import { startWorkerProcess } from '@/lib/jobs/worker-process';
import { startBackgroundWork } from '@/lib/jobs/background';
import { registerNodeRuntime } from '@/instrumentation-node';
import { KNOWLEDGE_INDEX_JOB } from '@/lib/services/knowledge-index-queue';
import { LEARNING_PROCESS_JOB } from '@/lib/services/learning-decisions';
import { truncateAll } from './helpers/db';

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// ---- in-memory fakes of the BullMQ Queue / Worker -------------------------

class FakeJob implements QueuedJob {
  locked = false;
  constructor(
    private readonly queue: FakeQueue,
    public id: string,
    public name: string,
    public data: unknown,
    public state: string,
    public opts: { repeat?: unknown } = {},
  ) {}
  async getState() {
    return this.state;
  }
  async remove() {
    if (this.locked) throw new Error('job is locked by another worker');
    this.queue.jobs.delete(this.id);
  }
}

class FakeQueue implements LaneQueue {
  readonly added: Array<{ name: string; data: unknown; opts?: JobsOptions }> = [];
  readonly jobs = new Map<string, FakeJob>();
  repeatables: Array<{ key: string; name: string }> = [];
  scanned: JobType[][] = [];
  closed = false;
  private seq = 0;
  constructor(readonly name: string) {}
  async add(name: string, data: unknown, opts?: JobsOptions) {
    this.added.push({ name, data, opts });
    if (opts?.repeat) {
      this.repeatables.push({ key: `${name}:::${String(opts.repeat.every)}`, name });
      return { id: `repeat:${name}` };
    }
    const id = String(++this.seq);
    this.jobs.set(id, new FakeJob(this, id, name, data, 'waiting'));
    return { id };
  }
  /** Seed a job directly (the pre-lane queue's leftovers). */
  seed(job: { id: string; name: string; data?: unknown; state?: string; repeat?: boolean }) {
    const j = new FakeJob(
      this,
      job.id,
      job.name,
      job.data ?? {},
      job.state ?? 'waiting',
      job.repeat ? { repeat: { every: 30_000 } } : {},
    );
    this.jobs.set(job.id, j);
    return j;
  }
  async getJob(id: string) {
    return this.jobs.get(id);
  }
  async getJobs(types: JobType[]) {
    this.scanned.push(types);
    return [...this.jobs.values()].filter((j) => types.includes(j.state as JobType));
  }
  async getRepeatableJobs() {
    return [...this.repeatables];
  }
  async removeRepeatableByKey(key: string) {
    const before = this.repeatables.length;
    this.repeatables = this.repeatables.filter((r) => r.key !== key);
    return this.repeatables.length < before;
  }
  async close() {
    this.closed = true;
  }
}

class FakeWorker extends EventEmitter implements LaneWorker {
  closedWith: 'graceful' | 'force' | null = null;
  /** A graceful close that never finishes (a job that will not stop). */
  hangOnClose = false;
  constructor(
    readonly queueName: string,
    readonly processor: Processor,
    readonly concurrency: number,
  ) {
    super();
  }
  async close(force?: boolean) {
    if (force) {
      this.closedWith = 'force';
      return;
    }
    if (this.hangOnClose) return new Promise<void>(() => {});
    this.closedWith = 'graceful';
  }
  /** What BullMQ would do with a job taken off this worker's queue. */
  process(name: string, data: unknown, attemptsMade = 0, id = '7') {
    return this.processor({ name, data, id, attemptsMade } as unknown as Job);
  }
}

function fakeBull(options: { consume?: boolean; env?: Record<string, string> } = {}) {
  const queues = new Map<string, FakeQueue>();
  const workers: FakeWorker[] = [];
  const q = new BullMQJobQueue({
    consume: options.consume ?? true,
    env: options.env ?? {},
    factories: {
      queue: (name) => {
        const f = new FakeQueue(name);
        queues.set(name, f);
        return f;
      },
      worker: (name, processor, o) => {
        const w = new FakeWorker(name, processor, o.concurrency);
        workers.push(w);
        return w;
      },
    },
  });
  const queue = (name: string) => {
    const f = queues.get(name);
    if (!f) throw new Error(`queue ${name} never created`);
    return f;
  };
  return { q, queues, workers, queue };
}

const TICKS_QUEUE = LANE_DEFINITIONS.ticks.queueName;
const BATCH_QUEUE = LANE_DEFINITIONS.batch.queueName;
const RUNS_QUEUE = LANE_DEFINITIONS.runs.queueName;

// ---- lanes ----------------------------------------------------------------

describe('job lanes (PC-36)', () => {
  it('short ticks run on the ticks lane, the long AI ticks on the batch lane, on-demand work on the runs lane', () => {
    const batch: readonly string[] = BATCH_TICKS;
    for (const tick of TICK_CATALOG) {
      expect(laneForJob(tick.name)).toBe(batch.includes(tick.name) ? 'batch' : 'ticks');
    }
    expect(BATCH_TICKS).toEqual([
      'autopilot.tick',
      'outreach.follow_up.tick',
      'knowledge.compact.tick',
      'health.check.tick',
    ]);
    // Every batch tick is catalogued (heartbeated, judged for staleness).
    for (const name of BATCH_TICKS) expect(TICK_CATALOG.some((t) => t.name === name)).toBe(true);
    for (const name of ['outreach.drain.tick', 'mail.imap.tick', 'mail.probe.tick', 'ops.reaper.tick']) {
      expect(laneForJob(name)).toBe('ticks');
    }
    expect(laneForJob('connector.run')).toBe('runs');
    expect(laneForJob(LEARNING_PROCESS_JOB)).toBe('runs');
    expect(laneForJob(KNOWLEDGE_INDEX_JOB)).toBe('runs');
    expect(TICKS_QUEUE).not.toBe(RUNS_QUEUE);
    expect([TICKS_QUEUE, RUNS_QUEUE]).not.toContain(LEGACY_QUEUE_NAME);
  });

  it('lane concurrency: ticks 4, batch 3 and runs 2 by default, an env override, a typo refused', () => {
    expect(laneConcurrency('ticks', {})).toBe(4);
    expect(laneConcurrency('batch', {})).toBe(3);
    expect(laneConcurrency('runs', {})).toBe(2);
    expect(laneConcurrency('batch', { JOB_BATCH_CONCURRENCY: '1' })).toBe(1);
    expect(laneConcurrency('runs', { JOB_RUNS_CONCURRENCY: ' 3 ' })).toBe(3);
    expect(laneConcurrency('ticks', { JOB_TICKS_CONCURRENCY: '' })).toBe(4);
    for (const bad of ['0', 'two', '2.5', '-1', '33']) {
      expect(() => laneConcurrency('runs', { JOB_RUNS_CONCURRENCY: bad })).toThrow(LaneConfigError);
    }
  });

  it('only connector.run is retried: 3 attempts, exponential backoff from 30 s', () => {
    expect(retryPolicyFor('connector.run')).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delayMs: 30_000 },
    });
    expect(retryPolicyFor('outreach.drain.tick').attempts).toBe(1);
    expect(retryPolicyFor(LEARNING_PROCESS_JOB).attempts).toBe(1);
    expect(retryPolicyFor(KNOWLEDGE_INDEX_JOB).attempts).toBe(1);
  });
});

// ---- process role -----------------------------------------------------------

describe('process role (PC-36)', () => {
  it('parses ROLE: unset or blank is all; case and spaces are forgiven; a typo is an error', () => {
    expect(parseProcessRole(undefined)).toBe('all');
    expect(parseProcessRole('  ')).toBe('all');
    expect(parseProcessRole(' WEB ')).toBe('web');
    expect(parseProcessRole('worker')).toBe('worker');
    expect(() => parseProcessRole('wrker')).toThrow(ProcessRoleError);
  });

  it('the web server: web enqueues only, all does everything, worker is refused', () => {
    expect(planWebProcess({ ROLE: 'web', JOB_QUEUE_PROVIDER: 'bullmq' })).toEqual({
      requested: 'web',
      role: 'web',
      runsWorkers: false,
      schedulesTicks: false,
      runsWatchdog: true,
    });
    expect(planWebProcess({ JOB_QUEUE_PROVIDER: 'bullmq' })).toMatchObject({
      role: 'all',
      runsWorkers: true,
      schedulesTicks: true,
      runsWatchdog: true,
    });
    expect(() => planWebProcess({ ROLE: 'worker', JOB_QUEUE_PROVIDER: 'bullmq' })).toThrow(
      /serves no HTTP/,
    );
  });

  it('ROLE=web on the in-memory queue runs the jobs itself, with a warning', () => {
    const plan = planWebProcess({ ROLE: 'web' });
    expect(plan).toMatchObject({ requested: 'web', role: 'all', runsWorkers: true });
    expect(plan.warning).toMatch(/JOB_QUEUE_PROVIDER=bullmq/);
  });

  it('the worker entry: worker (or unset) on bullmq only', () => {
    expect(planWorkerProcess({ JOB_QUEUE_PROVIDER: 'bullmq' })).toEqual({
      requested: 'worker',
      role: 'worker',
      runsWorkers: true,
      schedulesTicks: true,
      runsWatchdog: false,
    });
    expect(planWorkerProcess({ ROLE: 'worker', JOB_QUEUE_PROVIDER: 'bullmq' }).role).toBe('worker');
    expect(() => planWorkerProcess({ ROLE: 'web', JOB_QUEUE_PROVIDER: 'bullmq' })).toThrow(
      ProcessRoleError,
    );
    expect(() => planWorkerProcess({ ROLE: 'all', JOB_QUEUE_PROVIDER: 'bullmq' })).toThrow(
      ProcessRoleError,
    );
    expect(() => planWorkerProcess({ ROLE: 'worker' })).toThrow(/JOB_QUEUE_PROVIDER=bullmq/);
  });

  it('a queue consumes jobs everywhere except in a web process on a shared queue', () => {
    expect(queueConsumesJobs({ ROLE: 'web', JOB_QUEUE_PROVIDER: 'bullmq' })).toBe(false);
    expect(queueConsumesJobs({ ROLE: 'web' })).toBe(true);
    expect(queueConsumesJobs({ ROLE: 'worker', JOB_QUEUE_PROVIDER: 'bullmq' })).toBe(true);
    expect(queueConsumesJobs({ JOB_QUEUE_PROVIDER: 'bullmq' })).toBe(true);
    expect(queueConsumesJobs({ ROLE: '???', JOB_QUEUE_PROVIDER: 'bullmq' })).toBe(true);
  });

  it('the queue factory builds the BullMQ queue non-consuming under ROLE=web only', () => {
    expect(bullmqQueueOptionsFromEnv({ ROLE: 'web', JOB_QUEUE_PROVIDER: 'bullmq' })).toEqual({
      consume: false,
    });
    expect(bullmqQueueOptionsFromEnv({ ROLE: 'worker', JOB_QUEUE_PROVIDER: 'bullmq' })).toEqual({
      consume: true,
    });
    expect(bullmqQueueOptionsFromEnv({ JOB_QUEUE_PROVIDER: 'bullmq' })).toEqual({ consume: true });
    // Building it opens no Redis connection: queues and workers are lazy.
    const q = new BullMQJobQueue(
      bullmqQueueOptionsFromEnv({ ROLE: 'web', JOB_QUEUE_PROVIDER: 'bullmq' }),
    );
    q.on('connector.run', async () => 'x');
    expect(q.consume).toBe(false);
    expect(q.activeLanes()).toEqual([]);
  });
});

// ---- in-memory queue ------------------------------------------------------

describe('InMemoryJobQueue lanes (PC-36)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(1) drain ticks stay on schedule while a long run occupies the runs lane', async () => {
    const q = new InMemoryJobQueue();
    const longRun = deferred();
    let runsStarted = 0;
    let runsFinished = 0;
    q.on('connector.run', async () => {
      runsStarted++;
      await longRun.promise;
      runsFinished++;
    });
    let drains = 0;
    q.on('outreach.drain.tick', async () => {
      drains++;
    });

    await q.enqueue('connector.run', { runId: '1' });
    await q.enqueue('connector.run', { runId: '2' });
    await q.enqueueRepeatable('outreach.drain.tick', {}, { everyMs: 30, jobId: 'drain' });
    await vi.advanceTimersByTimeAsync(100); // slots at 30, 60, 90

    expect(drains).toBe(3);
    // The runs lane is still busy with the first run; the second waits its turn.
    expect(runsStarted).toBe(1);
    expect(runsFinished).toBe(0);

    longRun.resolve();
    await q.drain();
    expect(runsFinished).toBe(2);
    await q.close();
  });

  it('(1) the drain keeps its cadence while four long AI ticks hold the batch lane', async () => {
    const q = new InMemoryJobQueue();
    const longTicks = deferred();
    const started: string[] = [];
    for (const name of BATCH_TICKS) {
      q.on(name, async () => {
        started.push(name);
        await longTicks.promise;
      });
    }
    let drains = 0;
    q.on('outreach.drain.tick', async () => {
      drains++;
    });
    let imaps = 0;
    q.on('mail.imap.tick', async () => {
      imaps++;
    });

    for (const name of BATCH_TICKS) await q.enqueue(name, {});
    await q.enqueueRepeatable('outreach.drain.tick', {}, { everyMs: 30, jobId: 'drain' });
    await q.enqueueRepeatable('mail.imap.tick', {}, { everyMs: 120, jobId: 'imap' });
    await vi.advanceTimersByTimeAsync(250); // drain slots at 30 ... 240, imap at 120, 240

    // The first long AI tick holds the batch lane; the drain and the inbox
    // sync never wait for any of them.
    expect(started).toEqual(['autopilot.tick']);
    expect(drains).toBe(8);
    expect(imaps).toBe(2);

    longTicks.resolve();
    await q.drain();
    expect(started).toEqual([...BATCH_TICKS]);
    await q.close();
  });

  it('(2) a tick is never stacked: at most one pending per type while its lane is busy', async () => {
    const q = new InMemoryJobQueue();
    const longTick = deferred();
    // A long tick on the ticks lane itself (retention deleting a big backlog).
    q.on('ops.retention.tick', async () => {
      await longTick.promise;
    });
    let drains = 0;
    q.on('outreach.drain.tick', async () => {
      drains++;
    });
    await q.enqueue('ops.retention.tick', {});
    await q.enqueueRepeatable('outreach.drain.tick', {}, { everyMs: 30, jobId: 'drain' });

    await vi.advanceTimersByTimeAsync(300); // ten slots while the ticks lane is busy
    expect(drains).toBe(0);
    expect(q.pendingCount('outreach.drain.tick')).toBe(1);

    longTick.resolve();
    await q.drain();
    // One catch-up run, not a burst of ten back to back.
    expect(drains).toBe(1);
    expect(q.pendingCount('outreach.drain.tick')).toBe(0);

    await vi.advanceTimersByTimeAsync(30);
    await q.drain();
    expect(drains).toBe(2);
    await q.close();
  });

  it('a tick with no handler stays a single pending job however many slots pass', async () => {
    const q = new InMemoryJobQueue();
    await q.enqueueRepeatable('mail.imap.tick', {}, { everyMs: 10, jobId: 'imap' });
    await vi.advanceTimersByTimeAsync(200);
    expect(q.pendingCount('mail.imap.tick')).toBe(1);
    await q.close();
  });

  it('runs-lane jobs still run one at a time (no concurrent writes on shared rows)', async () => {
    const q = new InMemoryJobQueue();
    const order: string[] = [];
    const first = deferred();
    q.on('connector.run', async (p: { runId?: string }) => {
      order.push(`start ${p.runId}`);
      if (p.runId === 'a') await first.promise;
      order.push(`end ${p.runId}`);
    });
    q.on(LEARNING_PROCESS_JOB, async () => {
      order.push('learning');
    });
    await q.enqueue('connector.run', { runId: 'a' });
    await q.enqueue(LEARNING_PROCESS_JOB, {});
    await q.enqueue('connector.run', { runId: 'b' });
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['start a']);
    first.resolve();
    await q.drain();
    expect(order).toEqual(['start a', 'end a', 'learning', 'start b', 'end b']);
  });

  it('a dedupe key holds while its job waits or runs, and is free again after', async () => {
    const q = new InMemoryJobQueue();
    const gate = deferred();
    let runs = 0;
    q.on(LEARNING_PROCESS_JOB, async () => {
      runs++;
      await gate.promise;
    });
    const a = await q.enqueue(
      LEARNING_PROCESS_JOB,
      { decisionId: 'd1' },
      { dedupeKey: 'learning:d1' },
    );
    const b = await q.enqueue(
      LEARNING_PROCESS_JOB,
      { decisionId: 'd1' },
      { dedupeKey: 'learning:d1' },
    );
    const other = await q.enqueue(
      LEARNING_PROCESS_JOB,
      { decisionId: 'd2' },
      { dedupeKey: 'learning:d2' },
    );
    expect(b).toBe(a);
    expect(other).not.toBe(a);
    await vi.advanceTimersByTimeAsync(0);
    // Running now: still deduplicated.
    expect(await q.enqueue(LEARNING_PROCESS_JOB, {}, { dedupeKey: 'learning:d1' })).toBe(a);
    gate.resolve();
    await q.drain();
    expect(runs).toBe(2);
    const c = await q.enqueue(LEARNING_PROCESS_JOB, {}, { dedupeKey: 'learning:d1' });
    expect(c).not.toBe(a);
    await q.drain();
    expect(runs).toBe(3);
  });

  it('cancelling a waiting job frees its dedupe key and its pending slot', async () => {
    const q = new InMemoryJobQueue();
    const id = await q.enqueue('knowledge.index', {}, { dedupeKey: 'knowledge-index:1' });
    expect(q.pendingCount('knowledge.index')).toBe(1);
    await q.cancel(id);
    expect(q.pendingCount('knowledge.index')).toBe(0);
    expect(await q.enqueue('knowledge.index', {}, { dedupeKey: 'knowledge-index:1' })).not.toBe(id);
  });
});

// ---- BullMQ wiring (fakes) ------------------------------------------------

describe('BullMQJobQueue lanes (PC-36, fakes)', () => {
  it('(3) a non-consuming queue (ROLE=web) starts no worker, whatever registers handlers', async () => {
    const { q, workers, queue } = fakeBull({ consume: false });
    q.on('connector.run', async () => 'x');
    q.on('outreach.drain.tick', async () => 'x');
    q.on(LEARNING_PROCESS_JOB, async () => 'x');
    expect(workers).toHaveLength(0);
    expect(q.activeLanes()).toEqual([]);
    // It still enqueues.
    const id = await q.enqueue('connector.run', { runId: '9' });
    expect(id).toBe('runs:1');
    expect(queue(RUNS_QUEUE).added).toHaveLength(1);
  });

  it('a consuming queue starts one worker per lane, with the lane concurrency', () => {
    const { q, workers } = fakeBull({ env: { JOB_TICKS_CONCURRENCY: '5' } });
    q.on('connector.run', async () => 'x');
    q.on(KNOWLEDGE_INDEX_JOB, async () => 'x');
    q.on('outreach.drain.tick', async () => 'x');
    q.on('mail.imap.tick', async () => 'x');
    q.on('autopilot.tick', async () => 'x');
    q.on('outreach.follow_up.tick', async () => 'x');
    expect(workers.map((w) => [w.queueName, w.concurrency])).toEqual([
      [RUNS_QUEUE, 2],
      [TICKS_QUEUE, 5],
      [BATCH_QUEUE, 3],
    ]);
    expect(q.activeLanes()).toEqual(['ticks', 'batch', 'runs']);
  });

  it('the long AI ticks are scheduled on the batch queue, never on the ticks queue', async () => {
    const { q, queue } = fakeBull();
    for (const name of BATCH_TICKS) {
      await q.enqueueRepeatable(name, {}, { everyMs: 300_000, jobId: name });
    }
    await q.enqueueRepeatable('outreach.drain.tick', {}, { everyMs: 30_000, jobId: 'd' });
    expect(queue(BATCH_QUEUE).repeatables.map((r) => r.name)).toEqual([...BATCH_TICKS]);
    expect(queue(TICKS_QUEUE).repeatables.map((r) => r.name)).toEqual(['outreach.drain.tick']);
    expect(decodeJobId(await q.enqueue('autopilot.tick', {})).lane).toBe('batch');
  });

  it('connector.run goes to the runs queue with 3 attempts and exponential backoff', async () => {
    const { q, queue } = fakeBull();
    const id = await q.enqueue('connector.run', { runId: '1' });
    expect(decodeJobId(id)).toEqual({ lane: 'runs', rawId: '1' });
    const [added] = queue(RUNS_QUEUE).added;
    expect(added!.name).toBe('connector.run');
    expect(added!.opts).toMatchObject({
      attempts: CONNECTOR_RUN_RETRY.attempts,
      backoff: { type: 'exponential', delay: 30_000 },
    });
  });

  it('other jobs are not retried; a dedupe key becomes BullMQ deduplication', async () => {
    const { q, queue } = fakeBull();
    await q.enqueue(LEARNING_PROCESS_JOB, { decisionId: 'd' }, { dedupeKey: 'learning:d' });
    await q.enqueue('outreach.drain.tick', {});
    const learning = queue(RUNS_QUEUE).added[0]!;
    expect(learning.opts?.attempts).toBeUndefined();
    expect(learning.opts?.deduplication).toEqual({ id: 'learning:d' });
    const drain = queue(TICKS_QUEUE).added[0]!;
    expect(drain.opts?.attempts).toBeUndefined();
    expect(drain.opts?.deduplication).toBeUndefined();
  });

  it('repeatables are scheduled on the ticks queue, replacing an older schedule of the same name', async () => {
    const { q, queue } = fakeBull();
    await q.enqueueRepeatable('outreach.drain.tick', {}, { everyMs: 30_000, jobId: 'd' });
    await q.enqueueRepeatable('outreach.drain.tick', {}, { everyMs: 60_000, jobId: 'd' });
    const ticks = queue(TICKS_QUEUE);
    expect(ticks.repeatables).toEqual([
      { key: 'outreach.drain.tick:::60000', name: 'outreach.drain.tick' },
    ]);
    expect(ticks.added.at(-1)!.opts?.repeat).toEqual({ every: 60_000 });
  });

  it('the processor passes the lane-qualified id and the attempt; NonRetryableJobError stops retries', async () => {
    const { q, workers } = fakeBull();
    const seen: Array<{ jobId: string; attempt?: number }> = [];
    q.on('connector.run', async (_p, ctx) => {
      seen.push(ctx);
      if (ctx.attempt === 2) throw new NonRetryableJobError('row gone');
      if (ctx.attempt === 3) throw new Error('db blip');
      return 'ok';
    });
    const w = workers[0]!;
    await expect(w.process('connector.run', {}, 0, '41')).resolves.toBe('ok');
    await expect(w.process('connector.run', {}, 1, '41')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    const plain = await w.process('connector.run', {}, 2, '41').catch((e: unknown) => e);
    expect(plain).toBeInstanceOf(Error);
    expect(plain).not.toBeInstanceOf(UnrecoverableError);
    expect(seen).toEqual([
      { jobId: 'runs:41', attempt: 1 },
      { jobId: 'runs:41', attempt: 2 },
      { jobId: 'runs:41', attempt: 3 },
    ]);
    // A job nobody registered fails without retries.
    q.on('outreach.drain.tick', async () => 'x');
    await expect(workers[1]!.process('mystery.job', {})).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('status / cancel ask the queue the id names; an id without a lane is the pre-lane queue', async () => {
    const { q, queue } = fakeBull();
    const id = await q.enqueue('connector.run', { runId: '1' });
    expect(await q.status(id)).toEqual({ state: 'pending' });
    await q.cancel(id);
    expect(queue(RUNS_QUEUE).jobs.size).toBe(0);
    expect(await q.status(id)).toEqual({ state: 'unknown' });
    expect(await q.status('17')).toEqual({ state: 'unknown' });
    expect(queue(LEGACY_QUEUE_NAME)).toBeDefined();
    expect(encodeJobId('ticks', 3)).toBe('ticks:3');
    expect(decodeJobId('repeat:x')).toEqual({ lane: null, rawId: 'repeat:x' });
  });

  it('hasLiveJob scans the type’s own lane', async () => {
    const { q, queue } = fakeBull();
    await q.enqueue('connector.run', { runId: '5' });
    expect(await q.hasLiveJob('connector.run', { field: 'runId', value: '5' })).toBe(true);
    expect(await q.hasLiveJob('connector.run', { field: 'runId', value: '6' })).toBe(false);
    expect(queue(RUNS_QUEUE).scanned[0]).toEqual(
      expect.arrayContaining(['waiting', 'active', 'delayed']),
    );
  });

  it('moves the pre-lane queue: schedules removed, waiting jobs re-queued on their lane, taken ones skipped', async () => {
    const { q, queue, queues } = fakeBull();
    // Create the pre-lane queue as the old process left it.
    await q.status('0');
    const legacy = queue(LEGACY_QUEUE_NAME);
    legacy.repeatables = [
      { key: 'outreach.drain.tick:::30000', name: 'outreach.drain.tick' },
      { key: 'mail.imap.tick:::120000', name: 'mail.imap.tick' },
    ];
    legacy.seed({
      id: 'repeat:abc:1',
      name: 'outreach.drain.tick',
      state: 'delayed',
      repeat: true,
    });
    legacy.seed({ id: '11', name: 'connector.run', data: { runId: '77' } });
    legacy.seed({
      id: '12',
      name: LEARNING_PROCESS_JOB,
      data: { decisionId: 'd' },
      state: 'delayed',
    });
    legacy.seed({ id: '13', name: KNOWLEDGE_INDEX_JOB, data: {} }).locked = true;
    legacy.seed({ id: '14', name: 'connector.run', data: { runId: '78' }, state: 'active' });

    const result = await q.migrateLegacyQueue();
    expect(result).toEqual({ schedulesRemoved: 2, jobsMoved: 2, jobsSkipped: 1 });
    expect(legacy.repeatables).toEqual([]);
    // The running job stays with its (old) process; the locked one too.
    expect([...legacy.jobs.keys()].sort()).toEqual(['13', '14']);
    const moved = queue(RUNS_QUEUE).added.map((a) => [a.name, a.data, a.opts?.attempts]);
    expect(moved).toEqual([
      ['connector.run', { runId: '77' }, 3],
      [LEARNING_PROCESS_JOB, { decisionId: 'd' }, undefined],
    ]);
    // No tick was re-queued: the lane schedule replaces the old one.
    expect(queues.get(TICKS_QUEUE)?.added ?? []).toEqual([]);

    // Idempotent.
    expect(await q.migrateLegacyQueue()).toEqual({
      schedulesRemoved: 0,
      jobsMoved: 0,
      jobsSkipped: 1,
    });
  });

  it('close() lets running jobs finish, and stops a worker hard after the grace', async () => {
    const { q, workers, queues } = fakeBull();
    q.on('connector.run', async () => 'x');
    q.on('outreach.drain.tick', async () => 'x');
    workers[0]!.hangOnClose = true;
    await q.close({ graceMs: 20 });
    expect(workers.map((w) => w.closedWith)).toEqual(['force', 'graceful']);
    expect([...queues.values()].every((f) => f.closed)).toBe(true);
    expect(q.activeLanes()).toEqual([]);
  });
});

// ---- the web server's startup hook ----------------------------------------

describe('registerNodeRuntime (PC-36)', () => {
  function deps(env: Record<string, string>) {
    const calls = {
      background: [] as Array<{ schedule: boolean }>,
      watchdog: 0,
      exit: [] as number[],
    };
    return {
      calls,
      overrides: {
        env,
        startBackground: async (o: { schedule: boolean }) => {
          calls.background.push({ schedule: o.schedule });
        },
        startWatchdog: () => {
          calls.watchdog++;
        },
        log: () => {},
        warn: () => {},
        error: () => {},
        exit: (code: number) => {
          calls.exit.push(code);
        },
      },
    };
  }

  it('(3) ROLE=web: no background work, no schedule — only the watchdog', async () => {
    const { calls, overrides } = deps({ ROLE: 'web', JOB_QUEUE_PROVIDER: 'bullmq' });
    const plan = await registerNodeRuntime(overrides);
    expect(plan.role).toBe('web');
    expect(calls.background).toEqual([]);
    expect(calls.watchdog).toBe(1);
  });

  it('ROLE=all (the default): background work with the schedule, and the watchdog', async () => {
    const { calls, overrides } = deps({ JOB_QUEUE_PROVIDER: 'bullmq' });
    await registerNodeRuntime(overrides);
    expect(calls.background).toEqual([{ schedule: true }]);
    expect(calls.watchdog).toBe(1);
  });

  it('SCHEDULE_BACKGROUND_JOBS=0: handlers without a schedule, and no watchdog', async () => {
    const { calls, overrides } = deps({ SCHEDULE_BACKGROUND_JOBS: '0' });
    await registerNodeRuntime(overrides);
    expect(calls.background).toEqual([{ schedule: false }]);
    expect(calls.watchdog).toBe(0);
  });

  it('ROLE=worker or a typo: the web server exits instead of serving, and starts nothing', async () => {
    for (const ROLE of ['worker', 'wbe']) {
      const { calls, overrides } = deps({ ROLE, JOB_QUEUE_PROVIDER: 'bullmq' });
      await expect(registerNodeRuntime(overrides)).rejects.toThrow(ProcessRoleError);
      expect(calls).toEqual({ background: [], watchdog: 0, exit: [1] });
    }
  });

  it('(3) a web process that starts a discovery run still starts no worker', async () => {
    const { q } = fakeBull({
      consume: queueConsumesJobs({ ROLE: 'web', JOB_QUEUE_PROVIDER: 'bullmq' }),
    });
    _setJobQueueForTests(q);
    _resetHandlersForTests();
    try {
      // startRun() calls registerJobHandlers() before it enqueues.
      registerJobHandlers();
      expect(q.activeLanes()).toEqual([]);
    } finally {
      _resetHandlersForTests();
      _setJobQueueForTests(null);
    }
  });
});

// ---- the worker process -----------------------------------------------------

describe('worker process (PC-36)', () => {
  beforeEach(async () => {
    await truncateAll();
    _resetHandlersForTests();
    _resetRepeatablesForTests();
  });
  afterEach(() => {
    _resetHandlersForTests();
    _resetRepeatablesForTests();
    _setJobQueueForTests(null);
    vi.restoreAllMocks();
  });

  it('(3) ROLE=worker runs every lane and the schedule, moves the old queue, and serves no HTTP', async () => {
    const listen = vi.spyOn(net.Server.prototype, 'listen');
    const { q, queue, queues } = fakeBull();
    _setJobQueueForTests(q);
    const migrate = vi.spyOn(q, 'migrateLegacyQueue');
    const logs: string[] = [];

    const worker = await startWorkerProcess({
      env: { ROLE: 'worker', JOB_QUEUE_PROVIDER: 'bullmq' },
      queue: () => q,
      startBackground: startBackgroundWork,
      log: (m) => logs.push(m),
      error: (m) => logs.push(m),
      closeGraceMs: 50,
    });

    expect(worker.plan.role).toBe('worker');
    expect(q.activeLanes()).toEqual(['ticks', 'batch', 'runs']);
    expect(migrate).toHaveBeenCalledTimes(1);
    const scheduledOn = (name: string) =>
      queue(name)
        .added.filter((a) => a.opts?.repeat)
        .map((a) => a.name)
        .sort();
    const batch: readonly string[] = BATCH_TICKS;
    expect(scheduledOn(TICKS_QUEUE)).toEqual(
      TICK_CATALOG.map((t) => t.name)
        .filter((n) => !batch.includes(n))
        .sort(),
    );
    expect(scheduledOn(BATCH_QUEUE)).toEqual([...BATCH_TICKS].sort());
    expect((queues.get(RUNS_QUEUE)?.added ?? []).filter((a) => a.opts?.repeat)).toEqual([]);
    expect(listen).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/lanes ticks×4, batch×3, runs×2/);

    await worker.stop('test');
    await worker.stop('again');
    expect(q.activeLanes()).toEqual([]);
    expect(listen).not.toHaveBeenCalled();
  });

  it('refuses to start on the in-memory queue or as a web role, before anything runs', async () => {
    let started = 0;
    const startBackground = async () => {
      started++;
    };
    await expect(
      startWorkerProcess({ env: { ROLE: 'worker' }, startBackground, log: () => {} }),
    ).rejects.toThrow(/JOB_QUEUE_PROVIDER=bullmq/);
    await expect(
      startWorkerProcess({
        env: { ROLE: 'web', JOB_QUEUE_PROVIDER: 'bullmq' },
        startBackground,
        log: () => {},
      }),
    ).rejects.toThrow(ProcessRoleError);
    expect(started).toBe(0);
  });

  it('SCHEDULE_BACKGROUND_JOBS=0: the runs lane only, no schedule', async () => {
    const { q, queues } = fakeBull();
    _setJobQueueForTests(q);
    const worker = await startWorkerProcess({
      env: { ROLE: 'worker', JOB_QUEUE_PROVIDER: 'bullmq', SCHEDULE_BACKGROUND_JOBS: '0' },
      queue: () => q,
      startBackground: startBackgroundWork,
      log: () => {},
      error: () => {},
      closeGraceMs: 50,
    });
    expect(q.activeLanes()).toEqual(['runs']);
    expect(queues.get(TICKS_QUEUE)?.added ?? []).toEqual([]);
    await worker.stop('test');
  });
});
