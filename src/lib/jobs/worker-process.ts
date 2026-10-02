// PC-36 (I065): the dedicated worker process (ROLE=worker). Entry point
// src/worker.ts, bundled to worker.cjs (scripts/build-worker.mjs) and run
// as the `worker` service of docker-compose.prod.yml from the same image
// as the web app.
//
// It runs both job lanes and schedules the ticks (background.ts). It
// serves no HTTP and runs no ops watchdog: the watchdog stays in the web
// process, so a dead worker shows up there as stale ticks (and on
// /api/ready), never silenced with it.
//
// Shutdown (SIGTERM from `docker stop`): stop taking jobs, give the
// running ones DEFAULT_CLOSE_GRACE_MS to finish (compose allows 30 s),
// then exit. A job cut off there is handed to the next worker as stalled;
// a discovery run it had started is failed by the stuck-work reaper
// (PC-10) — a retry never runs a started run twice.

import { getBootInfo } from './boot';
import { startBackgroundWork, type BackgroundStartOptions } from './background';
import { getJobQueue, type IJobQueue } from './index';
import { DEFAULT_CLOSE_GRACE_MS } from './bullmq';
import { JOB_LANES } from './lanes';
import { planWorkerProcess, jobQueueProvider, type Env, type ProcessPlan } from './role';

export interface WorkerProcessDeps {
  env: Env;
  queue: () => IJobQueue;
  startBackground: (options: BackgroundStartOptions) => Promise<unknown>;
  log: (message: string) => void;
  error: (message: string, err?: unknown) => void;
  closeGraceMs: number;
}

export interface RunningWorker {
  readonly plan: ProcessPlan;
  /** Stop the lanes (idempotent). */
  stop(reason: string): Promise<void>;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function defaultDeps(): WorkerProcessDeps {
  return {
    env: process.env,
    queue: getJobQueue,
    startBackground: startBackgroundWork,
    log: (m) => console.log(m),
    error: (m, err) => console.error(m, err === undefined ? '' : errText(err)),
    closeGraceMs: DEFAULT_CLOSE_GRACE_MS,
  };
}

/** Start the worker. Throws (before anything runs) on a role or queue
 *  misconfiguration: ROLE other than worker, or the in-memory queue. */
export async function startWorkerProcess(
  overrides: Partial<WorkerProcessDeps> = {},
): Promise<RunningWorker> {
  const d: WorkerProcessDeps = { ...defaultDeps(), ...overrides };
  const plan = planWorkerProcess(d.env);
  const provider = jobQueueProvider(d.env);
  const boot = getBootInfo();
  const queue = d.queue();

  const lanes = JOB_LANES.map((lane) => {
    const c = (queue as { laneConcurrency?: (l: typeof lane) => number }).laneConcurrency?.(lane);
    return c === undefined ? lane : `${lane}×${c}`;
  }).join(', ');
  d.log(`[worker] starting (role=worker, provider=${provider}, boot=${boot.id}, lanes ${lanes})`);

  await d.startBackground({
    provider,
    schedule: d.env.SCHEDULE_BACKGROUND_JOBS !== '0',
    bootId: boot.id,
    log: d.log,
    error: d.error,
  });
  d.log('[worker] running; no HTTP is served by this process.');

  let stopping: Promise<void> | null = null;
  return {
    plan,
    stop(reason: string) {
      stopping ??= (async () => {
        d.log(
          `[worker] stopping (${reason}): running jobs get ${d.closeGraceMs / 1000}s to finish.`,
        );
        await queue.close?.({ graceMs: d.closeGraceMs });
        d.log('[worker] stopped.');
      })();
      return stopping;
    },
  };
}

/** The process entry: start, stop on SIGTERM / SIGINT, exit 1 when the
 *  worker cannot start (compose restarts it; the log says why). */
export function runWorkerMain(): void {
  process.on('unhandledRejection', (reason) => {
    console.error('[worker] unhandled rejection:', errText(reason));
  });
  startWorkerProcess().then(
    (worker) => {
      const shutdown = (signal: string) => {
        worker.stop(signal).then(
          () => process.exit(0),
          (err: unknown) => {
            console.error('[worker] shutdown failed:', errText(err));
            process.exit(1);
          },
        );
      };
      process.once('SIGTERM', () => shutdown('SIGTERM'));
      process.once('SIGINT', () => shutdown('SIGINT'));
    },
    (err: unknown) => {
      console.error('[worker] cannot start:', errText(err));
      process.exit(1);
    },
  );
}
