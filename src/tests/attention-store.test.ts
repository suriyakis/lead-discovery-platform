// MOB-02: useAttention()'s refetch triggers, through the store it wraps
// (src/lib/attention/store.ts) with a fake browser: fake timers, event
// targets for window / document / the service worker, a stubbed fetch.
// There is no jsdom harness (AP-00), so the store is the unit and the
// hook is a thin useSyncExternalStore over it; the hook's server render
// is checked with react-dom/server at the end.
//
// Triggers: on mount (unless the server rendered a summary), every 60 s
// while visible (and at once when a hidden page becomes visible after a
// missed poll), on focus, when the connection returns, after a mutation,
// and on a service-worker message.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTENTION_POLL_MS,
  ATTENTION_SW_MESSAGE,
  ATTENTION_URL,
  createAttentionStore,
  type AttentionEnv,
} from '@/lib/attention/store';
import {
  ATTENTION_COUNT_KEYS,
  ATTENTION_VERSION,
  type AttentionSummary,
} from '@/lib/attention/types';
import { navCountsFromAttention } from '@/lib/attention/project';
import { refreshAttention, useAttention } from '@/lib/attention/use-attention';
import { areaById, resolveNavCount } from '@/lib/nav/resolve';

function summary(opts: {
  at: number;
  reviewOpen?: number | null;
  workspaceId?: string;
}): AttentionSummary {
  const counts = Object.fromEntries(
    ATTENTION_COUNT_KEYS.map((k) => [k, 0]),
  ) as AttentionSummary['counts'];
  counts['review.open'] = opts.reviewOpen === undefined ? 1 : opts.reviewOpen;
  return {
    version: ATTENTION_VERSION,
    workspaceId: opts.workspaceId ?? '1',
    generatedAt: new Date(opts.at).toISOString(),
    counts,
    failed: [],
    degraded: false,
    findings: [],
    outreach: null,
    wallet: null,
    health: null,
    platform: null,
  };
}

interface Fake {
  env: AttentionEnv;
  fetch: ReturnType<typeof vi.fn>;
  window: EventTarget;
  document: EventTarget;
  serviceWorker: EventTarget;
  setVisible(v: boolean): void;
  /** What the next responses are (a function of the call number). */
  respond(fn: (call: number) => Response | Promise<Response>): void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fake(): Fake {
  let visible = true;
  let responder: (call: number) => Response | Promise<Response> = () =>
    json(summary({ at: Date.now() }));
  let calls = 0;
  const win = new EventTarget();
  const doc = new EventTarget();
  const sw = new EventTarget();
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(ATTENTION_URL);
    expect(init).toMatchObject({ cache: 'no-store', credentials: 'same-origin' });
    calls += 1;
    return responder(calls);
  });
  return {
    env: {
      fetch: fetchFn,
      now: () => Date.now(),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
      isVisible: () => visible,
      window: win,
      document: doc,
      serviceWorker: sw,
    },
    fetch: fetchFn,
    window: win,
    document: doc,
    serviceWorker: sw,
    setVisible(v) {
      visible = v;
      doc.dispatchEvent(new Event('visibilitychange'));
    },
    respond(fn) {
      responder = fn;
    },
  };
}

/** Let pending promises (the fetch and its JSON) settle. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
  });
  vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the attention store: when it fetches', () => {
  it('on mount without a server summary; not on mount with one', async () => {
    const a = fake();
    const store = createAttentionStore(a.env);
    store.subscribe(() => {});
    store.mounted();
    await settle();
    expect(a.fetch).toHaveBeenCalledTimes(1);
    expect(store.requests).toEqual(['mount']);
    expect(store.getSnapshot().summary?.counts['review.open']).toBe(1);

    const b = fake();
    const seeded = createAttentionStore(b.env);
    seeded.subscribe(() => {});
    seeded.seed(summary({ at: Date.now(), reviewOpen: 7 }));
    seeded.mounted();
    await settle();
    expect(b.fetch).not.toHaveBeenCalled();
    expect(seeded.getSnapshot().summary?.counts['review.open']).toBe(7);
  });

  it('every 60 s while the page is visible, never while hidden, and at once when it shows again after a missed poll', async () => {
    const f = fake();
    const store = createAttentionStore(f.env);
    store.subscribe(() => {});
    store.seed(summary({ at: Date.now() }));
    await vi.advanceTimersByTimeAsync(ATTENTION_POLL_MS - 1);
    expect(f.fetch).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ATTENTION_POLL_MS);
    expect(f.fetch).toHaveBeenCalledTimes(2);

    f.setVisible(false);
    await vi.advanceTimersByTimeAsync(3 * ATTENTION_POLL_MS);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    // Back after missing polls: fetch at once.
    f.setVisible(true);
    await settle();
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(store.requests.at(-1)).toBe('visible');
    // Hidden and shown again a moment later: nothing missed, no fetch.
    f.setVisible(false);
    f.setVisible(true);
    await settle();
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(store.requests).toEqual(['interval', 'interval', 'visible']);
  });

  it('on focus and when the connection returns', async () => {
    const f = fake();
    const store = createAttentionStore(f.env);
    store.subscribe(() => {});
    f.window.dispatchEvent(new Event('focus'));
    await settle();
    f.window.dispatchEvent(new Event('online'));
    await settle();
    expect(store.requests).toEqual(['focus', 'online']);
  });

  it('on the service worker message, and only that message', async () => {
    const f = fake();
    const store = createAttentionStore(f.env);
    store.subscribe(() => {});
    f.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'push:other' } }));
    f.serviceWorker.dispatchEvent(new MessageEvent('message', { data: 'attention:refresh' }));
    await settle();
    expect(f.fetch).not.toHaveBeenCalled();
    f.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: ATTENTION_SW_MESSAGE } }),
    );
    await settle();
    expect(store.requests).toEqual(['service-worker']);
  });

  it('after a mutation; a mutation during a request runs once more after it, never twice', async () => {
    const f = fake();
    let release!: () => void;
    let n = 0;
    f.respond(async () => {
      n += 1;
      if (n === 1) await new Promise<void>((r) => (release = r));
      return json(summary({ at: Date.now(), reviewOpen: 10 - n }));
    });
    const store = createAttentionStore(f.env);
    store.subscribe(() => {});
    const first = store.refresh('mutation');
    await settle();
    // Three more mutations land while the first request is in flight.
    void store.refresh('mutation');
    void store.refresh('focus');
    void store.refresh('mutation');
    expect(f.fetch).toHaveBeenCalledTimes(1);
    release();
    await first;
    await settle();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(store.requests).toEqual(['mutation', 'mutation']);
    // The numbers are the ones from after the mutation.
    expect(store.getSnapshot().summary?.counts['review.open']).toBe(8);
  });
});

describe('the attention store: what it keeps', () => {
  it('a failed request keeps the last good summary and says why; 401 says signed out', async () => {
    const f = fake();
    const store = createAttentionStore(f.env);
    store.subscribe(() => {});
    store.seed(summary({ at: Date.now(), reviewOpen: 4 }));
    for (const [response, error] of [
      [json({ error: 'attention_unavailable' }, 500), 'http_500'],
      [json({ error: 'unauthorized' }, 401), 'unauthorized'],
      [json({ nope: true }), 'invalid'],
    ] as const) {
      f.respond(() => response.clone());
      await store.refresh('focus');
      expect(store.getSnapshot()).toMatchObject({ error, loading: false });
      expect(store.getSnapshot().summary?.counts['review.open']).toBe(4);
    }
    f.respond(() => Promise.reject(new TypeError('Failed to fetch')));
    await store.refresh('online');
    expect(store.getSnapshot().error).toBe('network');
    expect(store.getSnapshot().summary?.counts['review.open']).toBe(4);
    // Back: the new numbers replace it and the error clears.
    f.respond(() => json(summary({ at: Date.now() + 1000, reviewOpen: 3 })));
    await store.refresh('online');
    expect(store.getSnapshot()).toMatchObject({ error: null });
    expect(store.getSnapshot().summary?.counts['review.open']).toBe(3);
  });

  it('a null count travels as null (unknown), never as 0', async () => {
    const f = fake();
    f.respond(() =>
      json({
        ...summary({ at: Date.now(), reviewOpen: null }),
        degraded: true,
        failed: ['review.open'],
      }),
    );
    const store = createAttentionStore(f.env);
    store.subscribe(() => {});
    store.mounted();
    await settle();
    expect(store.getSnapshot().summary?.counts['review.open']).toBeNull();
    expect(store.getSnapshot().summary?.degraded).toBe(true);
  });

  it('an older answer never replaces a newer server summary; another workspace always does', async () => {
    const f = fake();
    const store = createAttentionStore(f.env);
    store.subscribe(() => {});
    store.seed(summary({ at: Date.now(), reviewOpen: 5 }));
    f.respond(() => json(summary({ at: Date.now() - 10_000, reviewOpen: 9 })));
    await store.refresh('focus');
    expect(store.getSnapshot().summary?.counts['review.open']).toBe(5);
    // The workspace was switched in another tab.
    f.respond(() => json(summary({ at: Date.now() - 10_000, reviewOpen: 2, workspaceId: '2' })));
    await store.refresh('focus');
    expect(store.getSnapshot().summary).toMatchObject({ workspaceId: '2' });
    // A newer server render of the same workspace is adopted.
    store.seed(summary({ at: Date.now() + 5000, reviewOpen: 1, workspaceId: '2' }));
    expect(store.getSnapshot().summary?.counts['review.open']).toBe(1);
  });

  it('the last reader leaving removes the poll and every listener', async () => {
    const f = fake();
    const store = createAttentionStore(f.env);
    const a = store.subscribe(() => {});
    const b = store.subscribe(() => {});
    a();
    f.window.dispatchEvent(new Event('focus'));
    await settle();
    expect(f.fetch).toHaveBeenCalledTimes(1); // one reader left: still listening
    b();
    f.window.dispatchEvent(new Event('focus'));
    f.window.dispatchEvent(new Event('online'));
    f.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: ATTENTION_SW_MESSAGE } }),
    );
    await vi.advanceTimersByTimeAsync(5 * ATTENTION_POLL_MS);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it('notifies its readers on every change', async () => {
    const f = fake();
    const store = createAttentionStore(f.env);
    const seen: Array<number | null | undefined> = [];
    store.subscribe(() => seen.push(store.getSnapshot().summary?.counts['review.open']));
    store.mounted();
    await settle();
    expect(seen.at(-1)).toBe(1);
    expect(seen.length).toBeGreaterThanOrEqual(2); // loading, then loaded
  });
});

describe('the navigation projection (nav-counts = a view of the summary)', () => {
  it('maps the keys, sums Outreach, and marks a failed source unknown ("—", neutral)', () => {
    const s = summary({ at: Date.now(), reviewOpen: 12 });
    s.counts['review.needsReview'] = 2;
    s.counts['drafts.approve'] = 3;
    s.counts['followUps.approve'] = 4;
    s.counts['replies.awaiting'] = 5;
    s.counts['support.unread'] = 1;
    let p = navCountsFromAttention(s);
    expect(p.values).toEqual({
      reviewPending: 12,
      reviewNeedsReview: 2,
      draftsPending: 3,
      followUpsAwaiting: 4,
      outreachPending: 7,
      supportUnread: 1,
      repliesUnhandled: 5,
    });
    expect(p.unknown.size).toBe(0);
    expect(resolveNavCount(areaById('review').count, p.values)).toMatchObject({
      text: '12',
      tone: 'attention',
    });
    // Replies stay gated (I084): no number although 5 wait.
    expect(resolveNavCount(areaById('conversations').count, p.values)).toBeNull();

    // follow-ups failed: Outreach is unknown, not "3".
    s.counts['followUps.approve'] = null;
    s.counts['review.open'] = null;
    p = navCountsFromAttention(s);
    expect(p.values.outreachPending).toBeNull();
    expect([...p.unknown].sort()).toEqual(['outreachPending', 'reviewPending']);
    for (const area of ['review', 'outreach']) {
      expect(resolveNavCount(areaById(area).count, p.values, { unknown: p.unknown })).toMatchObject(
        {
          value: null,
          text: '—',
          tone: 'neutral',
        },
      );
    }
    // Without the unknown set (a caller that never computed it) nothing shows.
    expect(resolveNavCount(areaById('outreach').count, p.values)).toBeNull();
  });

  it('adds the console count for super-admins only', () => {
    const s = summary({ at: Date.now() });
    expect(navCountsFromAttention(s).values.adminSupportUnread).toBeUndefined();
    expect(
      navCountsFromAttention({ ...s, platform: { supportUnread: 3 } }).values.adminSupportUnread,
    ).toBe(3);
    const failed = navCountsFromAttention({ ...s, platform: { supportUnread: null } });
    expect(failed.unknown.has('adminSupportUnread')).toBe(true);
  });
});

describe('useAttention on the server', () => {
  function Probe({ seed }: { seed: AttentionSummary | null }) {
    const s = useAttention(seed);
    return createElement('span', null, s ? String(s.counts['review.open']) : 'none');
  }

  it('renders the server summary it is given, without fetching; refreshAttention is a no-op there', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(
      renderToStaticMarkup(
        createElement(Probe, { seed: summary({ at: Date.now(), reviewOpen: 6 }) }),
      ),
    ).toBe('<span>6</span>');
    expect(renderToStaticMarkup(createElement(Probe, { seed: null }))).toBe('<span>none</span>');
    refreshAttention();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
