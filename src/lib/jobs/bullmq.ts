// BullMQ-backed durable job queue. Backed by Redis. Used in production
// when JOB_QUEUE_PROVIDER=bullmq.
//
// PC-36 (I065): one Redis queue per lane (lanes.ts) — lead-platform-ticks
// for the repeatable ticks, lead-platform-runs for on-demand work — each
// with its own Worker and concurrency, so long discovery runs never take
// the slots the 30 s drain tick and the inbox sync need. Job NAMES still
// pick the handler (`connector.run`, `outreach.drain.tick`, …).
//
// Whether this process consumes jobs is decided at construction
// (`consume`, from the process role): the web server (ROLE=web) only
// enqueues — on() records the handler and starts no Worker — and the
// worker service runs both lanes.
//
// Job ids carry their lane (`runs:123`): each Redis queue numbers its own
// jobs, so status() and cancel() need to know which queue to ask. An id
// without a lane is looked up on the pre-PC-36 queue.

import {
  Queue,
  UnrecoverableError,
  Worker,
  type JobsOptions,
  type JobType,
  type Processor,
} from 'bullmq';
import IORedis, { type RedisOptions } from 'ioredis';
import {
  NonRetryableJobError,
  type IJobQueue,
  type JobHandler,
  type JobId,
  type JobOptions,
  type JobPayload,
  type JobStatus,
  type LegacyQueueMigration,
  type RepeatableJobOptions,
} from './index';
import { isInstrumentedHandler } from './instrumented';
import {
  JOB_LANES,
  LANE_DEFINITIONS,
  LEGACY_QUEUE_NAME,
  laneConcurrency,
  laneForJob,
  retryPolicyFor,
  type JobLane,
  type JobRetryPolicy,
} from './lanes';
import { attachWorkerEventReporting, type WorkerEventSource } from './worker-events';

/** Jobs scanned per state by hasLiveJob (the reaper's lost-run check). */
const LIVE_JOB_SCAN_LIMIT = 1000;
/** Jobs moved off the pre-PC-36 queue per boot. */
const LEGACY_SCAN_LIMIT = 5000;
/** close(): how long running jobs get to finish before the workers stop hard. */
export const DEFAULT_CLOSE_GRACE_MS = 25_000;

const LIVE_STATES: JobType[] = [
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'paused',
  'waiting-children',
];
const WAITING_STATES: JobType[] = ['waiting', 'delayed', 'prioritized', 'paused'];

// ---- the slices of BullMQ this class uses (fakes in unit tests) ----------

export interface QueuedJob {
  id?: string | null;
  name: string;
  data: unknown;
  opts?: { repeat?: unknown };
  returnvalue?: unknown;
  failedReason?: string;
  getState(): Promise<string>;
  remove(): Promise<void>;
}

export interface LaneQueue {
  readonly name: string;
  add(name: string, data: unknown, opts?: JobsOptions): Promise<{ id?: string | null }>;
  getJob(id: string): Promise<QueuedJob | undefined | null>;
  getJobs(types: JobType[], start?: number, end?: number): Promise<Array<QueuedJob | undefined>>;
  getRepeatableJobs(): Promise<Array<{ key: string; name: string }>>;
  removeRepeatableByKey(key: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface LaneWorker extends WorkerEventSource {
  close(force?: boolean): Promise<void>;
}

export interface BullMQFactories {
  queue: (name: string) => LaneQueue;
  worker: (name: string, processor: Processor, options: { concurrency: number }) => LaneWorker;
}

export interface BullMQJobQueueOptions {
  redisUrl?: string;
  redisOptions?: RedisOptions;
  /** Run the lane workers in this process (default true). */
  consume?: boolean;
  /** Per-lane concurrency; default from env (laneConcurrency). */
  concurrency?: Partial<Record<JobLane, number>>;
  /** Test seam: shorter backoff for a type. */
  retryPolicies?: Readonly<Record<string, JobRetryPolicy>>;
  /** Test seam: in-memory fakes instead of Redis. */
  factories?: BullMQFactories;
  /** Test seam: environment for the lane concurrency. */
  env?: Readonly<Record<string, string | undefined>>;
}

export function encodeJobId(lane: JobLane, rawId: string | number | null | undefined): JobId {
  return `${lane}:${rawId ?? ''}`;
}

export function decodeJobId(id: JobId): { lane: JobLane | null; rawId: string } {
  const sep = id.indexOf(':');
  if (sep > 0) {
    const lane = id.slice(0, sep);
    if ((JOB_LANES as readonly string[]).includes(lane)) {
      return { lane: lane as JobLane, rawId: id.slice(sep + 1) };
    }
  }
  return { lane: null, rawId: id };
}

function isRepeatInstance(job: QueuedJob): boolean {
  return Boolean(job.opts?.repeat) || String(job.id ?? '').startsWith('repeat:');
}

export class BullMQJobQueue implements IJobQueue {
  public readonly id = 'bullmq';

  readonly consume: boolean;
  private readonly redisUrl: string;
  private readonly redisOptions: RedisOptions;
  private connection: IORedis | null = null;
  private readonly factories: BullMQFactories;
  private readonly queues = new Map<string, LaneQueue>();
  private readonly workers = new Map<JobLane, LaneWorker>();
  private readonly handlers = new Map<string, JobHandler>();
  private readonly concurrency: Record<JobLane, number>;
  private readonly retryPolicies: Readonly<Record<string, JobRetryPolicy>>;

  constructor(opts: BullMQJobQueueOptions = {}) {
    this.redisUrl = opts.redisUrl ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.redisOptions = opts.redisOptions ?? {};
    this.consume = opts.consume ?? true;
    this.retryPolicies = opts.retryPolicies ?? {};
    const env = opts.env ?? process.env;
    // Read up front so a bad JOB_*_CONCURRENCY fails the boot, not the
    // first job.
    this.concurrency = {
      ticks: opts.concurrency?.ticks ?? laneConcurrency('ticks', env),
      runs: opts.concurrency?.runs ?? laneConcurrency('runs', env),
    };
    this.factories = opts.factories ?? {
      queue: (name) => new Queue(name, { connection: this.redis() }) as unknown as LaneQueue,
      worker: (name, processor, options) =>
        new Worker(name, processor, {
          connection: this.redis(),
          concurrency: options.concurrency,
          autorun: true,
        }),
    };
  }

  /** One connection for the queues; BullMQ duplicates it for each
   *  worker's blocking reads. Opened on first use. */
  private redis(): IORedis {
    if (!this.connection) {
      // BullMQ requires maxRetriesPerRequest: null on its connection.
      this.connection = new IORedis(this.redisUrl, {
        maxRetriesPerRequest: null,
        ...this.redisOptions,
      });
    }
    return this.connection;
  }

  private queueNamed(name: string): LaneQueue {
    let q = this.queues.get(name);
    if (!q) {
      q = this.factories.queue(name);
      this.queues.set(name, q);
    }
    return q;
  }

  private laneQueue(lane: JobLane): LaneQueue {
    return this.queueNamed(LANE_DEFINITIONS[lane].queueName);
  }

  private queueForId(id: JobId): { queue: LaneQueue; rawId: string } {
    const { lane, rawId } = decodeJobId(id);
    return { queue: lane ? this.laneQueue(lane) : this.queueNamed(LEGACY_QUEUE_NAME), rawId };
  }

  /** The concurrency each lane's worker runs with (diagnostics, tests). */
  laneConcurrency(lane: JobLane): number {
    return this.concurrency[lane];
  }

  /** Lanes with a running worker in this process (diagnostics, tests). */
  activeLanes(): JobLane[] {
    return JOB_LANES.filter((lane) => this.workers.has(lane));
  }

  private jobOptions(type: string, options: JobOptions): JobsOptions {
    const policy = this.retryPolicies[type] ?? retryPolicyFor(type);
    return {
      removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
      removeOnFail: { age: 30 * 24 * 3600 },
      ...(policy.attempts > 1
        ? {
            attempts: policy.attempts,
            backoff: { type: policy.backoff.type, delay: policy.backoff.delayMs },
          }
        : {}),
      ...(options.dedupeKey ? { deduplication: { id: options.dedupeKey } } : {}),
    };
  }

  async enqueue<P extends JobPayload>(
    type: string,
    payload: P,
    options: JobOptions = {},
  ): Promise<JobId> {
    const lane = laneForJob(type);
    const job = await this.laneQueue(lane).add(type, payload, this.jobOptions(type, options));
    return encodeJobId(lane, job.id);
  }

  /** PC-10: see IJobQueue.hasLiveJob. Scans the type's lane, up to
   *  LIVE_JOB_SCAN_LIMIT jobs; a job beyond that reads as not live. */
  async hasLiveJob(type: string, match: { field: string; value: string }): Promise<boolean> {
    const jobs = await this.laneQueue(laneForJob(type)).getJobs(
      LIVE_STATES,
      0,
      LIVE_JOB_SCAN_LIMIT - 1,
    );
    return jobs.some(
      (job) =>
        job?.name === type &&
        (job.data as Record<string, unknown> | undefined)?.[match.field] === match.value,
    );
  }

  async status(id: JobId): Promise<JobStatus> {
    const { queue, rawId } = this.queueForId(id);
    const job = await queue.getJob(rawId);
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
    const { queue, rawId } = this.queueForId(id);
    const job = await queue.getJob(rawId);
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
    if (this.consume) this.ensureWorker(laneForJob(type));
  }

  /**
   * BullMQ repeatable, on the type's lane. The legacy `repeat: { every }`
   * on purpose: its slots are aligned to the Unix epoch, which the tick
   * staleness rule relies on (tick-schedule.ts). Re-registering removes
   * the prior schedule of the same name, so a changed cadence takes effect
   * on the next boot; the queue's `:repeat` namespace dedupes across
   * processes.
   */
  async enqueueRepeatable<P extends JobPayload>(
    type: string,
    payload: P,
    options: RepeatableJobOptions,
  ): Promise<void> {
    const queue = this.laneQueue(laneForJob(type));
    const existing = await queue.getRepeatableJobs();
    for (const r of existing) {
      if (r.name === type) {
        try {
          await queue.removeRepeatableByKey(r.key);
        } catch {
          // ignore — race with another replica
        }
      }
    }
    await queue.add(type, payload, {
      repeat: { every: options.everyMs },
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
    void options.jobId; // reserved for future per-tenant schedules
  }

  /**
   * PC-36: before the lanes, every job went to one queue ("lead-platform"),
   * which nothing reads any more. At worker boot: remove its repeatable
   * schedules (the lane schedules replace them) and move the jobs still
   * waiting there (a discovery run, a learning or indexing job queued
   * before the deploy) onto their lane. A job is removed before it is
   * re-added, so one an old process picks up meanwhile is skipped, never
   * run twice. Jobs that were running when the old process stopped stay
   * behind; the stuck-work reaper and the outbox sweepers settle their
   * work. Idempotent: an empty old queue costs two reads.
   */
  async migrateLegacyQueue(): Promise<LegacyQueueMigration> {
    const legacy = this.queueNamed(LEGACY_QUEUE_NAME);
    const result: LegacyQueueMigration = { schedulesRemoved: 0, jobsMoved: 0, jobsSkipped: 0 };
    for (const r of await legacy.getRepeatableJobs()) {
      try {
        if (await legacy.removeRepeatableByKey(r.key)) result.schedulesRemoved++;
      } catch {
        // another process removed it first
      }
    }
    const waiting = await legacy.getJobs(WAITING_STATES, 0, LEGACY_SCAN_LIMIT - 1);
    for (const job of waiting) {
      if (!job) continue;
      try {
        await job.remove();
      } catch {
        result.jobsSkipped++;
        continue;
      }
      // A leftover occurrence of an old schedule: the lane schedule runs
      // that tick from now on.
      if (isRepeatInstance(job)) continue;
      await this.enqueue(job.name, (job.data ?? {}) as JobPayload);
      result.jobsMoved++;
    }
    return result;
  }

  /**
   * Stop the workers (running jobs get `graceMs` to finish, then the
   * workers stop hard and BullMQ hands the jobs to the next worker as
   * stalled), then close the queues and the connection.
   */
  async close(options: { graceMs?: number } = {}): Promise<void> {
    const graceMs = options.graceMs ?? DEFAULT_CLOSE_GRACE_MS;
    await Promise.all(
      [...this.workers.values()].map(async (worker) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const forced = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            worker.close(true).then(resolve, resolve);
          }, graceMs);
        });
        try {
          await Promise.race([worker.close(), forced]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
    this.workers.clear();
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
    if (this.connection) {
      await this.connection.quit();
      this.connection = null;
    }
  }

  private ensureWorker(lane: JobLane): void {
    if (this.workers.has(lane)) return;
    const processor: Processor = async (job) => {
      const h = this.handlers.get(job.name);
      if (!h) {
        throw new UnrecoverableError(
          `no handler registered for job type "${job.name}" on the ${lane} lane`,
        );
      }
      try {
        return await h(job.data as JobPayload, {
          jobId: encodeJobId(lane, job.id),
          attempt: job.attemptsMade + 1,
        });
      } catch (err) {
        // Trying again cannot help: fail the job now, keep the message.
        if (err instanceof NonRetryableJobError) throw new UnrecoverableError(err.message);
        throw err;
      }
    };
    const worker = this.factories.worker(LANE_DEFINITIONS[lane].queueName, processor, {
      concurrency: this.concurrency[lane],
    });
    this.workers.set(lane, worker);
    // PC-07: worker failures and errors become platform ops_events
    // (handlers wrapped by instrumented() report their own failures).
    attachWorkerEventReporting(worker, {
      isInstrumented: (name) => isInstrumentedHandler(this.handlers.get(name)),
    });
  }
}
