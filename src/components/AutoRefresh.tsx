'use client';

// PC-10 (I074): re-render the current server page every few seconds while
// something on it is still in progress (a discovery run that is pending or
// running). router.refresh() re-runs the server component and keeps client
// state; the page stops rendering this component once the work is done,
// which stops the timer. Renders nothing.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export const AUTO_REFRESH_DEFAULT_MS = 3_000;

export function AutoRefresh({ intervalMs = AUTO_REFRESH_DEFAULT_MS }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const ms = Math.max(1_000, intervalMs);
    const timer = setInterval(() => {
      // Skip while the tab is hidden; the next visible tick catches up.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      router.refresh();
    }, ms);
    return () => clearInterval(timer);
  }, [router, intervalMs]);
  return null;
}
