// BullMQ-backed durable job queue. Backed by Redis. Used in production
// when JOB_QUEUE_PROVIDER=bullmq.
//
// Single named queue ("lead-platform"). Job NAMES distinguish handlers
// (`connector.run`, `crawl.recipe`, etc.). One Worker dispatches by name.

import { Queue, Worker, Job, type Processor, type WorkerOptions } from 'bullmq';
import IORedis, { type RedisOptions } from 'ioredis';
import type { IJobQueue, JobHandler, JobId, JobOptions, JobPayload, JobStatus } from './index';

const QUEUE_NAME = 'lead-platform';

export class BullMQJobQueue implements IJobQueue {
  public readonly id = 'bullmq';

  private readonly redis: IORedis;
  private readonly queue: Queue;
  private worker: Worker | null = null;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly concurrency: number;

  constructor(opts: {
    redisUrl?: string;
    redisOptions?: RedisOptions;
    concurrency?: number;
  } = {}) {
    const url = opts.redisUrl ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
    // BullMQ requires maxRetriesPerRequest: null on its connection.
    this.redis = new IORedis(url, {
      maxRetriesPerRequest: null,
      ...(opts.redisOptions ?? {}),
    });
    this.queue = new Queue(QUEUE_NAME, { connection: this.redis });
    this.concurrency = opts.concurrency ?? 4;
  }

  async enqueue<P extends JobPayload>(
    type: string,
    payload: P,
    options: JobOptions = {},
  ): Promise<JobId> {
    const job = await this.queue.add(type, payload, {
      removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
      removeOnFail: { age: 30 * 24 * 3600 },
    });
    void options;
    return String(job.id);
  }

  async status(id: JobId): Promise<JobStatus> {
    const job = await Job.fromId(this.queue, id);
    if (!job) return { state: 'unknown' };
    const state = await job.getState();
    switch (state) {
      case 'waiting':
      case 'waiting-children':
      case 'delayed':
      case 'prioritized':
        return { state: 'pending' };
      case 'active':
        return { state: 'running' };
      case 'completed':
        return { state: 'succeeded', result: job.returnvalue };
      case 'failed':
        return { state: 'failed', error: { message: job.failedReason ?? 'unknown' } };
      default:
        return { state: 'unknown' };
    }
  }

  async cancel(id: JobId): Promise<void> {
    const job = await Job.fromId(this.queue, id);
    if (!job) return;
    // BullMQ: `remove()` works for non-active jobs; we don't support
    // killing in-flight jobs (cooperative cancellation only).
    try {
      await job.remove();
    } catch {
      // already running or already gone; tolerate
    }
  }

  on<P extends JobPayload>(type: string, handler: JobHandler<P>): void {
    this.handlers.set(type, handler as JobHandler);
    if (!this.worker) this.bootWorker();
  }

  /**
   * Close the queue + worker connections. Useful in tests and for
   * controlled shutdown.
   */
  async close(): Promise<void> {
    if (this.worker) await this.worker.close();
    await this.queue.close();
    await this.redis.quit();
  }

  private bootWorker() {
    const processor: Processor = async (job: Job) => {
      const h = this.handlers.get(job.name);
      if (!h) {
        throw new Error(`no handler registered for job type "${job.name}"`);
      }
      const jobId: JobId = String(job.id);
      const payload = job.data as JobPayload;
      return h(payload, { jobId });
    };
    const options: WorkerOptions = {
      connection: this.redis,
      concurrency: this.concurrency,
      autorun: true,
    };
    this.worker = new Worker(QUEUE_NAME, processor, options);
  }
}
