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
import { TICK_CATALOG } from './tick-catalog';

/** A tick's cadence for the boot log: "30 s", "2 min", "6 h", "7 d". */
export function formatTickInterval(ms: number): string {
  const units: Array<[number, string]> = [
    [24 * 60 * 60 * 1000, 'd'],
    [60 * 60 * 1000, 'h'],
    [60 * 1000, 'min'],
  ];
  for (const [size, unit] of units) {
    if (ms >= size && ms % size === 0) return `${ms / size} ${unit}`;
  }
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

/** I155: the boot log names every catalogued tick and its cadence (it used
 *  to name three of them, so the others looked unscheduled). */
export function describeTickSchedule(): string {
  return TICK_CATALOG.map((t) => `${t.name} every ${formatTickInterval(t.everyMs)}`).join(', ');
}

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
      `[startup] ${TICK_CATALOG.length} background ticks scheduled ` +
        `(provider=${options.provider}, boot=${options.bootId}): ${describeTickSchedule()}.`,
    );
    return { scheduled: true, legacy };
  } catch (err) {
    error('[startup] Failed to register repeatable jobs:', err);
    await reportScheduleRegistrationFailure(err);
    return { scheduled: false, legacy };
  }
}
