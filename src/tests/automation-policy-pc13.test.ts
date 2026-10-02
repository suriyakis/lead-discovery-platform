// PC-13 (+ the backend of flow:F-08 and the ia:F-17 resolver): honest
// automation semantics. One resolveAutomationPolicy(ctx) decides what runs;
// per-product overlays are narrow-only and enforced (a paused product gets
// no autopilot work and its outbound mail waits); the dead toggles are
// gone; plan gating only applies to switching ON; the Crawl Engine page no
// longer writes autopilot settings; the CRM steps push only new or changed
// leads; getAutomationState is the header pill's read model.
//
// Acceptance map:
//   PC-13 (1) a product pause → 0 approvals / drafts / enqueues for it, its
//         queued rows stay queued ("product pause" describe)
//   PC-13 (2) widening overrides rejected ("narrow-only overrides")
//   PC-13 (3) removed toggles: migration + no readers ("dead toggles")
//   PC-13 (4) /connectors/engine has no autopilot form ("pages")
//   PC-13 (5) /autopilot copy matches the behaviour ("pages", "flow copy")
//   F-08: product A paused / B unaffected; lapsed plan saves off; second
//         CRM tick 0 calls; no syncInbound from autopilot; engine writes
//         no autopilot fields; flow view equals the resolver output.
//   F-17: state table + precedence; follow-up approval text; partly
//         paused lists what continues; every registered tick has a line.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/connectors/mock';
import fs from 'node:fs';
import path from 'node:path';
import type { ReactNode } from 'react';
import type { ZodSchema } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  _setAIProviderForTests,
  type AIGenInput,
  type AIGenResult,
  type IAIProvider,
} from '@/lib/ai';
import type { ICRMConnector, SyncResult } from '@/lib/crm';
import {
  InMemoryJobQueue,
  _setJobQueueForTests,
  getJobQueue,
  type JobPayload,
  type RepeatableJobOptions,
} from '@/lib/jobs';
import {
  _resetRepeatablesForTests,
  registerRepeatableJobs,
  runAutopilotTick,
} from '@/lib/jobs/repeatables';
import { MockMailProvider, type OutboundMessage, type SendResult } from '@/lib/mail';
import { auditLog } from '@/lib/db/schema/audit';
import {
  autopilotLog,
  autopilotProductSettings,
  autopilotSettings,
} from '@/lib/db/schema/autopilot';
import { sourceRecords } from '@/lib/db/schema/connectors';
import { contactAssociations, contacts } from '@/lib/db/schema/contacts';
import { crmConnections, crmSyncLog } from '@/lib/db/schema/crm';
import { outreachFollowUps } from '@/lib/db/schema/follow-ups';
import { mailMessages, mailThreads, mailboxes, type Mailbox } from '@/lib/db/schema/mailing';
import {
  outreachDrafts,
  outreachQueue,
  outreachThreadState,
} from '@/lib/db/schema/outreach';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { productProfiles } from '@/lib/db/schema/products';
import { qualifications } from '@/lib/db/schema/qualifications';
import { reviewItems } from '@/lib/db/schema/review';
import { workspaces } from '@/lib/db/schema/workspaces';
import type { AutomationState, EnforcedHold } from '@/lib/services/automation-gate';
import { MAINTENANCE_TICKS } from '@/lib/jobs/tick-catalog';
import { pauseAutomation } from '@/lib/services/automation-pause';
import {
  AUTOMATION_TICKS,
  autopilotFlow,
  buildAutomationPolicy,
  describeAutomationState,
  getAutomationState,
  policyPath,
  productPolicy,
  resolveAutomationPolicy,
  tickVerdict,
  type AutomationPolicyInputs,
  type ProductOverlayInput,
} from '@/lib/services/automation-policy';
import {
  WIDENING_OVERRIDE_MESSAGE,
  pauseProductAutomation,
  resumeProductAutomation,
  runOnce,
  switchesTurningOn,
  updateAutopilotSettings,
  upsertProductAutopilotSettings,
} from '@/lib/services/autopilot';
import { type WorkspaceContext, makeAutomationContext, makeWorkspaceContext } from '@/lib/services/context';
import { createCrmConnection } from '@/lib/services/crm';
import { processDueFollowUps, scheduleFollowUps, updateFollowUpConfig } from '@/lib/services/follow-up';
import { sendMessage } from '@/lib/services/mail';
import { createMailbox } from '@/lib/services/mailbox';
import { handleClassifiedReply } from '@/lib/services/outreach-reply-handler';
import { drainQueue } from '@/lib/services/outreach-queue';
import type { ReplyClassification } from '@/lib/services/reply-classifier';
import AutopilotPage from '@/app/(app)/autopilot/page';
import CrawlEnginePage from '@/app/(app)/connectors/engine/page';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { renderToHtml } from './helpers/next-render';

const session = vi.hoisted(() => ({
  current: null as null | { user: { id: string; role: 'member'; accountStatus: 'active' } },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => children,
}));

function signInAs(userId: string): void {
  session.current = { user: { id: userId, role: 'member', accountStatus: 'active' } };
}

const SRC = path.resolve(__dirname, '..');
const REPO = path.resolve(SRC, '..');

// ---- fixtures -------------------------------------------------------------

interface Tenant {
  workspaceId: bigint;
  ownerId: string;
  adminId: string;
  memberId: string;
  viewerId: string;
  owner: WorkspaceContext;
  admin: WorkspaceContext;
  member: WorkspaceContext;
  viewer: WorkspaceContext;
  auto: WorkspaceContext;
}

let seq = 0;

async function tenant(opts: { plan?: 'free' | 'starter' | 'pro'; live?: boolean } = {}): Promise<Tenant> {
  seq++;
  const ownerId = await seedUser({ email: `pc13-owner-${seq}@test.local` });
  const adminId = await seedUser({ email: `pc13-admin-${seq}@test.local` });
  const memberId = await seedUser({ email: `pc13-member-${seq}@test.local` });
  const viewerId = await seedUser({ email: `pc13-viewer-${seq}@test.local` });
  const workspaceId = await seedWorkspace({
    name: `pc13-${seq}`,
    ownerUserId: ownerId,
    plan: opts.plan,
    live: opts.live,
    extraMembers: [
      { userId: adminId, role: 'admin' },
      { userId: memberId, role: 'member' },
      { userId: viewerId, role: 'viewer' },
    ],
  });
  const c = (userId: string, role: WorkspaceContext['role']) =>
    makeWorkspaceContext({ workspaceId, userId, role });
  return {
    workspaceId,
    ownerId,
    adminId,
    memberId,
    viewerId,
    owner: c(ownerId, 'owner'),
    admin: c(adminId, 'admin'),
    member: c(memberId, 'member'),
    viewer: c(viewerId, 'viewer'),
    auto: makeAutomationContext(workspaceId, ownerId),
  };
}

async function product(t: Tenant, name: string) {
  const [row] = await db
    .insert(productProfiles)
    .values({ workspaceId: t.workspaceId, name })
    .returning();
  return row!;
}

/** A source record + review item + relevant qualification for `productId`;
 *  with `email`, also a pipeline lead carrying that contact email. */
async function item(
  t: Tenant,
  productId: bigint,
  state: 'new' | 'approved',
  opts: { score?: number; email?: string; leadState?: 'relevant' | 'qualified' } = {},
) {
  seq++;
  const [sr] = await db
    .insert(sourceRecords)
    .values({
      workspaceId: t.workspaceId,
      sourceSystem: 'mock',
      sourceId: `pc13-${seq}-${Math.random()}`,
      rawData: {},
      normalizedData: { title: `Project ${seq}`, companyName: `Company ${seq}` },
      sourceUrl: `https://example.com/${seq}`,
    })
    .returning();
  const [ri] = await db
    .insert(reviewItems)
    .values({ workspaceId: t.workspaceId, sourceRecordId: sr!.id, state })
    .returning();
  await db.insert(qualifications).values({
    workspaceId: t.workspaceId,
    sourceRecordId: sr!.id,
    productProfileId: productId,
    isRelevant: true,
    relevanceScore: opts.score ?? 90,
    confidence: 80,
    method: 'rules',
  });
  let lead = null;
  if (opts.email || opts.leadState) {
    [lead] = await db
      .insert(qualifiedLeads)
      .values({
        workspaceId: t.workspaceId,
        reviewItemId: ri!.id,
        productProfileId: productId,
        state: opts.leadState ?? 'relevant',
        contactEmail: opts.email ?? null,
      })
      .returning();
  }
  return { sourceRecord: sr!, reviewItem: ri!, lead };
}

async function makeMailbox(t: Tenant): Promise<Mailbox> {
  seq++;
  return createMailbox(t.owner, {
    name: `sales-${seq}`,
    fromAddress: `sales-${seq}@nulife.pl`,
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpUser: `sales-${seq}@nulife.pl`,
    smtpPassword: 'secret',
    imap: null,
    isDefault: true,
  });
}

/** A due queue row backed by an approved cold draft for `productId`. */
async function queuedDraftRow(t: Tenant, mailboxId: bigint, productId: bigint, to: string, ageMs = 60_000) {
  const { sourceRecord, reviewItem } = await item(t, productId, 'approved');
  const [draft] = await db
    .insert(outreachDrafts)
    .values({
      workspaceId: t.workspaceId,
      reviewItemId: reviewItem.id,
      sourceRecordId: sourceRecord.id,
      productProfileId: productId,
      status: 'approved',
      stage: 'discovery',
      subject: 'Hi',
      body: 'Body',
      method: 'rules',
    })
    .returning();
  const [row] = await db
    .insert(outreachQueue)
    .values({
      workspaceId: t.workspaceId,
      mailboxId,
      draftId: draft!.id,
      toAddresses: [to],
      subject: 'Hi',
      bodyText: 'Body',
      delayMode: 'immediate',
      scheduledSendAt: new Date(Date.now() - ageMs),
      status: 'queued',
      createdBy: t.ownerId,
    })
    .returning();
  return row!;
}

async function queueRow(id: bigint) {
  const [row] = await db.select().from(outreachQueue).where(eq(outreachQueue.id, id));
  return row!;
}

async function reviewState(id: bigint) {
  const [row] = await db.select().from(reviewItems).where(eq(reviewItems.id, id));
  return row!.state;
}

async function draftsFor(t: Tenant, productId: bigint) {
  return db
    .select()
    .from(outreachDrafts)
    .where(
      and(eq(outreachDrafts.workspaceId, t.workspaceId), eq(outreachDrafts.productProfileId, productId)),
    );
}

async function queueRowsForProduct(t: Tenant, productId: bigint) {
  return db
    .select({ q: outreachQueue })
    .from(outreachQueue)
    .innerJoin(outreachDrafts, eq(outreachDrafts.id, outreachQueue.draftId))
    .where(
      and(eq(outreachQueue.workspaceId, t.workspaceId), eq(outreachDrafts.productProfileId, productId)),
    );
}

async function auditRows(workspaceId: bigint, kind: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.kind, kind)));
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** The text React renders for a string (what the HTML contains). */
function htmlText(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

/** Counts AI calls; returns a plain text body. */
class CountingAi implements IAIProvider {
  public readonly id = 'counting';
  public readonly model = 'counting-1';
  public calls = 0;
  async generateText(_i: AIGenInput): Promise<AIGenResult> {
    this.calls++;
    return { text: 'Polite follow-up body.', model: this.model, usage: { inputTokens: 1, outputTokens: 1 } };
  }
  async generateJson<T>(_i: AIGenInput, schema: ZodSchema<T>): Promise<T> {
    this.calls++;
    return schema.parse({ naturalness: 90, issues: [], advice: [] });
  }
  estimateCost(): number {
    return 0;
  }
  async healthCheck() {
    return { ok: true, detail: 'counting' };
  }
}

/** A CRM connector that counts every call it gets. */
class CountingCrm implements ICRMConnector {
  public readonly id = 'counting-crm';
  public contactCalls = 0;
  public dealCalls = 0;
  constructor(private readonly outcome: 'succeeded' | 'failed' = 'succeeded') {}
  async push(): Promise<SyncResult> {
    this.contactCalls++;
    return this.outcome === 'succeeded'
      ? { outcome: 'succeeded', externalId: `contact-${this.contactCalls}`, payload: {}, response: {} }
      : { outcome: 'failed', error: 'HTTP 500', payload: {}, response: {} };
  }
  async pushDeal(): Promise<SyncResult> {
    this.dealCalls++;
    return { outcome: 'succeeded', externalId: `deal-${this.dealCalls}`, payload: {}, response: {} };
  }
  async testConnection() {
    return { ok: true };
  }
  get calls(): number {
    return this.contactCalls + this.dealCalls;
  }
}

beforeEach(async () => {
  await truncateAll();
  session.current = null;
});

afterEach(() => {
  _setAIProviderForTests(null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- (1) the product pause -------------------------------------------------

describe('product pause (PC-13 (1), F-08)', { timeout: 60_000 }, () => {
  it('product A paused: 0 approvals, drafts and enqueues for A; product B runs as before', async () => {
    const t = await tenant();
    await makeMailbox(t);
    const A = await product(t, 'Alpha');
    const B = await product(t, 'Beta');
    const aNew = await item(t, A.id, 'new');
    const bNew = await item(t, B.id, 'new');
    const aApproved = await item(t, A.id, 'approved', { email: 'anna@alpha-target.com' });
    const bApproved = await item(t, B.id, 'approved', { email: 'bob@beta-target.com' });
    void aApproved;
    void bApproved;
    await updateAutopilotSettings(t.owner, {
      autopilotEnabled: true,
      enableAutoApproveProjects: true,
      autoApproveThreshold: 50,
      enableAutoEnqueueOutreach: true,
    });
    await pauseProductAutomation(t.member, A.id);

    const run = await runOnce(t.auto);
    expect(run.steps.map((s) => s.step)).toEqual(['auto_approve_projects', 'auto_enqueue_outreach']);

    expect(await reviewState(aNew.reviewItem.id)).toBe('new');
    expect(await reviewState(bNew.reviewItem.id)).toBe('approved');
    expect(await draftsFor(t, A.id)).toHaveLength(0);
    expect(await queueRowsForProduct(t, A.id)).toHaveLength(0);
    expect((await draftsFor(t, B.id)).length).toBeGreaterThan(0);
    expect((await queueRowsForProduct(t, B.id)).length).toBeGreaterThan(0);

    // Resumed by an admin: A's work happens on the next run.
    await resumeProductAutomation(t.admin, A.id);
    await runOnce(t.auto);
    expect(await reviewState(aNew.reviewItem.id)).toBe('approved');
    expect((await queueRowsForProduct(t, A.id)).length).toBeGreaterThan(0);
  });

  it('a product switched off for one step only skips that step for it', async () => {
    const t = await tenant();
    const A = await product(t, 'Alpha');
    const B = await product(t, 'Beta');
    const aNew = await item(t, A.id, 'new');
    const bNew = await item(t, B.id, 'new');
    await updateAutopilotSettings(t.owner, {
      autopilotEnabled: true,
      enableAutoApproveProjects: true,
      autoApproveThreshold: 50,
    });
    await upsertProductAutopilotSettings(t.owner, {
      productProfileId: A.id,
      enableAutoApproveProjects: false,
    });
    const run = await runOnce(t.auto);
    expect(await reviewState(aNew.reviewItem.id)).toBe('new');
    expect(await reviewState(bNew.reviewItem.id)).toBe('approved');
    // A was left out of the candidates (it never uses up the per-run cap).
    expect(run.steps[0]).toMatchObject({ step: 'auto_approve_projects', detail: 'approved=1/1' });
  });

  it("the drain holds a paused product's queued rows (still queued, reason shown, never failed); B sends", async () => {
    const t = await tenant();
    const mb = await makeMailbox(t);
    const A = await product(t, 'Alpha');
    const B = await product(t, 'Beta');
    const a1 = await queuedDraftRow(t, mb.id, A.id, 'a1@alpha.example', 90_000);
    const b1 = await queuedDraftRow(t, mb.id, B.id, 'b1@beta.example', 80_000);
    await pauseProductAutomation(t.member, A.id);

    const r = await drainQueue(t.auto, { providerOverride: new MockMailProvider() });
    expect(r).toMatchObject({ sent: 1, failed: 0, deferred: 1 });
    const held = await queueRow(a1.id);
    expect(held.status).toBe('queued');
    expect(held.lastError).toContain('the product "Alpha" is paused');
    expect(held.claimedAt).toBeNull();
    expect((await queueRow(b1.id)).status).toBe('sent');
  });

  it('a product paused mid-drain holds its remaining rows from the next row on', async () => {
    const t = await tenant();
    const mb = await makeMailbox(t);
    const A = await product(t, 'Alpha');
    const first = await queuedDraftRow(t, mb.id, A.id, 'a1@alpha-one.example', 120_000);
    const second = await queuedDraftRow(t, mb.id, A.id, 'a2@alpha-two.example', 110_000);
    const third = await queuedDraftRow(t, mb.id, A.id, 'a3@alpha-three.example', 100_000);
    const member = t.member;
    // Pauses the product while the first row is being sent.
    class PausingProvider extends MockMailProvider {
      private paused = false;
      override async send(message: OutboundMessage): Promise<SendResult> {
        const result = await super.send(message);
        if (!this.paused) {
          this.paused = true;
          await pauseProductAutomation(member, A.id);
        }
        return result;
      }
    }
    const r = await drainQueue(t.auto, { providerOverride: new PausingProvider() });
    expect(r).toMatchObject({ sent: 1, deferred: 2, failed: 0 });
    expect((await queueRow(first.id)).status).toBe('sent');
    for (const row of [second, third]) {
      const after = await queueRow(row.id);
      expect(after.status).toBe('queued');
      expect(after.claimedAt).toBeNull();
    }
  });

  it("a paused product's due follow-up is not composed (0 AI calls), stays pending with the reason, and goes out after resume", async () => {
    const t = await tenant();
    const provider = new MockMailProvider();
    const mb = await makeMailbox(t);
    const P = await product(t, 'Alpha');
    const { reviewItem } = await item(t, P.id, 'approved');
    const first = await sendMessage(t.owner, {
      mode: 'sequence',
      origin: 'manual',
      mailboxId: mb.id,
      to: [{ address: 'lead@target.com' }],
      subject: 'Hi',
      text: 'first touch',
      providerOverride: provider,
    });
    const [lead] = await db
      .insert(qualifiedLeads)
      .values({
        workspaceId: t.workspaceId,
        reviewItemId: reviewItem.id,
        productProfileId: P.id,
        state: 'relevant',
        contactEmail: 'lead@target.com',
      })
      .returning();
    await db.insert(outreachThreadState).values({
      workspaceId: t.workspaceId,
      qualifiedLeadId: lead!.id,
      threadId: first.threadId!,
      stage: 'discovery',
    });
    await updateFollowUpConfig(t.owner, { requireApproval: false });
    await scheduleFollowUps(t.owner, { threadId: first.threadId!, qualifiedLeadId: lead!.id });
    const due = () =>
      db
        .update(outreachFollowUps)
        .set({ scheduledFor: new Date(Date.now() - 60_000) })
        .where(
          and(eq(outreachFollowUps.workspaceId, t.workspaceId), eq(outreachFollowUps.stepNumber, 1)),
        );
    await due();
    const ai = new CountingAi();
    _setAIProviderForTests(ai);
    await pauseProductAutomation(t.member, P.id);

    const held = await processDueFollowUps(t.auto, { mailProviderOverride: provider });
    expect(held).toMatchObject({ sent: 0, failed: 0 });
    expect(ai.calls).toBe(0);
    const [step] = await db
      .select()
      .from(outreachFollowUps)
      .where(
        and(eq(outreachFollowUps.workspaceId, t.workspaceId), eq(outreachFollowUps.stepNumber, 1)),
      );
    expect(step!.status).toBe('pending');
    expect(step!.lastError).toContain('the product "Alpha" is paused');

    await resumeProductAutomation(t.admin, P.id);
    await due();
    const after = await processDueFollowUps(t.auto, { mailProviderOverride: provider });
    expect(after.sent).toBe(1);
    expect(ai.calls).toBeGreaterThan(0);
  });

  it("no AI reply draft is written for a paused product's lead", async () => {
    const t = await tenant();
    const [mb] = await db
      .insert(mailboxes)
      .values({
        workspaceId: t.workspaceId,
        name: 'inbox',
        fromAddress: 'inbox@nulife.pl',
        smtpHost: 'smtp.x',
        smtpUser: 'inbox',
        smtpPasswordSecretKey: 'mailbox.smtp_pc13',
        imapFolder: 'INBOX',
        status: 'active',
      })
      .returning();
    const [thread] = await db
      .insert(mailThreads)
      .values({
        workspaceId: t.workspaceId,
        mailboxId: mb!.id,
        subject: 'Re: hi',
        externalThreadKey: `subj:pc13-${Date.now()}`,
        participants: ['anna@target.com', mb!.fromAddress],
      })
      .returning();
    const [msg] = await db
      .insert(mailMessages)
      .values({
        workspaceId: t.workspaceId,
        mailboxId: mb!.id,
        threadId: thread!.id,
        direction: 'inbound',
        status: 'received',
        messageId: `<reply-pc13-${Date.now()}>`,
        fromAddress: 'anna@target.com',
        toAddresses: [mb!.fromAddress],
        subject: 'Re: hi',
        bodyText: 'How does this work?',
        outreachRelevance: 'prospect_reply',
      })
      .returning();
    const [contact] = await db
      .insert(contacts)
      .values({ workspaceId: t.workspaceId, email: 'anna@target.com', name: 'Anna', status: 'active' })
      .returning();
    const P = await product(t, 'Alpha');
    const { reviewItem } = await item(t, P.id, 'new');
    const [lead] = await db
      .insert(qualifiedLeads)
      .values({
        workspaceId: t.workspaceId,
        reviewItemId: reviewItem.id,
        productProfileId: P.id,
        state: 'relevant',
        relevantAt: new Date(),
      })
      .returning();
    for (const [entityType, entityId] of [
      ['mail_thread', thread!.id],
      ['qualified_lead', lead!.id],
    ] as const) {
      await db.insert(contactAssociations).values({
        workspaceId: t.workspaceId,
        contactId: contact!.id,
        entityType,
        entityId: entityId.toString(),
      });
    }
    const question: ReplyClassification = {
      type: 'question',
      confidence: 80,
      rationale: 'test',
      extractedEmails: [],
      suggestedAction: 'human_review',
    };
    const ai = new CountingAi();
    _setAIProviderForTests(ai);
    await pauseProductAutomation(t.member, P.id);
    const r = await handleClassifiedReply(t.auto, msg!.id, question);
    expect(r.draftIds).toEqual([]);
    expect(ai.calls).toBe(0);
    // Control: resumed, the same reply is drafted (the AI is asked).
    await resumeProductAutomation(t.admin, P.id);
    try {
      await handleClassifiedReply(t.auto, msg!.id, question);
    } catch {
      // The counting AI's text may not satisfy every drafting rule; the
      // point is that it was asked.
    }
    expect(ai.calls).toBeGreaterThan(0);
  });

  it('any write role pauses (idempotent, audited, never plan-gated); only owners and admins resume', async () => {
    const t = await tenant({ plan: 'free' });
    await db
      .update(workspaces)
      .set({ tokenBalance: 0n, subscriptionStatus: 'canceled' })
      .where(eq(workspaces.id, t.workspaceId));
    const P = await product(t, 'Alpha');
    await expect(pauseProductAutomation(t.viewer, P.id)).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await expect(pauseProductAutomation(t.member, P.id)).resolves.toMatchObject({
      alreadyPaused: false,
    });
    await expect(pauseProductAutomation(t.owner, P.id)).resolves.toMatchObject({
      alreadyPaused: true,
    });
    const paused = await auditRows(t.workspaceId, 'automation.product_paused');
    expect(paused).toHaveLength(1);
    expect(paused[0]!.userId).toBe(t.memberId);
    expect(paused[0]!.payload).toMatchObject({ productName: 'Alpha' });

    await expect(resumeProductAutomation(t.member, P.id)).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await expect(resumeProductAutomation(t.admin, P.id)).resolves.toEqual({ wasPaused: true });
    await expect(resumeProductAutomation(t.admin, P.id)).resolves.toEqual({ wasPaused: false });
    expect(await auditRows(t.workspaceId, 'automation.product_resumed')).toHaveLength(1);

    // Another workspace's product cannot be paused.
    const other = await tenant();
    await expect(pauseProductAutomation(other.owner, P.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

// ---- (2) narrow-only overrides ----------------------------------------------

describe('narrow-only overrides (PC-13 (2), I020)', { timeout: 60_000 }, () => {
  it('the service rejects every widening override and saves nothing', async () => {
    const t = await tenant();
    const P = await product(t, 'Alpha');
    await updateAutopilotSettings(t.owner, { autopilotEnabled: true, autoApproveThreshold: 70 });
    for (const field of [
      'autopilotEnabled',
      'enableAutoApproveProjects',
      'enableAutoEnqueueOutreach',
      'enableAutoCrmContactSync',
      'enableAutoCrmDealOnQualified',
    ] as const) {
      await expect(
        upsertProductAutopilotSettings(t.owner, {
          productProfileId: P.id,
          [field]: true as unknown as false,
        }),
      ).rejects.toMatchObject({ code: 'widening_override', message: WIDENING_OVERRIDE_MESSAGE });
    }
    await expect(
      upsertProductAutopilotSettings(t.owner, { productProfileId: P.id, autoApproveThreshold: 69 }),
    ).rejects.toMatchObject({ code: 'widening_override' });
    // The old per-product "emergency pause" is not an override any more.
    await expect(
      upsertProductAutopilotSettings(t.owner, {
        productProfileId: P.id,
        emergencyPause: true,
      } as unknown as Parameters<typeof upsertProductAutopilotSettings>[1]),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    const rows = await db
      .select()
      .from(autopilotProductSettings)
      .where(eq(autopilotProductSettings.workspaceId, t.workspaceId));
    expect(rows).toHaveLength(0);

    // Narrowing saves.
    await expect(
      upsertProductAutopilotSettings(t.owner, {
        productProfileId: P.id,
        enableAutoApproveProjects: false,
        autoApproveThreshold: 70,
      }),
    ).resolves.toMatchObject({ enableAutoApproveProjects: false, autoApproveThreshold: 70 });
  });

  it('the database refuses an "on" override too (narrow-only CHECK)', async () => {
    const t = await tenant();
    const P = await product(t, 'Alpha');
    let caught: unknown;
    try {
      await db.insert(autopilotProductSettings).values({
        workspaceId: t.workspaceId,
        productProfileId: P.id,
        enableAutoEnqueueOutreach: true,
      });
    } catch (err) {
      caught = err;
    }
    const text = `${(caught as Error | undefined)?.message ?? ''} ${String((caught as { cause?: unknown } | undefined)?.cause ?? '')} ${(caught as { constraint_name?: string } | undefined)?.constraint_name ?? ''}`;
    expect(text).toContain('autopilot_product_settings_narrow_only_check');
  });

  it("the resolver never lets a product widen, even if an 'on' value were stored", () => {
    const policy = buildAutomationPolicy(
      inputs({
        autopilot: { enabled: true, steps: steps({ auto_approve_projects: false }) },
        overlays: [overlay(5n, { enableAutoApproveProjects: true, autoApproveThreshold: 10 })],
      }),
    );
    const p = productPolicy(policy, 5n);
    expect(p.steps.auto_approve_projects).toBe('workspace_off');
    expect(p.autoApproveThreshold).toBe(70);
  });
});

// ---- plan gating on transitions (I063) -------------------------------------

describe('plan gating applies only to switching ON (I063)', { timeout: 60_000 }, () => {
  it('switchesTurningOn: only false → true counts', () => {
    const current = {
      autopilotEnabled: true,
      enableAutoApproveProjects: true,
      enableAutoEnqueueOutreach: false,
      enableAutoCrmContactSync: false,
      enableAutoCrmDealOnQualified: false,
    };
    expect(switchesTurningOn(current, { autopilotEnabled: true, enableAutoApproveProjects: true })).toEqual([]);
    expect(switchesTurningOn(current, { enableAutoApproveProjects: false })).toEqual([]);
    expect(
      switchesTurningOn(current, { enableAutoEnqueueOutreach: true, enableAutoCrmDealOnQualified: true }),
    ).toEqual(['enableAutoEnqueueOutreach', 'enableAutoCrmDealOnQualified']);
  });

  it('on a lapsed plan: re-saving the form, switching off and pausing save; enabling a step shows the plan message', async () => {
    const t = await tenant({ plan: 'starter' });
    await updateAutopilotSettings(t.owner, {
      autopilotEnabled: true,
      enableAutoApproveProjects: true,
    });
    await db
      .update(workspaces)
      .set({ subscriptionStatus: 'canceled' })
      .where(eq(workspaces.id, t.workspaceId));

    // The form posts every switch: the ones already on stay on — saves.
    await expect(
      updateAutopilotSettings(t.owner, {
        autopilotEnabled: true,
        enableAutoApproveProjects: true,
        enableAutoEnqueueOutreach: false,
        enableAutoCrmContactSync: false,
        enableAutoCrmDealOnQualified: false,
        autoApproveThreshold: 80,
      }),
    ).resolves.toMatchObject({ autoApproveThreshold: 80 });
    // Turning a step ON is refused with the plan's own message.
    await expect(
      updateAutopilotSettings(t.owner, { enableAutoEnqueueOutreach: true }),
    ).rejects.toMatchObject({ code: 'plan_limit', message: expect.stringContaining('Autopilot needs a subscription') });
    // Off saves; the pause works.
    await expect(
      updateAutopilotSettings(t.owner, { autopilotEnabled: false, enableAutoApproveProjects: false }),
    ).resolves.toMatchObject({ autopilotEnabled: false });
    await expect(pauseAutomation(t.member, { source: 'api' })).resolves.toMatchObject({
      alreadyPaused: false,
    });
  });
});

// ---- CRM steps (I072) -------------------------------------------------------

describe('autopilot CRM steps push only new or changed leads (I072)', { timeout: 60_000 }, () => {
  async function crmFixture() {
    const t = await tenant();
    const A = await product(t, 'Alpha');
    const B = await product(t, 'Beta');
    const a = await item(t, A.id, 'approved', { email: 'a@a.example', leadState: 'qualified' });
    const b = await item(t, B.id, 'approved', { email: 'b@b.example', leadState: 'qualified' });
    const conn = await createCrmConnection(t.owner, {
      system: 'hubspot',
      name: 'HS',
      credential: 'pat-test',
    });
    return { t, A, B, leadA: a.lead!, leadB: b.lead!, conn };
  }

  it('a second run makes 0 connector calls; a changed lead is pushed again', async () => {
    const { t, leadA } = await crmFixture();
    await updateAutopilotSettings(t.owner, {
      autopilotEnabled: true,
      enableAutoCrmContactSync: true,
      enableAutoCrmDealOnQualified: true,
    });
    const crm = new CountingCrm();
    await runOnce(t.auto, { crmConnectorOverride: crm });
    expect({ contacts: crm.contactCalls, deals: crm.dealCalls }).toEqual({ contacts: 2, deals: 2 });

    const before = crm.calls;
    const second = await runOnce(t.auto, { crmConnectorOverride: crm });
    expect(crm.calls - before).toBe(0);
    expect(second.steps).toEqual([
      { step: 'auto_crm_contact_sync', outcome: 'success', detail: 'synced=0/0' },
      { step: 'auto_crm_deal_on_qualified', outcome: 'success', detail: 'created=0/0' },
    ]);

    // Lead A changes: its contact and deal are pushed once more, B's are not.
    await db
      .update(qualifiedLeads)
      .set({ contactName: 'Anna', updatedAt: new Date(Date.now() + 1000) })
      .where(eq(qualifiedLeads.id, leadA.id));
    const beforeChange = { c: crm.contactCalls, d: crm.dealCalls };
    await runOnce(t.auto, { crmConnectorOverride: crm });
    expect({ c: crm.contactCalls - beforeChange.c, d: crm.dealCalls - beforeChange.d }).toEqual({ c: 1, d: 1 });
  });

  it('the deal step skips quietly without a synced contact, in id order', async () => {
    const { t } = await crmFixture();
    await updateAutopilotSettings(t.owner, {
      autopilotEnabled: true,
      enableAutoCrmDealOnQualified: true,
    });
    const crm = new CountingCrm();
    const run = await runOnce(t.auto, { crmConnectorOverride: crm });
    expect(crm.calls).toBe(0);
    expect(run.steps).toEqual([
      { step: 'auto_crm_deal_on_qualified', outcome: 'success', detail: 'created=0/0' },
    ]);
    const errors = await db
      .select()
      .from(autopilotLog)
      .where(and(eq(autopilotLog.workspaceId, t.workspaceId), eq(autopilotLog.outcome, 'error')));
    expect(errors).toHaveLength(0);
    expect(readSrc('lib/services/autopilot.ts')).toMatch(/orderBy\(asc\(qualifiedLeads\.id\)\)/);
  });

  it('a failed push is retried after an hour, not on every run', async () => {
    const { t } = await crmFixture();
    await updateAutopilotSettings(t.owner, { autopilotEnabled: true, enableAutoCrmContactSync: true });
    const failing = new CountingCrm('failed');
    await runOnce(t.auto, { crmConnectorOverride: failing });
    expect(failing.contactCalls).toBe(2);
    await runOnce(t.auto, { crmConnectorOverride: failing });
    expect(failing.contactCalls).toBe(2);
    // An hour later they are tried again.
    await db
      .update(crmSyncLog)
      .set({ createdAt: sql`now() - interval '2 hours'` })
      .where(eq(crmSyncLog.workspaceId, t.workspaceId));
    await db
      .update(qualifiedLeads)
      .set({ updatedAt: sql`now() - interval '3 hours'` })
      .where(eq(qualifiedLeads.workspaceId, t.workspaceId));
    // (A failed push marks the connection failing; autopilot uses only an
    // active one, so the operator's fix is simulated.)
    await db
      .update(crmConnections)
      .set({ status: 'active' })
      .where(eq(crmConnections.workspaceId, t.workspaceId));
    await runOnce(t.auto, { crmConnectorOverride: failing });
    expect(failing.contactCalls).toBe(4);
  });

  it("a paused product's leads are not pushed", async () => {
    const { t, A } = await crmFixture();
    await updateAutopilotSettings(t.owner, { autopilotEnabled: true, enableAutoCrmContactSync: true });
    await pauseProductAutomation(t.member, A.id);
    const crm = new CountingCrm();
    await runOnce(t.auto, { crmConnectorOverride: crm });
    expect(crm.contactCalls).toBe(1);
  });
});

// ---- (3) the dead toggles ---------------------------------------------------

describe('dead toggles are gone (PC-13 (3), I019, I067)', { timeout: 60_000 }, () => {
  const DEAD =
    /enableAutoDrainQueue|enableAutoSyncInbound|autoSendReplies|enable_auto_drain_queue|enable_auto_sync_inbound|auto_send_replies|stepAutoSyncInbound|stepAutoDrainQueue|auto_sync_inbound|auto_drain_queue/;

  it('no code reads or writes them (only the deprecated schema columns remain)', () => {
    const allowed = new Set(['lib/db/schema/autopilot.ts', 'lib/db/schema/workspaces.ts']);
    const offenders: string[] = [];
    for (const dir of ['app', 'lib', 'components']) {
      for (const file of walk(path.join(SRC, dir))) {
        const rel = path.relative(SRC, file).split(path.sep).join('/');
        if (allowed.has(rel)) continue;
        if (DEAD.test(fs.readFileSync(file, 'utf8'))) offenders.push(rel);
      }
    }
    if (DEAD.test(fs.readFileSync(path.join(REPO, 'scripts', 'seed-demo.ts'), 'utf8'))) {
      offenders.push('scripts/seed-demo.ts');
    }
    expect(offenders).toEqual([]);
    for (const rel of ['lib/db/schema/autopilot.ts', 'lib/db/schema/workspaces.ts']) {
      expect(readSrc(rel)).toMatch(/@deprecated PC-13/);
    }
  });

  it('autopilot never syncs inbound mail or drains the queue itself', () => {
    const autopilot = readSrc('lib/services/autopilot.ts');
    expect(autopilot).not.toMatch(/\bsyncInbound\b|\bsafeSyncOne\b|\bdrainQueue\b/);
  });

  it('the migration zeroes and deprecates them', () => {
    const file = fs
      .readdirSync(path.join(REPO, 'drizzle'))
      .filter((f) => f.endsWith('_p1_automation_control_policy.sql'))
      .map((f) => fs.readFileSync(path.join(REPO, 'drizzle', f), 'utf8'))[0];
    expect(file).toBeDefined();
    const custom = file!.slice(file!.indexOf('-- custom:begin'), file!.indexOf('-- custom:end'));
    expect(custom).toMatch(/SET "enable_auto_drain_queue" = false,\s+"enable_auto_sync_inbound" = false/);
    expect(custom).toMatch(/SET "auto_send_replies" = false/);
    for (const col of ['enable_auto_drain_queue', 'enable_auto_sync_inbound', 'auto_send_replies']) {
      expect(custom).toContain(`."${col}" IS 'Deprecated (PC-13`);
    }
  });

  it('the migration carries a per-product emergency pause into the product pause, clears "on" overrides and adds the CHECK', async () => {
    const t = await tenant();
    const P = await product(t, 'Alpha');
    const Q = await product(t, 'Beta');
    const file = fs
      .readdirSync(path.join(REPO, 'drizzle'))
      .filter((f) => f.endsWith('_p1_automation_control_policy.sql'))
      .map((f) => fs.readFileSync(path.join(REPO, 'drizzle', f), 'utf8'))[0]!;
    const custom = file.slice(file.indexOf('-- custom:begin'), file.indexOf('-- custom:end'));
    await db.execute(
      sql.raw(
        'ALTER TABLE "autopilot_product_settings" DROP CONSTRAINT "autopilot_product_settings_narrow_only_check"',
      ),
    );
    try {
      await db.insert(autopilotProductSettings).values([
        {
          workspaceId: t.workspaceId,
          productProfileId: P.id,
          emergencyPause: true,
          enableAutoApproveProjects: true,
          enableAutoEnqueueOutreach: false,
          updatedBy: t.adminId,
        },
        { workspaceId: t.workspaceId, productProfileId: Q.id, autopilotEnabled: true },
      ]);
      await db.insert(autopilotSettings).values({
        workspaceId: t.workspaceId,
        enableAutoDrainQueue: true,
        enableAutoSyncInbound: true,
      });
      await db.update(workspaces).set({ autoSendReplies: true }).where(eq(workspaces.id, t.workspaceId));
    } finally {
      for (const stmt of custom.split('--> statement-breakpoint')) {
        if (stmt.replace(/--.*$/gm, '').trim()) await db.execute(sql.raw(stmt));
      }
    }

    const rows = await db
      .select()
      .from(autopilotProductSettings)
      .where(eq(autopilotProductSettings.workspaceId, t.workspaceId));
    const p = rows.find((r) => r.productProfileId === P.id)!;
    expect(p.pausedAt).not.toBeNull();
    expect(p.pausedByUserId).toBe(t.adminId);
    expect(p.emergencyPause).toBeNull();
    expect(p.enableAutoApproveProjects).toBeNull();
    expect(p.enableAutoEnqueueOutreach).toBe(false);
    expect(rows.find((r) => r.productProfileId === Q.id)!.autopilotEnabled).toBeNull();
    const [audit] = await auditRows(t.workspaceId, 'automation.product_paused');
    expect(audit!.payload).toMatchObject({ source: 'legacy_overlay_migration' });
    const [ap] = await db
      .select()
      .from(autopilotSettings)
      .where(eq(autopilotSettings.workspaceId, t.workspaceId));
    expect(ap).toMatchObject({ enableAutoDrainQueue: false, enableAutoSyncInbound: false });
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, t.workspaceId));
    expect(ws!.autoSendReplies).toBe(false);
    // The product is now really paused.
    expect(productPolicy(await resolveAutomationPolicy(t.owner), P.id).pause).not.toBeNull();
  });

  it('/settings/outreach no longer offers "Auto-send replies"', () => {
    const page = readSrc('app/(app)/settings/outreach/page.tsx');
    expect(page).not.toContain('Auto-send replies');
    expect(page).toContain('never sent on its own');
  });
});

// ---- every tick uses the policy ---------------------------------------------

describe('one policy for every tick (F-08)', { timeout: 60_000 }, () => {
  it('every tick body iterates workspacesForTick and asks tickVerdict', () => {
    const src = readSrc('lib/jobs/repeatables.ts');
    expect(src).not.toMatch(/\bactiveWorkspacesForTicks\(/);
    expect(src).not.toContain('imapAutoSyncEnabled');
    const bodies = src.split(/export async function run\w+Tick/).slice(1);
    expect(bodies.length).toBe(AUTOMATION_TICKS.length);
    for (const body of bodies) {
      const fnBody = body.slice(0, body.indexOf('\n}\n'));
      expect(fnBody).toContain('workspacesForTick(');
      expect(fnBody).toMatch(/shouldRun\(ws, '[a-z._]+'/);
    }
  });

  it('autopilot off: the tick does not run it (no log row every 5 minutes)', async () => {
    const t = await tenant();
    expect(await runAutopilotTick()).toMatchObject({ stepsRun: 0, held: 0, failed: 0 });
    const rows = await db.select().from(autopilotLog).where(eq(autopilotLog.workspaceId, t.workspaceId));
    expect(rows).toHaveLength(0);
  });

  it('tickVerdict: held by the gate first, then off by configuration', () => {
    const base = buildAutomationPolicy(inputs());
    expect(tickVerdict(base, 'outreach.drain.tick')).toEqual({ run: true });
    expect(tickVerdict(base, 'autopilot.tick')).toEqual({ run: false, off: 'autopilot is off' });
    expect(tickVerdict(base, 'crawl.engine.tick')).toEqual({ run: true });
    const paused = buildAutomationPolicy(
      inputs({ state: { pause: pause() }, autopilot: { enabled: true } }),
    );
    expect(tickVerdict(paused, 'autopilot.tick')).toMatchObject({ run: false, held: { reason: 'paused' } });
    expect(tickVerdict(paused, 'mail.imap.tick')).toEqual({ run: true });
    const noSync = buildAutomationPolicy(inputs({ workspace: { imapAutoSyncEnabled: false } }));
    expect(tickVerdict(noSync, 'mail.imap.tick')).toEqual({ run: false, off: 'mailbox auto-sync is off' });
    const noPlans = buildAutomationPolicy(inputs({ enabledCrawlPlans: 0 }));
    expect(tickVerdict(noPlans, 'crawl.engine.tick')).toEqual({ run: false, off: 'no crawl plan is enabled' });
  });

  it('tickVerdict: autopilot that is off is off, never held, so a free plan is not logged every 5 minutes', () => {
    const freeOff = buildAutomationPolicy(inputs({ state: { planAllowsAutopilot: false } }));
    expect(tickVerdict(freeOff, 'autopilot.tick')).toEqual({ run: false, off: 'autopilot is off' });
    const pausedOff = buildAutomationPolicy(inputs({ state: { pause: pause() } }));
    expect(tickVerdict(pausedOff, 'autopilot.tick')).toEqual({ run: false, off: 'autopilot is off' });
    // Switched on without a plan that includes it: held, and counted.
    const freeOn = buildAutomationPolicy(
      inputs({ state: { planAllowsAutopilot: false }, autopilot: { enabled: true } }),
    );
    expect(tickVerdict(freeOn, 'autopilot.tick')).toMatchObject({
      run: false,
      held: { reason: 'plan_no_autopilot' },
    });
  });

  it('the autopilot tick neither counts nor logs a free-plan workspace whose autopilot is off', async () => {
    await tenant({ plan: 'free' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await runAutopilotTick();
      expect(r).toMatchObject({ stepsRun: 0, held: 0, failed: 0 });
      expect(warn.mock.calls.filter(([m]) => String(m).includes('[autopilot.tick]'))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('tickVerdict: other ticks still ask the gate before the configuration', () => {
    const paused = buildAutomationPolicy(
      inputs({ state: { pause: pause() }, workspace: { followUpEnabled: false } }),
    );
    expect(tickVerdict(paused, 'outreach.follow_up.tick')).toMatchObject({
      run: false,
      held: { reason: 'paused' },
    });
    const noSync = buildAutomationPolicy(inputs({ workspace: { imapAutoSyncEnabled: false } }));
    expect(tickVerdict(noSync, 'mail.imap.tick')).toEqual({ run: false, off: 'mailbox auto-sync is off' });
    const noPlans = buildAutomationPolicy(inputs({ enabledCrawlPlans: 0 }));
    expect(tickVerdict(noPlans, 'crawl.engine.tick')).toEqual({ run: false, off: 'no crawl plan is enabled' });
  });
});

// ---- (4) + (5) pages ------------------------------------------------------------

describe('pages (PC-13 (4), (5))', { timeout: 60_000 }, () => {
  it('/connectors/engine has no autopilot form and links to /autopilot', async () => {
    const t = await tenant();
    await updateAutopilotSettings(t.owner, { autopilotEnabled: true, enableAutoApproveProjects: true });
    signInAs(t.adminId);
    const tree = await CrawlEnginePage({ searchParams: Promise.resolve({}) });
    const html = (await renderToHtml(tree)).replaceAll('<!-- -->', '');
    for (const field of [
      'autopilotEnabled',
      'enableAutoApproveProjects',
      'enableAutoEnqueueOutreach',
      'autoApproveThreshold',
    ]) {
      expect(html).not.toContain(`name="${field}"`);
    }
    expect(html).toContain('href="/autopilot"');
    expect(html).toContain('Autopilot ON');
    const actions = await import('@/app/(app)/connectors/engine/actions');
    expect(Object.keys(actions).sort()).toEqual(
      ['createPlan', 'deletePlanAction', 'reclassifyAll', 'runPlanAction', 'savePlan'].sort(),
    );
    expect(readSrc('app/(app)/connectors/engine/actions.ts')).not.toMatch(/updateAutopilotSettings/);
  });

  it('/autopilot renders exactly the resolver flow, and its copy has no dead switches', async () => {
    const t = await tenant();
    await makeMailbox(t);
    await updateAutopilotSettings(t.owner, {
      autopilotEnabled: true,
      enableAutoApproveProjects: true,
    });
    signInAs(t.adminId);
    const tree = await AutopilotPage({ searchParams: Promise.resolve({}) });
    const html = (await renderToHtml(tree)).replaceAll('<!-- -->', '');
    const flow = autopilotFlow(await resolveAutomationPolicy(t.owner), null);
    for (const step of flow) {
      expect(html).toContain(`data-flow-step="${step.key}" data-flow-status="${step.status}"`);
      expect(html).toContain(htmlText(step.label));
      expect(html).toContain(htmlText(step.blurb));
    }
    expect(flow.find((s) => s.key === 'send_queue')!.status).toBe('always');
    for (const dead of [
      'name="enableAutoDrainQueue"',
      'name="enableAutoSyncInbound"',
      'Auto-drain',
      'Sync inbound mail',
      'Each step shows whether it is currently running',
      'explicitly turn that step on/off',
    ]) {
      expect(html).not.toContain(dead);
    }
    expect(html).toContain('always on in the background');
  });

  it("/autopilot for a product: only inherit / off, and a Pause button; a paused product's flow holds its mail", async () => {
    const t = await tenant();
    const P = await product(t, 'Alpha');
    await updateAutopilotSettings(t.owner, { autopilotEnabled: true, enableAutoApproveProjects: true });
    signInAs(t.adminId);
    let html = (
      await renderToHtml(await AutopilotPage({ searchParams: Promise.resolve({ scope: P.id.toString() }) }))
    ).replaceAll('<!-- -->', '');
    expect(html).toContain('value="inherit"');
    expect(html).toContain('value="off"');
    expect(html).not.toMatch(/type="radio"[^>]*value="on"/);
    expect(html).toContain('Pause Alpha');
    expect(html).toContain(htmlText('A product can only narrow what the workspace runs'));

    await pauseProductAutomation(t.member, P.id);
    html = (
      await renderToHtml(await AutopilotPage({ searchParams: Promise.resolve({ scope: P.id.toString() }) }))
    ).replaceAll('<!-- -->', '');
    expect(html).toContain('Resume Alpha');
    expect(html).toContain('data-flow-step="send_queue" data-flow-status="held"');
    expect(html).toContain('data-flow-step="auto_approve" data-flow-status="held"');
  });
});

// ---- the flow copy (snapshot of the resolver output) ----------------------------

describe('the /autopilot flow copy matches the behaviour (PC-13 (5))', () => {
  it('workspace scope: autopilot on, auto-approve + generate on, CRM off, live, one crawl plan', () => {
    const policy = buildAutomationPolicy(
      inputs({
        autopilot: {
          enabled: true,
          steps: steps({ auto_approve_projects: true, auto_enqueue_outreach: true }),
        },
      }),
    );
    expect(autopilotFlow(policy, null)).toEqual([
      {
        key: 'discovery',
        label: '1. Discovery',
        status: 'on',
        blurb: '1 crawl plan runs on schedule; found records are qualified against your products.',
      },
      {
        key: 'classify',
        label: '2. Classify',
        status: 'inline',
        blurb: 'AI scores every new record against each active product as it lands.',
      },
      {
        key: 'auto_approve',
        label: '3. Auto-approve',
        status: 'on',
        blurb:
          'Review items still "new" scoring 70 or more are approved once each, recorded as autopilot\'s decision; no person looks at them.',
      },
      {
        key: 'generate_queue',
        label: '4. Generate + queue',
        status: 'on',
        blurb:
          "For each approved item whose pipeline lead has a contact email, writes a template draft per relevant product, approves it in the owner's name and queues it, oldest approval first; nobody reviews these emails.",
      },
      {
        key: 'send_queue',
        label: '5. Send queue',
        status: 'always',
        blurb:
          "Always on in the background, whatever autopilot says. Approved emails send automatically every 30 seconds, within each mailbox's sending window and the daily cap.",
      },
      {
        key: 'replies',
        label: '6. Classify replies',
        status: 'inline',
        blurb:
          'Replies to your outreach are classified as they arrive. Inbox sync: replies are read every 2 minutes. Reply auto-actions: create contacts from redirect replies.',
      },
      {
        key: 'crm',
        label: '7. Hand over to CRM',
        status: 'off',
        blurb: 'Off: leads reach the CRM only when someone pushes them.',
      },
    ]);
  });

  it('autopilot off: its steps say so; the send queue is still always on', () => {
    const flow = autopilotFlow(buildAutomationPolicy(inputs()), null);
    expect(flow.find((s) => s.key === 'auto_approve')).toMatchObject({
      status: 'off',
      blurb: 'Off: autopilot is off.',
    });
    expect(flow.find((s) => s.key === 'send_queue')!.status).toBe('always');
  });

  it('paused workspace and not live: steps and the queue say why they wait', () => {
    const paused = autopilotFlow(
      buildAutomationPolicy(
        inputs({
          state: { pause: pause() },
          autopilot: { enabled: true, steps: steps({ auto_approve_projects: true }) },
        }),
      ),
      null,
    );
    expect(paused.find((s) => s.key === 'auto_approve')!.status).toBe('held');
    expect(paused.find((s) => s.key === 'send_queue')!.status).toBe('held');
    const notLive = autopilotFlow(buildAutomationPolicy(inputs({ state: { live: null } })), null);
    expect(notLive.find((s) => s.key === 'send_queue')).toMatchObject({
      status: 'partial',
      blurb: expect.stringContaining('Not live yet'),
    });
  });

  it('product scope: off, paused and a higher threshold show for that product', () => {
    const policy = buildAutomationPolicy(
      inputs({
        autopilot: {
          enabled: true,
          steps: steps({ auto_approve_projects: true, auto_enqueue_outreach: true }),
        },
        overlays: [
          overlay(1n, { enableAutoEnqueueOutreach: false, autoApproveThreshold: 85 }),
          overlay(2n, { pausedAt: T0 }),
        ],
      }),
    );
    const one = autopilotFlow(policy, 1n);
    expect(one.find((s) => s.key === 'auto_approve')!.blurb).toContain('scoring 85 or more');
    expect(one.find((s) => s.key === 'generate_queue')).toMatchObject({
      status: 'off',
      blurb: 'Off for this product.',
    });
    const two = autopilotFlow(policy, 2n);
    expect(two.find((s) => s.key === 'auto_approve')).toMatchObject({
      status: 'held',
      blurb: 'Held: this product is paused.',
    });
    expect(two.find((s) => s.key === 'send_queue')!.status).toBe('held');
    // A product with no overlay inherits.
    expect(autopilotFlow(policy, 3n).find((s) => s.key === 'generate_queue')!.status).toBe('on');
  });
});

// ---- ia:F-17: the header pill ------------------------------------------------------

const T0 = new Date('2026-10-02T08:00:00.000Z');

function gateState(over: Partial<AutomationState> = {}): AutomationState {
  return {
    workspaceId: 1n,
    workspaceStatus: 'active',
    ownerUserId: 'owner-1',
    ownerAccountStatus: 'active',
    ownerIsMember: true,
    ownerProblem: null,
    ownerIncidentOpenSince: null,
    holds: [],
    platformOutboundStop: null,
    pause: null,
    live: { since: T0, byUserId: null },
    walletHasTokens: true,
    planAllowsAutopilot: true,
    evaluatedAt: T0,
    ...over,
  };
}

function pause() {
  return { since: T0, byUserId: 'member-1', reason: null, source: 'api' };
}

function hold(over: Partial<EnforcedHold>): EnforcedHold {
  return {
    id: 9n,
    scope: 'capabilities',
    capabilities: ['sending'],
    source: 'tenant',
    reason: 'checking deliverability',
    expiresAt: null,
    placedAt: T0,
    blocksAccess: false,
    ...over,
  };
}

function steps(over: Partial<Record<string, boolean>> = {}) {
  return {
    auto_approve_projects: false,
    auto_enqueue_outreach: false,
    auto_crm_contact_sync: false,
    auto_crm_deal_on_qualified: false,
    ...over,
  } as AutomationPolicyInputs['autopilot']['steps'];
}

function overlay(productProfileId: bigint, over: Partial<ProductOverlayInput> = {}): ProductOverlayInput {
  return {
    productProfileId,
    productName: `Product ${productProfileId}`,
    autopilotEnabled: null,
    enableAutoApproveProjects: null,
    autoApproveThreshold: null,
    enableAutoEnqueueOutreach: null,
    enableAutoCrmContactSync: null,
    enableAutoCrmDealOnQualified: null,
    defaultMailboxId: null,
    pausedAt: null,
    pausedByUserId: null,
    ...over,
  };
}

function inputs(
  over: {
    state?: Partial<AutomationState>;
    autopilot?: Partial<AutomationPolicyInputs['autopilot']>;
    overlays?: ProductOverlayInput[];
    workspace?: Partial<AutomationPolicyInputs['workspace']>;
    replyActions?: Partial<AutomationPolicyInputs['replyActions']>;
    enabledCrawlPlans?: number;
    imapMailboxes?: number;
    failingMailboxes?: number;
  } = {},
): AutomationPolicyInputs {
  return {
    state: gateState(over.state),
    autopilot: {
      enabled: false,
      steps: steps(),
      autoApproveThreshold: 70,
      maxApprovalsPerRun: 20,
      maxEnqueuesPerRun: 20,
      defaultMailboxId: null,
      defaultCrmConnectionId: null,
      ...over.autopilot,
    },
    overlays: over.overlays ?? [],
    workspace: {
      followUpEnabled: true,
      followUpRequireApproval: true,
      imapAutoSyncEnabled: true,
      autoDraftReplies: true,
      autoTopupEnabled: false,
      healthCheckEnabled: true,
      healthCheckIntervalDays: 7,
      trashRetentionDays: 30,
      ...over.workspace,
    },
    replyActions: {
      autoSuppressUnsubscribe: false,
      autoSuppressBounce: false,
      autoCloseNegative: false,
      autoExtractRedirects: true,
      ...over.replyActions,
    },
    enabledCrawlPlans: over.enabledCrawlPlans ?? 1,
    imapMailboxes: over.imapMailboxes ?? 1,
    failingMailboxes: over.failingMailboxes ?? 0,
  };
}

describe('getAutomationState: states and precedence (ia:F-17)', () => {
  const AP_ON = { enabled: true, steps: steps({ auto_approve_projects: true }) };
  const cases: Array<{
    name: string;
    input: Parameters<typeof inputs>[0];
    kind: string;
    label: string;
  }> = [
    { name: 'nothing set', input: {}, kind: 'manual', label: 'Manual' },
    { name: 'autopilot on', input: { autopilot: AP_ON }, kind: 'autopilot_on', label: 'Autopilot on' },
    {
      name: 'autopilot on without a plan that includes it',
      input: { autopilot: AP_ON, state: { planAllowsAutopilot: false } },
      kind: 'blocked',
      label: 'Blocked',
    },
    {
      name: 'no accountable owner (beats autopilot on)',
      input: {
        autopilot: AP_ON,
        state: { ownerProblem: 'owner_inactive', ownerAccountStatus: 'suspended' },
      },
      kind: 'blocked',
      label: 'Blocked',
    },
    {
      name: 'archived',
      input: { state: { workspaceStatus: 'archived' } },
      kind: 'blocked',
      label: 'Blocked',
    },
    {
      name: 'paused (beats blocked)',
      input: { autopilot: AP_ON, state: { pause: pause(), ownerProblem: 'owner_not_member' } },
      kind: 'paused',
      label: 'Paused',
    },
    {
      name: 'a workspace hold on everything',
      input: { state: { holds: [hold({ scope: 'all', capabilities: [] })] } },
      kind: 'paused',
      label: 'Paused',
    },
    {
      name: 'the platform-wide outbound stop (beats paused)',
      input: {
        state: {
          pause: pause(),
          platformOutboundStop: { since: T0, byUserId: 'sa', reason: 'provider incident' },
        },
      },
      kind: 'stopped_by_platform',
      label: 'Stopped by platform',
    },
    {
      name: 'a platform hold on Sending',
      input: { state: { holds: [hold({ source: 'platform', reason: 'abuse report' })] } },
      kind: 'stopped_by_platform',
      label: 'Stopped by platform',
    },
    {
      name: 'a workspace hold on Sending only',
      input: { state: { holds: [hold({})] } },
      kind: 'manual',
      label: 'Partly paused',
    },
    {
      name: 'a paused product with autopilot on',
      input: { autopilot: AP_ON, overlays: [overlay(4n, { pausedAt: T0 })] },
      kind: 'autopilot_on',
      label: 'Partly paused',
    },
  ];
  for (const c of cases) {
    it(`${c.name} → ${c.label}`, () => {
      const s = describeAutomationState(buildAutomationPolicy(inputs(c.input)));
      expect({ kind: s.kind, label: s.label }).toEqual({ kind: c.kind, label: c.label });
      expect(s.banner === null).toBe(!(c.kind === 'paused' || c.kind === 'stopped_by_platform'));
    });
  }

  it('the Manual one-liner comes from the real configuration: follow-ups without approval send automatically', () => {
    const withApproval = describeAutomationState(buildAutomationPolicy(inputs()));
    expect(withApproval.summary).toContain('wait for your approval before they send');
    const without = describeAutomationState(
      buildAutomationPolicy(
        inputs({
          workspace: { followUpRequireApproval: false },
          replyActions: { autoSuppressUnsubscribe: true },
        }),
      ),
    );
    expect(without.kind).toBe('manual');
    expect(without.summary).toContain('Due follow-ups are written by AI and send automatically, without approval.');
    expect(without.summary).toContain('Approved emails send automatically every 30 seconds');
    expect(without.summary).toContain('Reply auto-actions: suppress the sender on an unsubscribe');
    const off = describeAutomationState(buildAutomationPolicy(inputs({ workspace: { followUpEnabled: false } })));
    expect(off.summary).toContain('Follow-ups are off.');
  });

  it('the Autopilot on one-liner names the steps and the threshold', () => {
    const s = describeAutomationState(
      buildAutomationPolicy(
        inputs({
          autopilot: {
            enabled: true,
            autoApproveThreshold: 82,
            steps: steps({ auto_approve_projects: true, auto_crm_contact_sync: true }),
          },
        }),
      ),
    );
    expect(s.summary).toMatch(/^Autopilot on\. Runs auto-approve \(score ≥ 82\) and CRM contact sync every 5 minutes\./);
  });

  it('with only a Sending hold the state is "Partly paused" and lists what continues', () => {
    const s = describeAutomationState(buildAutomationPolicy(inputs({ state: { holds: [hold({})] } })));
    expect(s.partlyPaused).toBe(true);
    expect(s.label).toBe('Partly paused');
    expect(s.continues).toContain('Inbox sync');
    expect(s.continues).toContain('Scheduled crawls');
    expect(s.continues).not.toContain('Send queue');
    expect(s.continues).not.toContain('Follow-ups');
    expect(s.summary).toContain('Sending is on hold (placed by this workspace): checking deliverability.');
    expect(s.summary).toContain('Still running: Scheduled crawls');
  });

  it('degradations add the amber dot; not live is reported on its own', () => {
    const s = describeAutomationState(
      buildAutomationPolicy(
        inputs({ state: { walletHasTokens: false, live: null }, failingMailboxes: 2 }),
      ),
    );
    expect(s.degraded).toBe(true);
    expect(s.degradations).toEqual([
      'No tokens left: discovery, AI drafting and follow-ups wait.',
      '2 mailboxes failing: their queued emails are held and replies to them are not read.',
    ]);
    expect(s.live).toBe(false);
    expect(describeAutomationState(buildAutomationPolicy(inputs())).degraded).toBe(false);
  });

  it('every registered background tick has a line in "What runs right now"', async () => {
    class RecordingQueue extends InMemoryJobQueue {
      public types: string[] = [];
      override async enqueueRepeatable<P extends JobPayload>(
        type: string,
        _payload: P,
        _options: RepeatableJobOptions,
      ): Promise<void> {
        this.types.push(type);
      }
    }
    const q = new RecordingQueue();
    const previous = getJobQueue();
    _setJobQueueForTests(q);
    _resetRepeatablesForTests();
    try {
      await registerRepeatableJobs();
    } finally {
      _setJobQueueForTests(previous);
      _resetRepeatablesForTests();
    }
    expect(q.types.length).toBeGreaterThan(0);
    const paths = describeAutomationState(buildAutomationPolicy(inputs())).paths;
    const covered = new Set(paths.flatMap((p) => [...p.ticks]));
    // Integration (PC-10 / PC-35): the platform maintenance ticks are no
    // workspace automation and have no line; every other one does.
    const maintenance = new Set<string>(MAINTENANCE_TICKS);
    const automation = q.types.filter((type) => !maintenance.has(type));
    expect(automation.filter((type) => !covered.has(type as (typeof AUTOMATION_TICKS)[number]))).toEqual([]);
    expect([...automation].sort()).toEqual([...AUTOMATION_TICKS].sort());
    expect(q.types.filter((type) => maintenance.has(type)).sort()).toEqual([...MAINTENANCE_TICKS].sort());
    for (const p of paths) expect(p.detail.length).toBeGreaterThan(0);
  });

  it('reads the live workspace: a member pause shows Paused with who and when', async () => {
    const t = await tenant();
    expect((await getAutomationState(t.member)).label).toBe('Manual');
    await pauseAutomation(t.member, { source: 'api', reason: 'checking copy' });
    const s = await getAutomationState(t.viewer);
    expect(s.kind).toBe('paused');
    expect(s.banner).toMatch(/^Paused by pc13-member-\d+ since 20\d\d-/);
    expect(s.banner).toContain('checking copy');
    expect(policyPath(await resolveAutomationPolicy(t.viewer), 'inbox_sync').status).toBe('off');
    expect(s.continues).toContain('Health check');
  });
});
