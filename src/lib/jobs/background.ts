// PC-36: start the background work of a process that consumes jobs — the
// worker service (src/worker.ts) or a ROLE=all web server (dev, a single
// container). Shared so both entries boot it the same way:
//
//   1. register the on-demand handlers (connector.run, learning.process,
//      knowledge.index) — under BullMQ this starts the runs lane's worker;
//   2. move what still waits on the pre-lane BullMQ queue onto the lanes
//      (best effort; BullMQJobQueue.migrateLegacyQueue);
//   3. unless SCHEDULE_BACKGROUND_JOBS=0: register the tick handlers (the
//      ticks and batch lanes' workers) and their repeatable schedules. A failed
//      registration is a critical platform incident (PC-07).

import { getJobQueue, type LegacyQueueMigration } from './index';

export interface BackgroundStartOptions {
  /** JOB_QUEUE_PROVIDER, for the log line. */
  provider: string;
  /** false with SCHEDULE_BACKGROUND_JOBS=0: no tick handlers, no schedules. */
  schedule: boolean;
  bootId: string;
  log?: (message: string) => void;
  error?: (message: string, err?: unknown) => void;
}

export interface BackgroundStartResult {
  scheduled: boolean;
  legacy: LegacyQueueMigration | null;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function startBackgroundWork(
  options: BackgroundStartOptions,
): Promise<BackgroundStartResult> {
  const log = options.log ?? ((m: string) => console.log(m));
  const error = options.error ?? ((m: string, err?: unknown) => console.error(m, errText(err)));

  const { registerJobHandlers } = await import('./bootstrap');
  registerJobHandlers();

  let legacy: LegacyQueueMigration | null = null;
  const queue = getJobQueue();
  if (queue.migrateLegacyQueue) {
    try {
      legacy = await queue.migrateLegacyQueue();
      if (legacy.schedulesRemoved || legacy.jobsMoved || legacy.jobsSkipped) {
        log(
          `[startup] Pre-lane queue migrated: ${legacy.schedulesRemoved} schedule(s) removed, ` +
            `${legacy.jobsMoved} waiting job(s) moved onto their lane, ${legacy.jobsSkipped} left to an old process.`,
        );
      }
    } catch (err) {
      // Not fatal: what is left there is settled by the reaper and the
      // outbox sweepers; the next boot tries again.
      error('[startup] Could not migrate the pre-lane job queue:', err);
    }
  }

  // Skip schedule registration when the explicit env says so — useful for
  // ephemeral CI containers, smoke-test pods, local demo copies and one-shot
  // Docker exec commands that shouldn't try to enqueue cron jobs.
  if (!options.schedule) {
    log('[startup] SCHEDULE_BACKGROUND_JOBS=0 — skipping repeatable schedule.');
    return { scheduled: false, legacy };
  }

  const { registerRepeatableJobs, reportScheduleRegistrationFailure } =
    await import('./repeatables');
  try {
    await registerRepeatableJobs();
    log(
      `[startup] Background ticks scheduled (provider=${options.provider}, boot=${options.bootId}): ` +
        'outreach drain every 30s, IMAP every 2min, autopilot every 5min.',
    );
    return { scheduled: true, legacy };
  } catch (err) {
    error('[startup] Failed to register repeatable jobs:', err);
    await reportScheduleRegistrationFailure(err);
    return { scheduled: false, legacy };
  }
}
