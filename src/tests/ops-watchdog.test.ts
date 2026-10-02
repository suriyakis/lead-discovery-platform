// PC-08 acceptance (2): a single stale observation does not alert; two
// consecutive ones alert once. Driven through runWatchdogPass() with a fake
// clock, real job_heartbeats rows, real ops_events and the real dispatcher
// (fetch mocked). Plus the watchdog timer: idempotent start, no overlapping
// passes, stop.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { jobHeartbeats, opsEvents } from '@/lib/db/schema/ops';
import { readAlertConfig } from '@/lib/ops/alert-config';
import {
  STALE_CHECKS_BEFORE_ALERT,
  StaleTickStreaks,
  TICK_STALE_KIND,
  WATCHDOG_INTERVAL_MS,
  runWatchdogPass,
  startOpsWatchdog,
  tickStaleFingerprint,
} from '@/lib/ops/watchdog';
import { _setOpsAlertDepsForTests } from '@/lib/services/ops-alerts';
import type { TickStatus } from '@/lib/services/job-heartbeats';
import { truncateAll } from './helpers/db';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DRAIN = 'outreach.drain.tick';

let clock: Date;
const fetchMock = vi.fn(
  async (_url: string, _init: RequestInit): Promise<Response> =>
    new Response('{}', { status: 200 }),
);

const titles = () =>
  fetchMock.mock.calls.map(
    ([, init]) => (JSON.parse(String(init.body)) as { title: string }).title,
  );

async function seedDrain(lastStartedAt: Date) {
  await db.insert(jobHeartbeats).values({
    name: DRAIN,
    kind: 'tick',
    intervalMs: 30 * SEC,
    queueProvider: 'memory',
    bootId: 'boot-1',
    registeredAt: new Date(clock.getTime() - 2 * HOUR),
    lastStartedAt,
    lastFinishedAt: lastStartedAt,
    lastOkAt: lastStartedAt,
    lastStatus: 'ok',
    runCount: 100,
  });
}

function pass(streaks: StaleTickStreaks, bootedAt: Date = new Date(clock.getTime() - 3 * HOUR)) {
  return runWatchdogPass(streaks, {
    now: () => clock,
    processBootedAt: () => bootedAt,
    dailyDigest: async () => null,
    log: () => undefined,
  });
}

async function openStale() {
  return db
    .select()
    .from(opsEvents)
    .where(and(eq(opsEvents.kind, TICK_STALE_KIND), isNull(opsEvents.resolvedAt)));
}

beforeEach(async () => {
  await truncateAll();
  clock = new Date('2026-10-02T09:00:00.000Z');
  fetchMock.mockClear();
  _setOpsAlertDepsForTests({
    now: () => clock,
    config: () => readAlertConfig({ NTFY_TOPIC: 'ls-owner-K9q2Zr' }),
    fetch: fetchMock,
    log: () => undefined,
  });
});

afterEach(() => {
  _setOpsAlertDepsForTests(null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('acceptance (2): stale ticks alert only after two consecutive checks', () => {
  it('one stale check: nothing; the second: one incident and one alert; then quiet', async () => {
    expect(STALE_CHECKS_BEFORE_ALERT).toBe(2);
    // Last run 10 min ago: a 30 s tick is long past its slot + 1 min.
    await seedDrain(new Date(clock.getTime() - 10 * MIN));
    const streaks = new StaleTickStreaks();

    const first = await pass(streaks);
    expect(first.stale).toEqual([]);
    expect(first.errors).toEqual([]);
    expect(await openStale()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    clock = new Date(clock.getTime() + WATCHDOG_INTERVAL_MS);
    const second = await pass(streaks);
    expect(second.stale).toEqual([DRAIN]);
    const [incident] = await openStale();
    expect(incident).toMatchObject({
      scope: 'platform',
      severity: 'error',
      source: DRAIN,
      fingerprint: tickStaleFingerprint(DRAIN),
      title: 'Send queue stopped running',
    });
    expect(incident!.message).toContain('No run since 2026-10-02 08:50 UTC');
    expect(incident!.message).toContain('every 30 s');
    expect(incident!.message).toContain('Stale on 2 consecutive watchdog checks');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(titles()).toEqual(['Leadsonar: Send queue stopped running']);

    // Still stale: the incident counts on, nobody is paged again.
    clock = new Date(clock.getTime() + WATCHDOG_INTERVAL_MS);
    const third = await pass(streaks);
    expect(third.stale).toEqual([DRAIN]);
    const [still] = await openStale();
    expect(still!.occurrences).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // It runs again: the next check resolves the incident.
    await db
      .update(jobHeartbeats)
      .set({ lastStartedAt: clock })
      .where(eq(jobHeartbeats.name, DRAIN));
    clock = new Date(clock.getTime() + 10 * SEC);
    const fourth = await pass(streaks);
    expect(fourth.recovered).toEqual([DRAIN]);
    expect(await openStale()).toEqual([]);
    const [resolved] = await db.select().from(opsEvents).where(eq(opsEvents.kind, TICK_STALE_KIND));
    expect(resolved).toMatchObject({ resolution: 'auto' });
  });

  it('stale, healthy, stale again is not two CONSECUTIVE checks', async () => {
    await seedDrain(new Date(clock.getTime() - 10 * MIN));
    const streaks = new StaleTickStreaks();
    await pass(streaks);
    // A run lands between the checks.
    await db
      .update(jobHeartbeats)
      .set({ lastStartedAt: clock })
      .where(eq(jobHeartbeats.name, DRAIN));
    clock = new Date(clock.getTime() + 10 * SEC);
    await pass(streaks);
    expect(streaks.streak(DRAIN)).toBe(0);
    // Stale again later: the count starts over.
    clock = new Date(clock.getTime() + 10 * MIN);
    expect((await pass(streaks)).stale).toEqual([]);
    expect(await openStale()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('within the boot grace a stale tick never counts', async () => {
    await seedDrain(new Date(clock.getTime() - 10 * MIN));
    const streaks = new StaleTickStreaks();
    const bootedAt = new Date(clock.getTime() - MIN);
    for (let i = 0; i < 3; i++) {
      await pass(streaks, bootedAt);
      clock = new Date(clock.getTime() + WATCHDOG_INTERVAL_MS);
    }
    expect(streaks.streak(DRAIN)).toBe(0);
    expect(await openStale()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a pending or unscheduled tick is never stale', async () => {
    const streaks = new StaleTickStreaks();
    // No rows at all: every catalogued tick is unscheduled.
    for (let i = 0; i < 3; i++) {
      expect((await pass(streaks)).stale).toEqual([]);
      clock = new Date(clock.getTime() + WATCHDOG_INTERVAL_MS);
    }
    expect(await openStale()).toEqual([]);
  });

  it('one failing step does not skip the others', async () => {
    const dispatch = vi.fn(async () => 'dispatched');
    const dailyDigest = vi.fn(async () => 'digested');
    const r = await runWatchdogPass(new StaleTickStreaks(), {
      now: () => clock,
      processBootedAt: () => clock,
      loadHeartbeats: async () => {
        throw new Error('db down password=hunter2');
      },
      dispatch,
      dailyDigest,
      log: () => undefined,
    });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('stale-tick check: db down');
    expect(r.errors[0]).not.toContain('hunter2');
    expect(r.dispatch).toBe('dispatched');
    expect(r.dailyDigest).toBe('digested');
  });
});

describe('StaleTickStreaks', () => {
  const status = (name: string, over: Partial<TickStatus>): TickStatus =>
    ({ name, state: 'ok', failsReadiness: false, ...over }) as TickStatus;

  it('confirms on the second consecutive failing observation', () => {
    const s = new StaleTickStreaks(2);
    const stale = status('a', { state: 'stale', failsReadiness: true });
    expect(s.observe([stale]).confirmed).toEqual([]);
    expect(s.observe([stale]).confirmed).toEqual([{ status: stale, checks: 2 }]);
    expect(s.observe([stale]).confirmed).toEqual([{ status: stale, checks: 3 }]);
    const ok = status('a', {});
    expect(s.observe([ok])).toEqual({ confirmed: [], healthy: [ok] });
    expect(s.streak('a')).toBe(0);
  });

  it('a stale tick in its boot grace is neither confirmed nor healthy', () => {
    const s = new StaleTickStreaks(2);
    const graced = status('a', { state: 'stale', failsReadiness: false, inBootGrace: true });
    expect(s.observe([graced])).toEqual({ confirmed: [], healthy: [] });
  });
});

describe('startOpsWatchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts once, never overlaps passes, and stops', async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const runPass = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    );
    const handle = startOpsWatchdog({
      runPass,
      intervalMs: 1000,
      firstDelayMs: 500,
      log: () => undefined,
    });
    expect(startOpsWatchdog({ runPass: vi.fn() })).toBe(handle);

    await vi.advanceTimersByTimeAsync(499);
    expect(runPass).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runPass).toHaveBeenCalledTimes(1);
    // The pass hangs: no second one starts on top of it.
    await vi.advanceTimersByTimeAsync(5000);
    expect(runPass).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runPass).toHaveBeenCalledTimes(2);

    handle.stop();
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runPass).toHaveBeenCalledTimes(2);
    // A fresh start after stop is a new watchdog.
    const next = startOpsWatchdog({ runPass: vi.fn(async () => undefined), firstDelayMs: 1 });
    expect(next).not.toBe(handle);
    next.stop();
  });

  it('a throwing pass is logged and the loop goes on', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const runPass = vi.fn(async () => {
      throw new Error('boom');
    });
    const handle = startOpsWatchdog({ runPass, intervalMs: 100, firstDelayMs: 100, log });
    await vi.advanceTimersByTimeAsync(350);
    expect(runPass).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledWith('[ops] watchdog pass failed: boom');
    handle.stop();
  });
});
