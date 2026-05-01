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

export interface IJobQueue {
  enqueue<P extends JobPayload>(type: string, payload: P, options?: JobOptions): Promise<JobId>;
  status(id: JobId): Promise<JobStatus>;
  cancel(id: JobId): Promise<void>;
  on<P extends JobPayload>(type: string, handler: JobHandler<P>): void;
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

    queueMicrotask(async () => {
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
    default:
      throw new Error(`Unknown JOB_QUEUE_PROVIDER: ${id}. Phase 1 supports only "memory".`);
  }
}

export function _setJobQueueForTests(queue: IJobQueue | null): void {
  cached = queue;
}
