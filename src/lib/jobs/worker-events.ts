// PC-07 (I022): the BullMQ Worker had no 'failed' or 'error' listener, so
// a job that died outside our handlers (no handler registered, a crash in
// a non-instrumented job) or a worker that lost Redis left no trace but a
// BullMQ return value that is deleted after a week.
//
// attachWorkerEventReporting() turns those events into platform-scope
// ops_events:
//   'failed'    → 'job.failed' per job name — skipped for instrumented
//                 handlers, whose wrapper already raised the incident;
//   'error'     → 'worker.error' (critical): the worker itself is unwell,
//                 usually Redis;
//   'completed' → resolves 'job.failed' for that name and 'worker.error'.
// Event listeners are synchronous; the writes run detached (runDetached
// tracks them for tests) and never throw. Repeats of one fingerprint
// within `throttleMs` are folded into the next write's occurrence count,
// so a flapping Redis connection cannot flood the database.

import { runDetached } from '@/lib/detached';
import {
  opsEventFingerprint,
  raiseOpsEvent,
  resolveOpsEvent,
  type RaiseOpsEventInput,
} from '@/lib/services/ops-events';

export const WORKER_EVENT_SOURCE = 'bullmq.worker';
const DEFAULT_THROTTLE_MS = 60 * 1000;

type JobLike = { name?: string; id?: string | number | null } | undefined | null;

/** The slice of the BullMQ Worker this needs (an EventEmitter in tests). */
export interface WorkerEventSource {
  on(event: 'failed', listener: (job: JobLike, err: Error) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'completed', listener: (job: JobLike) => void): unknown;
}

export interface WorkerEventReporter {
  raise: (input: RaiseOpsEventInput) => Promise<unknown>;
  resolve: (fingerprint: string) => Promise<unknown>;
}

const DEFAULT_REPORTER: WorkerEventReporter = {
  raise: (input) => raiseOpsEvent(input),
  resolve: (fingerprint) => resolveOpsEvent(fingerprint, { resolution: 'auto' }),
};

export function jobFailedFingerprint(jobName: string): string {
  return opsEventFingerprint({ scope: 'platform', kind: 'job.failed', dedupeKey: jobName });
}

export const WORKER_ERROR_FINGERPRINT = opsEventFingerprint({
  scope: 'platform',
  kind: 'worker.error',
  dedupeKey: WORKER_EVENT_SOURCE,
});

export function attachWorkerEventReporting(
  worker: WorkerEventSource,
  options: {
    /** True when the job's handler is wrapped by instrumented(). */
    isInstrumented: (jobName: string) => boolean;
    reporter?: WorkerEventReporter;
    throttleMs?: number;
    now?: () => number;
  },
): void {
  const reporter = options.reporter ?? DEFAULT_REPORTER;
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
  const now = options.now ?? Date.now;

  /** fingerprint → last write time + repeats folded since. */
  const lastWrite = new Map<string, { at: number; suppressed: number }>();
  /** fingerprint → may be open (unknown after boot counts as maybe). */
  const maybeOpen = new Map<string, boolean>();

  const raise = (fingerprint: string, input: RaiseOpsEventInput) => {
    const t = now();
    const prev = lastWrite.get(fingerprint);
    if (prev && t - prev.at < throttleMs) {
      prev.suppressed++;
      return;
    }
    const occurrences = 1 + (prev?.suppressed ?? 0);
    lastWrite.set(fingerprint, { at: t, suppressed: 0 });
    maybeOpen.set(fingerprint, true);
    runDetached('ops.worker-event', () => reporter.raise({ ...input, occurrences }));
  };

  const resolve = (fingerprint: string) => {
    if (maybeOpen.get(fingerprint) === false) return;
    maybeOpen.set(fingerprint, false);
    lastWrite.delete(fingerprint);
    runDetached('ops.worker-event', () => reporter.resolve(fingerprint));
  };

  worker.on('failed', (job, err) => {
    const name = job?.name ?? 'unknown';
    if (job?.name && options.isInstrumented(job.name)) return;
    raise(jobFailedFingerprint(name), {
      scope: 'platform',
      kind: 'job.failed',
      severity: 'error',
      source: name,
      dedupeKey: name,
      title: `Background job "${name}" failed`,
      error: err,
      payload: { job: name, jobId: job?.id != null ? String(job.id) : null },
    });
  });

  worker.on('error', (err) => {
    raise(WORKER_ERROR_FINGERPRINT, {
      scope: 'platform',
      kind: 'worker.error',
      severity: 'critical',
      source: WORKER_EVENT_SOURCE,
      dedupeKey: WORKER_EVENT_SOURCE,
      title: 'The background job worker reported an error',
      error: err,
    });
  });

  worker.on('completed', (job) => {
    // Any completed job proves the worker ↔ Redis loop works again.
    resolve(WORKER_ERROR_FINGERPRINT);
    const name = job?.name;
    if (name && !options.isInstrumented(name)) resolve(jobFailedFingerprint(name));
  });
}
