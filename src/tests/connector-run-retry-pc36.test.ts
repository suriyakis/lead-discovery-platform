// PC-36 (I065) acceptance (4): a retried connector.run whose row was
// reaped is skipped.
//
// BullMQ now retries connector.run (3 attempts, exponential backoff). A
// retry must never race the stuck-work reaper (PC-10): it executes the run
// only while the row is still 'pending', so a run that the first attempt
// claimed before it died — and that the reaper then failed — or a pending
// run the reaper failed as lost, is left exactly as the reaper left it.
// The retry completes normally (no throw), so BullMQ stops retrying.

import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Job, Processor } from 'bullmq';
import { db } from '@/lib/db/client';
import { connectorRuns, sourceRecords, type ConnectorRun } from '@/lib/db/schema/connectors';
import { registerConnector } from '@/lib/connectors/registry';
import type { ConnectorRunRequest, HarvesterEvent, ISourceConnector } from '@/lib/connectors/types';
import { InMemoryJobQueue, _setJobQueueForTests } from '@/lib/jobs';
import { BullMQJobQueue, type LaneQueue, type LaneWorker } from '@/lib/jobs/bullmq';
import { handleConnectorRun, type ConnectorRunJobPayload } from '@/lib/jobs/bootstrap';
import type { WorkspaceContext } from '@/lib/services/context';
import { createConnector } from '@/lib/services/connector-run';
import {
  RUN_PENDING_STUCK_AFTER_MS,
  RUN_STUCK_AFTER_MS,
  reapStuckRuns,
} from '@/lib/services/stuck-work';
import { truncateAll } from './helpers/db';
import {
  queueCtx as ctx,
  setupQueueWorkspace as setup,
  type QueueSetup as Setup,
} from './helpers/outreach-fixtures';

/** A connector that counts how often it is actually executed. */
const counting = { runs: 0 };
class CountingConnector implements ISourceConnector {
  readonly id = 'pc36-counting';
  readonly name = 'Counting (PC-36 test)';
  readonly type = 'directory_harvester' as const;
  readonly configSchema = z.object({}).passthrough();
  readonly credentialsSchema = z.object({});
  async testConnection() {
    return { ok: true };
  }
  async *run(_ctx: WorkspaceContext, request: ConnectorRunRequest): AsyncIterable<HarvesterEvent> {
    counting.runs += 1;
    yield {
      kind: 'record',
      record: {
        sourceId: `pc36-${request.runId}`,
        recordType: 'web_search_hit',
        raw: {},
        normalized: { title: 'PC-36', domain: 'pc36.test' },
      },
    };
    yield { kind: 'progress', current: 1, total: 1 };
  }
}
registerConnector(new CountingConnector());

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

beforeEach(async () => {
  await truncateAll();
  counting.runs = 0;
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function runRow(id: bigint): Promise<ConnectorRun> {
  const [r] = await db.select().from(connectorRuns).where(eq(connectorRuns.id, id));
  return r!;
}

async function recordsOf(runId: bigint) {
  return db.select().from(sourceRecords).where(eq(sourceRecords.runId, runId));
}

async function insertRun(s: Setup, set: Partial<ConnectorRun>): Promise<ConnectorRun> {
  const connector = await createConnector(ctx(s), {
    templateType: 'directory_harvester',
    name: 'Counting',
    config: {},
  });
  const [r] = await db
    .insert(connectorRuns)
    .values({ workspaceId: s.workspaceId, connectorId: connector.id, status: 'pending', ...set })
    .returning();
  return r!;
}

function payloadFor(s: Setup, run: ConnectorRun): ConnectorRunJobPayload {
  const c = ctx(s);
  return {
    runId: run.id.toString(),
    workspaceId: c.workspaceId.toString(),
    userId: c.userId,
    role: c.role,
  };
}

describe('a retried connector.run whose row was reaped is skipped (PC-36 acceptance 4)', () => {
  it('attempt 1 claimed the run and died; the reaper failed it; the retry changes nothing', async () => {
    const s = await setup();
    // What attempt 1 left behind: claimed ('running'), then no progress.
    const run = await insertRun(s, {
      status: 'running',
      startedAt: minutesAgo(RUN_STUCK_AFTER_MS / 60_000 + 5),
      lastProgressAt: minutesAgo(RUN_STUCK_AFTER_MS / 60_000 + 5),
    });
    const reaped = await reapStuckRuns(ctx(s));
    expect(reaped.failed).toEqual([run.id]);
    const before = await runRow(run.id);
    expect(before.status).toBe('failed');

    // BullMQ's retry (attempt 2) runs the registered handler.
    const result = await handleConnectorRun(payloadFor(s, run), { jobId: 'runs:1', attempt: 2 });

    expect(result).toMatchObject({ status: 'skipped', currentStatus: 'failed' });
    expect(counting.runs).toBe(0);
    const after = await runRow(run.id);
    expect(after.status).toBe('failed');
    expect(after.errorPayload).toEqual(before.errorPayload);
    expect(after.completedAt?.getTime()).toBe(before.completedAt?.getTime());
    expect(await recordsOf(run.id)).toEqual([]);
  });

  it('a pending run the reaper failed as lost is not started late by a retry', async () => {
    const s = await setup();
    const run = await insertRun(s, {
      status: 'pending',
      createdAt: minutesAgo(RUN_PENDING_STUCK_AFTER_MS / 60_000 + 5),
    });
    // Its job is in no queue: the reaper fails it as never started.
    _setJobQueueForTests(new InMemoryJobQueue());
    try {
      expect((await reapStuckRuns(ctx(s))).failed).toEqual([run.id]);
    } finally {
      _setJobQueueForTests(null);
    }

    const result = await handleConnectorRun(payloadFor(s, run), { jobId: 'runs:2', attempt: 3 });
    expect(result).toMatchObject({ status: 'skipped', currentStatus: 'failed' });
    expect(counting.runs).toBe(0);
    expect((await runRow(run.id)).errorPayload).toMatchObject({ reason: 'never_started' });
  });

  it('through the BullMQ worker: the retry completes (no throw), so BullMQ stops retrying', async () => {
    const s = await setup();
    const run = await insertRun(s, {
      status: 'running',
      startedAt: minutesAgo(30),
      lastProgressAt: minutesAgo(30),
    });
    await reapStuckRuns(ctx(s));

    let processor: Processor | null = null;
    const q = new BullMQJobQueue({
      env: {},
      factories: {
        queue: () => ({}) as unknown as LaneQueue,
        worker: (_name, p) => {
          processor = p;
          return Object.assign(new EventEmitter(), { close: async () => {} }) as LaneWorker;
        },
      },
    });
    q.on('connector.run', handleConnectorRun);
    const job = { name: 'connector.run', id: '5', attemptsMade: 1, data: payloadFor(s, run) };
    await expect(processor!(job as unknown as Job)).resolves.toMatchObject({
      status: 'skipped',
      currentStatus: 'failed',
    });
    expect(counting.runs).toBe(0);
  });

  it('a retry still runs a run that never started (the reason retries exist)', async () => {
    const s = await setup();
    const run = await insertRun(s, { status: 'pending' });
    const result = await handleConnectorRun(payloadFor(s, run), { jobId: 'runs:3', attempt: 2 });
    expect(result).toMatchObject({ status: 'succeeded', recordCount: 1 });
    expect(counting.runs).toBe(1);
    expect((await runRow(run.id)).status).toBe('succeeded');
  });

  it('a missing row or a foreign workspace is not retried', async () => {
    const s = await setup();
    const run = await insertRun(s, { status: 'pending' });
    const missing = { ...payloadFor(s, run), runId: '999999' };
    await expect(handleConnectorRun(missing, { jobId: 'runs:4' })).rejects.toMatchObject({
      name: 'NonRetryableJobError',
    });
    const foreign = { ...payloadFor(s, run), workspaceId: (s.workspaceId + 1000n).toString() };
    await expect(handleConnectorRun(foreign, { jobId: 'runs:5' })).rejects.toMatchObject({
      name: 'NonRetryableJobError',
    });
    expect((await runRow(run.id)).status).toBe('pending');
  });
});
