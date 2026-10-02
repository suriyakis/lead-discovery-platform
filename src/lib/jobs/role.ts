// PC-36 (I065): what this process does — ROLE=web|worker|all.
//
//   web     the Next.js server: serves pages and API routes and enqueues
//           jobs. It registers no queue worker and schedules no ticks;
//           the ops watchdog (PC-08) runs here, independent of the worker.
//   worker  the worker entry (src/worker.ts, `node worker.cjs`): runs the
//           queue workers (both lanes) and schedules the ticks. It serves
//           no HTTP and runs no watchdog.
//   all     both in one process (the default): local development and a
//           single-container deploy.
//
// Production runs two services from one image: app (ROLE=web) and worker
// (ROLE=worker), docker-compose.prod.yml.
//
// A split needs a queue both processes share. With the in-memory queue
// each process has its own, so ROLE=web there falls back to 'all' (jobs
// still run, with a warning) and the worker entry refuses to start.

import { z } from 'zod';

export const PROCESS_ROLES = ['web', 'worker', 'all'] as const;
export type ProcessRole = (typeof PROCESS_ROLES)[number];

const ProcessRoleSchema = z.enum(PROCESS_ROLES);

export type Env = Readonly<Record<string, string | undefined>>;

export class ProcessRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessRoleError';
  }
}

/** ROLE from the environment: trimmed, case-insensitive; unset or blank
 *  is 'all'. Anything else is a configuration error. */
export function parseProcessRole(raw: string | undefined): ProcessRole {
  const value = raw?.trim().toLowerCase() ?? '';
  if (value === '') return 'all';
  const parsed = ProcessRoleSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProcessRoleError(
      `ROLE=${JSON.stringify(raw)} is not a process role; use web, worker or all (unset means all).`,
    );
  }
  return parsed.data;
}

export function jobQueueProvider(env: Env = process.env): string {
  return env.JOB_QUEUE_PROVIDER?.trim() || 'memory';
}

export interface ProcessPlan {
  /** What ROLE asked for. */
  requested: ProcessRole;
  /** What this process does (requested, unless the queue cannot split). */
  role: ProcessRole;
  /** Runs queue workers (consumes jobs). */
  runsWorkers: boolean;
  /** Registers the repeatable tick schedules at boot. */
  schedulesTicks: boolean;
  /** Runs the ops watchdog (owner alerts, PC-08). */
  runsWatchdog: boolean;
  /** Set when the plan differs from the request. */
  warning?: string;
}

function planFor(requested: ProcessRole, role: ProcessRole, warning?: string): ProcessPlan {
  return {
    requested,
    role,
    runsWorkers: role !== 'web',
    schedulesTicks: role !== 'web',
    runsWatchdog: role !== 'worker',
    ...(warning ? { warning } : {}),
  };
}

/**
 * The plan of a process that serves HTTP (the Next.js server). ROLE=worker
 * is refused: a worker serves no HTTP, so a web server started with it is
 * a misconfiguration (the worker service runs `node worker.cjs`).
 */
export function planWebProcess(env: Env = process.env): ProcessPlan {
  const requested = parseProcessRole(env.ROLE);
  if (requested === 'worker') {
    throw new ProcessRoleError(
      'ROLE=worker is for the worker entry (node worker.cjs), which serves no HTTP. ' +
        'Start this web server with ROLE=web (or all).',
    );
  }
  if (requested === 'web' && jobQueueProvider(env) === 'memory') {
    return planFor(
      requested,
      'all',
      'ROLE=web needs a shared queue (JOB_QUEUE_PROVIDER=bullmq); with the in-memory ' +
        'queue no other process can run its jobs, so this process runs them itself (ROLE=all).',
    );
  }
  return planFor(requested, requested);
}

/**
 * The plan of the worker entry. Unset ROLE or ROLE=worker; web or all are
 * refused (the entry serves no HTTP), and so is the in-memory queue (the
 * web process could not hand it any job).
 */
export function planWorkerProcess(env: Env = process.env): ProcessPlan {
  const raw = env.ROLE?.trim() ?? '';
  const requested: ProcessRole = raw === '' ? 'worker' : parseProcessRole(raw);
  if (requested !== 'worker') {
    throw new ProcessRoleError(
      `The worker entry runs background jobs only; ROLE=${requested} is for the web server. ` +
        'Start it with ROLE=worker (or ROLE unset).',
    );
  }
  const provider = jobQueueProvider(env);
  if (provider !== 'bullmq') {
    throw new ProcessRoleError(
      `The worker needs JOB_QUEUE_PROVIDER=bullmq (got ${provider}): an in-memory queue ` +
        'lives inside one process, so the web server could not hand it any job.',
    );
  }
  return planFor('worker', 'worker');
}

/**
 * Does a queue created in this process consume jobs? Read by the queue
 * factory in every bundle of the process (Next.js compiles the startup
 * hook and the route handlers separately), so it depends on the
 * environment only: ROLE=web with a shared queue does not; everything else
 * does (tests, scripts and dev keep running their jobs in-process).
 */
export function queueConsumesJobs(env: Env = process.env): boolean {
  let role: ProcessRole;
  try {
    role = parseProcessRole(env.ROLE);
  } catch {
    // The startup hook refuses an invalid ROLE before anything enqueues;
    // a script with a typo still runs its own jobs.
    return true;
  }
  return !(role === 'web' && jobQueueProvider(env) !== 'memory');
}
