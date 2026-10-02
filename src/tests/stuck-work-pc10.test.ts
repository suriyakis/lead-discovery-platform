// PC-10 — the stuck-work reaper, honest run status and cross-process
// Cancel (I013, I074).
//
//   (1) a stuck 'sending' row with a sent copy of its draft becomes sent;
//       one with only a failed copy becomes failed + an incident;
//   (5) a run where every query failed ends 'failed' and notifies (some
//       failed: 'partial');
//   (6) cancel_requested_at written by a SEPARATE database connection stops
//       a running fake connector within one query, status 'cancelled';
//   (7) a run with no progress is failed by the reaper.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import postgres from 'postgres';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import {
  connectorRunLogs,
  connectorRuns,
  sourceRecords,
  type ConnectorRun,
} from '@/lib/db/schema/connectors';
import { mailMessages } from '@/lib/db/schema/mailing';
import { jobHeartbeats, opsEvents } from '@/lib/db/schema/ops';
import { notifications } from '@/lib/db/schema/notifications';
import { outreachQueue } from '@/lib/db/schema/outreach';
import { registerConnector } from '@/lib/connectors/registry';
import { runConnectorRun } from '@/lib/connectors/runner';
import type { ConnectorRunRequest, HarvesterEvent, ISourceConnector } from '@/lib/connectors/types';
import { InMemoryJobQueue, _setJobQueueForTests, getJobQueue } from '@/lib/jobs';
import { _resetRepeatablesForTests, registerRepeatableJobs } from '@/lib/jobs/repeatables';
import {
  MockSearchProvider,
  _setSearchProviderForTests,
  type SearchOptions,
  type SearchOutcome,
} from '@/lib/search';
import type { WorkspaceContext } from '@/lib/services/context';
import {
  ConnectorServiceError,
  awaitRun,
  createConnector,
  createRecipe,
  requestRunCancel,
  startRun,
} from '@/lib/services/connector-run';
import { drainQueue } from '@/lib/services/outreach-queue';
import {
  INTERRUPTED_SEND_REASON,
  RUN_PENDING_STUCK_AFTER_MS,
  RUN_STUCK_AFTER_MS,
  SEND_STUCK_AFTER_MS,
  reapStuckRuns,
  reapStuckSends,
} from '@/lib/services/stuck-work';
import { truncateAll } from './helpers/db';
import {
  FlakyProvider,
  greylisted,
  outboundCopy,
  queueCtx as ctx,
  queuedDraft,
  setupQueueWorkspace as setup,
  withFailingTrigger,
  type QueueSetup as Setup,
} from './helpers/outreach-fixtures';

// ---- a slow fake connector (one "query" per step) ------------------------

const fake = {
  queriesStarted: 0,
  total: 40,
  delayMs: 40,
  /** Runs after each query's wait, before its record is yielded. */
  afterQuery: null as null | ((n: number) => Promise<void>),
};

class SlowConnector implements ISourceConnector {
  readonly id = 'pc10-slow';
  readonly name = 'Slow (PC-10 test)';
  readonly type = 'directory_harvester' as const;
  readonly configSchema = z.object({}).passthrough();
  readonly credentialsSchema = z.object({});
  async testConnection() {
    return { ok: true };
  }
  async *run(_ctx: WorkspaceContext, request: ConnectorRunRequest): AsyncIterable<HarvesterEvent> {
    for (let i = 0; i < fake.total; i++) {
      if (request.signal?.aborted) {
        yield { kind: 'log', level: 'warn', message: 'slow: aborted by caller' };
        return;
      }
      fake.queriesStarted += 1;
      await new Promise((resolve) => setTimeout(resolve, fake.delayMs));
      if (fake.afterQuery) await fake.afterQuery(i + 1);
      yield {
        kind: 'record',
        record: {
          sourceId: `slow-${request.runId}-${i}`,
          recordType: 'web_search_hit',
          raw: {},
          normalized: { title: `Slow ${i}`, domain: `slow-${i}.test` },
        },
      };
      yield { kind: 'progress', current: i + 1, total: fake.total };
    }
  }
}
registerConnector(new SlowConnector());

/** Search that fails for the queries `failing` picks (429-style). */
class FlakySearch extends MockSearchProvider {
  constructor(private readonly failing: (query: string) => boolean) {
    super();
  }
  async search(
    c: WorkspaceContext,
    query: string,
    options?: SearchOptions,
  ): Promise<SearchOutcome> {
    if (this.failing(query)) {
      throw Object.assign(new Error('429 Too Many Requests'), { code: 'rate_limited' });
    }
    return super.search(c, query, options);
  }
}

// A second connection, as another process would have.
const other = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runRow(id: bigint): Promise<ConnectorRun> {
  const [r] = await db.select().from(connectorRuns).where(eq(connectorRuns.id, id));
  return r!;
}

async function queueRow(id: bigint) {
  const [r] = await db.select().from(outreachQueue).where(eq(outreachQueue.id, id));
  return r!;
}

async function openEvents(kind: string) {
  return db
    .select()
    .from(opsEvents)
    .where(and(eq(opsEvents.kind, kind), isNull(opsEvents.resolvedAt)));
}

async function slowConnector(s: Setup) {
  return createConnector(ctx(s), { templateType: 'directory_harvester', name: 'Slow', config: {} });
}

/** A run row in a given state, as a crashed worker would leave it. */
async function strandedRun(
  s: Setup,
  connectorId: bigint,
  set: Partial<
    Pick<
      ConnectorRun,
      'status' | 'lastProgressAt' | 'cancelRequestedAt' | 'createdAt' | 'startedAt'
    >
  >,
) {
  const [r] = await db
    .insert(connectorRuns)
    .values({ workspaceId: s.workspaceId, connectorId, status: 'running', ...set })
    .returning();
  return r!;
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

beforeEach(async () => {
  await truncateAll();
  fake.queriesStarted = 0;
  fake.total = 40;
  fake.delayMs = 40;
  fake.afterQuery = null;
  _setSearchProviderForTests(null);
});

afterEach(async () => {
  // Let an in-process run that a test left behind finish before truncate.
  await getJobQueue().drain?.();
  _setSearchProviderForTests(null);
});

afterAll(async () => {
  await other.end();
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- (1) stuck sends ------------------------------------------------------

describe('stuck sends (I013)', () => {
  it('(1) a stuck row with a sent copy of its draft becomes sent', async () => {
    const s = await setup();
    const { entry, draft } = await queuedDraft(s, 'anna@target.com');
    await db
      .update(outreachQueue)
      .set({ status: 'sending', claimedAt: minutesAgo(11), attemptCount: 1 })
      .where(eq(outreachQueue.id, entry.id));
    const copy = await outboundCopy(s, {
      to: 'anna@target.com',
      status: 'sent',
      sourceDraftId: draft.id,
    });

    const r = await reapStuckSends(ctx(s));
    expect(r).toEqual({ settledSent: [entry.id], failed: [] });
    const q = await queueRow(entry.id);
    expect(q.status).toBe('sent');
    expect(q.sentMessageId).toBe(copy.id);
    expect(q.lastError).toMatch(/^Recovered by the stuck-send check/);
    expect(await openEvents('send.interrupted')).toHaveLength(0);

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.kind, 'outreach.queue.reaped'));
    expect(audit!.userId).toBeNull();
    expect(audit!.workspaceId).toBe(s.workspaceId);
    expect(audit!.payload).toMatchObject({ outcome: 'sent', actor: 'system' });
  });

  it('(1) one with only a failed copy becomes failed, "delivery unknown", with one incident', async () => {
    const s = await setup();
    const { entry, draft } = await queuedDraft(s, 'anna@target.com');
    await db
      .update(outreachQueue)
      .set({ status: 'sending', claimedAt: minutesAgo(11), attemptCount: 1 })
      .where(eq(outreachQueue.id, entry.id));
    await outboundCopy(s, { to: 'anna@target.com', status: 'failed', sourceDraftId: draft.id });

    const r = await reapStuckSends(ctx(s));
    expect(r).toEqual({ settledSent: [], failed: [entry.id] });
    const q = await queueRow(entry.id);
    expect(q.status).toBe('failed');
    expect(q.lastFailureKind).toBe('interrupted');
    expect(q.lastError!.startsWith(INTERRUPTED_SEND_REASON)).toBe(true);

    const events = await openEvents('send.interrupted');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      scope: 'workspace',
      workspaceId: s.workspaceId,
      severity: 'error',
      source: 'ops.reaper.tick',
    });
    expect(events[0]!.payload).toMatchObject({ queueEntryId: entry.id.toString() });

    // A second pass finds nothing left to do.
    expect(await reapStuckSends(ctx(s))).toEqual({ settledSent: [], failed: [] });
    expect(await openEvents('send.interrupted')).toHaveLength(1);
  });

  it('leaves a recent claim alone; a copy from before the claim or of another draft does not count; a pre-PC-10 claim is dated by updated_at', async () => {
    const s = await setup();
    const recent = await queuedDraft(s, 'a@one.com');
    await db
      .update(outreachQueue)
      .set({ status: 'sending', claimedAt: minutesAgo(SEND_STUCK_AFTER_MS / 60_000 - 5) })
      .where(eq(outreachQueue.id, recent.entry.id));

    const earlier = await queuedDraft(s, 'b@two.com');
    await db
      .update(outreachQueue)
      .set({ status: 'sending', claimedAt: minutesAgo(11) })
      .where(eq(outreachQueue.id, earlier.entry.id));
    await outboundCopy(s, {
      to: 'b@two.com',
      status: 'sent',
      sourceDraftId: earlier.draft.id,
      createdAt: minutesAgo(30),
    });
    await outboundCopy(s, { to: 'b@two.com', status: 'sent', sourceDraftId: recent.draft.id });

    const legacy = await queuedDraft(s, 'c@three.com');
    await db
      .update(outreachQueue)
      .set({ status: 'sending', claimedAt: null, updatedAt: minutesAgo(20) })
      .where(eq(outreachQueue.id, legacy.entry.id));

    const r = await reapStuckSends(ctx(s));
    expect(r.settledSent).toEqual([]);
    expect(r.failed.sort()).toEqual([earlier.entry.id, legacy.entry.id].sort());
    expect((await queueRow(recent.entry.id)).status).toBe('sending');
  });

  it('a delivered send whose queue update failed is recorded anyway and settled sent by the reaper', async () => {
    const s = await setup();
    const { entry } = await queuedDraft(s, 'anna@target.com');
    const provider = new FlakyProvider(greylisted, 0);

    await withFailingTrigger(
      'pc10_fail_queue_sent',
      'outreach_queue',
      'BEFORE UPDATE',
      "NEW.status = 'sent'",
      async () => {
        const r = await drainQueue(ctx(s), { providerOverride: provider });
        expect(r.sent).toBe(1);
      },
    );
    expect(provider.calls).toBe(1);
    // The hook's transaction rolled back; the message was recorded alone.
    let q = await queueRow(entry.id);
    expect(q.status).toBe('sending');
    const sentCopies = await db
      .select()
      .from(mailMessages)
      .where(and(eq(mailMessages.workspaceId, s.workspaceId), eq(mailMessages.status, 'sent')));
    expect(sentCopies).toHaveLength(1);
    expect(sentCopies[0]!.sourceDraftId).toBe(entry.draftId);

    // 10 minutes later the reaper finds the sent copy.
    await db
      .update(outreachQueue)
      .set({ claimedAt: minutesAgo(11) })
      .where(eq(outreachQueue.id, entry.id));
    const r = await reapStuckSends(ctx(s));
    expect(r.settledSent).toEqual([entry.id]);
    q = await queueRow(entry.id);
    expect(q.status).toBe('sent');
    expect(q.sentMessageId).toBe(sentCopies[0]!.id);
  });
});

// ---- (5) honest run status -----------------------------------------------

async function searchRun(s: Setup, queries: string[]) {
  const c = await createConnector(ctx(s), {
    templateType: 'internet_search',
    name: 'IS',
    config: {},
  });
  const recipe = await createRecipe(ctx(s), {
    connectorId: c.id,
    name: 'r',
    selectors: { searchQueries: queries },
  });
  return { connector: c, recipe };
}

describe('honest run status (I074)', () => {
  it('[handbook H-33] every query failing ends the run failed and notifies; some failing ends it partial and resolves the incident', async () => {
    const s = await setup();
    const { connector, recipe } = await searchRun(s, ['concrete repair', 'floor coating']);

    _setSearchProviderForTests(new FlakySearch(() => true));
    const failed = await startRun(ctx(s), {
      connectorId: connector.id,
      recipeId: recipe.id,
      wait: true,
    });
    expect(failed.result!.status).toBe('failed');
    expect(failed.result!.recordCount).toBe(0);
    const failedRun = await runRow(failed.run.id);
    expect(failedRun.status).toBe('failed');
    expect((failedRun.errorPayload as { message: string }).message).toBe(
      'all 2 search queries failed (first: rate_limited: 429 Too Many Requests)',
    );
    const notes = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.workspaceId, s.workspaceId), eq(notifications.kind, 'run.failed')),
      );
    expect(notes).toHaveLength(1);
    expect(notes[0]!.href).toBe(`/connectors/${connector.id}/runs/${failed.run.id}`);
    expect(await openEvents('run.failed')).toHaveLength(1);

    _setSearchProviderForTests(new FlakySearch((q) => q === 'concrete repair'));
    const partial = await startRun(ctx(s), {
      connectorId: connector.id,
      recipeId: recipe.id,
      wait: true,
    });
    expect(partial.result!.status).toBe('partial');
    const partialRun = await runRow(partial.run.id);
    expect(partialRun.status).toBe('partial');
    expect(partialRun.recordCount).toBeGreaterThan(0);
    expect(partialRun.errorPayload).toMatchObject({ payload: { partial: true, failedSteps: 1 } });
    // The recipe works again (partly): its failure incident is resolved.
    expect(await openEvents('run.failed')).toHaveLength(0);

    _setSearchProviderForTests(new FlakySearch(() => false));
    const ok = await startRun(ctx(s), {
      connectorId: connector.id,
      recipeId: recipe.id,
      wait: true,
    });
    expect(ok.result!.status).toBe('succeeded');
  });

  it('a recipe with one query that fails is failed, not partial', async () => {
    const s = await setup();
    const { connector, recipe } = await searchRun(s, ['only one']);
    _setSearchProviderForTests(new FlakySearch(() => true));
    const r = await startRun(ctx(s), {
      connectorId: connector.id,
      recipeId: recipe.id,
      wait: true,
    });
    expect(r.result!.status).toBe('failed');
    expect(r.result!.error!.message).toMatch(/^all 1 search query failed/);
  });
});

// ---- (6) cross-process Cancel --------------------------------------------

describe('Cancel works across processes (I074)', () => {
  it('(6) cancel_requested_at set by a separate connection stops a running connector within one query', async () => {
    const s = await setup();
    const c = await slowConnector(s);
    const { run } = await startRun(ctx(s), { connectorId: c.id });

    await waitFor(() => fake.queriesStarted >= 2);
    await other`UPDATE connector_runs SET cancel_requested_at = now() WHERE id = ${run.id.toString()}`;
    const startedAtCancel = fake.queriesStarted;

    const result = await awaitRun(ctx(s), run.id, { timeoutMs: 10_000 });
    expect(result.status).toBe('cancelled');
    await getJobQueue().drain?.();
    // At most the query in flight when the flag was set ran to its end.
    expect(fake.queriesStarted).toBeLessThanOrEqual(startedAtCancel + 1);
    expect(fake.queriesStarted).toBeLessThan(fake.total);

    const finished = await runRow(run.id);
    expect(finished.status).toBe('cancelled');
    expect(finished.completedAt).not.toBeNull();
    const records = await db.select().from(sourceRecords).where(eq(sourceRecords.runId, run.id));
    expect(records.length).toBe(finished.recordCount);
    expect(records.length).toBeGreaterThan(0); // what it found is kept
    const logs = await db.select().from(connectorRunLogs).where(eq(connectorRunLogs.runId, run.id));
    expect(logs.some((l) => l.message.startsWith('Cancelled on request'))).toBe(true);
  });

  it('the Cancel service: a member cancels a running run; a pending one is cancelled at once and never starts', async () => {
    const s = await setup();
    const c = await slowConnector(s);
    const { run } = await startRun(ctx(s), { connectorId: c.id });
    await waitFor(() => fake.queriesStarted >= 1);

    const asked = await requestRunCancel(ctx(s, 'member'), run.id);
    expect(asked.immediate).toBe(false);
    expect(asked.run.cancelRequestedAt).not.toBeNull();
    expect((await awaitRun(ctx(s), run.id, { timeoutMs: 10_000 })).status).toBe('cancelled');
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.kind, 'connector_run.cancel'));
    expect(audit!.userId).toBe(s.memberId);

    // Pending (no worker has it yet): cancelled immediately.
    const pending = await strandedRun(s, c.id, { status: 'pending' });
    const now = await requestRunCancel(ctx(s), pending.id);
    expect(now.immediate).toBe(true);
    expect(now.run.status).toBe('cancelled');
    // A late job for it does nothing.
    const before = fake.queriesStarted;
    const late = await runConnectorRun(ctx(s), pending.id);
    expect(late).toMatchObject({ status: 'skipped', currentStatus: 'cancelled' });
    expect(fake.queriesStarted).toBe(before);

    // Finished runs and viewers are refused.
    await expect(requestRunCancel(ctx(s), pending.id)).rejects.toMatchObject({ code: 'conflict' });
    const running = await strandedRun(s, c.id, { status: 'running', lastProgressAt: new Date() });
    await expect(requestRunCancel(ctx(s, 'viewer'), running.id)).rejects.toBeInstanceOf(
      ConnectorServiceError,
    );
    expect((await runRow(running.id)).cancelRequestedAt).toBeNull();
  });
});

// ---- (7) stuck runs --------------------------------------------------------

describe('stuck runs (I013, I074)', () => {
  it('(7) a running run without progress for 15 minutes is failed, notified and raised; recent ones stay', async () => {
    const s = await setup();
    const c = await slowConnector(s);
    const stuck = await strandedRun(s, c.id, {
      startedAt: minutesAgo(40),
      lastProgressAt: minutesAgo(RUN_STUCK_AFTER_MS / 60_000 + 1),
    });
    const busy = await strandedRun(s, c.id, {
      startedAt: minutesAgo(40),
      lastProgressAt: minutesAgo(5),
    });

    const r = await reapStuckRuns(ctx(s));
    expect(r).toEqual({ failed: [stuck.id], cancelled: [] });

    const failed = await runRow(stuck.id);
    expect(failed.status).toBe('failed');
    expect(failed.completedAt).not.toBeNull();
    expect(failed.errorPayload).toMatchObject({ reason: 'no_progress' });
    expect((failed.errorPayload as { message: string }).message).toMatch(
      /^Stopped: no progress for 15 minutes/,
    );
    expect((await runRow(busy.id)).status).toBe('running');

    const logs = await db
      .select()
      .from(connectorRunLogs)
      .where(eq(connectorRunLogs.runId, stuck.id));
    expect(logs.map((l) => l.level)).toEqual(['error']);
    const notes = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.workspaceId, s.workspaceId), eq(notifications.kind, 'run.failed')),
      );
    expect(notes.length).toBeGreaterThanOrEqual(1);
    const events = await openEvents('run.stuck');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ severity: 'error', workspaceId: s.workspaceId });
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.kind, 'connector_run.reaped'));
    expect(audit!.userId).toBeNull();
  });

  it('a pending run that never started is failed after an hour; an unanswered cancel ends cancelled', async () => {
    const s = await setup();
    const c = await slowConnector(s);
    const lost = await strandedRun(s, c.id, {
      status: 'pending',
      createdAt: minutesAgo(RUN_PENDING_STUCK_AFTER_MS / 60_000 + 1),
    });
    const waiting = await strandedRun(s, c.id, { status: 'pending', createdAt: minutesAgo(30) });
    const unanswered = await strandedRun(s, c.id, {
      lastProgressAt: minutesAgo(3),
      cancelRequestedAt: minutesAgo(3),
    });
    const answering = await strandedRun(s, c.id, {
      lastProgressAt: minutesAgo(1),
      cancelRequestedAt: minutesAgo(1),
    });

    const r = await reapStuckRuns(ctx(s));
    expect(r).toEqual({ failed: [lost.id], cancelled: [unanswered.id] });
    expect((await runRow(lost.id)).errorPayload).toMatchObject({ reason: 'never_started' });
    expect((await runRow(unanswered.id)).status).toBe('cancelled');
    expect((await runRow(waiting.id)).status).toBe('pending');
    expect((await runRow(answering.id)).status).toBe('running');
  });

  it('a runner that finds its run reaped stops and keeps the reaper’s outcome', async () => {
    const s = await setup();
    const c = await slowConnector(s);
    let runId: bigint | null = null;
    fake.afterQuery = async (n) => {
      // Mid-run, "the reaper" (another process) fails it.
      if (n === 2 && runId !== null) {
        await other`UPDATE connector_runs SET status = 'failed', completed_at = now() WHERE id = ${runId.toString()}`;
      }
    };
    const { run } = await startRun(ctx(s), { connectorId: c.id });
    runId = run.id;
    await waitFor(async () => (await runRow(run.id)).status === 'failed');
    await getJobQueue().drain?.();

    expect(fake.queriesStarted).toBeLessThanOrEqual(3);
    expect((await runRow(run.id)).status).toBe('failed');
    const logs = await db.select().from(connectorRunLogs).where(eq(connectorRunLogs.runId, run.id));
    expect(logs.some((l) => l.message.startsWith('The run was already marked failed'))).toBe(true);
  });
});

// ---- the tick ---------------------------------------------------------------

describe('ops.reaper.tick', () => {
  it('reaps every active workspace and records its heartbeat', async () => {
    const s = await setup();
    const { entry } = await queuedDraft(s, 'anna@target.com');
    await db
      .update(outreachQueue)
      .set({ status: 'sending', claimedAt: minutesAgo(11) })
      .where(eq(outreachQueue.id, entry.id));
    const c = await slowConnector(s);
    await strandedRun(s, c.id, { lastProgressAt: minutesAgo(20) });

    const q = new InMemoryJobQueue();
    _setJobQueueForTests(q);
    _resetRepeatablesForTests();
    try {
      await registerRepeatableJobs({ skipSchedule: true });
      const id = await q.enqueue('ops.reaper.tick', {});
      await q.drain();
      const status = await q.status(id);
      expect(status.state).toBe('succeeded');
      expect((status as { result: unknown }).result).toMatchObject({
        workspaces: 1,
        sendsFailed: 1,
        runsFailed: 1,
        workspacesFailed: 0,
      });
      const [beat] = await db
        .select()
        .from(jobHeartbeats)
        .where(eq(jobHeartbeats.name, 'ops.reaper.tick'));
      expect(beat!.lastStatus).toBe('ok');
    } finally {
      _setJobQueueForTests(null);
      _resetRepeatablesForTests();
    }
  });
});
