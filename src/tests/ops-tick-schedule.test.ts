// PC-07 acceptance (3): the expected-slot rule, with a fake clock.
//   - a weekly tick right after a deploy is 'pending', not stale;
//   - a stopped 30 s tick is stale after its slot plus the tolerance;
//   - nothing fails readiness within 10 minutes of a new boot_id;
//   - BullMQ (epoch-aligned) and memory (registration-based) slots.
// Pure functions: no database.

import { describe, expect, it } from 'vitest';
import {
  BOOT_GRACE_MS,
  evaluateTick,
  expectedSlotAfterStart,
  firstSlotAfterRegistration,
  staleToleranceMs,
  type TickHeartbeatLike,
} from '@/lib/jobs/tick-schedule';
import {
  DRAIN_TICK_MS,
  KNOWLEDGE_COMPACT_TICK_MS,
  MAIL_TRASH_PURGE_TICK_MS,
  TICK_CATALOG,
} from '@/lib/jobs/tick-catalog';
import { buildTickStatuses } from '@/lib/services/job-heartbeats';
import type { JobHeartbeat } from '@/lib/db/schema/ops';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function hb(over: Partial<TickHeartbeatLike>): TickHeartbeatLike {
  return {
    name: 'test.tick',
    intervalMs: DRAIN_TICK_MS,
    queueProvider: 'bullmq',
    registeredAt: null,
    lastStartedAt: null,
    consecutiveFailures: 0,
    ...over,
  };
}

const at = (ms: number) => new Date(ms);

describe('tolerance', () => {
  it('is two intervals, clamped to [1 min, 1 h]', () => {
    expect(staleToleranceMs(30 * SEC)).toBe(MIN);
    expect(staleToleranceMs(2 * MIN)).toBe(4 * MIN);
    expect(staleToleranceMs(5 * MIN)).toBe(10 * MIN);
    expect(staleToleranceMs(HOUR)).toBe(HOUR);
    expect(staleToleranceMs(WEEK)).toBe(HOUR);
  });
});

describe('slot alignment', () => {
  it('bullmq slots are epoch multiples of the interval (BullMQ legacy repeat "every")', () => {
    // 2026-10-05 09:00 UTC is a Monday; weekly epoch slots fall on
    // Thursdays 00:00 UTC (1970-01-01 was a Thursday).
    const registered = Date.UTC(2026, 9, 5, 9, 0, 0);
    const first = firstSlotAfterRegistration(registered, WEEK, 'epoch');
    expect(first).toBe(Date.UTC(2026, 9, 8, 0, 0, 0));
    expect(new Date(first).getUTCDay()).toBe(4);
    expect(first % WEEK).toBe(0);
    // Same formula BullMQ uses: floor(now / every) * every + every.
    expect(first).toBe(Math.floor(registered / WEEK) * WEEK + WEEK);
  });

  it('memory slots count from the registration (setInterval)', () => {
    const registered = Date.UTC(2026, 9, 5, 9, 0, 7);
    expect(firstSlotAfterRegistration(registered, WEEK, 'registration')).toBe(registered + WEEK);
    expect(
      expectedSlotAfterStart(registered + 3 * 30 * SEC + 20, 30 * SEC, 'registration', registered),
    ).toBe(registered + 4 * 30 * SEC);
  });

  it('a start just before a slot boundary (clock skew) counts for that slot', () => {
    const midnight = Date.UTC(2026, 9, 6);
    const expected = expectedSlotAfterStart(midnight - 5, MAIL_TRASH_PURGE_TICK_MS, 'epoch', 0);
    expect(expected).toBe(midnight + DAY);
  });
});

describe('weekly tick right after a deploy', () => {
  const registered = Date.UTC(2026, 9, 5, 9, 0, 0); // Monday 09:00
  const thursday = Date.UTC(2026, 9, 8, 0, 0, 0);

  it('bullmq: pending until its first epoch slot plus tolerance, then stale', () => {
    const base = hb({
      intervalMs: KNOWLEDGE_COMPACT_TICK_MS,
      queueProvider: 'bullmq',
      registeredAt: at(registered),
      // Ran 6 days ago under the previous boot: not "since registration".
      lastStartedAt: at(registered - 6 * DAY),
    });
    const afterGrace = evaluateTick(base, at(registered + 20 * MIN));
    expect(afterGrace.state).toBe('pending');
    expect(afterGrace.failsReadiness).toBe(false);
    expect(afterGrace.expectedAt?.getTime()).toBe(thursday);

    const twoDaysLater = evaluateTick(base, at(registered + 2 * DAY));
    expect(twoDaysLater.state).toBe('pending');

    const justInside = evaluateTick(base, at(thursday + HOUR));
    expect(justInside.state).toBe('pending');
    const missed = evaluateTick(base, at(thursday + HOUR + 1));
    expect(missed.state).toBe('stale');
    expect(missed.failsReadiness).toBe(true);
  });

  it('memory: pending for a whole interval after registration', () => {
    const base = hb({
      intervalMs: KNOWLEDGE_COMPACT_TICK_MS,
      queueProvider: 'memory',
      registeredAt: at(registered),
    });
    expect(evaluateTick(base, at(registered + 3 * DAY)).state).toBe('pending');
    expect(evaluateTick(base, at(registered + WEEK + HOUR)).state).toBe('pending');
    const missed = evaluateTick(base, at(registered + WEEK + HOUR + 1));
    expect(missed.state).toBe('stale');
    expect(missed.failsReadiness).toBe(true);
  });

  it('turns ok once it has run in its slot', () => {
    const ran = evaluateTick(
      hb({
        intervalMs: KNOWLEDGE_COMPACT_TICK_MS,
        queueProvider: 'bullmq',
        registeredAt: at(registered),
        lastStartedAt: at(thursday + 40),
      }),
      at(thursday + 3 * DAY),
    );
    expect(ran.state).toBe('ok');
    expect(ran.expectedAt?.getTime()).toBe(thursday + WEEK);
  });
});

describe('a stopped 30 s tick', () => {
  it('bullmq: stale once its next epoch slot plus 60 s has passed', () => {
    const registered = Date.UTC(2026, 9, 1, 8, 0, 0);
    const slot = Date.UTC(2026, 9, 2, 12, 0, 30); // a 30 s epoch boundary
    expect(slot % DRAIN_TICK_MS).toBe(0);
    const base = hb({
      intervalMs: DRAIN_TICK_MS,
      queueProvider: 'bullmq',
      registeredAt: at(registered),
      lastStartedAt: at(slot + 180), // the last run, slightly late
    });
    const dueBy = slot + DRAIN_TICK_MS + MIN;

    const onTime = evaluateTick(base, at(slot + DRAIN_TICK_MS + 5 * SEC));
    expect(onTime.state).toBe('ok');
    const lastMoment = evaluateTick(base, at(dueBy));
    expect(lastMoment.state).toBe('ok');
    expect(lastMoment.dueBy?.getTime()).toBe(dueBy);

    const stopped = evaluateTick(base, at(dueBy + 1));
    expect(stopped.state).toBe('stale');
    expect(stopped.inBootGrace).toBe(false);
    expect(stopped.failsReadiness).toBe(true);
  });

  it('memory: the same rule on registration-based slots', () => {
    const registered = Date.UTC(2026, 9, 2, 12, 0, 7);
    const fifth = registered + 5 * DRAIN_TICK_MS;
    const base = hb({
      intervalMs: DRAIN_TICK_MS,
      queueProvider: 'memory',
      registeredAt: at(registered),
      lastStartedAt: at(fifth + 15),
    });
    const dueBy = fifth + DRAIN_TICK_MS + MIN;
    expect(evaluateTick(base, at(dueBy)).state).toBe('ok');
    const stopped = evaluateTick(base, at(dueBy + 1));
    expect(stopped.state).toBe('stale');
    expect(stopped.expectedAt?.getTime()).toBe(fifth + DRAIN_TICK_MS);
    // Not epoch-aligned: registered at :07, so the slots fall on :07 / :37.
    expect((fifth + DRAIN_TICK_MS) % DRAIN_TICK_MS).not.toBe(0);
  });

  it('a 30 s tick that never ran since registration is stale after 30 s + 60 s', () => {
    const registered = Date.UTC(2026, 9, 2, 12, 0, 7);
    const base = hb({
      intervalMs: DRAIN_TICK_MS,
      queueProvider: 'memory',
      registeredAt: at(registered),
    });
    expect(evaluateTick(base, at(registered + DRAIN_TICK_MS + MIN)).state).toBe('pending');
    expect(evaluateTick(base, at(registered + DRAIN_TICK_MS + MIN + 1)).state).toBe('stale');
  });
});

describe('boot grace', () => {
  const registered = Date.UTC(2026, 9, 2, 12, 0, 0);
  const neverRan = hb({
    intervalMs: DRAIN_TICK_MS,
    queueProvider: 'bullmq',
    registeredAt: at(registered),
  });

  it('nothing fails within 10 minutes of a new boot_id (registration)', () => {
    for (const offset of [2 * MIN, 5 * MIN, BOOT_GRACE_MS - 1]) {
      const e = evaluateTick(neverRan, at(registered + offset));
      expect(e.state).toBe('stale');
      expect(e.inBootGrace).toBe(true);
      expect(e.failsReadiness).toBe(false);
    }
    const after = evaluateTick(neverRan, at(registered + BOOT_GRACE_MS));
    expect(after.inBootGrace).toBe(false);
    expect(after.failsReadiness).toBe(true);
  });

  it('nothing fails within 10 minutes of this process booting, even on an old registration', () => {
    const oldRegistration = hb({
      intervalMs: DRAIN_TICK_MS,
      queueProvider: 'memory',
      registeredAt: at(registered - DAY),
      lastStartedAt: at(registered - DAY + 40 * SEC),
    });
    const booted = at(registered);
    const inside = evaluateTick(oldRegistration, at(registered + 9 * MIN), {
      processBootedAt: booted,
    });
    expect(inside.state).toBe('stale');
    expect(inside.failsReadiness).toBe(false);
    const outside = evaluateTick(oldRegistration, at(registered + BOOT_GRACE_MS + 1), {
      processBootedAt: booted,
    });
    expect(outside.failsReadiness).toBe(true);
  });

  it('applies to both alignments', () => {
    for (const queueProvider of ['bullmq', 'memory']) {
      const e = evaluateTick({ ...neverRan, queueProvider }, at(registered + 9 * MIN));
      expect(e.alignment).toBe(queueProvider === 'bullmq' ? 'epoch' : 'registration');
      expect(e.failsReadiness).toBe(false);
    }
  });
});

describe('unscheduled and failing', () => {
  it('a tick with no registration is never judged', () => {
    const e = evaluateTick(hb({ registeredAt: null, lastStartedAt: at(0) }), at(Date.now()));
    expect(e.state).toBe('unscheduled');
    expect(e.failsReadiness).toBe(false);
    const job = evaluateTick(hb({ intervalMs: null, registeredAt: at(0) }), at(Date.now()));
    expect(job.state).toBe('unscheduled');
  });

  it('consecutive failures flag the tick as failing without making it stale', () => {
    const registered = Date.UTC(2026, 9, 2, 12, 0, 0);
    const e = evaluateTick(
      hb({
        intervalMs: DRAIN_TICK_MS,
        registeredAt: at(registered),
        lastStartedAt: at(registered + 30 * SEC),
        consecutiveFailures: 3,
      }),
      at(registered + 40 * SEC),
    );
    expect(e.state).toBe('ok');
    expect(e.failing).toBe(true);
    expect(e.failsReadiness).toBe(false);
  });
});

describe('buildTickStatuses', () => {
  it('reports every catalogued tick, ignores retired rows, and judges each by its own row', () => {
    const now = Date.UTC(2026, 9, 2, 12, 0, 0);
    const registered = now - DAY;
    const row = (name: string, lastStartedAt: number | null): JobHeartbeat => ({
      name,
      kind: 'tick',
      intervalMs: TICK_CATALOG.find((t) => t.name === name)?.everyMs ?? 1000,
      queueProvider: 'memory',
      bootId: 'boot-1',
      registeredAt: at(registered),
      lastStartedAt: lastStartedAt === null ? null : at(lastStartedAt),
      lastFinishedAt: null,
      lastOkAt: null,
      lastStatus: null,
      lastDurationMs: null,
      lastError: null,
      lastErrorAt: null,
      lastSummary: {},
      nextDueAt: null,
      runCount: 0,
      consecutiveFailures: 0,
      updatedAt: at(registered),
    });
    const statuses = buildTickStatuses(
      [
        row('outreach.drain.tick', now - 10 * MIN), // stopped 10 min ago
        row('autopilot.tick', now - 2 * MIN),
        row('retired.tick', null),
      ],
      at(now),
    );
    expect(statuses.map((s) => s.name)).toEqual(TICK_CATALOG.map((t) => t.name));
    const byName = new Map(statuses.map((s) => [s.name, s]));
    expect(byName.get('outreach.drain.tick')?.state).toBe('stale');
    expect(byName.get('outreach.drain.tick')?.failsReadiness).toBe(true);
    expect(byName.get('autopilot.tick')?.state).toBe('ok');
    expect(byName.get('mail.imap.tick')?.state).toBe('unscheduled');
    expect(byName.has('retired.tick' as never)).toBe(false);
  });
});
