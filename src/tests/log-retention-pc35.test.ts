// PC-35 (I066) — log noise and retention.
//
//   (1) With autopilot off, 24 h of autopilot ticks write 0 guard rows; the
//       guard is logged only when its state changes (incl. a lapsed plan
//       on an enabled workspace: one row, not 288 a day).
//   (2) An empty inbox sync writes no audit row (nor an all-duplicate one).
//   (3) Retention deletes only rows past their window, and only of the
//       listed kinds (mixed fixtures), batched, policy by policy, and it is
//       not gated by a pause. The daily tick has its own heartbeat.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { auditRowOrigin } from '@/lib/audit-scope';
import { db } from '@/lib/db/client';
import { auditLog, usageLog } from '@/lib/db/schema/audit';
import { autopilotLog, autopilotSettings } from '@/lib/db/schema/autopilot';
import { mailboxes } from '@/lib/db/schema/mailing';
import { notifications } from '@/lib/db/schema/notifications';
import { jobHeartbeats, opsAlertDeliveries, opsAlertState, opsEvents } from '@/lib/db/schema/ops';
import { workspaces } from '@/lib/db/schema/workspaces';
import { InMemoryJobQueue, _setJobQueueForTests } from '@/lib/jobs';
import {
  _resetRepeatablesForTests,
  registerRepeatableJobs,
  runAutopilotTick,
} from '@/lib/jobs/repeatables';
import { RETENTION_TICK_MS, TICK_CATALOG } from '@/lib/jobs/tick-catalog';
import { MockMailProvider, type InboundMessage } from '@/lib/mail';
import {
  AUTOPILOT_GUARD_OPEN,
  recordGuardState,
  runOnce,
  updateAutopilotSettings,
} from '@/lib/services/autopilot';
import { PAUSED_MESSAGE } from '@/lib/services/automation-gate';
import { pauseAutomation, resumeAutomation } from '@/lib/services/automation-pause';
import { makeWorkspaceContext, type WorkspaceContext } from '@/lib/services/context';
import { syncInbound } from '@/lib/services/mail';
import { createMailbox } from '@/lib/services/mailbox';
import { opsEventFingerprint } from '@/lib/services/ops-events';
import {
  RETENTION_AUDIT_KIND,
  RETENTION_POLICIES,
  RetentionRunError,
  runRetention,
  runRetentionTick,
  type RetentionPolicy,
} from '@/lib/services/retention';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-02T03:00:00.000Z');
const daysAgo = (d: number, from: Date = NOW) => new Date(from.getTime() - d * DAY);

beforeEach(async () => {
  await truncateAll();
  _setJobQueueForTests(null);
  _resetRepeatablesForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  _setJobQueueForTests(null);
  _resetRepeatablesForTests();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

let seq = 0;
async function workspace(
  input: { plan?: 'free' | 'starter' | 'pro' } = {},
): Promise<{ id: bigint; owner: string; ctx: WorkspaceContext }> {
  seq++;
  const owner = await seedUser({ email: `owner${seq}@pc35.test` });
  const id = await seedWorkspace({ name: `W${seq}`, ownerUserId: owner, plan: input.plan });
  return { id, owner, ctx: makeWorkspaceContext({ workspaceId: id, userId: owner, role: 'owner' }) };
}

async function guardRows(workspaceId: bigint) {
  return db
    .select()
    .from(autopilotLog)
    .where(and(eq(autopilotLog.workspaceId, workspaceId), eq(autopilotLog.step, 'guard')))
    .orderBy(autopilotLog.id);
}

async function withQueue<T>(fn: (q: InMemoryJobQueue) => Promise<T>): Promise<T> {
  const q = new InMemoryJobQueue();
  _setJobQueueForTests(q);
  _resetRepeatablesForTests();
  await registerRepeatableJobs({ skipSchedule: true });
  return fn(q);
}

async function runTickOnce(q: InMemoryJobQueue, name: string) {
  const id = await q.enqueue(name, {});
  await q.drain();
  return q.status(id);
}

// ---- (1) autopilot guard noise ------------------------------------------------

describe('(1) autopilot tick and guard: state changes only', () => {
  it('with autopilot off (and paused, and never configured), 24 h of ticks write 0 guard rows', async () => {
    const off = await workspace();
    await updateAutopilotSettings(off.ctx, { enableAutoApproveProjects: true }); // configured, master off
    const paused = await workspace();
    await updateAutopilotSettings(paused.ctx, { autopilotEnabled: true });
    await pauseAutomation(paused.ctx, { source: 'api' });
    const never = await workspace(); // no autopilot_settings row at all

    await withQueue(async (q) => {
      // 24 h of the 5-minute tick, through the instrumented handler.
      for (let i = 0; i < 288; i++) {
        const status = await runTickOnce(q, 'autopilot.tick');
        expect(status.state).toBe('succeeded');
      }
      const last = await runTickOnce(q, 'autopilot.tick');
      // Integration (PC-13 × PC-35): the tick visits the active workspaces,
      // skips autopilot-off ones silently and counts the paused one as held
      // by the gate — none reaches runOnce, so none writes a guard row.
      expect((last as { result: unknown }).result).toMatchObject({
        workspaces: 3,
        stepsRun: 0,
        held: 1,
      });
    });

    expect(await db.select().from(autopilotLog)).toHaveLength(0);
    for (const ws of [off, paused, never]) expect(await guardRows(ws.id)).toHaveLength(0);
    const [beat] = await db
      .select()
      .from(jobHeartbeats)
      .where(eq(jobHeartbeats.name, 'autopilot.tick'));
    expect(beat).toMatchObject({ lastStatus: 'ok', runCount: 289 });
  }, 120_000);

  it('runs enabled workspaces only; a lapsed plan is held by the tick (no row) and logs its guard once on Run now', async () => {
    const on = await workspace();
    await updateAutopilotSettings(on.ctx, { autopilotEnabled: true });
    const lapsed = await workspace({ plan: 'starter' });
    await updateAutopilotSettings(lapsed.ctx, { autopilotEnabled: true });
    await db
      .update(workspaces)
      .set({ subscriptionStatus: 'canceled' })
      .where(eq(workspaces.id, lapsed.id));
    const off = await workspace();
    const archived = await workspace();
    await updateAutopilotSettings(archived.ctx, { autopilotEnabled: true });
    await db.update(workspaces).set({ status: 'archived' }).where(eq(workspaces.id, archived.id));

    // The tick visits the active workspaces (on, lapsed, off); the lapsed
    // plan is the automation gate's refusal, counted as held before runOnce.
    for (let i = 0; i < 288; i++) {
      const r = await runAutopilotTick();
      expect(r).toMatchObject({ workspaces: 3, failed: 0, held: 1 });
    }
    expect(await guardRows(lapsed.id)).toHaveLength(0);

    // Run now reaches runOnce: the plan guard is logged once, however often.
    for (let i = 0; i < 3; i++) await runOnce(lapsed.ctx);
    const lapsedGuard = await guardRows(lapsed.id);
    expect(lapsedGuard).toHaveLength(1);
    expect(lapsedGuard[0]).toMatchObject({
      outcome: 'skipped',
      detail: 'plan_no_autopilot',
      payload: { state: 'plan_no_autopilot', previous: null },
    });
    // The running workspace: its first 'open' is stored, never logged.
    expect(await guardRows(on.id)).toHaveLength(0);
    const [onSettings] = await db
      .select()
      .from(autopilotSettings)
      .where(eq(autopilotSettings.workspaceId, on.id));
    expect(onSettings!.guardState).toBe(AUTOPILOT_GUARD_OPEN);
    expect(onSettings!.guardStateAt).toBeInstanceOf(Date);
    for (const ws of [off, archived]) expect(await guardRows(ws.id)).toHaveLength(0);

    // The plan comes back: one 'resumed' row, then quiet again.
    await db.update(workspaces).set({ subscriptionStatus: 'active' }).where(eq(workspaces.id, lapsed.id));
    for (let i = 0; i < 3; i++) await runAutopilotTick();
    const after = await guardRows(lapsed.id);
    expect(after).toHaveLength(2);
    expect(after[1]).toMatchObject({
      outcome: 'success',
      detail: 'resumed',
      payload: { state: AUTOPILOT_GUARD_OPEN, previous: 'plan_no_autopilot' },
    });
  }, 120_000);

  it('runOnce (Run now, the after-crawl hook) logs each guard change once and still returns the guard every time', async () => {
    const ws = await workspace();

    for (let i = 0; i < 3; i++) {
      const r = await runOnce(ws.ctx);
      expect(r.steps).toEqual([{ step: 'guard', outcome: 'skipped', detail: 'autopilot_disabled' }]);
    }
    expect(await guardRows(ws.id)).toHaveLength(1);

    await updateAutopilotSettings(ws.ctx, { autopilotEnabled: true });
    for (let i = 0; i < 3; i++) await runOnce(ws.ctx);
    await pauseAutomation(ws.ctx, { source: 'api' });
    for (let i = 0; i < 2; i++) {
      const r = await runOnce(ws.ctx);
      expect(r.steps[0]).toEqual({
        step: 'guard',
        outcome: 'skipped',
        detail: `held: ${PAUSED_MESSAGE}`,
      });
    }
    await resumeAutomation(ws.ctx, { source: 'api' });
    await runOnce(ws.ctx);
    await runOnce(ws.ctx);

    const rows = await guardRows(ws.id);
    expect(rows.map((r) => [r.outcome, r.detail])).toEqual([
      ['skipped', 'autopilot_disabled'],
      ['success', 'resumed'],
      ['skipped', `held: ${PAUSED_MESSAGE}`],
      ['success', 'resumed'],
    ]);
    expect(rows.map((r) => r.payload)).toEqual([
      { state: 'autopilot_disabled', previous: null },
      { state: AUTOPILOT_GUARD_OPEN, previous: 'autopilot_disabled' },
      { state: 'paused', previous: AUTOPILOT_GUARD_OPEN },
      { state: AUTOPILOT_GUARD_OPEN, previous: 'paused' },
    ]);
  });

  it('two runs racing on one guard change log it once', async () => {
    const ws = await workspace();
    await updateAutopilotSettings(ws.ctx, { autopilotEnabled: true });
    await runOnce(ws.ctx); // state: open

    const results = await Promise.all([
      recordGuardState(ws.ctx, 'run-a', AUTOPILOT_GUARD_OPEN, 'paused'),
      recordGuardState(ws.ctx, 'run-b', AUTOPILOT_GUARD_OPEN, 'paused'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await guardRows(ws.id)).toHaveLength(1);
    // A run that read a stale state does not overwrite the newer one.
    expect(await recordGuardState(ws.ctx, 'run-c', 'plan_no_autopilot', 'autopilot_disabled')).toBe(
      false,
    );
    const [s] = await db
      .select()
      .from(autopilotSettings)
      .where(eq(autopilotSettings.workspaceId, ws.id));
    expect(s!.guardState).toBe('paused');
  });
});

// ---- (2) sync audit noise -----------------------------------------------------

function inbound(n: number, receivedAt: Date): InboundMessage {
  return {
    uid: n,
    messageId: `<pc35-${n}@target.example>`,
    inReplyTo: null,
    references: [],
    from: { address: 'lead@target.example', name: 'Lead' },
    to: [{ address: 'sales@pc35.test' }],
    cc: [],
    subject: `Message ${n}`,
    textBody: 'hello',
    htmlBody: null,
    receivedAt,
    headers: {},
    attachments: [],
  };
}

describe('(2) syncInbound audits only syncs that stored something', () => {
  it('an empty sync and an all-duplicate sync write no audit row; a sync with new mail writes one', async () => {
    const ws = await workspace();
    const mb = await createMailbox(ws.ctx, {
      name: 'sales',
      fromAddress: 'sales@pc35.test',
      fromName: 'Sales',
      smtpHost: 'smtp.example.com',
      smtpPort: 465,
      smtpSecure: true,
      smtpUser: 'sales@pc35.test',
      smtpPassword: 'secret-password',
      imap: {
        host: 'imap.example.com',
        port: 993,
        secure: true,
        user: 'sales@pc35.test',
        password: 'secret-password',
        folder: 'INBOX',
      },
      isDefault: true,
    });
    const syncAudits = () =>
      db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.workspaceId, ws.id), eq(auditLog.kind, 'mail.sync_inbound')));
    const provider = new MockMailProvider();

    const empty = await syncInbound(ws.ctx, mb.id, provider);
    expect(empty).toEqual({ fetched: 0, inserted: 0, duplicates: 0 });
    expect(await syncAudits()).toHaveLength(0);
    // The sync itself still happened.
    const [synced] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb.id));
    expect(synced!.lastSyncedAt).toBeInstanceOf(Date);

    // Far enough ahead that the next sync's `since` still fetches it again.
    provider.enqueueInbound(inbound(1, new Date(Date.now() + 10 * 60_000)));
    const fresh = await syncInbound(ws.ctx, mb.id, provider);
    expect(fresh).toMatchObject({ fetched: 1, inserted: 1 });
    const audits = await syncAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.payload).toMatchObject({ fetched: 1, inserted: 1, duplicates: 0 });

    const dupes = await syncInbound(ws.ctx, mb.id, provider);
    expect(dupes).toEqual({ fetched: 1, inserted: 0, duplicates: 1 });
    expect(await syncAudits()).toHaveLength(1);
  });
});

// ---- (3) retention ------------------------------------------------------------

interface Fixtures {
  a: bigint;
  b: bigint;
  keep: Record<string, bigint | string>;
  gone: Record<string, bigint | string>;
}

async function insertAutopilotLog(workspaceId: bigint, createdAt: Date): Promise<bigint> {
  const [row] = await db
    .insert(autopilotLog)
    .values({ workspaceId, runId: 'r', step: 'auto_approve_projects', outcome: 'success', createdAt })
    .returning({ id: autopilotLog.id });
  return row!.id;
}

async function insertAudit(workspaceId: bigint | null, kind: string, createdAt: Date): Promise<bigint> {
  const [row] = await db
    .insert(auditLog)
    .values({ workspaceId, kind, createdAt })
    .returning({ id: auditLog.id });
  return row!.id;
}

async function insertNotification(
  workspaceId: bigint,
  createdAt: Date,
  readAt: Date | null,
): Promise<bigint> {
  const [row] = await db
    .insert(notifications)
    .values({ workspaceId, kind: 'lead.replied', title: 'Reply', createdAt, readAt })
    .returning({ id: notifications.id });
  return row!.id;
}

async function insertEvent(input: {
  key: string;
  workspaceId?: bigint;
  firstSeenAt: Date;
  resolvedAt: Date | null;
}): Promise<bigint> {
  const scope = input.workspaceId ? 'workspace' : 'platform';
  const [row] = await db
    .insert(opsEvents)
    .values({
      scope,
      workspaceId: input.workspaceId ?? null,
      kind: 'tick.failed',
      severity: 'error',
      source: 'pc35.test',
      dedupeKey: input.key,
      fingerprint: opsEventFingerprint({
        scope,
        workspaceId: input.workspaceId ?? null,
        kind: 'tick.failed',
        dedupeKey: input.key,
      }),
      title: input.key,
      firstSeenAt: input.firstSeenAt,
      lastSeenAt: input.resolvedAt ?? input.firstSeenAt,
      resolvedAt: input.resolvedAt,
      resolution: input.resolvedAt ? 'auto' : null,
    })
    .returning({ id: opsEvents.id });
  return row!.id;
}

async function insertDelivery(createdAt: Date): Promise<bigint> {
  const [row] = await db
    .insert(opsAlertDeliveries)
    .values({ kind: 'incident', status: 'sent', title: 'alert', priority: 4, eventCount: 1, createdAt })
    .returning({ id: opsAlertDeliveries.id });
  return row!.id;
}

async function insertHeartbeat(name: string, kind: 'tick' | 'job', updatedAt: Date): Promise<string> {
  await db.insert(jobHeartbeats).values({ name, kind, updatedAt });
  return name;
}

async function seedFixtures(): Promise<Fixtures> {
  const a = (await workspace()).id;
  // B is archived with automation paused: retention ignores both.
  const bWs = await workspace();
  const b = bWs.id;
  await db.insert(autopilotSettings).values({ workspaceId: b, autopilotEnabled: true });
  await pauseAutomation(bWs.ctx, { source: 'api' });
  await db.update(workspaces).set({ status: 'archived' }).where(eq(workspaces.id, b));

  const keep: Fixtures['keep'] = {};
  const gone: Fixtures['gone'] = {};

  // autopilot_log: 30 days.
  gone.apOld = await insertAutopilotLog(a, daysAgo(31));
  gone.apJustPast = await insertAutopilotLog(a, new Date(daysAgo(30).getTime() - 60_000));
  gone.apPausedArchived = await insertAutopilotLog(b, daysAgo(45));
  keep.apJustInside = await insertAutopilotLog(a, new Date(daysAgo(30).getTime() + 60_000));
  keep.apRecent = await insertAutopilotLog(b, daysAgo(1));

  // audit_log: only mail.sync_inbound, 30 days.
  gone.syncOld = await insertAudit(a, 'mail.sync_inbound', daysAgo(31));
  gone.syncArchived = await insertAudit(b, 'mail.sync_inbound', daysAgo(60));
  keep.syncRecent = await insertAudit(a, 'mail.sync_inbound', daysAgo(29));
  keep.sendAncient = await insertAudit(a, 'mail.send', daysAgo(400));
  keep.settingsAncient = await insertAudit(a, 'autopilot.settings.update', daysAgo(400));
  keep.platformAncient = await insertAudit(null, 'platform.settings.update', daysAgo(400));

  // notifications: read ones, 90 days by created_at.
  gone.readOld = await insertNotification(a, daysAgo(91), daysAgo(90));
  gone.readArchived = await insertNotification(b, daysAgo(120), daysAgo(119));
  keep.readRecent = await insertNotification(a, daysAgo(89), daysAgo(88));
  keep.unreadAncient = await insertNotification(a, daysAgo(200), null);

  // ops_events: resolved ones, 90 days after resolved_at.
  gone.evResolvedOld = await insertEvent({ key: 'old', firstSeenAt: daysAgo(100), resolvedAt: daysAgo(91) });
  gone.evWorkspaceOld = await insertEvent({
    key: 'ws-old',
    workspaceId: b,
    firstSeenAt: daysAgo(96),
    resolvedAt: daysAgo(95),
  });
  keep.evResolvedRecent = await insertEvent({
    key: 'recent',
    firstSeenAt: daysAgo(200),
    resolvedAt: daysAgo(89),
  });
  keep.evOpenAncient = await insertEvent({ key: 'open', firstSeenAt: daysAgo(200), resolvedAt: null });

  // ops_alert_state: keys not alerted for 90 days.
  await db.insert(opsAlertState).values([
    { alertKey: 'key-old', lastAlertedAt: daysAgo(91), lastEventId: gone.evResolvedOld as bigint },
    { alertKey: 'key-recent', lastAlertedAt: daysAgo(1), lastEventId: gone.evWorkspaceOld as bigint },
  ]);
  gone.keyOld = 'key-old';
  keep.keyRecent = 'key-recent';

  // ops_alert_deliveries: 90 days.
  gone.deliveryOld = await insertDelivery(daysAgo(91));
  keep.deliveryRecent = await insertDelivery(daysAgo(89));

  // job_heartbeats: retired names only, 90 days.
  gone.hbRetired = await insertHeartbeat('old.retired.tick', 'tick', daysAgo(91));
  keep.hbCatalogued = await insertHeartbeat('mail.trash.purge.tick', 'tick', daysAgo(200));
  keep.hbRetiredRecent = await insertHeartbeat('another.retired.tick', 'tick', daysAgo(89));
  keep.hbJob = await insertHeartbeat('connector.run', 'job', daysAgo(10));

  // Not a retention table at all.
  await db.insert(usageLog).values({
    workspaceId: a,
    kind: 'ai.generate_text',
    provider: 'mock',
    units: 10n,
    createdAt: daysAgo(400),
  });

  return { a, b, keep, gone };
}

async function ids<T extends { id: bigint }>(rows: Promise<T[]>): Promise<Set<bigint>> {
  return new Set((await rows).map((r) => r.id));
}

describe('(3) retention: only rows past their window, only the listed kinds', () => {
  it('deletes the due rows of every policy and nothing else (mixed fixtures)', async () => {
    const f = await seedFixtures();
    const before = {
      usage: (await db.select().from(usageLog)).length,
    };

    const summary = await runRetention({ now: NOW });

    expect(summary.failed).toEqual([]);
    expect(
      Object.fromEntries(Object.entries(summary.policies).map(([k, v]) => [k, v.deleted])),
    ).toEqual({
      autopilot_log: 3,
      'audit_log.mail_sync_inbound': 2,
      'notifications.read': 2,
      'ops_events.resolved': 2,
      ops_alert_deliveries: 1,
      ops_alert_state: 1,
      'job_heartbeats.retired': 1,
      // PC-12: no lease rows in these fixtures (work-leases-pc12.test.ts).
      'work_leases.expired': 0,
      // PC-38: no limiter windows either (rate-limits-pc38.test.ts).
      'rate_limit_buckets.expired': 0,
    });
    expect(summary.deleted).toBe(12);
    expect(summary.policies.autopilot_log!.cutoff).toBe(daysAgo(30).toISOString());
    expect(summary.policies['ops_events.resolved']!.cutoff).toBe(daysAgo(90).toISOString());

    const ap = await ids(db.select({ id: autopilotLog.id }).from(autopilotLog));
    expect(ap).toEqual(new Set([f.keep.apJustInside, f.keep.apRecent]));

    const audits = await db.select().from(auditLog);
    const auditIds = new Set(audits.map((r) => r.id));
    for (const k of ['syncRecent', 'sendAncient', 'settingsAncient', 'platformAncient']) {
      expect(auditIds.has(f.keep[k] as bigint)).toBe(true);
    }
    for (const k of ['syncOld', 'syncArchived']) expect(auditIds.has(f.gone[k] as bigint)).toBe(false);

    const notes = await ids(db.select({ id: notifications.id }).from(notifications));
    expect(notes).toEqual(new Set([f.keep.readRecent, f.keep.unreadAncient]));

    const events = await ids(db.select({ id: opsEvents.id }).from(opsEvents));
    expect(events).toEqual(new Set([f.keep.evResolvedRecent, f.keep.evOpenAncient]));

    const keys = await db.select().from(opsAlertState);
    expect(keys.map((k) => k.alertKey)).toEqual(['key-recent']);
    // Its incident row was deleted: the key stays, the link is cleared.
    expect(keys[0]!.lastEventId).toBeNull();

    const deliveries = await ids(db.select({ id: opsAlertDeliveries.id }).from(opsAlertDeliveries));
    expect(deliveries).toEqual(new Set([f.keep.deliveryRecent]));

    const beats = (await db.select().from(jobHeartbeats)).map((h) => h.name).sort();
    expect(beats).toEqual(['another.retired.tick', 'connector.run', 'mail.trash.purge.tick']);

    expect((await db.select().from(usageLog)).length).toBe(before.usage);

    // The run is audited once, as a platform event with the counts.
    const runs = audits.filter((r) => r.kind === RETENTION_AUDIT_KIND);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ workspaceId: null, userId: null });
    // Read as a platform event in /admin/audit, not an orphaned row.
    expect(auditRowOrigin(runs[0]!)).toBe('platform');
    expect(runs[0]!.payload).toMatchObject({
      deleted: 12,
      policies: {
        autopilot_log: { deleted: 3, capped: false, failed: false },
        'audit_log.mail_sync_inbound': { deleted: 2 },
      },
    });

    // Idempotent: nothing left to delete, nothing audited.
    const again = await runRetention({ now: NOW });
    expect(again.deleted).toBe(0);
    expect(await db.select().from(auditLog).where(eq(auditLog.kind, RETENTION_AUDIT_KIND))).toHaveLength(
      1,
    );
  });

  it('deletes in batches and caps a run; the rest goes on the next run', async () => {
    const ws = await workspace();
    for (let i = 0; i < 7; i++) await insertAutopilotLog(ws.id, daysAgo(40));
    const keep = await insertAutopilotLog(ws.id, daysAgo(2));
    const policies = RETENTION_POLICIES.filter((p) => p.name === 'autopilot_log');

    const first = await runRetention({ now: NOW, policies, batchSize: 2, maxBatches: 2 });
    expect(first.policies.autopilot_log).toMatchObject({ deleted: 4, batches: 2, capped: true });
    expect(await db.select().from(autopilotLog)).toHaveLength(4);

    const second = await runRetention({ now: NOW, policies, batchSize: 2, maxBatches: 10 });
    expect(second.policies.autopilot_log).toMatchObject({ deleted: 3, batches: 2, capped: false });
    expect((await db.select().from(autopilotLog)).map((r) => r.id)).toEqual([keep]);
  });

  it('a failing policy does not stop the others; the tick body then throws with a masked reason', async () => {
    const ws = await workspace();
    await insertAutopilotLog(ws.id, daysAgo(40));
    const broken: RetentionPolicy = {
      name: 'broken',
      retentionDays: 1,
      async deleteBatch() {
        throw new Error('connection lost password=hunter2-secret');
      },
    };
    const autopilotPolicy = RETENTION_POLICIES.find((p) => p.name === 'autopilot_log')!;

    const err = await runRetentionTick({ now: NOW, policies: [broken, autopilotPolicy] }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RetentionRunError);
    const summary = (err as RetentionRunError).summary;
    expect(summary.failed).toEqual(['broken']);
    expect(summary.policies.autopilot_log!.deleted).toBe(1);
    expect((err as Error).message).toContain('broken');
    expect((err as Error).message).not.toContain('hunter2-secret');
    expect(await db.select().from(autopilotLog)).toHaveLength(0);
  });
});

describe('ops.retention.tick', () => {
  it('is a daily catalogued tick', () => {
    expect(TICK_CATALOG.find((t) => t.name === 'ops.retention.tick')).toMatchObject({
      everyMs: RETENTION_TICK_MS,
      label: 'Data retention',
    });
    expect(RETENTION_TICK_MS).toBe(DAY);
  });

  it('runs every policy with its own heartbeat; a failed run opens tick.failed, the next clean run resolves it', async () => {
    const ws = await workspace();
    const now = new Date();
    await insertAutopilotLog(ws.id, daysAgo(31, now));
    const recent = await insertAutopilotLog(ws.id, daysAgo(1, now));
    await insertNotification(ws.id, daysAgo(100, now), daysAgo(99, now));

    await withQueue(async (q) => {
      const ok = await runTickOnce(q, 'ops.retention.tick');
      expect(ok.state).toBe('succeeded');
      expect((ok as { result: unknown }).result).toMatchObject({
        deleted: 2,
        failed: [],
        policies: { autopilot_log: { deleted: 1 }, 'notifications.read': { deleted: 1 } },
      });
      expect((await db.select().from(autopilotLog)).map((r) => r.id)).toEqual([recent]);
      const [beat] = await db
        .select()
        .from(jobHeartbeats)
        .where(eq(jobHeartbeats.name, 'ops.retention.tick'));
      expect(beat).toMatchObject({ kind: 'tick', lastStatus: 'ok', consecutiveFailures: 0 });
      expect(beat!.lastSummary).toMatchObject({ deleted: 2 });

      // One policy breaks: the tick fails after the others ran.
      const auditPolicy = RETENTION_POLICIES.find((p) => p.name === 'audit_log.mail_sync_inbound')!;
      vi.spyOn(auditPolicy, 'deleteBatch').mockRejectedValueOnce(new Error('statement timeout'));
      await insertAutopilotLog(ws.id, daysAgo(31, now));
      const bad = await runTickOnce(q, 'ops.retention.tick');
      expect(bad.state).toBe('failed');
      expect((await db.select().from(autopilotLog)).map((r) => r.id)).toEqual([recent]);
      const [failedBeat] = await db
        .select()
        .from(jobHeartbeats)
        .where(eq(jobHeartbeats.name, 'ops.retention.tick'));
      expect(failedBeat).toMatchObject({ lastStatus: 'failed', consecutiveFailures: 1 });
      expect(failedBeat!.lastError).toContain('audit_log.mail_sync_inbound');
      const open = await db
        .select()
        .from(opsEvents)
        .where(and(eq(opsEvents.source, 'ops.retention.tick'), eq(opsEvents.kind, 'tick.failed')));
      expect(open).toHaveLength(1);
      expect(open[0]!.resolvedAt).toBeNull();

      const again = await runTickOnce(q, 'ops.retention.tick');
      expect(again.state).toBe('succeeded');
      const [resolved] = await db
        .select()
        .from(opsEvents)
        .where(inArray(opsEvents.id, [open[0]!.id]));
      expect(resolved!.resolvedAt).not.toBeNull();
    });
  });
});
