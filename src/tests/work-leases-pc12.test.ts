// PC-12 (I064, I067, I068) — work leases, a single inbound-sync path and
// one run per recipe.
//
// Acceptance:
//   (1) of two concurrent runOnce calls, one returns lease_held;
//   (2) parallel drains never exceed the daily cap;
//   (3) concurrent syncs of one mailbox produce one sync and no spurious
//       failure;
//   (4) an expired lease after a simulated crash allows the next run;
//   (5) a second run of a recipe with one in flight is skipped with a
//       reason;
//   (6) a draft superseded after enqueue is never sent;
//   (7) a follow-up is processed once under concurrent ticks.
// Plus: the lease primitives (acquire / renew / release / maximum hold,
// the holder token, the CHECK constraints, the ops-console listing), the
// drain stopping when it loses its lease, Retry now under the drain lease,
// persistInbound's ON CONFLICT for one email synced by two mailboxes, the
// recipe lease in the runner, follow-up claims (cancel mid-composition,
// the Scheduled tab) and the stuck-work reaper honouring live leases and
// settling dead follow-up claims.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock';
import { and, count, eq, sql } from 'drizzle-orm';
import type { ZodSchema } from 'zod';
import { db } from '@/lib/db/client';
import {
  _setAIProviderForTests,
  type AIGenInput,
  type AIGenResult,
  type IAIProvider,
} from '@/lib/ai';
import { autopilotLog, autopilotSettings } from '@/lib/db/schema/autopilot';
import { connectorRuns, crawlPlans, sourceRecords } from '@/lib/db/schema/connectors';
import { outreachFollowUps } from '@/lib/db/schema/follow-ups';
import { mailMessages, mailboxes, type Mailbox } from '@/lib/db/schema/mailing';
import { outreachDrafts, outreachQueue, outreachThreadState } from '@/lib/db/schema/outreach';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { reviewItems } from '@/lib/db/schema/review';
import { workLeases } from '@/lib/db/schema/work-leases';
import { workspaces } from '@/lib/db/schema/workspaces';
import {
  MockMailProvider,
  type FetchInboundOptions,
  type InboundMessage,
  type OutboundMessage,
  type SendResult,
} from '@/lib/mail';
import { runConnectorRun } from '@/lib/connectors/runner';
import { runDrainTick, runFollowUpTick, runImapTick } from '@/lib/jobs/repeatables';
import {
  AUTOPILOT_LEASE_HELD,
  getAutopilotSettings,
  runOnce,
} from '@/lib/services/autopilot';
import { makeAutomationContext, type WorkspaceContext } from '@/lib/services/context';
import {
  RecipeRunInFlightError,
  awaitRun,
  createConnector,
  createRecipe,
  startRun,
} from '@/lib/services/connector-run';
import {
  createCrawlPlan,
  describeRecipeSkips,
  processDueCrawlPlans,
  runCrawlPlanNow,
} from '@/lib/services/crawl-engine';
import {
  cancelFollowUps,
  countFollowUpsByStatus,
  listFollowUps,
  processDueFollowUps,
  scheduleFollowUps,
  updateFollowUpConfig,
} from '@/lib/services/follow-up';
import { MAILBOX_BUSY, safeSyncOne, sendMessage, syncInbound } from '@/lib/services/mail';
import {
  _setMailProviderFactoryForTests,
  createMailbox,
  getMailbox,
  testMailboxConnection,
} from '@/lib/services/mailbox';
import {
  drainQueue,
  retryQueueEntry,
  unapprovedDraftMessage,
  updateSendSettings,
} from '@/lib/services/outreach-queue';
import { RETENTION_POLICIES } from '@/lib/services/retention';
import {
  FOLLOW_UP_STUCK_AFTER_MS,
  INTERRUPTED_SEND_REASON,
  RUN_STUCK_AFTER_MS,
  reapStuckFollowUps,
  reapStuckSends,
} from '@/lib/services/stuck-work';
import {
  WORK_LEASE_POLICY,
  acquireWorkLease,
  type AcquireResult,
  type WorkLease,
  type WorkLeaseSpec,
  describeLeaseHolder,
  isWorkLeaseLive,
  leaseCoversClaim,
  listWorkLeases,
  liveWorkLease,
  withWorkLease,
} from '@/lib/services/work-leases';
import { describeRunNow } from '@/app/autopilot/run-now';
import { describeDrainBlocked, describeRetryOutcome } from '@/app/mailbox/queue/forms';
import { platformCtx, smuggled } from './helpers/platform';
import { seedUser, truncateAll } from './helpers/db';
import {
  queueCtx,
  queuedDraft,
  setupQueueWorkspace,
  type QueueSetup,
} from './helpers/outreach-fixtures';

// ---- helpers -----------------------------------------------------------

/** Leases a test took; released after it so no renewal timer outlives it. */
const taken: WorkLease[] = [];

async function take(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  spec: WorkLeaseSpec,
): Promise<AcquireResult> {
  const got = await acquireWorkLease(ctx, spec);
  if (got.acquired) taken.push(got.lease);
  return got;
}

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Poll `check` until it is true (5 s at most). */
async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Expire every lease of `kind` in the workspace, as a holder that died
 *  (no renewal, no release) leaves it once its TTL has passed. */
async function expireLeases(workspaceId: bigint, kind: string): Promise<void> {
  await db
    .update(workLeases)
    .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
    .where(and(eq(workLeases.workspaceId, workspaceId), eq(workLeases.kind, kind)));
}

async function setWallet(workspaceId: bigint, balance: bigint): Promise<void> {
  await db.update(workspaces).set({ tokenBalance: balance }).where(eq(workspaces.id, workspaceId));
}

async function queueRow(id: bigint) {
  const [row] = await db.select().from(outreachQueue).where(eq(outreachQueue.id, id));
  return row!;
}

async function deliveredOutbound(workspaceId: bigint): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, workspaceId),
        eq(mailMessages.direction, 'outbound'),
        eq(mailMessages.status, 'sent'),
      ),
    );
  return Number(r?.n ?? 0);
}

/** Holds its first send until `release`, so a pass is caught mid-send. */
class GatedProvider extends MockMailProvider {
  public calls = 0;
  public readonly entered = deferred();
  public readonly release = deferred();
  async send(message: OutboundMessage): Promise<SendResult> {
    this.calls += 1;
    if (this.calls === 1) {
      this.entered.resolve();
      await this.release.promise;
    }
    return super.send(message);
  }
}

class CountingProvider extends MockMailProvider {
  public calls = 0;
  constructor(private readonly onSend?: (n: number) => Promise<void>) {
    super();
  }
  async send(message: OutboundMessage): Promise<SendResult> {
    this.calls += 1;
    if (this.onSend) await this.onSend(this.calls);
    return super.send(message);
  }
}

function inboundMsg(messageId: string, uid = 1): InboundMessage {
  return {
    uid,
    messageId,
    inReplyTo: null,
    references: [],
    from: { address: `news-${uid}@shop.example` },
    to: [{ address: 'sales@nulife.pl' }],
    cc: [],
    subject: `Newsletter ${uid}`,
    textBody: 'Our offers this week.',
    htmlBody: null,
    receivedAt: new Date(Date.now() - 60_000),
    headers: {},
    attachments: [],
  };
}

/** An IMAP inbox whose fetch waits until `release` (and counts fetches). */
class GatedInbox extends MockMailProvider {
  public fetches = 0;
  public readonly entered = deferred();
  public readonly release = deferred();
  async fetchInbound(options?: FetchInboundOptions): Promise<InboundMessage[]> {
    this.fetches += 1;
    this.entered.resolve();
    await this.release.promise;
    return super.fetchInbound(options);
  }
}

/** Every inbox that arrives waits until `n` have arrived. */
function barrier(n: number) {
  let arrived = 0;
  const all = deferred();
  return {
    async arrive(): Promise<void> {
      arrived += 1;
      if (arrived >= n) all.resolve();
      await all.promise;
    },
  };
}

class BarrierInbox extends MockMailProvider {
  constructor(private readonly gate: { arrive(): Promise<void> }) {
    super();
  }
  async fetchInbound(options?: FetchInboundOptions): Promise<InboundMessage[]> {
    await this.gate.arrive();
    return super.fetchInbound(options);
  }
}

let mbSeq = 0;
async function imapMailbox(c: WorkspaceContext): Promise<Mailbox> {
  mbSeq += 1;
  return createMailbox(c, {
    name: `inbox-${mbSeq}`,
    fromAddress: `inbox-${mbSeq}@nulife.pl`,
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpUser: `inbox-${mbSeq}@nulife.pl`,
    smtpPassword: 'secret',
    imap: { host: 'imap.example.com', port: 993, user: `inbox-${mbSeq}@nulife.pl`, password: 'secret' },
  });
}

async function mailboxRow(id: bigint): Promise<Mailbox> {
  const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, id));
  return row!;
}

/** Answers like the AI (a follow-up body, a translation); the first
 *  generateText waits until `release` when `gated`. */
class TestAi implements IAIProvider {
  public readonly id = 'pc12-ai';
  public readonly model = 'pc12-ai-1';
  public calls = 0;
  public readonly entered = deferred();
  public readonly release = deferred();
  constructor(
    private readonly opts: { gated?: boolean; onJson?: () => Promise<void> } = {},
  ) {}
  async generateText(_i: AIGenInput): Promise<AIGenResult> {
    this.calls += 1;
    if (this.opts.gated && this.calls === 1) {
      this.entered.resolve();
      await this.release.promise;
    }
    return {
      text: 'Just checking whether my last note reached the right person.',
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
  async generateJson<T>(_i: AIGenInput, schema: ZodSchema<T>): Promise<T> {
    this.calls += 1;
    if (this.opts.onJson) await this.opts.onJson();
    return schema.parse({
      translatedText: 'Wer kümmert sich bei Ihnen um die Betonsanierung?',
      detectedLanguage: 'en',
      isSameLanguage: false,
    });
  }
  estimateCost(): number {
    return 0;
  }
  async healthCheck() {
    return { ok: true, detail: 'pc12' };
  }
}

/** A lead on an outreach thread with one due follow-up step (auto-send). */
async function followUpFixture(s: QueueSetup, provider: MockMailProvider) {
  const owner = queueCtx(s);
  const [sr] = await db
    .insert(sourceRecords)
    .values({
      workspaceId: s.workspaceId,
      sourceSystem: 'mock',
      sourceId: `pc12-fu-${Math.random()}`,
      rawData: {},
      normalizedData: {},
      sourceUrl: 'https://example.com',
    })
    .returning();
  const [ri] = await db
    .insert(reviewItems)
    .values({ workspaceId: s.workspaceId, sourceRecordId: sr!.id, state: 'approved' })
    .returning();
  const first = await sendMessage(owner, {
    mode: 'sequence',
    origin: 'manual',
    mailboxId: s.mailboxId,
    to: [{ address: 'lead@target.com' }],
    subject: 'Hi',
    text: 'first touch',
    providerOverride: provider,
  });
  const [lead] = await db
    .insert(qualifiedLeads)
    .values({
      workspaceId: s.workspaceId,
      reviewItemId: ri!.id,
      productProfileId: s.productId,
      state: 'relevant',
      contactEmail: 'lead@target.com',
    })
    .returning();
  await db.insert(outreachThreadState).values({
    workspaceId: s.workspaceId,
    qualifiedLeadId: lead!.id,
    threadId: first.threadId!,
    stage: 'discovery',
  });
  await updateFollowUpConfig(owner, { enabled: true, requireApproval: false });
  await scheduleFollowUps(owner, { threadId: first.threadId!, qualifiedLeadId: lead!.id });
  await db
    .update(outreachFollowUps)
    .set({ scheduledFor: new Date(Date.now() - 60_000) })
    .where(
      and(eq(outreachFollowUps.workspaceId, s.workspaceId), eq(outreachFollowUps.stepNumber, 1)),
    );
  const [step] = await db
    .select()
    .from(outreachFollowUps)
    .where(
      and(eq(outreachFollowUps.workspaceId, s.workspaceId), eq(outreachFollowUps.stepNumber, 1)),
    );
  await setWallet(s.workspaceId, 1_000_000n);
  return { step: step!, threadId: first.threadId!, auto: makeAutomationContext(s.workspaceId, s.ownerId) };
}

async function followUpRow(id: bigint) {
  const [row] = await db.select().from(outreachFollowUps).where(eq(outreachFollowUps.id, id));
  return row!;
}

const followUpSends = (p: MockMailProvider) =>
  p.sent.filter((x) => x.message.subject.startsWith('Re:')).length;

beforeEach(async () => {
  await truncateAll();
});

afterEach(async () => {
  _setAIProviderForTests(null);
  _setMailProviderFactoryForTests(null);
  for (const lease of taken.splice(0)) await lease.release();
});

// ---- the lease itself ----------------------------------------------------

describe('work leases (PC-12)', () => {
  it('one holder at a time; the refused caller learns who holds it and since when', async () => {
    const s = await setupQueueWorkspace();
    const ctx = queueCtx(s);
    const first = await take(ctx, { kind: 'outreach.drain', purpose: 'tick' });
    expect(first.acquired).toBe(true);
    const second = await take(ctx, { kind: 'outreach.drain', purpose: 'manual' });
    expect(second.acquired).toBe(false);
    if (second.acquired || !first.acquired) throw new Error('unreachable');
    expect(second.held).toMatchObject({ kind: 'outreach.drain', resourceKey: '', purpose: 'tick' });
    expect(second.held.holderLabel).toMatch(/pid \d+ on .+, boot [0-9a-f]{8}/);
    expect(describeLeaseHolder(second.held)).toMatch(/^since \d{4}-\d\d-\d\d \d\d:\d\d UTC \(tick, /);

    // Another kind, another workspace, another mailbox: independent.
    expect((await take(ctx, { kind: 'autopilot.run' })).acquired).toBe(true);
    const other = await setupQueueWorkspace();
    expect((await take(queueCtx(other), { kind: 'outreach.drain' })).acquired).toBe(true);
    expect((await take(ctx, { kind: 'mailbox.sync', resource: 1n })).acquired).toBe(true);
    expect((await take(ctx, { kind: 'mailbox.sync', resource: 2n })).acquired).toBe(true);

    await first.lease.release();
    expect((await take(ctx, { kind: 'outreach.drain' })).acquired).toBe(true);
  });

  it('withWorkLease releases after the work, also when it throws', async () => {
    const s = await setupQueueWorkspace();
    const ctx = queueCtx(s);
    expect(await withWorkLease(ctx, { kind: 'autopilot.run' }, async () => 42)).toEqual({
      status: 'ran',
      value: 42,
    });
    expect(await isWorkLeaseLive(ctx, 'autopilot.run')).toBe(false);
    await expect(
      withWorkLease(ctx, { kind: 'autopilot.run' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await isWorkLeaseLive(ctx, 'autopilot.run')).toBe(false);
    const nested = await withWorkLease(ctx, { kind: 'autopilot.run' }, () =>
      withWorkLease(ctx, { kind: 'autopilot.run' }, async () => 'inner'),
    );
    expect(nested).toMatchObject({ status: 'ran', value: { status: 'lease_held' } });
  });

  it('(4) a crashed holder blocks the work only until its lease expires; it can then neither renew nor release', async () => {
    const s = await setupQueueWorkspace();
    const ctx = queueCtx(s);
    const crashed = await take(ctx, { kind: 'outreach.drain', autoRenew: false });
    if (!crashed.acquired) throw new Error('expected the lease');
    // Its process dies: no renewal, no release.
    expect((await take(ctx, { kind: 'outreach.drain' })).acquired).toBe(false);
    await expireLeases(s.workspaceId, 'outreach.drain');
    const next = await take(ctx, { kind: 'outreach.drain' });
    expect(next.acquired).toBe(true);
    // The dead holder's token no longer matches: nothing it does touches
    // the new holder's lease.
    expect(await crashed.lease.renew()).toBe(false);
    expect(crashed.lease.lost).toBe(true);
    expect(await crashed.lease.checkpoint()).toBe(false);
    await crashed.lease.release();
    expect(await isWorkLeaseLive(ctx, 'outreach.drain')).toBe(true);
  });

  it('renews on its timer and at checkpoints; gives itself up after its maximum hold', async () => {
    const s = await setupQueueWorkspace();
    const ctx = queueCtx(s);
    const got = await take(ctx, { kind: 'autopilot.run', ttlMs: 300 });
    if (!got.acquired) throw new Error('expected the lease');
    const firstExpiry = (await liveWorkLease(ctx, 'autopilot.run'))!.expiresAt;
    await sleep(400); // past the TTL: only the timer kept it alive
    const renewed = await liveWorkLease(ctx, 'autopilot.run');
    expect(renewed).not.toBeNull();
    expect(renewed!.expiresAt.getTime()).toBeGreaterThan(firstExpiry.getTime());
    expect(await got.lease.checkpoint()).toBe(true);
    await got.lease.release();

    const capped = await take(ctx, { kind: 'autopilot.run', maxHoldMs: 50 });
    if (!capped.acquired) throw new Error('expected the lease');
    expect(await capped.lease.checkpoint()).toBe(true);
    await sleep(80);
    expect(await capped.lease.checkpoint()).toBe(false);
    await capped.lease.release();
  });

  it('per-resource kinds name their resource; the others do not', async () => {
    const s = await setupQueueWorkspace();
    const ctx = queueCtx(s);
    await expect(take(ctx, { kind: 'mailbox.sync' })).rejects.toThrow(/names its resource/);
    await expect(take(ctx, { kind: 'outreach.drain', resource: 5n })).rejects.toThrow(
      /names its resource/,
    );
    // The CHECK constraints say the same for any writer.
    const insert = (kind: string, resourceKey: string) =>
      db.execute(
        sql`INSERT INTO work_leases (workspace_id, kind, resource_key, holder, holder_label, acquired_at, renewed_at, expires_at)
            VALUES (${s.workspaceId}, ${kind}, ${resourceKey}, 't', 'l', now(), now(), now() + interval '1 minute')`,
      );
    await expect(insert('reports.export', '')).rejects.toThrow(/work_leases_kind_check/);
    await expect(insert('mailbox.sync', '')).rejects.toThrow(/work_leases_resource_key_check/);
    await expect(insert('autopilot.run', '7')).rejects.toThrow(/work_leases_resource_key_check/);
  });

  it('the discovery-run lease lasts the reaper\'s no-progress window and renews only at progress', () => {
    expect(WORK_LEASE_POLICY['connector.recipe']).toEqual({
      ttlMs: RUN_STUCK_AFTER_MS,
      maxHoldMs: Number.POSITIVE_INFINITY,
      autoRenew: false,
    });
  });

  it('the ops console lists live leases first, then the ones a dead holder left; platform scope only', async () => {
    const s = await setupQueueWorkspace();
    const ctx = queueCtx(s);
    const adminId = await seedUser({ email: 'pc12-root@test.local', role: 'super_admin' });
    await take(ctx, { kind: 'outreach.follow_up', purpose: 'tick', autoRenew: false });
    await expireLeases(s.workspaceId, 'outreach.follow_up');
    await take(ctx, { kind: 'mailbox.sync', resource: s.mailboxId, purpose: 'manual sync' });
    const rows = await listWorkLeases(platformCtx(adminId));
    expect(rows.map((r) => [r.kind, r.resourceKey, r.live])).toEqual([
      ['mailbox.sync', s.mailboxId.toString(), true],
      ['outreach.follow_up', '', false],
    ]);
    expect(rows[0]).toMatchObject({ workspaceId: s.workspaceId, purpose: 'manual sync' });
    await expect(listWorkLeases(smuggled(ctx))).rejects.toThrow(/PlatformContext/);
  });
});

// ---- (1) autopilot ---------------------------------------------------------

describe('autopilot runOnce under the workspace lease (I064)', () => {
  it('(1) of two concurrent runOnce calls, one returns lease_held', async () => {
    const s = await setupQueueWorkspace();
    const ctx = queueCtx(s);
    await getAutopilotSettings(ctx);
    // Hold the run that gets the lease mid-way: its guard write waits for
    // this row lock, so it is still running when the other call arrives.
    const locked = deferred();
    const unlock = deferred();
    const blocker = db.transaction(async (tx) => {
      await tx
        .select()
        .from(autopilotSettings)
        .where(eq(autopilotSettings.workspaceId, s.workspaceId))
        .for('update');
      locked.resolve();
      await unlock.promise;
    });
    await locked.promise;

    const runs = [runOnce(ctx), runOnce(makeAutomationContext(s.workspaceId, s.ownerId))];
    const firstBack = await Promise.race(runs);
    expect(firstBack.leaseHeld).toMatchObject({ kind: 'autopilot.run' });
    expect(firstBack.steps).toEqual([{ step: 'guard', outcome: 'skipped', detail: AUTOPILOT_LEASE_HELD }]);
    expect(describeRunNow(firstBack)).toMatch(/^Autopilot is already running in this workspace since /);

    unlock.resolve();
    await blocker;
    const both = await Promise.all(runs);
    expect(both.filter((r) => r.leaseHeld)).toHaveLength(1);
    const ran = both.find((r) => !r.leaseHeld)!;
    expect(ran.steps[0]).toMatchObject({ step: 'guard', detail: 'autopilot_disabled' });

    // The refused call wrote nothing; the lease is gone with the run.
    const refusedLog = await db
      .select()
      .from(autopilotLog)
      .where(eq(autopilotLog.runId, firstBack.runId));
    expect(refusedLog).toEqual([]);
    expect(await isWorkLeaseLive(ctx, 'autopilot.run')).toBe(false);
    expect((await runOnce(ctx)).leaseHeld).toBeUndefined();
  });

  it('(4) after a crashed run the next run goes ahead once the lease expired', async () => {
    const s = await setupQueueWorkspace();
    const ctx = queueCtx(s);
    const crashed = await take(ctx, { kind: 'autopilot.run', purpose: 'tick', autoRenew: false });
    expect(crashed.acquired).toBe(true);
    expect((await runOnce(ctx)).leaseHeld).toMatchObject({ purpose: 'tick' });
    await expireLeases(s.workspaceId, 'autopilot.run');
    const r = await runOnce(ctx);
    expect(r.leaseHeld).toBeUndefined();
    expect(r.steps[0]).toMatchObject({ detail: 'autopilot_disabled' });
  });
});

// ---- (2) the drain ---------------------------------------------------------

describe('the drain under the workspace lease (I064)', () => {
  it('(2) parallel drains never exceed the daily cap', async () => {
    const s = await setupQueueWorkspace();
    const ctx = queueCtx(s);
    await updateSendSettings(ctx, { dailyEmailLimit: 2 });
    for (const to of ['a@one.com', 'b@two.com', 'c@three.com', 'd@four.com', 'e@five.com']) {
      await queuedDraft(s, to);
    }
    const provider = new GatedProvider();
    const first = drainQueue(ctx, { providerOverride: provider });
    await provider.entered.promise; // pass 1 is sending its first row

    // Two more passes and a drain tick while pass 1 sends: each would have
    // counted the same headroom (nothing delivered yet) and sent past the cap.
    const [second, third, tick] = await Promise.all([
      drainQueue(ctx, { providerOverride: provider }),
      drainQueue(queueCtx(s, 'member'), { providerOverride: provider }),
      runDrainTick(),
    ]);
    for (const r of [second, third]) {
      expect(r).toMatchObject({ picked: 0, sent: 0, blocked: 'send_pass_running' });
      expect(r.sendPass).toMatchObject({ kind: 'outreach.drain' });
      expect(describeDrainBlocked(r.blocked!, describeLeaseHolder(r.sendPass!))).toMatch(
        /^Nothing was sent by this click: a send pass is already running in this workspace since /,
      );
    }
    expect(tick).toMatchObject({ busy: 1, totalSent: 0, failed: 0 });

    provider.release.resolve();
    expect(await first).toMatchObject({ picked: 2, sent: 2 });
    expect(await deliveredOutbound(s.workspaceId)).toBe(2);
    expect(provider.calls).toBe(2);

    // The next pass counts the cap again: used up.
    expect(await drainQueue(ctx, { providerOverride: provider })).toMatchObject({
      sent: 0,
      blocked: 'daily_limit',
    });
    expect(await deliveredOutbound(s.workspaceId)).toBe(2);
    expect(await isWorkLeaseLive(ctx, 'outreach.drain')).toBe(false);
  });

  it('Retry now while a pass is sending only puts the email back; the next pass sends it', async () => {
    const s = await setupQueueWorkspace();
    const ctx = queueCtx(s);
    const { entry: failed } = await queuedDraft(s, 'anna@target.com');
    await db.update(outreachQueue).set({ status: 'failed' }).where(eq(outreachQueue.id, failed.id));
    await queuedDraft(s, 'bob@other.com');
    const provider = new GatedProvider();
    const pass = drainQueue(ctx, { providerOverride: provider });
    await provider.entered.promise;

    const retried = await retryQueueEntry(ctx, failed.id, { providerOverride: provider });
    expect(retried).toMatchObject({ outcome: 'queued', reason: 'send_pass_running' });
    expect(retried.entry.status).toBe('queued');
    expect(describeRetryOutcome(retried).text).toMatch(/A send pass is running in this workspace right now/);

    provider.release.resolve();
    await pass;
    expect((await queueRow(failed.id)).status).toBe('queued');
    expect(await drainQueue(ctx, { providerOverride: provider })).toMatchObject({ sent: 1 });
    expect((await queueRow(failed.id)).status).toBe('sent');
  });

  it('a pass that loses its lease after a stall stops before its next claim; the rest stay queued', async () => {
    const s = await setupQueueWorkspace();
    const ctx = queueCtx(s);
    const rows = [];
    for (const to of ['a@one.com', 'b@two.com', 'c@three.com']) rows.push((await queuedDraft(s, to)).entry);
    // The first send stalls past the lease's TTL; meanwhile another pass
    // takes the expired lease over.
    const provider = new CountingProvider(async (n) => {
      if (n !== 1) return;
      await until(async () => !(await isWorkLeaseLive(ctx, 'outreach.drain')), 'the lease to expire');
      const other = await take(ctx, { kind: 'outreach.drain', purpose: 'another pass' });
      expect(other.acquired).toBe(true);
    });
    const r = await drainQueue(ctx, {
      providerOverride: provider,
      lease: { ttlMs: 150, autoRenew: false },
    });
    expect(r).toMatchObject({ picked: 3, sent: 1, leaseLost: true });
    expect(provider.calls).toBe(1);
    for (const row of rows.slice(1)) {
      const q = await queueRow(row.id);
      expect(q.status).toBe('queued');
      expect(q.claimedAt).toBeNull();
    }
    // The new holder's lease was left alone.
    expect(await liveWorkLease(ctx, 'outreach.drain')).toMatchObject({ purpose: 'another pass' });
  });

  it('(4) a drain lease left by a crashed pass expires and the next pass sends', async () => {
    const s = await setupQueueWorkspace();
    const ctx = queueCtx(s);
    await queuedDraft(s, 'anna@target.com');
    await take(ctx, { kind: 'outreach.drain', autoRenew: false });
    const provider = new CountingProvider();
    expect(await drainQueue(ctx, { providerOverride: provider })).toMatchObject({
      blocked: 'send_pass_running',
    });
    await expireLeases(s.workspaceId, 'outreach.drain');
    expect(await drainQueue(ctx, { providerOverride: provider })).toMatchObject({ sent: 1 });
  });
});

// ---- (6) a superseded draft --------------------------------------------------

describe('processEntry sends approved drafts only (I064)', () => {
  it('(6) a draft superseded after enqueue is never sent', async () => {
    const s = await setupQueueWorkspace();
    const ctx = queueCtx(s);
    const { draft, entry } = await queuedDraft(s, 'anna@target.com');
    // A regenerate supersedes the draft after its email was queued.
    await db.update(outreachDrafts).set({ status: 'superseded' }).where(eq(outreachDrafts.id, draft.id));
    const provider = new CountingProvider();
    const r = await drainQueue(ctx, { providerOverride: provider });
    expect(r).toMatchObject({ picked: 1, sent: 0, skipped: 1, failed: 0 });
    expect(provider.calls).toBe(0);
    const row = await queueRow(entry.id);
    expect(row.status).toBe('skipped');
    expect(row.lastError).toBe(unapprovedDraftMessage('superseded'));
  });

  it('(6) …also when the regenerate lands while the email is being translated', async () => {
    const s = await setupQueueWorkspace({ productLanguage: 'de' });
    const ctx = queueCtx(s);
    const { draft, entry } = await queuedDraft(s, 'anna@target.com');
    _setAIProviderForTests(
      new TestAi({
        onJson: async () => {
          await db
            .update(outreachDrafts)
            .set({ status: 'superseded' })
            .where(eq(outreachDrafts.id, draft.id));
        },
      }),
    );
    const provider = new CountingProvider();
    const r = await drainQueue(ctx, { providerOverride: provider });
    expect(r).toMatchObject({ sent: 0, skipped: 1, failed: 0 });
    expect(provider.calls).toBe(0);
    expect((await queueRow(entry.id)).lastError).toMatch(/^Not sent: a newer draft replaced this one/);
  });

  it('every unapproved status has its own reason; approved has none', () => {
    expect(unapprovedDraftMessage('approved')).toBeNull();
    expect(unapprovedDraftMessage('rejected')).toMatch(/rejected after it was queued/);
    expect(unapprovedDraftMessage('needs_edit')).toMatch(/went back for editing/);
    expect(unapprovedDraftMessage('draft')).toMatch(/went back for editing/);
    expect(unapprovedDraftMessage(null)).toMatch(/no longer exists/);
  });
});

// ---- (3) one inbound-sync path ------------------------------------------------

describe('mailbox syncs under the mailbox lease (I067)', () => {
  it('(3) concurrent syncs of one mailbox produce one sync and no spurious failure', async () => {
    const s = await setupQueueWorkspace();
    const ctx = queueCtx(s);
    const mb = await imapMailbox(ctx);
    const inbox = new GatedInbox();
    inbox.enqueueInbound(inboundMsg('<pc12-a@shop.example>', 1), inboundMsg('<pc12-b@shop.example>', 2));
    _setMailProviderFactoryForTests(() => inbox);

    const manual = safeSyncOne(ctx, await getMailbox(ctx, mb.id));
    await inbox.entered.promise;

    // The same mailbox from a second Sync click, the IMAP tick and Test
    // connection, while the first sync is fetching.
    const second = await safeSyncOne(ctx, await getMailbox(ctx, mb.id));
    expect(second).toMatchObject({ kind: 'busy' });
    if (second.kind !== 'busy') throw new Error('unreachable');
    expect(second.message).toMatch(/^A sync or connection check of this mailbox is already running since /);
    const tick = await runImapTick();
    expect(tick).toMatchObject({ busy: 1, failed: 0, mailboxesSynced: 0 });
    await expect(testMailboxConnection(ctx, mb.id)).rejects.toMatchObject({ code: 'busy' });
    await expect(syncInbound(ctx, mb.id)).rejects.toMatchObject({ code: MAILBOX_BUSY });

    inbox.release.resolve();
    expect(await manual).toMatchObject({ kind: 'synced', fetched: 2, inserted: 2 });
    expect(inbox.fetches).toBe(1);
    const row = await mailboxRow(mb.id);
    expect(row).toMatchObject({
      status: 'active',
      imapConsecutiveFailures: 0,
      lastError: null,
    });
    expect(await isWorkLeaseLive(ctx, 'mailbox.sync', mb.id)).toBe(false);

    // Free again: the next sync runs (nothing new to store).
    expect(await safeSyncOne(ctx, await getMailbox(ctx, mb.id))).toMatchObject({
      kind: 'synced',
      inserted: 0,
    });
  });

  it('one email synced by two of the workspace\'s mailboxes at once is stored once, and neither sync fails', async () => {
    const s = await setupQueueWorkspace();
    const ctx = queueCtx(s);
    const a = await imapMailbox(ctx);
    const b = await imapMailbox(ctx);
    const both = barrier(2);
    const inboxes = new Map<string, MockMailProvider>([
      [a.id.toString(), new BarrierInbox(both)],
      [b.id.toString(), new BarrierInbox(both)],
    ]);
    // CC'd to both mailboxes: the same Message-ID in each inbox.
    for (const inbox of inboxes.values()) inbox.enqueueInbound(inboundMsg('<dup-pc12@shop.example>'));
    _setMailProviderFactoryForTests((mb) => inboxes.get(mb.id.toString())!);

    // Both syncs pass the "already stored?" check before either inserts.
    await db.execute(
      sql.raw(`CREATE OR REPLACE FUNCTION pc12_slow_inbound() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.message_id = '<dup-pc12@shop.example>' THEN PERFORM pg_sleep(0.4); END IF;
          RETURN NEW;
        END $$;`),
    );
    await db.execute(
      sql.raw(
        'CREATE TRIGGER pc12_slow_inbound BEFORE INSERT ON mail_messages FOR EACH ROW EXECUTE FUNCTION pc12_slow_inbound();',
      ),
    );
    try {
      const [ra, rb] = await Promise.all([
        safeSyncOne(ctx, await getMailbox(ctx, a.id)),
        safeSyncOne(ctx, await getMailbox(ctx, b.id)),
      ]);
      expect(ra.kind).toBe('synced');
      expect(rb.kind).toBe('synced');
      if (ra.kind !== 'synced' || rb.kind !== 'synced') throw new Error('unreachable');
      expect(ra.inserted + rb.inserted).toBe(1);
      expect(ra.duplicates + rb.duplicates).toBe(1);
    } finally {
      await db.execute(sql.raw('DROP TRIGGER IF EXISTS pc12_slow_inbound ON mail_messages;'));
      await db.execute(sql.raw('DROP FUNCTION IF EXISTS pc12_slow_inbound();'));
    }
    const [stored] = await db
      .select({ n: count() })
      .from(mailMessages)
      .where(eq(mailMessages.messageId, '<dup-pc12@shop.example>'));
    expect(Number(stored!.n)).toBe(1);
    for (const id of [a.id, b.id]) {
      expect(await mailboxRow(id)).toMatchObject({ imapConsecutiveFailures: 0, lastError: null });
    }
  });
});

// ---- (5) one run per recipe ---------------------------------------------------

describe('one active run per recipe (I068)', () => {
  async function recipeFixture(s: QueueSetup) {
    const ctx = queueCtx(s);
    await setWallet(s.workspaceId, 1_000_000n);
    const conn = await createConnector(ctx, { templateType: 'mock', name: 'pc12-conn' });
    const recipe = await createRecipe(ctx, { connectorId: conn.id, name: 'pc12-recipe', active: true });
    return { ctx, conn, recipe };
  }

  it('(5) a second run of a recipe with one in flight is skipped with a reason', async () => {
    const s = await setupQueueWorkspace();
    const { ctx, conn, recipe } = await recipeFixture(s);
    const [inFlight] = await db
      .insert(connectorRuns)
      .values({
        workspaceId: s.workspaceId,
        connectorId: conn.id,
        recipeId: recipe.id,
        status: 'running',
        startedAt: new Date(),
        lastProgressAt: new Date(),
      })
      .returning();

    // Run now on the recipe.
    const refused = startRun(ctx, { connectorId: conn.id, recipeId: recipe.id });
    await expect(refused).rejects.toBeInstanceOf(RecipeRunInFlightError);
    await expect(refused).rejects.toMatchObject({
      code: 'run_in_flight',
      runId: inFlight!.id,
      runStatus: 'running',
    });

    // A plan (Run now, and the crawl tick).
    const plan = await createCrawlPlan(ctx, {
      name: 'pc12-plan',
      intervalMinutes: 60,
      recipeIds: [recipe.id],
      productProfileIds: [],
    });
    const r = await runCrawlPlanNow(ctx, plan.id);
    expect(r.startedRuns).toEqual([]);
    expect(r.failedRecipes).toEqual([]);
    expect(r.skippedRecipes).toEqual([recipe.id]);
    expect(r.recipeSkips).toEqual([
      {
        recipeId: recipe.id,
        reason: 'run_in_flight',
        runId: inFlight!.id,
        message: `A run of this recipe is already running (run ${inFlight!.id}). A recipe runs once at a time.`,
      },
    ]);
    expect(describeRecipeSkips(r.recipeSkips)).toBe(
      '1 recipe(s) skipped: 1 still running from an earlier run (a recipe runs once at a time)',
    );
    const [saved] = await db.select().from(crawlPlans).where(eq(crawlPlans.id, plan.id));
    expect(saved!.lastRunSummary).toMatchObject({
      started: 0,
      failed: 0,
      recipeSkips: [{ recipeId: recipe.id.toString(), reason: 'run_in_flight', runId: inFlight!.id.toString() }],
    });
    expect(saved!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());

    await db.update(crawlPlans).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(crawlPlans.id, plan.id));
    const tick = await processDueCrawlPlans(makeAutomationContext(s.workspaceId, s.ownerId));
    expect(tick).toMatchObject({ processed: 1, totalStartedRuns: 0, totalFailedRecipes: 0 });

    const runs = await db.select().from(connectorRuns).where(eq(connectorRuns.recipeId, recipe.id));
    expect(runs.map((x) => x.id)).toEqual([inFlight!.id]);

    // Once it has ended, the recipe runs again.
    await db.update(connectorRuns).set({ status: 'succeeded' }).where(eq(connectorRuns.id, inFlight!.id));
    const { run } = await startRun(ctx, { connectorId: conn.id, recipeId: recipe.id });
    await awaitRun(ctx, run.id);
  });

  it('two starts of one recipe at once make one run', async () => {
    const s = await setupQueueWorkspace();
    const { ctx, conn, recipe } = await recipeFixture(s);
    const results = await Promise.allSettled([
      startRun(ctx, { connectorId: conn.id, recipeId: recipe.id }),
      startRun(ctx, { connectorId: conn.id, recipeId: recipe.id }),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(RecipeRunInFlightError);
    const started = results.find((x) => x.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<typeof startRun>>
    >;
    await awaitRun(ctx, started.value.run.id);
    const [n] = await db
      .select({ n: count() })
      .from(connectorRuns)
      .where(eq(connectorRuns.recipeId, recipe.id));
    expect(Number(n!.n)).toBe(1);
  });

  it('a run whose recipe is still executing elsewhere (lease held) ends cancelled before it starts', async () => {
    const s = await setupQueueWorkspace();
    const { ctx, conn, recipe } = await recipeFixture(s);
    const zombie = await take(ctx, {
      kind: 'connector.recipe',
      resource: recipe.id,
      purpose: 'run 1',
    });
    expect(zombie.acquired).toBe(true);
    const [pending] = await db
      .insert(connectorRuns)
      .values({ workspaceId: s.workspaceId, connectorId: conn.id, recipeId: recipe.id, status: 'pending' })
      .returning();
    const r = await runConnectorRun(ctx, pending!.id);
    expect(r.status).toBe('cancelled');
    expect(r.error?.message).toMatch(/^Not started: another run of this recipe was still executing since /);
    const [row] = await db.select().from(connectorRuns).where(eq(connectorRuns.id, pending!.id));
    expect(row).toMatchObject({ status: 'cancelled', recordCount: 0 });
    expect(row!.errorPayload).toMatchObject({ reason: 'recipe_busy' });
  });

  it('an executing run gives its recipe lease back when it ends', async () => {
    const s = await setupQueueWorkspace();
    const { ctx, conn, recipe } = await recipeFixture(s);
    const { run } = await startRun(ctx, { connectorId: conn.id, recipeId: recipe.id });
    const result = await awaitRun(ctx, run.id);
    expect(['succeeded', 'partial']).toContain(result.status);
    expect(await isWorkLeaseLive(ctx, 'connector.recipe', recipe.id)).toBe(false);
  });
});

// ---- (7) follow-ups --------------------------------------------------------

describe('follow-ups: one pass per workspace, each step claimed (I064)', () => {
  it('(7) a follow-up is processed once under concurrent ticks', async () => {
    const s = await setupQueueWorkspace();
    const provider = new MockMailProvider();
    const { step, auto } = await followUpFixture(s, provider);
    const ai = new TestAi({ gated: true });
    _setAIProviderForTests(ai);

    const a = processDueFollowUps(auto, { mailProviderOverride: provider, purpose: 'tick' });
    await ai.entered.promise; // pass A claimed the step and is writing it
    expect(await followUpRow(step.id)).toMatchObject({ status: 'processing' });
    expect((await followUpRow(step.id)).claimedAt).not.toBeNull();

    // A concurrent tick: the follow-up lease is held.
    const b = await processDueFollowUps(auto, { mailProviderOverride: provider });
    expect(b).toMatchObject({ checked: 0, sent: 0, followUpPass: { kind: 'outreach.follow_up', purpose: 'tick' } });
    expect(await runFollowUpTick()).toMatchObject({ busy: 1, sent: 0 });

    // Even a pass that takes the lease over after A stalled past its TTL
    // does not pick the claimed step up again.
    await expireLeases(s.workspaceId, 'outreach.follow_up');
    const c = await processDueFollowUps(auto, { mailProviderOverride: provider });
    expect(c).toMatchObject({ checked: 0, sent: 0 });
    expect(c.followUpPass).toBeUndefined();

    ai.release.resolve();
    expect(await a).toMatchObject({ checked: 1, sent: 1, failed: 0 });
    expect(ai.calls).toBe(1);
    expect(followUpSends(provider)).toBe(1);
    const row = await followUpRow(step.id);
    expect(row.status).toBe('sent');
    expect(row.sentMessageId).not.toBeNull();
    expect(row.sendingAt).not.toBeNull();

    // Nothing left to do for the next pass.
    expect(await processDueFollowUps(auto, { mailProviderOverride: provider })).toMatchObject({
      checked: 0,
      sent: 0,
    });
    expect(followUpSends(provider)).toBe(1);
  });

  it('a step cancelled while it is being written is not sent', async () => {
    const s = await setupQueueWorkspace();
    const provider = new MockMailProvider();
    const { step, auto, threadId } = await followUpFixture(s, provider);
    const ai = new TestAi({ gated: true });
    _setAIProviderForTests(ai);

    const pass = processDueFollowUps(auto, { mailProviderOverride: provider });
    await ai.entered.promise;
    // The prospect replies meanwhile: the reply pipeline cancels the steps.
    expect(await cancelFollowUps(queueCtx(s), threadId, 'replied')).toBeGreaterThanOrEqual(1);
    ai.release.resolve();
    expect(await pass).toMatchObject({ sent: 0, skipped: 1, failed: 0 });
    expect(followUpSends(provider)).toBe(0);
    expect(await followUpRow(step.id)).toMatchObject({ status: 'skipped', skipReason: 'replied' });
  });

  it('a step deferred mid-pass goes back to pending, unclaimed', async () => {
    const s = await setupQueueWorkspace();
    const provider = new MockMailProvider();
    const { step, auto } = await followUpFixture(s, provider);
    await db.update(mailboxes).set({ status: 'paused' }).where(eq(mailboxes.id, s.mailboxId));
    _setAIProviderForTests(new TestAi());
    expect(await processDueFollowUps(auto, { mailProviderOverride: provider })).toMatchObject({
      sent: 0,
      skipped: 1,
    });
    const row = await followUpRow(step.id);
    expect(row).toMatchObject({ status: 'pending', claimedAt: null, sendingAt: null });
    expect(row.lastError).toMatch(/mailbox is paused/);
  });

  it('the Scheduled tab lists and counts a step being processed; the CHECK keeps a claim dated', async () => {
    const s = await setupQueueWorkspace();
    const provider = new MockMailProvider();
    const { step } = await followUpFixture(s, provider);
    await db
      .update(outreachFollowUps)
      .set({ status: 'processing', claimedAt: new Date() })
      .where(eq(outreachFollowUps.id, step.id));
    const ctx = queueCtx(s);
    expect((await listFollowUps(ctx, { status: 'pending' })).map((r) => r.id)).toContain(step.id);
    const counts = await countFollowUpsByStatus(ctx);
    expect(counts.pending).toBeGreaterThanOrEqual(1);
    await expect(
      db
        .update(outreachFollowUps)
        .set({ claimedAt: null })
        .where(eq(outreachFollowUps.id, step.id)),
    ).rejects.toThrow(/outreach_follow_ups_processing_claim_check/);
  });
});

// ---- the stuck-work reaper and leases ------------------------------------------

describe('the reaper honours live leases and settles dead follow-up claims (PC-12)', () => {
  it('a send claimed by the pass holding the drain lease now is left alone; an older claim is reaped', async () => {
    const s = await setupQueueWorkspace();
    const ctx = queueCtx(s);
    const { entry } = await queuedDraft(s, 'anna@target.com');
    const claimedAt = new Date(Date.now() - 11 * 60_000);
    await db
      .update(outreachQueue)
      .set({ status: 'sending', claimedAt })
      .where(eq(outreachQueue.id, entry.id));

    // A pass that took the lease 20 minutes ago (and still renews) may be
    // the one sending it.
    await take(ctx, { kind: 'outreach.drain', autoRenew: false });
    await db
      .update(workLeases)
      .set({ acquiredAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(workLeases.workspaceId, s.workspaceId));
    expect(await reapStuckSends(ctx)).toEqual({ settledSent: [], failed: [] });
    expect((await queueRow(entry.id)).status).toBe('sending');

    // A pass that took the lease after the claim cannot have made it.
    await db
      .update(workLeases)
      .set({ acquiredAt: new Date(Date.now() - 60_000) })
      .where(eq(workLeases.workspaceId, s.workspaceId));
    expect(await reapStuckSends(ctx)).toEqual({ settledSent: [], failed: [entry.id] });
    expect((await queueRow(entry.id)).lastError).toMatch(new RegExp(`^${INTERRUPTED_SEND_REASON}`));
  });

  it('leaseCoversClaim: only a lease taken at or before the claim', () => {
    const at = new Date('2026-10-02T10:00:00Z');
    const held = (acquiredAt: Date) => ({
      kind: 'outreach.drain' as const,
      resourceKey: '',
      holderLabel: 'x',
      purpose: '',
      acquiredAt,
      expiresAt: new Date(acquiredAt.getTime() + 60_000),
    });
    expect(leaseCoversClaim(null, at)).toBe(false);
    expect(leaseCoversClaim(held(new Date(at.getTime() - 1)), at)).toBe(true);
    expect(leaseCoversClaim(held(at), at)).toBe(true);
    expect(leaseCoversClaim(held(new Date(at.getTime() + 1)), at)).toBe(false);
  });

  it('a dead pass\'s claim that never reached the mail server is scheduled again; one cut off mid-send fails, never re-sent', async () => {
    const s = await setupQueueWorkspace();
    const ctx = queueCtx(s);
    const provider = new MockMailProvider();
    const { step, threadId } = await followUpFixture(s, provider);
    const old = new Date(Date.now() - FOLLOW_UP_STUCK_AFTER_MS - 60_000);

    // A claim younger than the window is left alone.
    await db
      .update(outreachFollowUps)
      .set({ status: 'processing', claimedAt: new Date(Date.now() - 60_000) })
      .where(eq(outreachFollowUps.id, step.id));
    expect(await reapStuckFollowUps(ctx)).toEqual({ requeued: [], settledSent: [], failed: [] });

    // Old, never handed to the mail server: scheduled again.
    await db.update(outreachFollowUps).set({ claimedAt: old }).where(eq(outreachFollowUps.id, step.id));
    expect(await reapStuckFollowUps(ctx)).toEqual({ requeued: [step.id], settledSent: [], failed: [] });
    const requeued = await followUpRow(step.id);
    expect(requeued).toMatchObject({ status: 'pending', claimedAt: null });
    expect(requeued.lastError).toMatch(/Nothing was sent; it is scheduled again\.$/);
    expect(requeued.scheduledFor.getTime()).toBeLessThanOrEqual(Date.now());

    // Old, handed to the mail server (after the thread's last message), no
    // copy on the thread: failed.
    await db
      .update(outreachFollowUps)
      .set({ status: 'processing', claimedAt: old, sendingAt: new Date() })
      .where(eq(outreachFollowUps.id, step.id));
    // …unless the pass holding the follow-up lease now may still be on it.
    await take(ctx, { kind: 'outreach.follow_up', autoRenew: false });
    await db
      .update(workLeases)
      .set({ acquiredAt: new Date(old.getTime() - 60_000) })
      .where(eq(workLeases.workspaceId, s.workspaceId));
    expect(await reapStuckFollowUps(ctx)).toEqual({ requeued: [], settledSent: [], failed: [] });
    await db.delete(workLeases).where(eq(workLeases.workspaceId, s.workspaceId));
    expect(await reapStuckFollowUps(ctx)).toEqual({ requeued: [], settledSent: [], failed: [step.id] });
    const failed = await followUpRow(step.id);
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toMatch(new RegExp(`^${INTERRUPTED_SEND_REASON}`));

    // A copy on the thread from sending_at on (the thread's first touch
    // stands in for it here): it went out — 'sent'.
    await db
      .update(outreachFollowUps)
      .set({ status: 'processing', claimedAt: old, sendingAt: old })
      .where(eq(outreachFollowUps.id, step.id));
    const [copy] = await db
      .select({ id: mailMessages.id })
      .from(mailMessages)
      .where(and(eq(mailMessages.threadId, threadId), eq(mailMessages.direction, 'outbound')));
    expect(await reapStuckFollowUps(ctx)).toEqual({ requeued: [], settledSent: [step.id], failed: [] });
    expect(await followUpRow(step.id)).toMatchObject({ status: 'sent', sentMessageId: copy!.id });
  });
});

// ---- retention and rollback ------------------------------------------------

describe('PC-12 housekeeping', () => {
  it('retention deletes leases a dead holder left more than 7 days ago, and only those', async () => {
    const s = await setupQueueWorkspace();
    const ctx = queueCtx(s);
    await take(ctx, { kind: 'mailbox.sync', resource: 101n, autoRenew: false });
    await take(ctx, { kind: 'mailbox.sync', resource: 102n, autoRenew: false });
    await take(ctx, { kind: 'outreach.drain' });
    await db
      .update(workLeases)
      .set({ expiresAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) })
      .where(and(eq(workLeases.workspaceId, s.workspaceId), eq(workLeases.resourceKey, '101')));
    await db
      .update(workLeases)
      .set({ expiresAt: new Date(Date.now() - 60 * 60_000) })
      .where(and(eq(workLeases.workspaceId, s.workspaceId), eq(workLeases.resourceKey, '102')));
    const policy = RETENTION_POLICIES.find((p) => p.name === 'work_leases.expired')!;
    expect(policy.retentionDays).toBe(7);
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000);
    expect(await policy.deleteBatch(cutoff, 100)).toBe(1);
    const left = await db
      .select({ kind: workLeases.kind, resourceKey: workLeases.resourceKey })
      .from(workLeases)
      .where(eq(workLeases.workspaceId, s.workspaceId));
    expect(left.map((r) => `${r.kind}:${r.resourceKey}`).sort()).toEqual([
      'mailbox.sync:102',
      'outreach.drain:',
    ]);
  });

  it('the rollback settles claimed follow-ups and restores the previous shape', async () => {
    const s = await setupQueueWorkspace();
    const provider = new MockMailProvider();
    const { step } = await followUpFixture(s, provider);
    const [second] = await db
      .select()
      .from(outreachFollowUps)
      .where(and(eq(outreachFollowUps.workspaceId, s.workspaceId), eq(outreachFollowUps.stepNumber, 2)));
    await db
      .update(outreachFollowUps)
      .set({ status: 'processing', claimedAt: new Date() })
      .where(eq(outreachFollowUps.id, step.id));
    await db
      .update(outreachFollowUps)
      .set({ status: 'processing', claimedAt: new Date(), sendingAt: new Date() })
      .where(eq(outreachFollowUps.id, second!.id));

    const file = fs.readFileSync(
      path.resolve(__dirname, '../../drizzle/rollback/p1_workers_work_leases.down.sql'),
      'utf8',
    );
    const statements = file
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('--'))
      .join(' ')
      .split(';')
      .map((st) => st.trim())
      .filter((st) => st.length > 0);
    expect(statements.length).toBeGreaterThanOrEqual(5);

    // Applied inside a transaction that is then rolled back.
    await expect(
      db.transaction(async (tx) => {
        for (const st of statements) await tx.execute(sql.raw(st));
        const rows = (await tx.execute(
          sql`SELECT id, status, last_error FROM outreach_follow_ups WHERE id IN (${step.id}, ${second!.id}) ORDER BY id`,
        )) as unknown as Array<{ id: string; status: string; last_error: string | null }>;
        expect(rows.map((r) => r.status)).toEqual(['pending', 'failed']);
        expect(rows[1]!.last_error).toMatch(/^Interrupted: delivery unknown/);
        const cols = (await tx.execute(
          sql`SELECT column_name FROM information_schema.columns
              WHERE table_name = 'outreach_follow_ups' AND column_name IN ('claimed_at', 'sending_at')`,
        )) as unknown as unknown[];
        expect(cols).toEqual([]);
        const table = (await tx.execute(
          sql`SELECT to_regclass('public.work_leases')::text AS t`,
        )) as unknown as Array<{ t: string | null }>;
        expect(table[0]!.t).toBeNull();
        throw new Error('rollback-only');
      }),
    ).rejects.toThrow('rollback-only');
    expect(await followUpRow(step.id)).toMatchObject({ status: 'processing' });
  });
});
