// Tracked fire-and-forget work.
//
// Some hooks must never delay or break the request that triggers them (the
// reply handler's learning hook, for one), so they run detached. A bare
// `void promise` is invisible, though: under Vitest such work outlives its
// test and races the next test's TRUNCATE, which deadlocked
// reply-classifier.test.ts in a full run. runDetached() keeps a handle on
// the work so settleDetached() can wait for it; production behaviour is
// unchanged (nothing awaits it there).

const inFlight = new Set<Promise<void>>();

/** Run `work` without awaiting it. Errors are logged, never thrown. */
export function runDetached(label: string, work: () => Promise<unknown>): void {
  const task: Promise<void> = Promise.resolve()
    .then(work)
    .then(
      () => undefined,
      (err: unknown) => {
        console.error(`[${label}] failed:`, err instanceof Error ? err.message : err);
      },
    )
    .finally(() => {
      inFlight.delete(task);
    });
  inFlight.add(task);
}

/** Wait until every detached task — including ones started meanwhile — settled. */
export async function settleDetached(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

/** Number of detached tasks still running (diagnostics / tests). */
export function detachedInFlight(): number {
  return inFlight.size;
}
