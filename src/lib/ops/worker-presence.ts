// PC-36 (review): is any worker consuming the job lanes?
//
// Since PC-36 the web server (ROLE=web) only enqueues; a separate `worker`
// service runs every job. A deploy that recreates only `app` — the old
// operator script `~/deploy-discover.sh` did `up -d … app` — leaves no
// worker at all: the send queue, inbox sync, follow-ups, autopilot,
// discovery runs and the reaper all stop, and until now the only signals
// were stale ticks (an `error` incident per tick) and /api/ready.
//
// The watchdog of every web process (ops/watchdog.ts) now asks the queue,
// once a minute, how many workers consume each lane (BullMQ:
// Queue.getWorkersCount, i.e. Redis CLIENT LIST). After the boot grace,
// a lane with no worker on ABSENT_CHECKS_BEFORE_ALERT consecutive checks
// raises ONE critical platform incident, `worker.absent` (PC-08 alerts
// it at once, past the hourly budget), and logs a loud console line on
// every such check. It resolves when every lane has a worker again.
//
// It does nothing on the in-memory queue (this process is its consumer),
// and when Redis cannot answer (the readiness `redis` check and the stale
// ticks already report that); the latter is logged once.

import { opsEventFingerprint, type raiseOpsEvent, type resolveOpsEvent } from '@/lib/services/ops-events';

export const WORKER_ABSENT_KIND = 'worker.absent';
export const WORKER_ABSENT_DEDUPE_KEY = 'job-worker';
/** No verdict this soon after this process booted: a deploy starts the
 *  app and the worker together, and the worker needs a moment to connect. */
export const WORKER_PRESENCE_GRACE_MS = 3 * 60_000;
/** Consecutive checks with a lane unconsumed before the incident opens (a
 *  worker restart takes seconds; the watchdog checks once a minute). */
export const ABSENT_CHECKS_BEFORE_ALERT = 2;

export function workerAbsentFingerprint(): string {
  return opsEventFingerprint({
    scope: 'platform',
    kind: WORKER_ABSENT_KIND,
    dedupeKey: WORKER_ABSENT_DEDUPE_KEY,
  });
}

/** What the watchdog remembers between checks (process-local). */
export class WorkerPresence {
  /** Consecutive checks that saw a lane without a worker. */
  streak = 0;
  /** Whether a worker.absent incident may be open: unknown until the first
   *  healthy check after boot resolves any a previous process left. */
  mayBeOpen = true;
  /** The "cannot count" line is logged once per process. */
  loggedCountFailure = false;
}

export interface WorkerPresenceDeps {
  now: Date;
  processBootedAt: Date;
  /** Workers per lane, or null when the queue cannot tell (in-memory). */
  workerCounts: () => Promise<Readonly<Record<string, number>> | null>;
  raise: typeof raiseOpsEvent;
  resolve: typeof resolveOpsEvent;
  log: (message: string) => void;
}

export type WorkerPresenceResult =
  | { state: 'not_applicable' }
  | { state: 'unknown'; error: string }
  | { state: 'grace' }
  | { state: 'present'; resolved: boolean }
  | { state: 'absent'; lanes: string[]; checks: number; raised: boolean };

const lanesText = (lanes: readonly string[]) =>
  lanes.length === 1 ? `the ${lanes[0]} lane` : `the ${lanes.join(', ')} lanes`;

/** One presence check (a step of the watchdog pass). */
export async function checkWorkerPresence(
  presence: WorkerPresence,
  d: WorkerPresenceDeps,
): Promise<WorkerPresenceResult> {
  let counts: Readonly<Record<string, number>> | null;
  try {
    counts = await d.workerCounts();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (!presence.loggedCountFailure) {
      presence.loggedCountFailure = true;
      d.log(`[ops] watchdog cannot count the job workers (${error}); the worker check is skipped while that lasts.`);
    }
    return { state: 'unknown', error };
  }
  if (counts === null) return { state: 'not_applicable' };

  const missing = Object.entries(counts)
    .filter(([, n]) => n < 1)
    .map(([lane]) => lane);

  if (missing.length === 0) {
    presence.streak = 0;
    let resolved = false;
    if (presence.mayBeOpen) {
      resolved = await d.resolve(workerAbsentFingerprint(), { resolution: 'auto', now: d.now });
      presence.mayBeOpen = false;
    }
    return { state: 'present', resolved };
  }

  const sinceBoot = d.now.getTime() - d.processBootedAt.getTime();
  if (sinceBoot < WORKER_PRESENCE_GRACE_MS) return { state: 'grace' };

  presence.streak += 1;
  const checks = presence.streak;
  if (checks < ABSENT_CHECKS_BEFORE_ALERT) {
    return { state: 'absent', lanes: missing, checks, raised: false };
  }
  const minutes = Math.floor(sinceBoot / 60_000);
  d.log(
    `[ops] CRITICAL: no background worker consumes ${lanesText(missing)} ` +
      `(${checks} consecutive checks, ${minutes} min after this web process booted). ` +
      'Nothing runs: send queue, inbox sync, follow-ups, autopilot, discovery runs, reaper. ' +
      'Start it: docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d worker',
  );
  await d.raise(
    {
      scope: 'platform',
      kind: WORKER_ABSENT_KIND,
      severity: 'critical',
      source: 'ops.watchdog',
      dedupeKey: WORKER_ABSENT_DEDUPE_KEY,
      title: 'No background worker is running',
      message:
        `No worker consumes ${lanesText(missing)} (seen on ${checks} consecutive checks). ` +
        'Nothing in the background runs: the send queue, inbox sync, follow-ups, autopilot, ' +
        'discovery runs and the stuck-work reaper all wait. Start the worker service ' +
        '(docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d worker); ' +
        'deploy with scripts/deploy/deploy-agregat.sh, which recreates app and worker together.',
      payload: {
        lanesWithoutWorker: missing,
        workers: { ...counts },
        consecutiveChecks: checks,
        processBootedAt: d.processBootedAt.toISOString(),
      },
    },
    d.now,
  );
  presence.mayBeOpen = true;
  return { state: 'absent', lanes: missing, checks, raised: true };
}
