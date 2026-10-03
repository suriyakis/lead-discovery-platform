// PC-38 review: "this worker is stopping" for long jobs.
//
// The worker process (worker-process.ts) gives running jobs
// DEFAULT_CLOSE_GRACE_MS (25 s) to finish when it gets SIGTERM, then stops
// them hard. A long job that works item by item (Re-classify all: records
// × products AI calls) asks jobShutdownRequested() between items and, once
// it is set, saves its progress and hands the rest to the next worker
// instead of being cut off mid-item with its lease still held.
//
// Process-wide (on globalThis, like the other process singletons), set
// once per process; tests reset it.

const holder = globalThis as unknown as {
  __leadPlatformJobShutdown?: { reason: string; at: Date } | null;
};

/** Mark this process as stopping (idempotent; the first reason wins). */
export function requestJobShutdown(reason: string): void {
  holder.__leadPlatformJobShutdown ??= { reason, at: new Date() };
}

/** Has this process been asked to stop? */
export function jobShutdownRequested(): boolean {
  return Boolean(holder.__leadPlatformJobShutdown);
}

/** Test seam. */
export function _resetJobShutdownForTests(): void {
  holder.__leadPlatformJobShutdown = null;
}
