'use client';

// MOB-02: useAttention() — the attention summary in client components.
// The workspace frame reads it once, in <ShellAttentionProvider> (DS-07),
// for the sidebar and tab badges, the bell and the account menu; the phone
// tab bar follows with MOB-09. Layouts do not re-render on client
// navigation, so badges that must stay true read this instead of a server
// prop. One store per page (store.ts): one poll and one request in flight
// however many components read it.
//
//   const summary = useAttention(serverSummary);  // seed from the server render
//   refreshAttention();                            // after a client-side mutation
//
// Server actions that redirect or call refreshChrome() need no call: their
// response re-renders the (app) layout with a fresh summary, which the
// store adopts as a newer seed.

import { useEffect, useSyncExternalStore } from 'react';
import { createAttentionStore, type AttentionSnapshot, type AttentionStore } from './store';
import { newerSummary, type AttentionSummary } from './types';

let browserStore: AttentionStore | null = null;

/** The page's one store (created on first use, in the browser only). */
export function getBrowserAttentionStore(): AttentionStore {
  browserStore ??= createAttentionStore({
    fetch: (url, init) => window.fetch(url, init),
    now: () => Date.now(),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (h) => window.clearInterval(h as number),
    isVisible: () => document.visibilityState === 'visible',
    window,
    document,
    serviceWorker:
      typeof navigator !== 'undefined' && 'serviceWorker' in navigator
        ? navigator.serviceWorker
        : null,
  });
  return browserStore;
}

const EMPTY: AttentionSnapshot = { summary: null, loading: false, error: null, updatedAt: null };
const noopSubscribe = () => () => {};

/**
 * Refetch the summary now — call it after a client-side mutation (a fetch
 * to an API route, an inline decision) so every badge follows at once.
 */
export function refreshAttention(): void {
  if (typeof window === 'undefined') return;
  void getBrowserAttentionStore().refresh('mutation');
}

const emptySnapshot = () => EMPTY;

export interface UseAttentionOptions {
  /**
   * false: no store, no poll, no request — the seed alone (a signed-in
   * user with no workspace yet has nothing to count). Default true.
   */
  enabled?: boolean;
}

/**
 * The newest attention summary for this page: the server-rendered `seed`
 * until the store holds a newer one. null only when neither exists (the
 * caller shows no numbers, never zeros).
 */
export function useAttention(
  seed?: AttentionSummary | null,
  options: UseAttentionOptions = {},
): AttentionSummary | null {
  const enabled = options.enabled ?? true;
  const store = enabled && typeof window !== 'undefined' ? getBrowserAttentionStore() : null;
  const snapshot = useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getSnapshot : emptySnapshot,
    // Server render and hydration: the seed alone, so both agree.
    emptySnapshot,
  );

  useEffect(() => {
    store?.seed(seed);
  }, [store, seed]);

  useEffect(() => {
    store?.mounted();
  }, [store]);

  return newerSummary(seed ?? null, snapshot.summary);
}
