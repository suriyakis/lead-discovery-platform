// MOB-02: the browser side of the attention summary, without React — so
// every refetch trigger is testable in node with a fake environment (there
// is no jsdom harness; src/tests/attention-store.test.ts drives it).
// use-attention.ts wraps the one browser instance in a React hook.
//
// One store per page: however many components read the summary, there is
// one poll, one set of listeners and at most one request in flight. The
// summary is fetched
//   - on mount, unless the server rendered one for this page (the seed);
//   - every ATTENTION_POLL_MS while the page is visible, and at once when
//     a hidden page becomes visible again after missing a poll;
//   - on window focus and when the connection returns ('online');
//   - after a mutation (refresh('mutation') — refreshAttention());
//   - when the service worker posts { type: ATTENTION_SW_MESSAGE } (web
//     push, ia:F-38).
// A refresh asked for while a request is in flight runs once more after
// it, so a mutation is never answered with numbers from before it. A
// failed request keeps the last good summary (and says so in `error`).

import { isAttentionSummary, newerSummary, type AttentionSummary } from './types';

export const ATTENTION_URL = '/api/attention';
export const ATTENTION_POLL_MS = 60_000;
/** The message a service worker posts to make every open tab refetch. */
export const ATTENTION_SW_MESSAGE = 'attention:refresh';

export type AttentionRefreshReason =
  | 'mount'
  | 'interval'
  | 'visible'
  | 'focus'
  | 'online'
  | 'mutation'
  | 'service-worker';

export interface AttentionSnapshot {
  summary: AttentionSummary | null;
  /** A request is in flight. */
  loading: boolean;
  /** Why the last request failed ('unauthorized', 'http_500', 'network',
   *  'invalid'); null after a success. */
  error: string | null;
  /** When the summary last changed (env clock, ms). */
  updatedAt: number | null;
}

/** What the store needs from the browser (tests pass fakes). */
export interface AttentionEnv {
  fetch(url: string, init: RequestInit): Promise<Response>;
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** document.visibilityState === 'visible' */
  isVisible(): boolean;
  /** Fires 'focus' and 'online'. */
  window: EventTarget | null;
  /** Fires 'visibilitychange'. */
  document: EventTarget | null;
  /** navigator.serviceWorker: fires 'message'. */
  serviceWorker: EventTarget | null;
}

export interface AttentionStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): AttentionSnapshot;
  /** Adopt a server-rendered summary when it is newer than the one held. */
  seed(summary: AttentionSummary | null | undefined): void;
  /** Fetch now (deduplicated; see the header). */
  refresh(reason: AttentionRefreshReason): Promise<void>;
  /** A component that reads the summary mounted: fetch unless seeded. */
  mounted(): void;
  /** Requests made so far, by reason (tests and the e2e log). */
  readonly requests: ReadonlyArray<AttentionRefreshReason>;
}

export function createAttentionStore(env: AttentionEnv): AttentionStore {
  let snapshot: AttentionSnapshot = { summary: null, loading: false, error: null, updatedAt: null };
  const listeners = new Set<() => void>();
  const requests: AttentionRefreshReason[] = [];
  let inFlight: Promise<void> | null = null;
  let again: AttentionRefreshReason | null = null;
  let seeded = false;
  let lastFetchAt: number | null = null;
  let timer: unknown = null;

  const emit = () => {
    for (const l of [...listeners]) l();
  };
  const set = (next: Partial<AttentionSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    emit();
  };

  async function load(reason: AttentionRefreshReason): Promise<void> {
    requests.push(reason);
    lastFetchAt = env.now();
    set({ loading: true });
    try {
      const res = await env.fetch(ATTENTION_URL, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      if (res.status === 401) {
        set({ loading: false, error: 'unauthorized' });
        return;
      }
      if (!res.ok) {
        set({ loading: false, error: `http_${res.status}` });
        return;
      }
      const body: unknown = await res.json();
      if (!isAttentionSummary(body)) {
        set({ loading: false, error: 'invalid' });
        return;
      }
      // The newer one wins, whatever its workspace: an answer for another
      // workspace computed after the frame's (a switch in another tab) is
      // adopted — the workspace frame shows it as drift, not as its own
      // numbers (DS-07) — but one that was in flight across a switch in
      // THIS tab is older than the new frame's seed and never replaces it.
      const current = snapshot.summary;
      const next = newerSummary(current, body);
      set({
        summary: next,
        loading: false,
        error: null,
        updatedAt: next !== current ? env.now() : snapshot.updatedAt,
      });
    } catch {
      set({ loading: false, error: 'network' });
    }
  }

  function refresh(reason: AttentionRefreshReason): Promise<void> {
    if (inFlight) {
      again ??= reason;
      return inFlight;
    }
    inFlight = (async () => {
      let next: AttentionRefreshReason | null = reason;
      while (next) {
        again = null;
        await load(next);
        next = again;
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  // ---- triggers ----------------------------------------------------------

  const onFocus = () => void refresh('focus');
  const onOnline = () => void refresh('online');
  const onVisibility = () => {
    if (!env.isVisible()) return;
    if (lastFetchAt === null || env.now() - lastFetchAt >= ATTENTION_POLL_MS) {
      void refresh('visible');
    }
  };
  const onWorkerMessage = (event: Event) => {
    const data = (event as MessageEvent).data as { type?: unknown } | null | undefined;
    if (data && data.type === ATTENTION_SW_MESSAGE) void refresh('service-worker');
  };
  const onTick = () => {
    if (env.isVisible()) void refresh('interval');
  };

  function start() {
    env.window?.addEventListener('focus', onFocus);
    env.window?.addEventListener('online', onOnline);
    env.document?.addEventListener('visibilitychange', onVisibility);
    env.serviceWorker?.addEventListener('message', onWorkerMessage);
    timer = env.setInterval(onTick, ATTENTION_POLL_MS);
  }

  function stop() {
    env.window?.removeEventListener('focus', onFocus);
    env.window?.removeEventListener('online', onOnline);
    env.document?.removeEventListener('visibilitychange', onVisibility);
    env.serviceWorker?.removeEventListener('message', onWorkerMessage);
    if (timer !== null) env.clearInterval(timer);
    timer = null;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    getSnapshot: () => snapshot,
    seed(summary) {
      if (!summary) return;
      // A server render is the frame's own state: one for another workspace
      // (this tab switched) always replaces what the store held.
      const current = snapshot.summary;
      const next =
        current && current.workspaceId !== summary.workspaceId
          ? summary
          : newerSummary(current, summary);
      seeded = true;
      if (next !== current) set({ summary: next, updatedAt: env.now() });
    },
    refresh,
    mounted() {
      // The server rendered this page's summary a moment ago: no need to
      // ask again on mount (the poll and the other triggers take over).
      if (seeded) return;
      void refresh('mount');
    },
    get requests() {
      return requests;
    },
  };
}
