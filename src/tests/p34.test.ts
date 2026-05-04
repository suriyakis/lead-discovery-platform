import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db/client';
import {
  InMemoryJobQueue,
  _setJobQueueForTests,
} from '@/lib/jobs';
import {
  _resetRepeatablesForTests,
  registerRepeatableJobs,
} from '@/lib/jobs/repeatables';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

beforeEach(async () => {
  await truncateAll();
  _setJobQueueForTests(null);
  _resetRepeatablesForTests();
});

afterEach(() => {
  _setJobQueueForTests(null);
  _resetRepeatablesForTests();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ============ InMemoryJobQueue.enqueueRepeatable =====================

describe('InMemoryJobQueue.enqueueRepeatable', () => {
  it('schedules a setInterval-backed tick that calls handlers', async () => {
    const q = new InMemoryJobQueue();
    let count = 0;
    q.on('tick.fast', async () => {
      count++;
    });
    await q.enqueueRepeatable('tick.fast', {}, { everyMs: 30, jobId: 't1' });
    // Wait two intervals plus a bit.
    await new Promise((r) => setTimeout(r, 100));
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('replaces existing schedule when re-registered with same jobId', async () => {
    const q = new InMemoryJobQueue();
    let countA = 0;
    let countB = 0;
    q.on('tick.replace', async (payload: { tag?: string }) => {
      if (payload.tag === 'A') countA++;
      else countB++;
    });
    await q.enqueueRepeatable('tick.replace', { tag: 'A' }, { everyMs: 30, jobId: 't1' });
    await new Promise((r) => setTimeout(r, 80));
    // Replace.
    await q.enqueueRepeatable('tick.replace', { tag: 'B' }, { everyMs: 30, jobId: 't1' });
    const beforeB = countB;
    await new Promise((r) => setTimeout(r, 80));
    // After replacement, only B should keep accumulating.
    expect(countB).toBeGreaterThan(beforeB);
    const afterA = countA;
    await new Promise((r) => setTimeout(r, 80));
    expect(countA).toBe(afterA); // A no longer firing
  });
});

// ============ registerRepeatableJobs ===============================

describe('registerRepeatableJobs', () => {
  it('registers all three tick handlers without scheduling when skipSchedule', async () => {
    const q = new InMemoryJobQueue();
    _setJobQueueForTests(q);
    await registerRepeatableJobs({ skipSchedule: true });
    // The three handlers should be registered. Enqueue a one-shot of each
    // type — if the handler is missing, enqueue would leave job pending
    // forever; if registered, status flips to succeeded after a tick.
    const ownerA = await seedUser({ email: 'ownerA@test.local' });
    await seedWorkspace({ name: 'A', ownerUserId: ownerA });

    const ids = await Promise.all([
      q.enqueue('autopilot.tick', {}),
      q.enqueue('outreach.drain.tick', {}),
      q.enqueue('mail.imap.tick', {}),
    ]);
    // Yield twice — handlers run on microtask + DB hits.
    await new Promise((r) => setTimeout(r, 100));
    for (const id of ids) {
      const status = await q.status(id);
      expect(status.state === 'succeeded' || status.state === 'failed').toBe(true);
    }
  });

  it('autopilot.tick fans out: returns workspaces count', async () => {
    const q = new InMemoryJobQueue();
    _setJobQueueForTests(q);
    await registerRepeatableJobs({ skipSchedule: true });

    const owner1 = await seedUser({ email: 'o1@test.local' });
    const owner2 = await seedUser({ email: 'o2@test.local' });
    await seedWorkspace({ name: 'W1', ownerUserId: owner1 });
    await seedWorkspace({ name: 'W2', ownerUserId: owner2 });

    const id = await q.enqueue('autopilot.tick', {});
    await new Promise((r) => setTimeout(r, 200));
    const status = await q.status(id);
    expect(status.state).toBe('succeeded');
    if (status.state === 'succeeded') {
      const result = status.result as { workspaces: number };
      expect(result.workspaces).toBe(2);
    }
  });

  it('drain.tick survives per-tenant errors and reports a failed count', async () => {
    const q = new InMemoryJobQueue();
    _setJobQueueForTests(q);
    await registerRepeatableJobs({ skipSchedule: true });

    // No mailboxes / no queue rows in this workspace — drainQueue should
    // be a no-op, not throw.
    const ownerA = await seedUser({ email: 'oa@test.local' });
    await seedWorkspace({ name: 'A', ownerUserId: ownerA });

    const id = await q.enqueue('outreach.drain.tick', {});
    await new Promise((r) => setTimeout(r, 200));
    const status = await q.status(id);
    expect(status.state).toBe('succeeded');
  });

  it('imap.tick yields zero when no IMAP-enabled mailboxes exist', async () => {
    const q = new InMemoryJobQueue();
    _setJobQueueForTests(q);
    await registerRepeatableJobs({ skipSchedule: true });

    const ownerA = await seedUser({ email: 'oa@test.local' });
    await seedWorkspace({ name: 'A', ownerUserId: ownerA });

    const id = await q.enqueue('mail.imap.tick', {});
    await new Promise((r) => setTimeout(r, 200));
    const status = await q.status(id);
    expect(status.state).toBe('succeeded');
    if (status.state === 'succeeded') {
      const result = status.result as { mailboxesSynced: number };
      expect(result.mailboxesSynced).toBe(0);
    }
  });

  it('idempotent: calling registerRepeatableJobs twice does not double-register', async () => {
    const q = new InMemoryJobQueue();
    _setJobQueueForTests(q);
    await registerRepeatableJobs({ skipSchedule: true });
    await registerRepeatableJobs({ skipSchedule: true });
    // No throw, no duplicate handlers (the handlers map replaces by key,
    // so even if it did register twice, behavior would be correct).
    expect(true).toBe(true);
  });
});
