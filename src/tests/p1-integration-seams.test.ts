// Phase 1 integration: the seams between the automation-control lane
// (PC-05 pause, PC-06 holds + platform outbound stop, flow:F-07 go-live)
// and the ops-visibility lane (PC-07 incident stream, PC-08 owner alerts,
// PC-10 send gate, retries and Retry now).
//
//   (1) the queue's one pre-send gate asks the automation gate: a Sending
//       hold stops the drain with its reason; the platform outbound stop
//       refuses Retry now even confirmed; under the workspace pause Retry
//       now only puts the email back until "send anyway" is confirmed,
//       and the confirmed send is audited as outbound.override;
//   (2) a paused mailbox and the go-live hold defer a row (never failed);
//   (3) every control change (hold, outbound stop, pause, undo, resume)
//       reaches the owner-alert channel once it has committed;
//   (4) autopilot step errors and a missing accountable owner become
//       ops_events, and the owner's return resolves its incident.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import { users } from '@/lib/db/schema/auth';
import { opsEvents } from '@/lib/db/schema/ops';
import { outreachQueue } from '@/lib/db/schema/outreach';
import { workspaces } from '@/lib/db/schema/workspaces';
import { MockMailProvider } from '@/lib/mail';
import { PAUSED_MANUAL_SEND_MESSAGE, checkGate, ownerIncidentFingerprint } from '@/lib/services/automation-gate';
import { pauseAutomation, resumeAutomation, undoPause } from '@/lib/services/automation-pause';
import {
  AUTOPILOT_STEP_FAILED,
  OPS_EVENT_INCIDENT_SINK,
  autopilotStepIncident,
} from '@/lib/services/autopilot-incidents';
import { makeAutomationContext } from '@/lib/services/context';
import {
  clearPlatformOutboundStop,
  placeTenantHold,
  releaseTenantHold,
  setPlatformOutboundStop,
} from '@/lib/services/holds';
import { updateMailbox } from '@/lib/services/mailbox';
import {
  MAILBOX_PAUSED_HOLD_REASON,
  drainQueue,
  retryQueueEntry,
} from '@/lib/services/outreach-queue';
import { seedUser, truncateAll } from './helpers/db';
import {
  queueCtx as ctx,
  queuedDraft,
  setupQueueWorkspace as setup,
} from './helpers/outreach-fixtures';
import { platformCtx } from './helpers/platform';

const alerts = vi.hoisted(() => ({ changes: [] as unknown[] }));
vi.mock('@/lib/services/ops-alerts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/ops-alerts')>()),
  notifyControlChange: vi.fn((change: unknown) => {
    alerts.changes.push(change);
  }),
}));

beforeEach(async () => {
  await truncateAll();
  alerts.changes.length = 0;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

async function row(id: bigint) {
  const [r] = await db.select().from(outreachQueue).where(eq(outreachQueue.id, id));
  return r!;
}

async function failed(id: bigint) {
  await db.update(outreachQueue).set({ status: 'failed' }).where(eq(outreachQueue.id, id));
}

describe('(1) the pre-send gate asks the automation gate', { timeout: 60_000 }, () => {
  it('a Sending hold stops the drain with its reason; nothing is claimed', async () => {
    const s = await setup();
    const { entry } = await queuedDraft(s, 'anna@target.com');
    await placeTenantHold(ctx(s, 'member'), {
      scope: 'capabilities',
      capabilities: ['sending'],
      reason: 'checking the new copy',
    });
    const provider = new MockMailProvider();
    const r = await drainQueue(ctx(s), { providerOverride: provider });
    expect(r).toMatchObject({ picked: 0, sent: 0, blocked: 'hold' });
    expect(r.heldReason).toContain('checking the new copy');
    expect(provider.sent).toHaveLength(0);
    expect(await row(entry.id)).toMatchObject({ status: 'queued', claimedAt: null });
  });

  it('Retry now: the platform stop refuses even a confirmed send; the pause needs "send anyway"', async () => {
    const s = await setup();
    const { entry } = await queuedDraft(s, 'anna@target.com');
    await failed(entry.id);
    const provider = new MockMailProvider();

    const admin = await seedUser({ email: 'root@seams.test', role: 'super_admin' });
    await setPlatformOutboundStop(platformCtx(admin), 'provider incident');
    const stopped = await retryQueueEntry(ctx(s), entry.id, {
      providerOverride: provider,
      confirmPaused: true,
    });
    expect(stopped).toMatchObject({ outcome: 'queued', reason: 'platform_outbound_stop' });
    expect(stopped.message).toContain('provider incident');
    expect(stopped.overridable).toBeUndefined();
    await clearPlatformOutboundStop(platformCtx(admin), 'incident over');

    await failed(entry.id);
    await pauseAutomation(ctx(s, 'member'), { source: 'api', reason: 'copy review' });
    const unconfirmed = await retryQueueEntry(ctx(s), entry.id, { providerOverride: provider });
    expect(unconfirmed).toMatchObject({
      outcome: 'queued',
      reason: 'paused',
      message: PAUSED_MANUAL_SEND_MESSAGE,
      overridable: true,
    });
    expect(provider.sent).toHaveLength(0);

    // Back in the queue it waits for the drain, which the pause holds.
    expect((await drainQueue(ctx(s), { providerOverride: provider })).blocked).toBe('paused');
    await failed(entry.id);
    const confirmed = await retryQueueEntry(ctx(s), entry.id, {
      providerOverride: provider,
      confirmPaused: true,
    });
    expect(confirmed.outcome).toBe('sent');
    expect(provider.sent).toHaveLength(1);
    const overrides = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, s.workspaceId), eq(auditLog.kind, 'outbound.override')));
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.payload).toMatchObject({ override: 'automation_paused', origin: 'cold' });
  });
});

describe('(2) per-row holds defer, never fail', { timeout: 60_000 }, () => {
  it('a paused mailbox defers the row with the shared hold reason, drain and Retry now alike', async () => {
    const s = await setup();
    const { entry } = await queuedDraft(s, 'anna@target.com');
    await updateMailbox(ctx(s), s.mailboxId, { status: 'paused' });
    const provider = new MockMailProvider();
    const r = await drainQueue(ctx(s), { providerOverride: provider });
    expect(r).toMatchObject({ sent: 0, failed: 0, deferred: 1, skipped: 1 });
    expect(await row(entry.id)).toMatchObject({
      status: 'queued',
      lastError: MAILBOX_PAUSED_HOLD_REASON,
      attemptCount: 0,
    });

    await failed(entry.id);
    const retried = await retryQueueEntry(ctx(s), entry.id, { providerOverride: provider });
    expect(retried.outcome).toBe('deferred');
    expect(retried.entry).toMatchObject({ status: 'queued', lastError: MAILBOX_PAUSED_HOLD_REASON });
    expect(provider.sent).toHaveLength(0);
  });

  it('a workspace that is not live defers a cold Retry now (flow:F-07)', async () => {
    const s = await setup();
    const { entry } = await queuedDraft(s, 'anna@target.com');
    await db.update(workspaces).set({ outreachLiveAt: null }).where(eq(workspaces.id, s.workspaceId));
    await failed(entry.id);
    const provider = new MockMailProvider();
    const r = await retryQueueEntry(ctx(s), entry.id, { providerOverride: provider });
    expect(r.outcome).toBe('deferred');
    expect(r.entry.status).toBe('queued');
    expect(r.entry.lastError).toMatch(/not live/);
    expect(provider.sent).toHaveLength(0);
  });
});

describe('(3) control changes reach the owner alerts (PC-08)', { timeout: 60_000 }, () => {
  it('hold placed / released, outbound stop set / cleared, pause / undo / resume', async () => {
    const s = await setup();
    const hold = await placeTenantHold(ctx(s, 'member'), { scope: 'all', reason: 'audit week' });
    await releaseTenantHold(ctx(s), hold.id, 'audit done');
    const admin = await seedUser({ email: 'root2@seams.test', role: 'super_admin' });
    await setPlatformOutboundStop(platformCtx(admin), 'provider incident');
    await clearPlatformOutboundStop(platformCtx(admin), 'resolved');
    await pauseAutomation(ctx(s, 'member'), { source: 'api', reason: 'check' });
    await undoPause(ctx(s, 'member'));
    await pauseAutomation(ctx(s), { source: 'api' });
    await pauseAutomation(ctx(s), { source: 'api' }); // already paused: no second alert
    await resumeAutomation(ctx(s), { source: 'api' });

    expect(alerts.changes).toEqual([
      expect.objectContaining({
        control: 'workspace_hold',
        action: 'placed',
        source: 'tenant',
        workspaceId: s.workspaceId,
        holdId: hold.id,
        reason: 'audit week',
      }),
      expect.objectContaining({ control: 'workspace_hold', action: 'released', reason: 'audit done' }),
      { control: 'platform_outbound_stop', action: 'set', reason: 'provider incident' },
      { control: 'platform_outbound_stop', action: 'cleared', reason: 'resolved' },
      { control: 'automation_pause', action: 'paused', workspaceId: s.workspaceId, reason: 'check' },
      expect.objectContaining({ control: 'automation_pause', action: 'resumed' }),
      expect.objectContaining({ control: 'automation_pause', action: 'paused' }),
      expect.objectContaining({ control: 'automation_pause', action: 'resumed' }),
    ]);
  });
});

describe('(4) incidents land in the ops stream (PC-07)', { timeout: 60_000 }, () => {
  it('an autopilot step incident is an ops_event, counted per step and day', async () => {
    const s = await setup();
    const at = new Date('2026-10-02T10:00:00Z');
    const input = autopilotStepIncident({
      workspaceId: s.workspaceId,
      step: 'auto_enqueue_outreach',
      runId: 'run-1',
      at,
      errors: { count: 2, first: 'draft failed' },
    });
    await OPS_EVENT_INCIDENT_SINK(input);
    await OPS_EVENT_INCIDENT_SINK(input);
    const open = await db
      .select()
      .from(opsEvents)
      .where(and(eq(opsEvents.kind, AUTOPILOT_STEP_FAILED), isNull(opsEvents.resolvedAt)));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ workspaceId: s.workspaceId, occurrences: 4 });
  });

  it('no accountable owner opens one incident; the owner coming back resolves it', async () => {
    const s = await setup();
    const auto = makeAutomationContext(s.workspaceId, s.ownerId);
    await db.update(users).set({ accountStatus: 'suspended' }).where(eq(users.id, s.ownerId));
    for (let i = 0; i < 3; i++) {
      expect(await checkGate(auto, 'sending', { manual: false })).toMatchObject({
        allowed: false,
        reason: 'no_accountable_owner',
      });
    }
    const fingerprint = ownerIncidentFingerprint(s.workspaceId);
    const open = await db.select().from(opsEvents).where(eq(opsEvents.fingerprint, fingerprint));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ scope: 'workspace', severity: 'error', resolvedAt: null });

    await db.update(users).set({ accountStatus: 'active' }).where(eq(users.id, s.ownerId));
    expect(await checkGate(auto, 'sending', { manual: false })).toMatchObject({ allowed: true });
    const [after] = await db.select().from(opsEvents).where(eq(opsEvents.fingerprint, fingerprint));
    expect(after!.resolvedAt).not.toBeNull();
    expect(after!.resolution).toBe('auto');
  });
});
