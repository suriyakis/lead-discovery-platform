// PC-07: the ops incident stream — fingerprinting, deduplication, masking,
// resolution — and the BullMQ worker's 'failed' / 'error' / 'completed'
// reporting (driven through a plain EventEmitter: no Redis in tests).

import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { opsEvents } from '@/lib/db/schema/ops';
import { settleDetached } from '@/lib/detached';
import { describeError, maskPayload, maskSensitive } from '@/lib/ops/mask';
import {
  OPS_EVENTS_RETENTION_DAYS,
  OpsEventError,
  countOpenOpsEventsBySeverity,
  listOpenOpsEventFingerprints,
  opsEventFingerprint,
  raiseOpsEvent,
  resolveOpsEvent,
  type RaiseOpsEventInput,
} from '@/lib/services/ops-events';
import {
  WORKER_ERROR_FINGERPRINT,
  attachWorkerEventReporting,
  jobFailedFingerprint,
  type WorkerEventReporter,
  type WorkerEventSource,
} from '@/lib/jobs/worker-events';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

async function seedWs(name: string): Promise<bigint> {
  const owner = await seedUser({ email: `${name}@ops.test` });
  return seedWorkspace({ name, ownerUserId: owner });
}

describe('maskSensitive', () => {
  it('drops secrets and personal data but keeps the shape of the message', () => {
    const raw =
      'SMTP login failed for jan.kowalski@ecobeton.pl via smtp://jan:Hunter2!@mail.example.com:587 ' +
      'password=Hunter2! api_key: sk-live-abcdef123456 Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload ' +
      'key AIzaSyA1234567890abcdef session 3f2b9c1e-7d4a-4b8e-9f00-1234567890ab';
    const masked = maskSensitive(raw);
    expect(masked).not.toContain('jan.kowalski');
    expect(masked).not.toContain('Hunter2');
    expect(masked).not.toContain('sk-live-abcdef123456');
    expect(masked).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(masked).not.toContain('AIzaSyA1234567890abcdef');
    expect(masked).not.toContain('3f2b9c1e-7d4a-4b8e-9f00-1234567890ab');
    expect(masked).toContain('SMTP login failed for ***@ecobeton.pl');
    expect(masked).toContain('mail.example.com:587');
  });

  it('caps the length', () => {
    expect(maskSensitive('x '.repeat(5000)).length).toBeLessThanOrEqual(1000);
  });

  it('masks every string in a payload and makes it JSON-safe', () => {
    const out = maskPayload({
      to: 'a.b@example.com',
      nested: { token: 'token=abc123secretvalue', at: new Date(Date.UTC(2026, 0, 1)) },
      id: 12n,
      list: ['ok', 'pwd=xyz'],
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toMatch(/a\.b@|abc123secretvalue|xyz/);
    expect(out.id).toBe('12');
    expect((out.nested as Record<string, unknown>).at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('describeError masks thrown values of any type', () => {
    expect(describeError(new TypeError('bad password=letmein')).name).toBe('TypeError');
    expect(describeError(new TypeError('bad password=letmein')).message).not.toContain('letmein');
    expect(describeError('plain secret=s3cr3t').message).not.toContain('s3cr3t');
    expect(describeError({ code: 42 }).message).toBe('{"code":42}');
  });
});

describe('raiseOpsEvent / resolveOpsEvent', () => {
  it('opens one incident per fingerprint and counts repeats', async () => {
    const ws = await seedWs('dedupe');
    const input = {
      scope: 'workspace' as const,
      workspaceId: ws,
      kind: 'tick.workspace_failed',
      severity: 'error' as const,
      source: 'autopilot.tick',
      dedupeKey: `autopilot.tick:ws=${ws}`,
      title: 'Autopilot failed for this workspace',
    };
    const first = await raiseOpsEvent({ ...input, error: new Error('first') }, new Date(1_000_000));
    const second = await raiseOpsEvent(
      { ...input, error: new Error('second') },
      new Date(2_000_000),
    );
    expect(first.opened).toBe(true);
    expect(second.opened).toBe(false);
    expect(second.id).toBe(first.id);
    expect(second.fingerprint).toBe(first.fingerprint);

    const rows = await db.select().from(opsEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrences).toBe(2);
    expect(rows[0]!.message).toBe('second');
    expect(rows[0]!.firstSeenAt.getTime()).toBe(1_000_000);
    expect(rows[0]!.lastSeenAt.getTime()).toBe(2_000_000);
    expect(rows[0]!.payload).toMatchObject({ errorName: 'Error' });
  });

  it('is atomic under concurrent raises', async () => {
    const input = {
      scope: 'platform' as const,
      kind: 'worker.error',
      severity: 'critical' as const,
      source: 'bullmq.worker',
      dedupeKey: 'bullmq.worker',
      title: 'Worker error',
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => raiseOpsEvent(input)));
    expect(results.filter((r) => r.opened)).toHaveLength(1);
    const rows = await db.select().from(opsEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrences).toBe(6);
  });

  it('resolves the open incident; the next failure opens a fresh one', async () => {
    const input = {
      scope: 'platform' as const,
      kind: 'tick.failed',
      severity: 'error' as const,
      source: 'outreach.drain.tick',
      dedupeKey: 'outreach.drain.tick',
      title: 'Send queue failed',
    };
    const raised = await raiseOpsEvent(input);
    expect(await listOpenOpsEventFingerprints('outreach.drain.tick')).toEqual(
      new Set([raised.fingerprint]),
    );
    expect(await resolveOpsEvent(raised.fingerprint)).toBe(true);
    expect(await resolveOpsEvent(raised.fingerprint)).toBe(false);
    expect(await listOpenOpsEventFingerprints('outreach.drain.tick')).toEqual(new Set());

    const again = await raiseOpsEvent(input);
    expect(again.opened).toBe(true);
    expect(again.id).not.toBe(raised.id);
    const rows = await db.select().from(opsEvents).orderBy(opsEvents.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.resolvedAt).not.toBeNull();
    expect(rows[0]!.resolution).toBe('auto');
    expect(rows[1]!.resolvedAt).toBeNull();
  });

  it('stores masked messages and payloads', async () => {
    await raiseOpsEvent({
      scope: 'platform',
      kind: 'job.failed',
      severity: 'error',
      source: 'connector.run',
      dedupeKey: 'connector.run',
      title: 'Discovery run failed for owner@tenant.pl',
      error: new Error('connect postgres://lead:topsecret@db:5432/lead failed'),
      payload: { recipient: 'someone@tenant.pl', note: 'password=abc' },
    });
    const [row] = await db.select().from(opsEvents);
    const stored = JSON.stringify({
      title: row!.title,
      message: row!.message,
      payload: row!.payload,
    });
    expect(stored).not.toContain('topsecret');
    expect(stored).not.toContain('someone@');
    expect(stored).not.toContain('owner@');
    expect(stored).not.toContain('password=abc');
  });

  it('fingerprints by scope, workspace, kind and dedupe key — not by message', async () => {
    const a = opsEventFingerprint({
      scope: 'workspace',
      workspaceId: 1n,
      kind: 'k',
      dedupeKey: 'd',
    });
    expect(
      opsEventFingerprint({ scope: 'workspace', workspaceId: 1n, kind: 'k', dedupeKey: 'd' }),
    ).toBe(a);
    expect(
      opsEventFingerprint({ scope: 'workspace', workspaceId: 2n, kind: 'k', dedupeKey: 'd' }),
    ).not.toBe(a);
    expect(
      opsEventFingerprint({ scope: 'workspace', workspaceId: 1n, kind: 'k2', dedupeKey: 'd' }),
    ).not.toBe(a);
    expect(opsEventFingerprint({ scope: 'platform', kind: 'k', dedupeKey: 'd' })).not.toBe(a);
  });

  it('validates scope against workspace id (Zod at the boundary, CHECK in the database)', async () => {
    await expect(
      raiseOpsEvent({
        scope: 'workspace',
        kind: 'k',
        severity: 'error',
        source: 's',
        dedupeKey: 'd',
        title: 't',
      }),
    ).rejects.toBeInstanceOf(OpsEventError);
    await expect(
      raiseOpsEvent({
        scope: 'platform',
        workspaceId: 1n,
        kind: 'k',
        severity: 'error',
        source: 's',
        dedupeKey: 'd',
        title: 't',
      }),
    ).rejects.toBeInstanceOf(OpsEventError);
    await expect(
      db.execute(
        sql`INSERT INTO ops_events (scope, kind, severity, source, dedupe_key, fingerprint, title) VALUES ('workspace', 'k', 'error', 's', 'd', 'f', 't')`,
      ),
    ).rejects.toThrow(/ops_events_scope_workspace_check/);
    await expect(
      db.execute(
        sql`INSERT INTO ops_events (scope, kind, severity, source, dedupe_key, fingerprint, title) VALUES ('platform', 'k', 'loud', 's', 'd', 'f', 't')`,
      ),
    ).rejects.toThrow(/ops_events_severity_check/);
  });

  it('counts open incidents by severity', async () => {
    await raiseOpsEvent({
      scope: 'platform',
      kind: 'a',
      severity: 'critical',
      source: 's',
      dedupeKey: '1',
      title: 't',
    });
    await raiseOpsEvent({
      scope: 'platform',
      kind: 'b',
      severity: 'error',
      source: 's',
      dedupeKey: '2',
      title: 't',
    });
    const resolved = await raiseOpsEvent({
      scope: 'platform',
      kind: 'c',
      severity: 'error',
      source: 's',
      dedupeKey: '3',
      title: 't',
    });
    await resolveOpsEvent(resolved.fingerprint);
    expect(await countOpenOpsEventsBySeverity()).toEqual({
      info: 0,
      warning: 0,
      error: 1,
      critical: 1,
    });
  });

  it('keeps resolved incidents for 90 days (retention constant for PC-35)', () => {
    expect(OPS_EVENTS_RETENTION_DAYS).toBe(90);
  });
});

// ---- BullMQ worker events --------------------------------------------------

function mockReporter() {
  return {
    raise: vi.fn(async (_input: RaiseOpsEventInput): Promise<unknown> => undefined),
    resolve: vi.fn(async (_fingerprint: string): Promise<unknown> => undefined),
  } satisfies WorkerEventReporter;
}

function fakeWorker(): EventEmitter & WorkerEventSource {
  return new EventEmitter() as EventEmitter & WorkerEventSource;
}

describe('attachWorkerEventReporting', () => {
  it("raises a platform 'job.failed' for a non-instrumented job, throttled per job name", async () => {
    const reporter = mockReporter();
    let clock = 0;
    const worker = fakeWorker();
    attachWorkerEventReporting(worker, {
      isInstrumented: () => false,
      reporter,
      throttleMs: 60_000,
      now: () => clock,
    });
    worker.emit('failed', { name: 'legacy.job', id: '7' }, new Error('no handler registered'));
    worker.emit('failed', { name: 'legacy.job', id: '8' }, new Error('again'));
    worker.emit('failed', { name: 'legacy.job', id: '9' }, new Error('again'));
    await settleDetached();
    expect(reporter.raise).toHaveBeenCalledTimes(1);
    expect(reporter.raise.mock.calls[0]![0]).toMatchObject({
      scope: 'platform',
      kind: 'job.failed',
      source: 'legacy.job',
      dedupeKey: 'legacy.job',
      occurrences: 1,
    });

    clock = 61_000;
    worker.emit('failed', { name: 'legacy.job', id: '10' }, new Error('later'));
    await settleDetached();
    expect(reporter.raise).toHaveBeenCalledTimes(2);
    // The two suppressed repeats are folded into this write.
    expect(reporter.raise.mock.calls[1]![0]).toMatchObject({ occurrences: 3 });
  });

  it('leaves failures of instrumented handlers to their wrapper', async () => {
    const reporter = mockReporter();
    const worker = fakeWorker();
    attachWorkerEventReporting(worker, { isInstrumented: (n) => n === 'autopilot.tick', reporter });
    worker.emit('failed', { name: 'autopilot.tick', id: '1' }, new Error('x'));
    await settleDetached();
    expect(reporter.raise).not.toHaveBeenCalled();
  });

  it("raises a critical 'worker.error' and resolves it on the next completed job", async () => {
    const reporter = mockReporter();
    const worker = fakeWorker();
    attachWorkerEventReporting(worker, { isInstrumented: (n) => n.endsWith('.tick'), reporter });
    worker.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    await settleDetached();
    expect(reporter.raise).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'worker.error', severity: 'critical', scope: 'platform' }),
    );

    worker.emit('completed', { name: 'outreach.drain.tick' });
    worker.emit('completed', { name: 'outreach.drain.tick' });
    await settleDetached();
    // Resolved once — a second completion does not write again.
    expect(
      reporter.resolve.mock.calls.filter((c) => c[0] === WORKER_ERROR_FINGERPRINT),
    ).toHaveLength(1);
    // Instrumented jobs resolve their own 'tick.failed'; no job.failed resolve for them.
    expect(
      reporter.resolve.mock.calls.some((c) => c[0] === jobFailedFingerprint('outreach.drain.tick')),
    ).toBe(false);
  });

  it('writes a real platform incident and resolves it on the next success (database)', async () => {
    const worker = fakeWorker();
    attachWorkerEventReporting(worker, { isInstrumented: () => false });
    worker.emit('failed', { name: 'legacy.job', id: '1' }, new Error('boom token=abcdef123'));
    await settleDetached();
    const open = await db
      .select()
      .from(opsEvents)
      .where(and(eq(opsEvents.kind, 'job.failed'), isNull(opsEvents.resolvedAt)));
    expect(open).toHaveLength(1);
    expect(open[0]!.scope).toBe('platform');
    expect(open[0]!.workspaceId).toBeNull();
    expect(open[0]!.message).not.toContain('abcdef123');

    worker.emit('completed', { name: 'legacy.job', id: '2' });
    await settleDetached();
    const [row] = await db.select().from(opsEvents).where(eq(opsEvents.id, open[0]!.id));
    expect(row!.resolvedAt).not.toBeNull();
    expect(row!.resolution).toBe('auto');
  });
});
