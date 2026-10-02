'use client';

// Re-render the current server page every few seconds while something on
// it is still moving — a discovery run pending or running (PC-10, I074), a
// knowledge source queued or indexing (KL-06). router.refresh() re-runs
// the server components and keeps client state (form input, scroll); the
// page stops rendering this component once the work settles, which stops
// the timer. Skips ticks while the tab is hidden.
//
// The hidden marker span lets a test see that a page polls (and why); it
// renders nothing visible.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export const AUTO_REFRESH_DEFAULT_MS = 3_000;

export function AutoRefresh({
  intervalMs = AUTO_REFRESH_DEFAULT_MS,
  reason = 'on',
}: {
  intervalMs?: number;
  /** What the page is waiting for (the marker's value), e.g. 'knowledge-index'. */
  reason?: string;
}) {
  const router = useOptionalRouter();
  const ms = Math.max(1_000, intervalMs);
  useEffect(() => {
    if (!router) return;
    const timer = setInterval(() => {
      // Skip while the tab is hidden; the next visible tick catches up.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      router.refresh();
    }, ms);
    return () => clearInterval(timer);
  }, [router, ms]);
  return <span hidden data-auto-refresh={reason} data-every-ms={ms} />;
}

/** useRouter() throws when rendered outside the App Router (a server
 *  render in a unit test); the page then simply does not poll. The hook
 *  is still called on every render, so the hook order never changes. */
function useOptionalRouter(): ReturnType<typeof useRouter> | null {
  try {
    return useRouter();
  } catch {
    return null;
  }
}
