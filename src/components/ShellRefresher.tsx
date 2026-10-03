'use client';

// DS-07 (ia:F-09): keeps the server-rendered parts of the persistent
// workspace frame — the automation banners, the god-mode bar, the
// workspace chip — from going stale while the (app) layout is kept across
// client navigation. Renders nothing. The rules and their tests live in
// src/lib/shell/freshness.ts:
//   - back on the tab after 5 idle minutes away: router.refresh(), unless
//     the newest summary (fetched first) says this browser is now in
//     another workspace — then <WorkspaceDriftNotice/> stays and offers a
//     reload; the frame never swaps tenants on its own;
//   - the polled summary's automation state differs from the one the
//     frame was rendered with (a pause, a hold, the platform stop):
//     router.refresh(), once per new state. `summary` only ever carries
//     the frame's own workspace (ShellAttention), so drift never gets here.
// Numbers need neither: they follow the attention store on their own.

import { useEffect, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useShellAttention } from './ShellAttention';
import { getBrowserAttentionStore } from '@/lib/attention/use-attention';
import {
  chromeSignature,
  createShellFreshness,
  idleRefreshAllowed,
  needsChromeRefresh,
} from '@/lib/shell/freshness';

export function ShellRefresher({
  renderedSignature,
}: Readonly<{ renderedSignature: string | null }>) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const shell = useShellAttention();
  const summary = shell?.summary ?? null;
  const frameWorkspaceId = shell?.workspaceId ?? null;
  const requested = useRef<string | null>(null);
  const frameWorkspace = useRef<string | null>(frameWorkspaceId);

  useEffect(() => {
    frameWorkspace.current = frameWorkspaceId;
  }, [frameWorkspaceId]);

  useEffect(() => {
    const freshness = createShellFreshness({
      now: () => Date.now(),
      isVisible: () => document.visibilityState === 'visible',
      window,
      document,
      shouldRefresh: () =>
        idleRefreshAllowed({
          frameWorkspaceId: frameWorkspace.current,
          fetchLatest: async () => {
            const store = getBrowserAttentionStore();
            await store.refresh('focus');
            return store.getSnapshot().summary;
          },
        }),
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
