// PC-07 acceptance (1): the instrumented() wrapper records start, finish,
// duration, status and consecutive_failures on job_heartbeats, a failed
// heartbeat write never fails the job, and a whole-job failure is a
// platform incident resolved by the next success. Plus the schedule
// registration (registered_at, boot_id) and the queue paths that use it.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { jobHeartbeats, opsEvents } from '@/lib/db/schema/ops';
import {
  InMemoryJobQueue,
  _setJobQueueForTests,
  type JobPayload,
  type RepeatableJobOptions,
} from '@/lib/jobs';
import { _setBootInfoForTests } from '@/lib/jobs/boot';
import { _resetHandlersForTests, registerJobHandlers } from '@/lib/jobs/bootstrap';
import {
  instrumented,
  isInstrumentedHandler,
  jobFailureFingerprint,
} from '@/lib/jobs/instrumented';
import {
  SCHEDULE_REGISTRATION_FAILED,
  _resetRepeatablesForTests,
  registerRepeatableJobs,
  reportScheduleRegistrationFailure,
} from '@/lib/jobs/repeatables';
import { TICK_CATALOG } from '@/lib/jobs/tick-catalog';
import { getTickStatuses } from '@/lib/services/job-heartbeats';
import { truncateAll } from './helpers/db';

beforeEach(async () => {
  await truncateAll();
  _setJobQueueForTests(null);
  _resetRepeatablesForTests();
  _resetHandlersForTests();
});

afterEach(() => {
  _setJobQueueForTests(null);
  _resetRepeatablesForTests();
  _resetHandlersForTests();
  _setBootInfoForTests(null);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

async function heartbeat(name: string) {
  const [row] = await db.select().from(jobHeartbeats).where(eq(jobHeartbeats.name, name));
  return row;
}

/** A clock that advances by `stepMs` on every read. */
function steppingClock(startMs: number, stepMs: number): () => Date {
  let t = startMs;
  return () => {
    const d = new Date(t);
    t += stepMs;
    return d;
  };
}

const T0 = Date.UTC(2026, 9, 2, 10, 0, 0);

describe('instrumented(): heartbeats', () => {
  it('records start, finish, duration, ok status and the summary', async () => {
    const handler = instrumented('test.tick', async () => ({ workspaces: 2, sent: 5 }), {
      kind: 'tick',
      label: 'Test',
      deps: { now: steppingClock(T0, 1500) },
    });
    const result = await handler({}, { jobId: '1' });
    expect(result).toEqual({ workspaces: 2, sent: 5 });

    const row = await heartbeat('test.tick');
    expect(row).toMatchObject({
      kind: 'tick',
      lastStatus: 'ok',
      lastDurationMs: 1500,
      runCount: 1,
      consecutiveFailures: 0,
      lastSummary: { workspaces: 2, sent: 5, failedSubjects: 0 },
    });
    expect(row!.lastStartedAt?.getTime()).toBe(T0);
    expect(row!.lastFinishedAt?.getTime()).toBe(T0 + 1500);
    expect(row!.lastOkAt?.getTime()).toBe(T0 + 1500);
  });

  it('counts consecutive failures, masks the error, rethrows, and resets on success', async () => {
    let fail = true;
    const handler = instrumented(
      'flaky.tick',
      async () => {
        if (fail) throw new Error('db refused: password=hunter2');
        return { ok: true };
      },
      { kind: 'tick', label: 'Flaky', deps: { now: steppingClock(T0, 10) } },
    );

    await expect(handler({}, { jobId: '1' })).rejects.toThrow('db refused');
    await expect(handler({}, { jobId: '2' })).rejects.toThrow('db refused');
    let row = await heartbeat('flaky.tick');
    expect(row).toMatchObject({ lastStatus: 'failed', consecutiveFailures: 2, runCount: 2 });
    expect(row!.lastOkAt).toBeNull();
    expect(row!.lastError).toContain('db refused');
    expect(row!.lastError).not.toContain('hunter2');

    // One open platform incident for the whole tick, counted twice.
    const open = await db
      .select()
      .from(opsEvents)
      .where(and(eq(opsEvents.kind, 'tick.failed'), isNull(opsEvents.resolvedAt)));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      scope: 'platform',
      source: 'flaky.tick',
      occurrences: 2,
      severity: 'error',
    });
    expect(open[0]!.fingerprint).toBe(jobFailureFingerprint('flaky.tick', 'tick'));

    fail = false;
    await handler({}, { jobId: '3' });
    row = await heartbeat('flaky.tick');
    expect(row).toMatchObject({ lastStatus: 'ok', consecutiveFailures: 0, runCount: 3 });
    expect(row!.lastError).toContain('db refused'); // history kept
    const [resolved] = await db.select().from(opsEvents).where(eq(opsEvents.id, open[0]!.id));
    expect(resolved!.resolvedAt).not.toBeNull();
    expect(resolved!.resolution).toBe('auto');
  });

  it("marks a run 'degraded' when a workspace failed inside it", async () => {
    const handler = instrumented(
      'partial.tick',
      async (_p, { incidents }) => {
        await incidents.failed({ workspaceId: 999n }, new Error('x'));
        return { workspaces: 1 };
      },
      {
        kind: 'tick',
        label: 'Partial',
        deps: {
          raise: vi.fn(async () => ({ id: 1n, fingerprint: 'f', occurrences: 1, opened: true })),
        },
      },
    );
    await handler({}, { jobId: '1' });
    expect(await heartbeat('partial.tick')).toMatchObject({
      lastStatus: 'degraded',
      consecutiveFailures: 0,
      lastSummary: { workspaces: 1, failedSubjects: 1 },
    });
  });

  it('a failed heartbeat write never fails the job', async () => {
    const broken = async () => {
      throw new Error('heartbeat table is gone');
    };
    const log = vi.fn();
    const deps = {
      recordStart: broken,
      recordFinish: broken,
      listOpen: broken,
      raise: broken,
      resolve: broken,
      log,
    };
    const ok = instrumented('ok.tick', async () => ({ done: true }), {
      kind: 'tick',
      label: 'Ok',
      deps,
    });
    await expect(ok({}, { jobId: '1' })).resolves.toEqual({ done: true });

    // A failing handler still rejects with ITS error, not the heartbeat's.
    const failing = instrumented(
      'bad.tick',
      async () => {
        throw new Error('the real failure');
      },
      { kind: 'tick', label: 'Bad', deps },
    );
    await expect(failing({}, { jobId: '2' })).rejects.toThrow('the real failure');
    expect(log).toHaveBeenCalled();
    // Per-workspace reporting is best-effort too.
    const reporting = instrumented(
      'report.tick',
      async (_p, { incidents }) => {
        await incidents.failed({ workspaceId: 1n }, new Error('x'));
        await incidents.succeeded({ workspaceId: 2n });
        return {};
      },
      { kind: 'tick', label: 'Report', deps },
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(reporting({}, { jobId: '3' })).resolves.toEqual({});
  });

  it('marks wrapped handlers so the BullMQ worker does not double-report', () => {
    const wrapped = instrumented('x', async () => ({}), { kind: 'job', label: 'X' });
    expect(isInstrumentedHandler(wrapped)).toBe(true);
    expect(isInstrumentedHandler(async () => ({}))).toBe(false);
    expect(isInstrumentedHandler(undefined)).toBe(false);
  });
});

describe('schedule registration', () => {
  class RecordingQueue extends InMemoryJobQueue {
    public schedules: Array<{ type: string; everyMs: number }> = [];
    override async enqueueRepeatable<P extends JobPayload>(
      type: string,
      _payload: P,
      options: RepeatableJobOptions,
    ): Promise<void> {
      this.schedules.push({ type, everyMs: options.everyMs });
    }
  }

  it('writes registered_at, boot_id, interval and provider for every tick', async () => {
    _setBootInfoForTests({ id: 'boot-test-1', startedAt: new Date(T0) });
    const q = new RecordingQueue();
    _setJobQueueForTests(q);
    const before = Date.now();
    await registerRepeatableJobs();
    const after = Date.now();

    expect(q.schedules.map((s) => s.type)).toEqual(TICK_CATALOG.map((t) => t.name));
    const rows = await db.select().from(jobHeartbeats);
    expect(rows).toHaveLength(TICK_CATALOG.length);
    for (const tick of TICK_CATALOG) {
      const row = rows.find((r) => r.name === tick.name)!;
      expect(row).toMatchObject({
        kind: 'tick',
        intervalMs: tick.everyMs,
        queueProvider: 'memory',
        bootId: 'boot-test-1',
      });
      const registered = row.registeredAt!.getTime();
      expect(registered).toBeGreaterThanOrEqual(before);
      expect(registered).toBeLessThanOrEqual(after);
      // Memory slots count from the registration.
      expect(row.nextDueAt!.getTime()).toBe(registered + tick.everyMs);
    }

    // Freshly registered and never run: pending, nothing fails readiness.
    const statuses = await getTickStatuses(new Date(after + 1000));
    expect(statuses.every((s) => s.state === 'pending')).toBe(true);
    expect(statuses.some((s) => s.failsReadiness)).toBe(false);
  });

  it('a run after registration stores the next expected slot', async () => {
    const q = new RecordingQueue();
    _setJobQueueForTests(q);
    await registerRepeatableJobs();
    const reg = (await heartbeat('outreach.drain.tick'))!.registeredAt!.getTime();

    const id = await q.enqueue('outreach.drain.tick', {});
    await q.drain();
    expect((await q.status(id)).state).toBe('succeeded');
    const row = await heartbeat('outreach.drain.tick');
    expect(row).toMatchObject({ lastStatus: 'ok', runCount: 1 });
    const started = row!.lastStartedAt!.getTime();
    const expected = reg + (Math.floor((started + 7_500 - reg) / 30_000) + 1) * 30_000;
    expect(row!.nextDueAt!.getTime()).toBe(expected);
  });

  it('a failed registration is a critical platform incident; the next registration resolves it', async () => {
    await reportScheduleRegistrationFailure(new Error('connect ECONNREFUSED redis:6379'));
    const [open] = await db
      .select()
      .from(opsEvents)
      .where(eq(opsEvents.kind, SCHEDULE_REGISTRATION_FAILED));
    expect(open).toMatchObject({ scope: 'platform', severity: 'critical', source: 'startup' });
    expect(open!.resolvedAt).toBeNull();

    _setJobQueueForTests(new RecordingQueue());
    await registerRepeatableJobs();
    const [after] = await db.select().from(opsEvents).where(eq(opsEvents.id, open!.id));
    expect(after!.resolvedAt).not.toBeNull();
  });

  it('skipSchedule registers instrumented handlers without registration rows', async () => {
    const q = new InMemoryJobQueue();
    _setJobQueueForTests(q);
    await registerRepeatableJobs({ skipSchedule: true });
    expect(await db.select().from(jobHeartbeats)).toHaveLength(0);
    const id = await q.enqueue('mail.trash.purge.tick', {});
    await q.drain();
    expect((await q.status(id)).state).toBe('succeeded');
    const row = await heartbeat('mail.trash.purge.tick');
    expect(row).toMatchObject({
      kind: 'tick',
      lastStatus: 'ok',
      runCount: 1,
      registeredAt: null,
      nextDueAt: null,
    });
  });
});

describe('connector.run (on-demand job)', () => {
  it("is instrumented as a 'job': heartbeat without a schedule, failures raise 'job.failed'", async () => {
    const q = new InMemoryJobQueue();
    _setJobQueueForTests(q);
    registerJobHandlers();
    const id = await q.enqueue('connector.run', {
      runId: '987654',
      workspaceId: '1',
      userId: 'nobody',
      role: 'owner',
    });
    await q.drain();
    const status = await q.status(id);
    expect(status.state).toBe('failed');

    const row = await heartbeat('connector.run');
    expect(row).toMatchObject({
      kind: 'job',
      lastStatus: 'failed',
      consecutiveFailures: 1,
      intervalMs: null,
      registeredAt: null,
    });
    const events = await db.select().from(opsEvents).where(eq(opsEvents.source, 'connector.run'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'job.failed',
      scope: 'platform',
      title: 'Discovery run failed',
    });
    // Never judged for staleness: not in the tick catalogue.
    const statuses = await getTickStatuses();
    expect(statuses.some((s) => s.name === ('connector.run' as never))).toBe(false);
  });
});
