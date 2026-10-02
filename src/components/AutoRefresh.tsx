'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Re-renders the current route's server components every `everyMs` while
 * mounted (router.refresh(): no full reload, form input and scroll are
 * kept). Pages render it only while something they show is still moving —
 * e.g. a knowledge source queued or indexing (KL-06) — so polling stops by
 * itself once the status settles.
 *
 * The marker span lets a test see that a page polls; it renders nothing
 * visible.
 */
export function AutoRefresh({ everyMs = 4000, reason }: { everyMs?: number; reason: string }) {
  const router = useOptionalRouter();
  useEffect(() => {
    if (!router) return;
    const timer = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(timer);
  }, [router, everyMs]);
  return <span hidden data-auto-refresh={reason} data-every-ms={everyMs} />;
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
