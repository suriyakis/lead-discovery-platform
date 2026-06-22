// Job queue abstraction.
//
// Phase 1: in-memory implementation runs the handler synchronously on the
// next microtask. Suitable for dev and for tests; real durability arrives
// in Phase 6+ via BullMQ + Redis.
//
// The interface is intentionally tiny. Add capabilities (retries, delayed
// runs, repeats) only when a concrete handler needs them, not speculatively.

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
}

export type JobPayload = Record<string, unknown>;
export type JobHandler<P extends JobPayload = JobPayload> = (
  payload: P,
  ctx: { jobId: JobId },
) => Promise<unknown> | unknown;

export interface RepeatableJobOptions {
  /** Period in milliseconds. */
  everyMs: number;
  /** Stable suffix so re-registration replaces an existing repeatable. */
  jobId: string;
}

export interface IJobQueue {
  enqueue<P extends JobPayload>(type: string, payload: P, options?: JobOptions): Promise<JobId>;
  status(id: JobId): Promise<JobStatus>;
  cancel(id: JobId): Promise<void>;
  on<P extends JobPayload>(type: string, handler: JobHandler<P>): void;
  /**
   * Schedule a repeatable. The queue owns the cadence; the handler runs once
   * per period until the queue is shut down. Re-registering with the same
   * `jobId` replaces the existing schedule.
   */
  /**
   * Wait for all currently in-flight in-process jobs to settle. No-op on
   * queues that run jobs in separate workers (BullMQ). Used by the test
   * harness to stop fire-and-forget jobs leaking across test boundaries.
   */
  drain?(): Promise<void>;
  enqueueRepeatable<P extends JobPayload>(
    type: string,
    payload: P,
    options: RepeatableJobOptions,
  ): Promise<void>;
}

// ---- in-memory implementation ------------------------------------------

interface InternalJob {
  id: JobId;
  type: string;
  status: JobStatus;
  cancelled: boolean;
}

export class InMemoryJobQueue implements IJobQueue {
  public readonly id = 'memory';
  private nextId = 1;
  private jobs = new Map<JobId, InternalJob>();
  private handlers = new Map<string, JobHandler>();
  private timers = new Map<string, NodeJS.Timeout>();
  /**
   * Serializes handler execution. In-memory jobs run one at a time, so
   * fire-and-forget enqueues (e.g. a crawl plan firing several connector
   * runs) can't execute concurrently and deadlock each other — or the
   * caller's foreground DB writes — on shared rows. Production runs
   * JOB_QUEUE_PROVIDER=bullmq with real workers; this is dev/test only.
   */
  private tail: Promise<void> = Promise.resolve();

  async enqueue<P extends JobPayload>(
    type: string,
    payload: P,
    options: JobOptions = {},
  ): Promise<JobId> {
    void options;
    const id = String(this.nextId++);
    const job: InternalJob = { id, type, status: { state: 'pending' }, cancelled: false };
    this.jobs.set(id, job);

    const handler = this.handlers.get(type) as JobHandler<P> | undefined;
    if (!handler) {
      // No handler — leave job in pending. Status() reports it.
      return id;
    }

    // Chain onto the tail so handlers run sequentially. The body never
    // rejects (errors are captured into job.status), so the chain stays
    // intact for subsequent jobs.
    this.tail = this.tail.then(async () => {
      if (job.cancelled) {
        job.status = { state: 'cancelled' };
        return;
      }
      job.status = { state: 'running' };
      try {
        const result = await handler(payload, { jobId: id });
        job.status = { state: 'succeeded', result };
      } catch (err) {
        job.status = {
          state: 'failed',
          error: { message: err instanceof Error ? err.message : String(err) },
        };
      }
    });

    return id;
  }

  async status(id: JobId): Promise<JobStatus> {
    const job = this.jobs.get(id);
    if (!job) return { state: 'unknown' };
    return job.status;
  }

  /** Await all chained jobs. Loops until the tail stops growing so jobs
   *  that enqueue follow-up jobs are fully drained. */
  async drain(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.tail;
      await current;
    } while (current !== this.tail);
  }

  async cancel(id: JobId): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.cancelled = true;
    if (job.status.state === 'pending') {
      job.status = { state: 'cancelled' };
    }
    // Already-running jobs run to completion in the in-memory impl. Real
    // queues should support cooperative cancellation.
  }

  on<P extends JobPayload>(type: string, handler: JobHandler<P>): void {
    this.handlers.set(type, handler as JobHandler);
  }

  /**
   * In-memory repeatable: setInterval-backed. Lost on restart — fine
   * for dev. Production must run JOB_QUEUE_PROVIDER=bullmq.
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
      void this.enqueue(type, payload);
    }, options.everyMs);
    // Don't keep the event loop alive solely for repeatable jobs.
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(key, timer);
  }
}

// ---- factory -----------------------------------------------------------

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
      cached = new BullMQJobQueue();
      return cached;
    }
    default:
      throw new Error(
        `Unknown JOB_QUEUE_PROVIDER: ${id}. Supported: "memory", "bullmq".`,
      );
  }
}

export function _setJobQueueForTests(queue: IJobQueue | null): void {
  cached = queue;
}
