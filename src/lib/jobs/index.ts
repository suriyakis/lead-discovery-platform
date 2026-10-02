// Job queue abstraction.
//
// Two implementations: the in-memory queue (dev and tests; the handler runs
// on a microtask in this process) and BullMQ on Redis (production,
// JOB_QUEUE_PROVIDER=bullmq; bullmq.ts).
//
// PC-36 (I065): jobs run on two lanes (lanes.ts) — 'ticks' for the
// repeatable ticks and 'runs' for on-demand work (discovery runs, knowledge
// indexing, learning) — so a long run never delays the 30 s drain tick or
// the inbox sync. Which process consumes them is the process role
// (role.ts): in production the web server only enqueues and a separate
// worker service runs both lanes.
//
// The interface is intentionally tiny. Add capabilities only when a
// concrete handler needs them, not speculatively.

import { laneForJob, JOB_LANES, type JobLane } from './lanes';
import { queueConsumesJobs } from './role';

export type JobId = string;

export type JobStatus =
  | { state: 'pending' }
  | { state: 'running' }
  | { state: 'succeeded'; result: unknown }
  | { state: 'failed'; error: { message: string } }
  | { state: 'cancelled' }
  | { state: 'unknown' };

export interface JobOptions {
  /** Diagnostic key. Doesn't affect execution; surfaces in logs/metrics. */
  tag?: string;
  /**
   * PC-36: while a job enqueued with this key is still waiting (or delayed,
   * or running), enqueueing the same key again adds nothing and returns
   * that job's id. For work an outbox sweeper re-enqueues (learning,
   * knowledge indexing): a job that waits its turn behind long runs must
   * not be queued again on every sweep.
   */
  dedupeKey?: string;
}

export type JobPayload = Record<string, unknown>;
export type JobHandler<P extends JobPayload = JobPayload> = (
  payload: P,
  /** `attempt` is 1-based; above 1 only for a queue retry (BullMQ). */
  ctx: { jobId: JobId; attempt?: number },
) => Promise<unknown> | unknown;

/**
 * Thrown by a handler when trying again cannot help (the job's row is gone,
 * the payload names another workspace): BullMQ fails the job at once
 * instead of spending its remaining attempts.
 */
export class NonRetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableJobError';
  }
}

export interface RepeatableJobOptions {
  /** Period in milliseconds. */
  everyMs: number;
  /** Stable suffix so re-registration replaces an existing repeatable. */
  jobId: string;
}

/** What BullMQJobQueue.migrateLegacyQueue moved off the pre-PC-36 queue. */
export interface LegacyQueueMigration {
  /** Repeatable schedules removed from the old queue. */
  schedulesRemoved: number;
  /** Waiting / delayed jobs moved onto their lane. */
  jobsMoved: number;
  /** Jobs another (old) process took while they were being moved. */
  jobsSkipped: number;
}

export interface IJobQueue {
  /** Provider id ('memory' | 'bullmq'); heartbeats record it to pick the
   *  tick slot alignment (PC-07). */
  readonly id?: string;
  enqueue<P extends JobPayload>(type: string, payload: P, options?: JobOptions): Promise<JobId>;
  status(id: JobId): Promise<JobStatus>;
  cancel(id: JobId): Promise<void>;
  /**
   * Register the handler of a job type. A queue that consumes jobs in this
   * process starts running that type's lane; one in a web process
   * (ROLE=web, PC-36) only records it.
   */
  on<P extends JobPayload>(type: string, handler: JobHandler<P>): void;
  /**
   * Wait for all currently in-flight in-process jobs to settle. No-op on
   * queues that run jobs in separate workers (BullMQ). Used by the test
   * harness to stop fire-and-forget jobs leaking across test boundaries.
   */
  drain?(): Promise<void>;
  /**
   * PC-10: is a job of `type` whose payload has `payload[match.field] ===
   * match.value` still waiting (or delayed) or running? The stuck-work
   * reaper asks before it fails a 'pending' connector run as lost: under
   * BullMQ a run can wait its turn behind long runs for a long time.
   */
  hasLiveJob?(type: string, match: { field: string; value: string }): Promise<boolean>;
  /**
   * Schedule a repeatable. The queue owns the cadence; the handler runs once
   * per period until the queue is shut down. Re-registering with the same
   * `jobId` replaces the existing schedule.
   */
  enqueueRepeatable<P extends JobPayload>(
    type: string,
    payload: P,
    options: RepeatableJobOptions,
  ): Promise<void>;
  /** PC-36: move what still waits on the pre-lane queue onto the lanes
   *  (BullMQ only; run once at worker boot, idempotent). */
  migrateLegacyQueue?(): Promise<LegacyQueueMigration>;
  /** Stop: no new jobs start; running ones get up to `graceMs` to finish. */
  close?(options?: { graceMs?: number }): Promise<void>;
}

// ---- in-memory implementation ------------------------------------------

interface InternalJob {
  id: JobId;
  type: string;
  payload: JobPayload;
  status: JobStatus;
  cancelled: boolean;
  dedupeKey?: string;
}

export class InMemoryJobQueue implements IJobQueue {
  public readonly id = 'memory';
  private nextId = 1;
  private jobs = new Map<JobId, InternalJob>();
  private handlers = new Map<string, JobHandler>();
  private timers = new Map<string, NodeJS.Timeout>();
  /** Jobs per type that are still waiting to start (PC-36: ticks never stack). */
  private waiting = new Map<string, number>();
  /** dedupe key → the waiting or running job holding it. */
  private dedupe = new Map<string, JobId>();
  /**
   * One serial chain per lane. Jobs of a lane run one at a time, so
   * fire-and-forget enqueues (e.g. a crawl plan firing several connector
   * runs) can't execute concurrently and deadlock each other — or the
   * caller's foreground DB writes — on shared rows. PC-36: the two lanes
   * run side by side, like the two BullMQ workers, so a long connector run
   * never holds up the drain tick. Retries are BullMQ's: here every job
   * runs once.
   */
  private tails: Record<JobLane, Promise<void>> = {
    ticks: Promise.resolve(),
    runs: Promise.resolve(),
  };

  async enqueue<P extends JobPayload>(
    type: string,
    payload: P,
    options: JobOptions = {},
  ): Promise<JobId> {
    if (options.dedupeKey) {
      const holder = this.dedupe.get(options.dedupeKey);
      if (holder !== undefined) return holder;
    }
    const id = String(this.nextId++);
    const job: InternalJob = {
      id,
      type,
      payload,
      status: { state: 'pending' },
      cancelled: false,
      ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
    };
    this.jobs.set(id, job);
    this.waiting.set(type, (this.waiting.get(type) ?? 0) + 1);
    if (job.dedupeKey) this.dedupe.set(job.dedupeKey, id);

    const handler = this.handlers.get(type) as JobHandler<P> | undefined;
    if (!handler) {
      // No handler — leave job in pending. Status() reports it.
      return id;
    }

    // Chain onto the lane's tail so the lane's handlers run sequentially.
    // The body never rejects (errors are captured into job.status), so the
    // chain stays intact for subsequent jobs.
    const lane = laneForJob(type);
    this.tails[lane] = this.tails[lane].then(async () => {
      if (job.cancelled) {
        job.status = { state: 'cancelled' };
        return;
      }
      this.leaveWaiting(job);
      job.status = { state: 'running' };
      try {
        const result = await handler(payload, { jobId: id, attempt: 1 });
        job.status = { state: 'succeeded', result };
      } catch (err) {
        job.status = {
          state: 'failed',
          error: { message: err instanceof Error ? err.message : String(err) },
        };
      } finally {
        this.releaseDedupe(job);
      }
    });

    return id;
  }

  private leaveWaiting(job: InternalJob): void {
    const n = (this.waiting.get(job.type) ?? 1) - 1;
    if (n <= 0) this.waiting.delete(job.type);
    else this.waiting.set(job.type, n);
  }

  private releaseDedupe(job: InternalJob): void {
    if (job.dedupeKey && this.dedupe.get(job.dedupeKey) === job.id) {
      this.dedupe.delete(job.dedupeKey);
    }
  }

  async status(id: JobId): Promise<JobStatus> {
    const job = this.jobs.get(id);
    if (!job) return { state: 'unknown' };
    return job.status;
  }

  /** Await all chained jobs on every lane. Loops until no tail grows any
   *  more, so jobs that enqueue follow-up jobs are fully drained. */
  async drain(): Promise<void> {
    for (;;) {
      const snapshot = JOB_LANES.map((lane) => this.tails[lane]);
      await Promise.all(snapshot);
      if (JOB_LANES.every((lane, i) => this.tails[lane] === snapshot[i])) return;
    }
  }

  async hasLiveJob(type: string, match: { field: string; value: string }): Promise<boolean> {
    for (const job of this.jobs.values()) {
      if (job.type !== type) continue;
      if (job.status.state !== 'pending' && job.status.state !== 'running') continue;
      if (job.payload[match.field] === match.value) return true;
    }
    return false;
  }

  async cancel(id: JobId): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.cancelled = true;
    if (job.status.state === 'pending') {
      job.status = { state: 'cancelled' };
      this.leaveWaiting(job);
      this.releaseDedupe(job);
    }
    // Already-running jobs run to completion in the in-memory impl. Real
    // queues should support cooperative cancellation.
  }

  on<P extends JobPayload>(type: string, handler: JobHandler<P>): void {
    this.handlers.set(type, handler as JobHandler);
  }

  /**
   * In-memory repeatable: setInterval-backed. Lost on restart — fine
   * for dev. Production runs JOB_QUEUE_PROVIDER=bullmq.
   *
   * PC-36 (I065): a tick is never stacked. While one of its jobs still
   * waits to start (its lane is busy), the interval adds no other, so a
   * busy lane leaves at most one pending tick per type — not a backlog of
   * 30-second drain ticks that then run back to back.
   */
  async enqueueRepeatable<P extends JobPayload>(
    type: string,
    payload: P,
    options: RepeatableJobOptions,
  ): Promise<void> {
    const key = `${type}:${options.jobId}`;
    const existing = this.timers.get(key);
    if (existing) clearInterval(existing);
    const timer = setInterval(() => {
      if ((this.waiting.get(type) ?? 0) > 0) return;
      void this.enqueue(type, payload);
    }, options.everyMs);
    // Don't keep the event loop alive solely for repeatable jobs.
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(key, timer);
  }

  /** How many jobs of `type` wait to start (tests, diagnostics). */
  pendingCount(type: string): number {
    return this.waiting.get(type) ?? 0;
  }

  /** Stop the repeatables and let the running jobs settle. */
  async close(): Promise<void> {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    await this.drain();
  }
}

// ---- factory -----------------------------------------------------------

/**
 * PC-36: how the factory builds the BullMQ queue. A web process
 * (ROLE=web) enqueues only; the worker service consumes. Decided from the
 * environment, so every bundle of the Next.js server agrees.
 */
export function bullmqQueueOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { consume: boolean } {
  return { consume: queueConsumesJobs(env) };
}

let cached: IJobQueue | null = null;

export function getJobQueue(): IJobQueue {
  if (cached) return cached;
  const id = process.env.JOB_QUEUE_PROVIDER ?? 'memory';
  switch (id) {
    case 'memory':
      cached = new InMemoryJobQueue();
      return cached;
    case 'bullmq': {
      // Dynamic import so the bullmq + ioredis modules don't load (or
      // require a Redis connection) when the operator chose memory.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { BullMQJobQueue } = require('./bullmq') as typeof import('./bullmq');
      cached = new BullMQJobQueue(bullmqQueueOptionsFromEnv());
      return cached;
    }
    default:
      throw new Error(`Unknown JOB_QUEUE_PROVIDER: ${id}. Supported: "memory", "bullmq".`);
  }
}

export function _setJobQueueForTests(queue: IJobQueue | null): void {
  cached = queue;
}
