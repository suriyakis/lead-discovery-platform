// PC-07 acceptance (2): for each of the 8 repeatable ticks, a per-workspace
// error creates exactly one open ops_event per fingerprint with its
// occurrences counted, and the workspace's next success resolves it.
//
// The per-workspace service each tick calls is replaced by a stub that
// throws for the workspaces a test flags (health.check fails through its
// token wallet read, inside the real processDueHealthChecks). Everything
// else — the tick handlers, instrumented(), ops_events, job_heartbeats —
// runs for real against the test database through the in-memory queue.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { jobHeartbeats, opsEvents } from '@/lib/db/schema/ops';
import { workspaces } from '@/lib/db/schema/workspaces';
import { InMemoryJobQueue, _setJobQueueForTests } from '@/lib/jobs';
import { _resetRepeatablesForTests, registerRepeatableJobs } from '@/lib/jobs/repeatables';
import { createMailbox } from '@/lib/services/mailbox';
import { makeWorkspaceContext } from '@/lib/services/context';
import { tickSubjectFingerprint } from '@/lib/ops/tick-incidents';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

const ctl = vi.hoisted(() => ({
  /** `${step}:${workspaceId}` or `sync:${mailboxId}` → throw. */
  failing: new Set<string>(),
  /** workspaceId → failed cluster merges the compaction pass reports. */
  clusterFailures: new Map<string, number>(),
}));

function boom(step: string, id: bigint | string): Error {
  return new Error(`${step} crashed for ${id}: password=s3cr3t-value owner@tenant.example`);
}

function check(step: string, id: bigint | string): void {
  if (ctl.failing.has(`${step}:${id}`)) throw boom(step, id);
}

vi.mock('@/lib/services/autopilot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/autopilot')>()),
  runOnce: vi.fn(async (ctx: { workspaceId: bigint }) => {
    check('autopilot', ctx.workspaceId);
    return { runId: 'r', ranAt: new Date(), steps: [] };
  }),
}));
vi.mock('@/lib/services/outreach-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/outreach-queue')>()),
  drainQueue: vi.fn(async (ctx: { workspaceId: bigint }) => {
    check('drain', ctx.workspaceId);
    return { picked: 0, sent: 0, failed: 0, skipped: 0 };
  }),
}));
vi.mock('@/lib/services/mailbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/mailbox')>()),
  adoptUntrackedFailingMailboxes: vi.fn(async (ctx: { workspaceId: bigint }) => {
    check('adopt', ctx.workspaceId);
    return 0;
  }),
}));
vi.mock('@/lib/services/mail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/mail')>()),
  safeSyncOne: vi.fn(async (_ctx: unknown, mb: { id: bigint }) => {
    check('sync', mb.id);
    return { kind: 'synced', recovered: false };
  }),
  purgeOldTrashUnattended: vi.fn(async (workspaceId: bigint) => {
    check('purge', workspaceId);
    return { deleted: 0, retentionDays: 30 };
  }),
}));
vi.mock('@/lib/services/follow-up', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/follow-up')>()),
  processDueFollowUps: vi.fn(async (ctx: { workspaceId: bigint }) => {
    check('follow_up', ctx.workspaceId);
    return { checked: 0, sent: 0, skipped: 0, failed: 0 };
  }),
}));
vi.mock('@/lib/services/crawl-engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/crawl-engine')>()),
  processDueCrawlPlans: vi.fn(async (ctx: { workspaceId: bigint }) => {
    check('crawl', ctx.workspaceId);
    return {
      workspaces: 1,
      processed: 0,
      inQuietHours: 0,
      notDue: 0,
      totalStartedRuns: 0,
      totalFailedRecipes: 0,
    };
  }),
}));
vi.mock('@/lib/services/knowledge-compaction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/knowledge-compaction')>()),
  compactWorkspaceKnowledgeUnattended: vi.fn(async (workspaceId: bigint) => {
    check('compaction', workspaceId);
    const failedClusters = ctl.clusterFailures.get(workspaceId.toString()) ?? 0;
    return {
      workspaceId,
      startedAt: new Date(),
      finishedAt: new Date(),
      retiredStaleCount: 0,
      retiredMergedCount: 0,
      keptClusters: 0,
      mergedClusters: 0,
      skippedSingletons: 0,
      skippedUnchangedClusters: 0,
      skippedDistinctClusters: 0,
      failedClusters,
      lastClusterError:
        failedClusters > 0 ? 'AI provider returned 429 api_key=sk-abcdef123456' : null,
    };
  }),
}));
vi.mock('@/lib/services/learning-synthesis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/learning-synthesis')>()),
  synthesizeWorkspaceLearningUnattended: vi.fn(async (workspaceId: bigint) => {
    check('synthesis', workspaceId);
    return {
      workspaceId,
      ran: false,
      skippedReason: 'insufficient_events',
      eventsExamined: 0,
      proposalsReceived: 0,
      lessonsCreated: 0,
    };
  }),
}));
vi.mock('@/lib/services/token-ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/token-ledger')>();
  return {
    ...actual,
    getTokenWallet: vi.fn(async (ctx: { workspaceId: bigint }) => {
      check('health', ctx.workspaceId);
      return actual.getTokenWallet(ctx as Parameters<typeof actual.getTokenWallet>[0]);
    }),
  };
});

beforeEach(async () => {
  await truncateAll();
  ctl.failing.clear();
  ctl.clusterFailures.clear();
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

let seq = 0;
async function twoWorkspaces(): Promise<{ a: bigint; b: bigint; ownerA: string }> {
  seq++;
  const ownerA = await seedUser({ email: `a${seq}@ops.test` });
  const ownerB = await seedUser({ email: `b${seq}@ops.test` });
  const a = await seedWorkspace({ name: `A${seq}`, ownerUserId: ownerA });
  const b = await seedWorkspace({ name: `B${seq}`, ownerUserId: ownerB });
  return { a, b, ownerA };
}

/** Run one tick exactly as the scheduler would; it must not throw. */
async function runTick(name: string): Promise<Record<string, unknown>> {
  const q = new InMemoryJobQueue();
  _setJobQueueForTests(q);
  _resetRepeatablesForTests();
  await registerRepeatableJobs({ skipSchedule: true });
  const id = await q.enqueue(name, {});
  await q.drain();
  const status = await q.status(id);
  if (status.state !== 'succeeded') throw new Error(`${name}: ${JSON.stringify(status)}`);
  return status.result as Record<string, unknown>;
}

async function eventsFor(source: string) {
  return db.select().from(opsEvents).where(eq(opsEvents.source, source)).orderBy(opsEvents.id);
}

async function openEventsFor(source: string) {
  return db
    .select()
    .from(opsEvents)
    .where(and(eq(opsEvents.source, source), isNull(opsEvents.resolvedAt)));
}

interface TickCase {
  tick: string;
  /** The stubbed step that throws. */
  step: string;
  /** Incident subject part, when the tick has several steps per workspace. */
  part?: string;
  /** Title prefix of the incident. */
  title: string;
  /** Make the workspace due again between runs (health check claims). */
  beforeRun?: () => Promise<void>;
}

const resetHealthClaims = async () => {
  await db.update(workspaces).set({ healthCheckLastAt: null });
};

const CASES: TickCase[] = [
  { tick: 'autopilot.tick', step: 'autopilot', title: 'Autopilot' },
  { tick: 'outreach.drain.tick', step: 'drain', title: 'Send queue' },
  { tick: 'mail.imap.tick', step: 'adopt', part: 'adopt', title: 'Inbox sync' },
  { tick: 'outreach.follow_up.tick', step: 'follow_up', title: 'Follow-ups' },
  {
    tick: 'knowledge.compact.tick',
    step: 'compaction',
    part: 'compaction',
    title: 'Knowledge compaction',
  },
  { tick: 'mail.trash.purge.tick', step: 'purge', title: 'Mail trash purge' },
  { tick: 'crawl.engine.tick', step: 'crawl', title: 'Scheduled discovery' },
  {
    tick: 'health.check.tick',
    step: 'health',
    title: 'Workspace health check',
    beforeRun: resetHealthClaims,
  },
];

describe.each(CASES)('$tick: per-workspace failure → one incident, resolved on success', (c) => {
  it('opens one incident per fingerprint, counts occurrences, resolves on the next success', async () => {
    const { a, b } = await twoWorkspaces();
    const run = async () => {
      await c.beforeRun?.();
      return runTick(c.tick);
    };

    ctl.failing.add(`${c.step}:${a}`);
    await run();
    await run();

    const open = await openEventsFor(c.tick);
    expect(open).toHaveLength(1);
    const ev = open[0]!;
    expect(ev).toMatchObject({
      scope: 'workspace',
      workspaceId: a,
      kind: 'tick.workspace_failed',
      severity: 'error',
      occurrences: 2,
    });
    expect(ev.fingerprint).toBe(tickSubjectFingerprint(c.tick, { workspaceId: a, part: c.part }));
    expect(ev.title).toBe(`${c.title} failed for this workspace`);
    expect(ev.payload).toMatchObject({ tick: c.tick, part: c.part ?? null });
    // Masked: the step name survives, the secret and the address do not.
    expect(ev.message).toContain(`${c.step} crashed`);
    expect(ev.message).not.toContain('s3cr3t-value');
    expect(ev.message).not.toContain('owner@');
    // The healthy workspace has no incident.
    expect((await eventsFor(c.tick)).some((e) => e.workspaceId === b)).toBe(false);

    // The tick itself finished: degraded, not failed.
    const [hb] = await db.select().from(jobHeartbeats).where(eq(jobHeartbeats.name, c.tick));
    expect(hb).toMatchObject({ lastStatus: 'degraded', consecutiveFailures: 0, runCount: 2 });
    expect(hb!.lastSummary).toMatchObject({ failedSubjects: 1 });

    // Next success resolves it.
    ctl.failing.delete(`${c.step}:${a}`);
    await run();
    expect(await openEventsFor(c.tick)).toHaveLength(0);
    const [resolved] = await db.select().from(opsEvents).where(eq(opsEvents.id, ev.id));
    expect(resolved!.resolvedAt).not.toBeNull();
    expect(resolved!.resolution).toBe('auto');
    const [hbOk] = await db.select().from(jobHeartbeats).where(eq(jobHeartbeats.name, c.tick));
    expect(hbOk!.lastStatus).toBe('ok');

    // A later failure is a new incident; history keeps the old one.
    ctl.failing.add(`${c.step}:${a}`);
    await run();
    const all = (await eventsFor(c.tick)).filter((e) => e.workspaceId === a);
    expect(all).toHaveLength(2);
    expect(all.filter((e) => e.resolvedAt === null)).toHaveLength(1);
    expect(all.find((e) => e.resolvedAt === null)!.occurrences).toBe(1);
  });
});

describe('steps with their own incident inside one workspace', () => {
  it('knowledge.compact.tick: synthesis fails independently of compaction', async () => {
    const { a } = await twoWorkspaces();
    ctl.failing.add(`synthesis:${a}`);
    await runTick('knowledge.compact.tick');
    await runTick('knowledge.compact.tick');
    const open = await openEventsFor('knowledge.compact.tick');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      workspaceId: a,
      occurrences: 2,
      title: 'Learning synthesis failed for this workspace',
    });
    expect(open[0]!.payload).toMatchObject({ part: 'synthesis' });

    ctl.failing.delete(`synthesis:${a}`);
    await runTick('knowledge.compact.tick');
    expect(await openEventsFor('knowledge.compact.tick')).toHaveLength(0);
  });

  it('knowledge.compact.tick: swallowed cluster-merge failures are an incident (I021)', async () => {
    const { a } = await twoWorkspaces();
    ctl.clusterFailures.set(a.toString(), 2);
    const summary = await runTick('knowledge.compact.tick');
    expect(summary).toMatchObject({ clusterFailures: 2, failed: 0 });
    const open = await openEventsFor('knowledge.compact.tick');
    expect(open).toHaveLength(1);
    expect(open[0]!.message).toContain('2 cluster merge(s) failed');
    expect(open[0]!.message).not.toContain('sk-abcdef123456');

    ctl.clusterFailures.delete(a.toString());
    await runTick('knowledge.compact.tick');
    expect(await openEventsFor('knowledge.compact.tick')).toHaveLength(0);
  });

  it('mail.imap.tick: a crashing mailbox sync is its own incident, resolved by its next clean sync', async () => {
    const { a, ownerA } = await twoWorkspaces();
    const ctx = makeWorkspaceContext({ workspaceId: a, userId: ownerA, role: 'owner' });
    const mb = await createMailbox(ctx, {
      name: 'sales',
      fromAddress: 'sales@nulife.pl',
      smtpHost: 'mail.example.com',
      smtpPort: 587,
      smtpUser: 'sales@nulife.pl',
      smtpPassword: 'secret',
      imap: { host: 'mail.example.com', port: 993, user: 'sales@nulife.pl', password: 'secret' },
    });
    ctl.failing.add(`sync:${mb.id}`);
    const first = await runTick('mail.imap.tick');
    expect(first).toMatchObject({ failed: 1, mailboxesSynced: 0 });
    await runTick('mail.imap.tick');
    const open = await openEventsFor('mail.imap.tick');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ workspaceId: a, occurrences: 2 });
    expect(open[0]!.payload).toMatchObject({ part: `mailbox:${mb.id}` });

    ctl.failing.delete(`sync:${mb.id}`);
    const ok = await runTick('mail.imap.tick');
    expect(ok).toMatchObject({ mailboxesSynced: 1 });
    expect(await openEventsFor('mail.imap.tick')).toHaveLength(0);
  });
});
