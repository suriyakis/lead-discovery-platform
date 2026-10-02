// Node-runtime half of the Next.js startup hook (see instrumentation.ts).
//   - PC-36: decide what this web server does from ROLE (lib/jobs/role.ts):
//       web  serve HTTP and enqueue only — no queue worker, no tick
//            schedule (the worker service runs both lanes);
//       all  (default) also run the background work in this process
//            (lib/jobs/background.ts): the job handlers, the move off the
//            pre-lane BullMQ queue and the repeatable tick schedule
//            (deduped by jobId — one schedule per platform regardless of
//            replica count).
//     ROLE=worker is refused here: the worker entry serves no HTTP.
//   - warn when production runs on the in-memory queue
//   - PC-07: fix this process's boot identity (boot_id + boot time for the
//     readiness deploy grace); a failed schedule registration is a platform
//     incident instead of a console line only
//   - PC-08: start the ops watchdog (owner alerts) in every web process —
//     ROLE=web included, so it does not depend on the worker; skipped, like
//     the schedule, with SCHEDULE_BACKGROUND_JOBS=0

import type { BackgroundStartOptions } from './lib/jobs/background';
import type { Env, ProcessPlan } from './lib/jobs/role';

export interface NodeRuntimeDeps {
  env: Env;
  startBackground: (options: BackgroundStartOptions) => Promise<unknown>;
  startWatchdog: () => Promise<void> | void;
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  /** Ends the process on a role misconfiguration (tests record it). */
  exit: (code: number) => void;
}

export async function registerNodeRuntime(
  overrides: Partial<NodeRuntimeDeps> = {},
): Promise<ProcessPlan> {
  const { getBootInfo } = await import('./lib/jobs/boot');
  const boot = getBootInfo();
  const { planWebProcess, jobQueueProvider } = await import('./lib/jobs/role');

  const d: NodeRuntimeDeps = {
    env: process.env,
    startBackground: async (options) =>
      (await import('./lib/jobs/background')).startBackgroundWork(options),
    startWatchdog: async () => {
      const { startOpsWatchdog } = await import('./lib/ops/watchdog');
      startOpsWatchdog();
    },
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
    exit: (code) => process.exit(code),
    ...overrides,
  };

  let plan: ProcessPlan;
  try {
    plan = planWebProcess(d.env);
  } catch (err) {
    // A misconfigured role must not come up half-working: Next.js only
    // logs a failed startup hook and keeps answering every request with a
    // 500, so end the process (compose restarts it; the log says why).
    d.error(`[startup] ${err instanceof Error ? err.message : String(err)}`);
    d.exit(1);
    throw err;
  }
  if (plan.warning) d.warn(`[startup] WARNING: ${plan.warning}`);

  // Production sanity: warn loudly when booting with the memory queue (jobs
  // lost on restart, no cross-replica deduplication). Skip when NODE_ENV is
  // not 'production' so dev + tests stay frictionless.
  const provider = jobQueueProvider(d.env);
  if (d.env.NODE_ENV === 'production' && provider !== 'bullmq') {
    d.warn(
      `[startup] WARNING: JOB_QUEUE_PROVIDER=${provider} in production. ` +
        `Background jobs (autopilot, drain, IMAP sync) will run in-memory ` +
        `with no durability and no cross-replica deduplication. ` +
        `Set JOB_QUEUE_PROVIDER=bullmq + REDIS_URL to enable production scheduling.`,
    );
  }

  const schedule = d.env.SCHEDULE_BACKGROUND_JOBS !== '0';
  if (plan.runsWorkers) {
    await d.startBackground({
      provider,
      schedule,
      bootId: boot.id,
      log: d.log,
      error: (m, err) =>
        d.error(err === undefined ? m : `${m} ${err instanceof Error ? err.message : String(err)}`),
    });
  } else {
    d.log(
      `[startup] ROLE=web (provider=${provider}, boot=${boot.id}): this process serves HTTP and ` +
        'enqueues jobs; the worker service runs them and schedules the ticks.',
    );
  }

  if (!schedule) return plan;

  // PC-08: the ops watchdog (stale ticks on two consecutive checks, owner
  // alerts to ntfy, the daily digest). Started after the registration on
  // both paths: a failed registration is exactly what it must report. A
  // timer in this web process, not a queued job, so a lost Redis or a dead
  // worker does not silence it; the external monitor on /api/ready covers
  // a dead web process.
  if (plan.runsWatchdog) await d.startWatchdog();
  return plan;
}
