'use client';

// DS-07 (ia:F-09): keeps the server-rendered parts of the persistent
// workspace frame — the automation banners, the god-mode bar, the
// workspace chip — from going stale while the (app) layout is kept across
// client navigation. Renders nothing. The rules and their tests live in
// src/lib/shell/freshness.ts:
//   - back on the tab after 5 idle minutes away: router.refresh();
//   - the polled summary's automation state differs from the one the
//     frame was rendered with (a pause, a hold, the platform stop):
//     router.refresh(), once per new state.
// Numbers need neither: they follow the attention store on their own.

import { useEffect, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useShellAttention } from './ShellAttention';
import { chromeSignature, createShellFreshness, needsChromeRefresh } from '@/lib/shell/freshness';

export function ShellRefresher({
  renderedSignature,
}: Readonly<{ renderedSignature: string | null }>) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const summary = useShellAttention()?.summary ?? null;
  const requested = useRef<string | null>(null);

  useEffect(() => {
    const freshness = createShellFreshness({
      now: () => Date.now(),
      isVisible: () => document.visibilityState === 'visible',
      window,
      document,
      refresh: () => startTransition(() => router.refresh()),
    });
    freshness.start();
    return () => freshness.stop();
  }, [router]);

  useEffect(() => {
    if (
      !needsChromeRefresh({
        rendered: renderedSignature,
        latest: summary,
        requested: requested.current,
      })
    ) {
      return;
    }
    requested.current = chromeSignature(summary);
    startTransition(() => router.refresh());
  }, [renderedSignature, summary, router]);

  return null;
}
