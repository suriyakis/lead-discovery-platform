// PC-36 (I065): job lanes — which queue a job type runs on, how many of a
// lane's jobs run at once, and which job types the queue retries.
//
// Three lanes, so slow work can never hold up the clock:
//
//   ticks  the short repeatable ticks (tick-catalog.ts): the 30 s send-queue
//          drain, the 2-minute inbox sync, the mailbox probes, the crawl
//          engine (it only enqueues runs), the reaper, retention, the
//          outbox sweepers. Judged by the heartbeat staleness rule (PC-07),
//          so they must start on time. Concurrency 4
//          (JOB_TICKS_CONCURRENCY).
//   batch  the long scheduled passes (BATCH_TICKS): autopilot (a run per
//          workspace, AI drafting, its lease held up to 30 min), the
//          follow-up pass (AI composition, up to 50 min), knowledge
//          compaction and the AI health check. Still ticks — catalogued,
//          heartbeated, judged against their slot — but they await the AI
//          provider for minutes, and under BullMQ's legacy repeat the next
//          slot of a tick starts while an earlier one is still working
//          another workspace. On the ticks lane four of them could hold
//          every slot and delay the drain; here they only queue behind each
//          other. Concurrency 3 (JOB_BATCH_CONCURRENCY): a long follow-up
//          pass and a long autopilot tick still leave a slot for the next
//          autopilot slot.
//   runs   on-demand work that can take minutes to hours: discovery runs
//          (connector.run), knowledge indexing (knowledge.index: OCR +
//          embeddings), learning (learning.process: an AI call per
//          decision) and "Re-classify all" (qualification.reclassify,
//          PC-38: AI calls per record × product, in batches of 50).
//          Concurrency 2 (JOB_RUNS_CONCURRENCY): the box has two
//          CPUs and shares them with the web process and Postgres.
//
// Under BullMQ each lane is its own Redis queue with its own Worker, so a
// crawl plan that fires five long runs fills the runs lane, four long AI
// ticks fill the batch lane, and the drain tick still starts every 30 s.
// The in-memory queue (dev and tests) keeps one serial chain per lane for
// the same reason.
//
// Retries. The queue retries nothing by default: durable work keeps its
// state in an outbox and a sweeper re-drives it (KL-03, ARCHITECTURE.md).
// connector.run is the one exception — 3 attempts, exponential backoff
// from 30 s — because a run that failed before it started (a database
// blip while loading the row) is otherwise only failed by the reaper an
// hour later. A retry executes the run only while its row is still
// 'pending' (the runner's conditional claim): a run that a first attempt
// already claimed, or that the stuck-work reaper ended, is skipped, so a
// retry never races the reaper.

import { z } from 'zod';
import { TICK_CATALOG, type TickName } from './tick-catalog';

export const JOB_LANES = ['ticks', 'batch', 'runs'] as const;
export type JobLane = (typeof JOB_LANES)[number];

export interface LaneDefinition {
  readonly lane: JobLane;
  /** The BullMQ queue (Redis key prefix bull:<queueName>). */
  readonly queueName: string;
  readonly defaultConcurrency: number;
  /** Env var that overrides the concurrency (an integer 1–32). */
  readonly concurrencyEnv: string;
  readonly description: string;
}

export const LANE_DEFINITIONS: Readonly<Record<JobLane, LaneDefinition>> = {
  ticks: {
    lane: 'ticks',
    queueName: 'lead-platform-ticks',
    defaultConcurrency: 4,
    concurrencyEnv: 'JOB_TICKS_CONCURRENCY',
    description: 'short repeatable ticks (drain, inbox sync, probes, crawl engine, sweepers, reaper)',
  },
  batch: {
    lane: 'batch',
    queueName: 'lead-platform-batch',
    defaultConcurrency: 3,
    concurrencyEnv: 'JOB_BATCH_CONCURRENCY',
    description: 'long scheduled passes (autopilot, follow-ups, knowledge compaction, health check)',
  },
  runs: {
    lane: 'runs',
    queueName: 'lead-platform-runs',
    defaultConcurrency: 2,
    concurrencyEnv: 'JOB_RUNS_CONCURRENCY',
    description: 'on-demand work (discovery runs, knowledge indexing, learning, re-classification)',
  },
};

/** The single queue every job used before PC-36. The worker moves what is
 *  still waiting there onto the lanes at boot (BullMQJobQueue). */
export const LEGACY_QUEUE_NAME = 'lead-platform';

/**
 * The catalogued ticks that run on the batch lane: each can spend minutes
 * awaiting the AI provider (or a workspace's run lease), which must never
 * take the slots of the drain and the inbox sync.
 */
export const BATCH_TICKS = [
  'autopilot.tick',
  'outreach.follow_up.tick',
  'knowledge.compact.tick',
  'health.check.tick',
] as const satisfies readonly TickName[];

const TICK_NAMES: ReadonlySet<string> = new Set(TICK_CATALOG.map((t) => t.name));
const BATCH_TICK_NAMES: ReadonlySet<string> = new Set(BATCH_TICKS);

/** Which lane a job type runs on: the long ticks (BATCH_TICKS) on
 *  'batch', the other catalogued ticks on 'ticks', everything else
 *  (on-demand work) on 'runs'. */
export function laneForJob(type: string): JobLane {
  if (BATCH_TICK_NAMES.has(type)) return 'batch';
  return TICK_NAMES.has(type) ? 'ticks' : 'runs';
}

const MAX_LANE_CONCURRENCY = 32;

const ConcurrencySchema = z.coerce
  .number()
  .int('must be a whole number')
  .min(1, 'must be at least 1')
  .max(MAX_LANE_CONCURRENCY, `must be at most ${MAX_LANE_CONCURRENCY}`);

export class LaneConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaneConfigError';
  }
}

/** How many of a lane's jobs one worker process runs at once. Unset or
 *  blank = the default; anything else must be an integer 1–32 (a typo is
 *  a startup error, not a silent default). */
export function laneConcurrency(
  lane: JobLane,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const def = LANE_DEFINITIONS[lane];
  const raw = env[def.concurrencyEnv]?.trim();
  if (!raw) return def.defaultConcurrency;
  const parsed = ConcurrencySchema.safeParse(raw);
  if (!parsed.success) {
    throw new LaneConfigError(
      `${def.concurrencyEnv}=${JSON.stringify(raw)}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    );
  }
  return parsed.data;
}

export interface JobRetryPolicy {
  /** Total tries, the first one included. */
  readonly attempts: number;
  /** Exponential: the n-th retry waits delayMs × 2^(n-1). */
  readonly backoff: { readonly type: 'exponential'; readonly delayMs: number };
}

export const NO_RETRY: JobRetryPolicy = {
  attempts: 1,
  backoff: { type: 'exponential', delayMs: 0 },
};

export const CONNECTOR_RUN_RETRY: JobRetryPolicy = {
  attempts: 3,
  backoff: { type: 'exponential', delayMs: 30_000 },
};

const RETRY_POLICIES: Readonly<Record<string, JobRetryPolicy>> = {
  'connector.run': CONNECTOR_RUN_RETRY,
};

export function retryPolicyFor(type: string): JobRetryPolicy {
  return RETRY_POLICIES[type] ?? NO_RETRY;
}
