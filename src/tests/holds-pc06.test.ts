// PC-06 — holds (one model), the accountable-owner rule, the platform-wide
// outbound stop and the legacy feature_flags import.
//
// Acceptance:
//   (1) for each capability a hold blocks every gate point —
//       Sending: drain, follow-up send (tick + approve), reply / compose
//       (sendMessage, manual), retry; Inbox sync: tick and manual sync;
//       Discovery: crawl tick and Run now; Autopilot: runOnce; CRM sync:
//       autopilot's steps and the manual push; Background AI: compaction,
//       synthesis, the health check's AI review, reply drafting (plus
//       reply auto-actions and auto top-up);
//   (2) scope 'all' stops automatic and manual capability work, and an
//       expired hold stops applying without any job running;
//   (3) a suspended owner stops automatic work, manual work by other
//       members continues, and exactly one incident audit row is written;
//   (4) legacy rows are not enforced until confirmed;
//   (5) X6: a workspace with a confirmed Inbox-sync hold syncs 0 messages.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock';
import { and, eq } from 'drizzle-orm';
import type { ZodSchema } from 'zod';
import { renderToStaticMarkup } from 'react-dom/server';
import { db } from '@/lib/db/client';
import {
  _setAIProviderForTests,
  type AIGenInput,
  type AIGenResult,
  type IAIProvider,
} from '@/lib/ai';
import { featureFlags } from '@/lib/db/schema/admin';
import { auditLog } from '@/lib/db/schema/audit';
import { contactAssociations, contacts } from '@/lib/db/schema/contacts';
import { sourceRecords } from '@/lib/db/schema/connectors';
import { outreachFollowUps } from '@/lib/db/schema/follow-ups';
import { workspaceHolds, type AutomationCapability } from '@/lib/db/schema/holds';
import { mailMessages, mailThreads, mailboxes, type Mailbox } from '@/lib/db/schema/mailing';
import { notifications } from '@/lib/db/schema/notifications';
import { outreachQueue, outreachThreadState } from '@/lib/db/schema/outreach';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { productProfiles } from '@/lib/db/schema/products';
import { reviewItems } from '@/lib/db/schema/review';
import { workspaceMembers, workspaces } from '@/lib/db/schema/workspaces';
import { MockMailProvider, type InboundMessage } from '@/lib/mail';
import {
  runAutopilotTick,
  runCrawlEngineTick,
  runDrainTick,
  runFollowUpTick,
  runImapTick,
  runKnowledgeCompactTick,
} from '@/lib/jobs/repeatables';
import { describeActionError } from '@/lib/action-errors';
import { listAuditEvents } from '@/lib/services/audit';
import {
  AUTOMATION_CAPABILITIES,
  AutomationGateError,
  OWNER_INCIDENT_KIND,
  OWNER_INCIDENT_RESOLVED_KIND,
  activeWorkspacesForTicks,
  checkGate,
  decideGate,
  getWorkspaceAutomationNotice,
  loadAutomationState,
  type AutomationState,
  type EnforcedHold,
} from '@/lib/services/automation-gate';
import { runOnce, updateAutopilotSettings } from '@/lib/services/autopilot';
import { attemptAutoTopup } from '@/lib/services/billing';
import {
  type WorkspaceContext,
  makeAutomationContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { createConnector, createRecipe, startRun } from '@/lib/services/connector-run';
import {
  createCrawlPlan,
  processDueCrawlPlans,
  runCrawlPlanNow,
} from '@/lib/services/crawl-engine';
import { pushDeal, pushLeadToCrm, pushThreadAsNotes } from '@/lib/services/crm';
import {
  approveFollowUp,
  processDueFollowUps,
  scheduleFollowUps,
  updateFollowUpConfig,
} from '@/lib/services/follow-up';
import { runHealthCheckNow, runWorkspaceHealthCheck } from '@/lib/services/health-check';
import {
  HoldServiceError,
  clearPlatformOutboundStop,
  confirmLegacyHold,
  discardLegacyHold,
  listWorkspaceHolds,
  placePlatformHold,
  placeTenantHold,
  releasePlatformHold,
  releaseTenantHold,
  setPlatformOutboundStop,
} from '@/lib/services/holds';
import {
  compactWorkspaceKnowledge,
  compactWorkspaceKnowledgeUnattended,
} from '@/lib/services/knowledge-compaction';
import {
  synthesizeWorkspaceLearning,
  synthesizeWorkspaceLearningUnattended,
} from '@/lib/services/learning-synthesis';
import { retrySend, safeSyncOne, sendMessage, syncInbound } from '@/lib/services/mail';
import { _setMailProviderFactoryForTests, createMailbox } from '@/lib/services/mailbox';
import { handleClassifiedReply } from '@/lib/services/outreach-reply-handler';
import { drainQueue } from '@/lib/services/outreach-queue';
import { updateReplyAutoActions } from '@/lib/services/reply-auto-actions';
import type { ReplyClassification } from '@/lib/services/reply-classifier';
import { setAccountStatus } from '@/lib/services/users';
import {
  applyLegacyFlagImport,
  mapLegacyFlag,
  planLegacyFlagImport,
  renderLegacyFlagReport,
} from '@/lib/remediation/legacy-feature-flags';
import { accountStatusConfirms } from '@/lib/confirm-copy';
import { AutomationHoldBanner } from '@/components/AutomationHoldBanner';
import { platformCtx, smuggled } from './helpers/platform';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { settleDetached } from '@/lib/detached';

// ---- fixtures --------------------------------------------------------

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
let superAdminId = '';

async function tenant(name = 'ws'): Promise<Tenant> {
  seq++;
  const ownerId = await seedUser({ email: `${name}-owner-${seq}@test.local` });
  const adminId = await seedUser({ email: `${name}-admin-${seq}@test.local` });
  const memberId = await seedUser({ email: `${name}-member-${seq}@test.local` });
  const viewerId = await seedUser({ email: `${name}-viewer-${seq}@test.local` });
  const workspaceId = await seedWorkspace({
    name: `${name}-${seq}`,
    ownerUserId: ownerId,
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

function pctx() {
  return platformCtx(superAdminId);
}

async function hold(t: Tenant, capabilities: AutomationCapability[] | 'all', reason = 'test hold') {
  return placePlatformHold(pctx(), t.workspaceId, {
    scope: capabilities === 'all' ? 'all' : 'capabilities',
    capabilities: capabilities === 'all' ? [] : capabilities,
    reason,
  });
}

async function makeMailbox(t: Tenant, opts: { imap?: boolean } = {}): Promise<Mailbox> {
  return createMailbox(t.owner, {
    name: `sales-${seq}`,
    fromAddress: `sales-${seq}@nulife.pl`,
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpUser: `sales-${seq}@nulife.pl`,
    smtpPassword: 'secret',
    imap: opts.imap
      ? { host: 'imap.example.com', port: 993, user: `sales-${seq}@nulife.pl`, password: 'secret' }
      : null,
    isDefault: true,
  });
}

async function queueRow(t: Tenant, mailboxId: bigint, to = 'anna@target.com') {
  const [row] = await db
    .insert(outreachQueue)
    .values({
      workspaceId: t.workspaceId,
      mailboxId,
      toAddresses: [to],
      subject: 'Hello',
      bodyText: 'Hi Anna',
      delayMode: 'immediate',
      scheduledSendAt: new Date(Date.now() - 60_000),
      status: 'queued',
      createdBy: t.ownerId,
    })
    .returning();
  return row!;
}

async function queueRowById(id: bigint) {
  const [row] = await db.select().from(outreachQueue).where(eq(outreachQueue.id, id));
  return row!;
}

let inboundSeq = 0;
function inbound(to: string): InboundMessage {
  inboundSeq++;
  return {
    uid: inboundSeq,
    messageId: `<in-${inboundSeq}-${Date.now()}@sender.example>`,
    inReplyTo: null,
    references: [],
    from: { address: `sender${inboundSeq}@sender.example` },
    to: [{ address: to }],
    cc: [],
    subject: `Message ${inboundSeq}`,
    textBody: 'Hello there',
    htmlBody: null,
    receivedAt: new Date(Date.now() - 1000),
    headers: {},
    attachments: [],
  };
}

async function messageCount(workspaceId: bigint): Promise<number> {
  const rows = await db
    .select({ id: mailMessages.id })
    .from(mailMessages)
    .where(eq(mailMessages.workspaceId, workspaceId));
  return rows.length;
}

/** A lead on an outreach thread with one due follow-up step (auto-send). */
async function followUpFixture(t: Tenant, provider: MockMailProvider) {
  const mb = await makeMailbox(t);
  const [sr] = await db
    .insert(sourceRecords)
    .values({
      workspaceId: t.workspaceId,
      sourceSystem: 'mock',
      sourceId: `fu-${seq}-${Date.now()}`,
      rawData: {},
      normalizedData: {},
      sourceUrl: 'https://example.com',
    })
    .returning();
  const [ri] = await db
    .insert(reviewItems)
    .values({ workspaceId: t.workspaceId, sourceRecordId: sr!.id, state: 'approved' })
    .returning();
  const [product] = await db
    .insert(productProfiles)
    .values({ workspaceId: t.workspaceId, name: 'P' })
    .returning();
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
      reviewItemId: ri!.id,
      productProfileId: product!.id,
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
  await db
    .update(outreachFollowUps)
    .set({ scheduledFor: new Date(Date.now() - 60_000) })
    .where(
      and(eq(outreachFollowUps.workspaceId, t.workspaceId), eq(outreachFollowUps.stepNumber, 1)),
    );
  const [step] = await db
    .select()
    .from(outreachFollowUps)
    .where(
      and(eq(outreachFollowUps.workspaceId, t.workspaceId), eq(outreachFollowUps.stepNumber, 1)),
    );
  return { mb, step: step!, lead: lead! };
}

/** Prospect reply on a thread linked to a lead (reply handler fixture). */
async function replyFixture(t: Tenant, body: string) {
  const [mb] = await db
    .insert(mailboxes)
    .values({
      workspaceId: t.workspaceId,
      name: `inbox-${seq}`,
      fromAddress: `inbox-${seq}@nulife.pl`,
      smtpHost: 'smtp.x',
      smtpUser: 'inbox',
      smtpPasswordSecretKey: `mailbox.smtp_pc06_${seq}`,
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
      externalThreadKey: `subj:pc06-${seq}-${Date.now()}`,
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
      messageId: `<reply-pc06-${seq}-${Date.now()}@target.com>`,
      fromAddress: 'anna@target.com',
      toAddresses: [mb!.fromAddress],
      subject: 'Re: hi',
      bodyText: body,
      outreachRelevance: 'prospect_reply',
    })
    .returning();
  const [contact] = await db
    .insert(contacts)
    .values({
      workspaceId: t.workspaceId,
      email: 'anna@target.com',
      name: 'Anna',
      status: 'active',
    })
    .returning();
  await db.insert(contactAssociations).values({
    workspaceId: t.workspaceId,
    contactId: contact!.id,
    entityType: 'mail_thread',
    entityId: thread!.id.toString(),
  });
  const [sr] = await db
    .insert(sourceRecords)
    .values({
      workspaceId: t.workspaceId,
      sourceSystem: 'mock',
      sourceId: `rp-${seq}-${Date.now()}`,
      rawData: {},
      normalizedData: {},
      sourceUrl: 'https://example.com',
    })
    .returning();
  const [ri] = await db
    .insert(reviewItems)
    .values({ workspaceId: t.workspaceId, sourceRecordId: sr!.id, state: 'new' })
    .returning();
  const [product] = await db
    .insert(productProfiles)
    .values({ workspaceId: t.workspaceId, name: 'P' })
    .returning();
  const [lead] = await db
    .insert(qualifiedLeads)
    .values({
      workspaceId: t.workspaceId,
      reviewItemId: ri!.id,
      productProfileId: product!.id,
      state: 'relevant',
      relevantAt: new Date(),
    })
    .returning();
  await db.insert(contactAssociations).values({
    workspaceId: t.workspaceId,
    contactId: contact!.id,
    entityType: 'qualified_lead',
    entityId: lead!.id.toString(),
  });
  return { messageId: msg!.id, leadId: lead!.id };
}

const unsubscribeVerdict: ReplyClassification = {
  type: 'unsubscribe',
  confidence: 70,
  rationale: 'test',
  extractedEmails: [],
  suggestedAction: 'suppress',
};

const questionVerdict: ReplyClassification = {
  type: 'question',
  confidence: 80,
  rationale: 'test',
  extractedEmails: [],
  suggestedAction: 'human_review',
};

/** Counts AI calls; answers the health check's review schema. */
class CountingAi implements IAIProvider {
  public readonly id = 'counting';
  public readonly model = 'counting-1';
  public calls = 0;
  async generateText(_i: AIGenInput): Promise<AIGenResult> {
    this.calls++;
    return {
      text: 'Polite follow-up body.',
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1 },
    };
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

async function seedHealthThread(t: Tenant) {
  const [mb] = await db
    .insert(mailboxes)
    .values({
      workspaceId: t.workspaceId,
      name: 'health',
      fromAddress: `health-${seq}@test.local`,
      smtpHost: 'smtp.x',
      smtpUser: 'health',
      smtpPasswordSecretKey: `mailbox.smtp_health_${seq}`,
      imapFolder: 'INBOX',
      status: 'active',
    })
    .returning();
  const [thread] = await db
    .insert(mailThreads)
    .values({
      workspaceId: t.workspaceId,
      mailboxId: mb!.id,
      subject: 'Inquiry',
      externalThreadKey: `subj:health-${seq}`,
      participants: ['anna@x.com', mb!.fromAddress],
      messageCount: 3,
      lastMessageAt: new Date(),
    })
    .returning();
  const mk = (direction: 'inbound' | 'outbound', i: number) => ({
    workspaceId: t.workspaceId,
    mailboxId: mb!.id,
    threadId: thread!.id,
    direction,
    status: direction === 'inbound' ? ('received' as const) : ('sent' as const),
    messageId: `<health-${seq}-${i}@x>`,
    fromAddress: direction === 'inbound' ? 'anna@x.com' : mb!.fromAddress,
    toAddresses: [direction === 'inbound' ? mb!.fromAddress : 'anna@x.com'],
    subject: 'Inquiry',
    bodyText: direction === 'inbound' ? 'What do you offer?' : 'Hi, who handles this?',
  });
  await db.insert(mailMessages).values([mk('outbound', 1), mk('inbound', 2), mk('outbound', 3)]);
}

async function auditRows(workspaceId: bigint | null, kind: string) {
  return db
    .select()
    .from(auditLog)
    .where(
      workspaceId === null
        ? eq(auditLog.kind, kind)
        : and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.kind, kind)),
    );
}

function blocked(err: unknown, reason = 'hold'): boolean {
  return err instanceof AutomationGateError && err.reason === reason;
}

async function expectGateError(p: Promise<unknown>, reason = 'hold'): Promise<AutomationGateError> {
  let caught: unknown = null;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(AutomationGateError);
  expect((caught as AutomationGateError).reason).toBe(reason);
  return caught as AutomationGateError;
}

beforeEach(async () => {
  await truncateAll();
  superAdminId = await seedUser({ email: 'root@platform.test', role: 'super_admin' });
  // Ticks build their own providers: never let one reach a real server.
  _setMailProviderFactoryForTests(() => new MockMailProvider());
  _setAIProviderForTests(null);
});

afterEach(() => {
  _setMailProviderFactoryForTests(null);
  _setAIProviderForTests(null);
});

afterAll(async () => {
  await settleDetached();
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- the pure gate ---------------------------------------------------

function state(overrides: Partial<AutomationState> = {}): AutomationState {
  return {
    workspaceId: 1n,
    workspaceStatus: 'active',
    ownerUserId: 'owner',
    ownerAccountStatus: 'active',
    ownerIsMember: true,
    ownerProblem: null,
    ownerIncidentOpenSince: null,
    holds: [],
    platformOutboundStop: null,
    // PC-05 inputs, all neutral here (running, live, funded, entitled).
    pause: null,
    live: { since: new Date('2026-09-01T00:00:00Z'), byUserId: null },
    walletHasTokens: true,
    planAllowsAutopilot: true,
    evaluatedAt: new Date('2026-10-02T12:00:00Z'),
    ...overrides,
  };
}

function enforced(overrides: Partial<EnforcedHold> = {}): EnforcedHold {
  return {
    id: 7n,
    scope: 'capabilities',
    capabilities: ['sending'],
    source: 'platform',
    reason: 'abuse report',
    expiresAt: null,
    placedAt: new Date('2026-10-01T00:00:00Z'),
    blocksAccess: false,
    ...overrides,
  };
}

describe('decideGate (pure)', () => {
  const caps = AUTOMATION_CAPABILITIES;
  const modes = [true, false];

  it('allows everything with no hold, no stop and an accountable owner', () => {
    for (const c of caps)
      for (const manual of modes) {
        expect(decideGate(state(), c, { manual })).toEqual({ allowed: true });
      }
  });

  it('a capability hold blocks exactly its capability, manual and automatic', () => {
    for (const held of caps) {
      const s = state({ holds: [enforced({ capabilities: [held] })] });
      for (const c of caps)
        for (const manual of modes) {
          const d = decideGate(s, c, { manual });
          if (c === held) {
            expect(d).toMatchObject({ allowed: false, reason: 'hold', capability: c });
          } else {
            expect(d.allowed).toBe(true);
          }
        }
    }
  });

  it("scope 'all' blocks every capability, manual and automatic", () => {
    const s = state({ holds: [enforced({ scope: 'all', capabilities: [] })] });
    for (const c of caps)
      for (const manual of modes) {
        expect(decideGate(s, c, { manual })).toMatchObject({ allowed: false, reason: 'hold' });
      }
  });

  it('an expired hold no longer applies (evaluated against now, no job)', () => {
    const s = state({
      holds: [enforced({ expiresAt: new Date('2026-10-02T11:59:00Z') })],
    });
    expect(decideGate(s, 'sending', { manual: true }).allowed).toBe(true);
    const live = state({
      holds: [enforced({ expiresAt: new Date('2026-10-02T12:01:00Z') })],
    });
    expect(decideGate(live, 'sending', { manual: true }).allowed).toBe(false);
    expect(
      decideGate(live, 'sending', { manual: true, now: new Date('2026-10-02T12:02:00Z') }).allowed,
    ).toBe(true);
  });

  it('the platform outbound stop refuses Sending only, manual sends too', () => {
    const s = state({
      platformOutboundStop: { since: new Date(), byUserId: 'root', reason: 'provider incident' },
    });
    for (const c of caps)
      for (const manual of modes) {
        const d = decideGate(s, c, { manual });
        if (c === 'sending') {
          expect(d).toMatchObject({ allowed: false, reason: 'platform_outbound_stop' });
          expect(!d.allowed && d.message).toContain('provider incident');
        } else {
          expect(d.allowed).toBe(true);
        }
      }
  });

  it('no accountable owner stops automatic work only, never manual work', () => {
    for (const problem of ['owner_inactive', 'owner_not_member'] as const) {
      const s = state({ ownerProblem: problem, ownerAccountStatus: 'suspended' });
      for (const c of caps) {
        expect(decideGate(s, c, { manual: true }).allowed).toBe(true);
        expect(decideGate(s, c, { manual: false })).toMatchObject({
          allowed: false,
          reason: 'no_accountable_owner',
        });
      }
    }
  });

  it('archived workspaces run nothing automatically', () => {
    const s = state({ workspaceStatus: 'archived' });
    expect(decideGate(s, 'sending', { manual: false })).toMatchObject({
      reason: 'workspace_archived',
    });
    expect(decideGate(s, 'sending', { manual: true }).allowed).toBe(true);
  });

  it('a platform hold is reported before a tenant hold; the message names the placer', () => {
    const s = state({
      holds: [
        enforced({ id: 1n, source: 'tenant', reason: 'our own pause' }),
        enforced({ id: 2n, source: 'platform', reason: 'abuse report' }),
      ],
    });
    const d = decideGate(s, 'sending', { manual: true });
    expect(d).toMatchObject({ allowed: false, hold: { id: 2n } });
    expect(!d.allowed && d.message).toBe(
      'Sending is on hold (placed by the platform): abuse report',
    );
  });
});

// ---- (1) every gate point, per capability ------------------------------

describe('(1) Sending hold blocks every sending gate point', { timeout: 60_000 }, () => {
  it('drain: claims nothing, rows stay queued untouched; the tick counts it held', async () => {
    const t = await tenant();
    const mb = await makeMailbox(t);
    const row = await queueRow(t, mb.id);
    await hold(t, ['sending']);

    const provider = new MockMailProvider();
    const r = await drainQueue(t.owner, { providerOverride: provider });
    expect(r).toMatchObject({ picked: 0, sent: 0, failed: 0, skipped: 0 });
    expect(r.heldReason).toContain('Sending is on hold');
    const tick = await runDrainTick();
    expect(tick).toMatchObject({ totalSent: 0, held: 1 });
    expect(provider.sent).toHaveLength(0);
    const after = await queueRowById(row.id);
    expect(after).toMatchObject({ status: 'queued', attemptCount: 0 });
  });

  it('drain: a hold placed mid-drain stops the loop; later rows stay queued', async () => {
    const t = await tenant();
    const mb = await makeMailbox(t);
    const r1 = await queueRow(t, mb.id, 'a@one.example');
    const r2 = await queueRow(t, mb.id, 'b@two.example');
    // Hold lands right after the first row is sent.
    const provider = new MockMailProvider();
    const origSend = provider.send.bind(provider);
    provider.send = async (m) => {
      const res = await origSend(m);
      if (provider.sent.length === 1) await hold(t, ['sending'], 'placed mid-drain');
      return res;
    };
    const r = await drainQueue(t.owner, { providerOverride: provider });
    expect(r.sent).toBe(1);
    expect(r.heldReason).toContain('placed mid-drain');
    const rows = [await queueRowById(r1.id), await queueRowById(r2.id)];
    expect(rows.map((x) => x.status).sort()).toEqual(['queued', 'sent']);
    expect(rows.find((x) => x.status === 'queued')!.attemptCount).toBe(0);
  });

  it('follow-up tick: 0 AI calls, 0 sends, the step stays pending; released → it sends', async () => {
    const t = await tenant();
    const provider = new MockMailProvider();
    const { step } = await followUpFixture(t, provider);
    const ai = new CountingAi();
    _setAIProviderForTests(ai);
    await hold(t, ['sending']);

    const r = await processDueFollowUps(t.owner, { mailProviderOverride: provider });
    expect(r).toMatchObject({ checked: 0, sent: 0, failed: 0 });
    expect(r.heldReason).toContain('Sending is on hold');
    expect((await runFollowUpTick()).held).toBe(1);
    expect(ai.calls).toBe(0);
    expect(provider.sent).toHaveLength(1); // the first touch only
    const [row] = await db
      .select()
      .from(outreachFollowUps)
      .where(eq(outreachFollowUps.id, step.id));
    expect(row!.status).toBe('pending');

    const holds = await listWorkspaceHolds(t.owner);
    await releasePlatformHold(pctx(), t.workspaceId, holds[0]!.id, 'investigation done');
    const after = await processDueFollowUps(t.owner, { mailProviderOverride: provider });
    expect(after.sent).toBe(1);
    expect(provider.sent).toHaveLength(2);
  });

  it('follow-up approve, reply/compose (manual sendMessage) and retry are refused', async () => {
    const t = await tenant();
    const mb = await makeMailbox(t);
    const provider = new MockMailProvider();
    await hold(t, ['sending'], 'complaint under review');

    // Approve: refused before anything else (a missing row would be not_found).
    const e = await expectGateError(approveFollowUp(t.member, 999_999n));
    expect(e.message).toContain('complaint under review');
    // Reply in a thread and compose: one-to-one manual sends.
    await expectGateError(
      sendMessage(t.admin, {
        mode: 'one_to_one',
        origin: 'manual',
        mailboxId: mb.id,
        to: [{ address: 'anna@target.com' }],
        subject: 'Re: hi',
        text: 'Tuesday works',
        providerOverride: provider,
      }),
    );
    // Retry from the Errors folder.
    await expectGateError(retrySend(t.member, [123n]));
    expect(provider.sent).toHaveLength(0);
  });

  it('without the hold the same calls get past the gate', async () => {
    const t = await tenant();
    await expect(approveFollowUp(t.member, 999_999n)).rejects.toMatchObject({ code: 'not_found' });
    expect(await retrySend(t.member, [123n])).toMatchObject({ retried: [], errors: [] });
  });
});

describe('(1) Inbox-sync hold blocks the tick and manual sync', { timeout: 60_000 }, () => {
  it('tick syncs 0 mailboxes; Sync / syncInbound refuse; nothing counts as a mailbox failure', async () => {
    const t = await tenant();
    const mb = await makeMailbox(t, { imap: true });
    const provider = new MockMailProvider();
    provider.enqueueInbound(inbound(mb.fromAddress));
    _setMailProviderFactoryForTests(() => provider);
    await hold(t, ['inbox_sync']);

    const tick = await runImapTick();
    expect(tick).toMatchObject({ mailboxesSynced: 0, failed: 0, held: 1 });
    await expectGateError(safeSyncOne(t.member, mb));
    await expectGateError(syncInbound(t.member, mb.id, provider));
    expect(await messageCount(t.workspaceId)).toBe(0);
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb.id));
    expect(row).toMatchObject({ status: 'active', imapConsecutiveFailures: 0, lastError: null });
  });
});

describe('(1) Discovery hold blocks the crawl tick and Run now', { timeout: 60_000 }, () => {
  it('no runs start; due plans stay due', async () => {
    const t = await tenant();
    const conn = await createConnector(t.owner, { templateType: 'mock', name: 'c' });
    const recipe = await createRecipe(t.owner, { connectorId: conn.id, name: 'r', active: true });
    const plan = await createCrawlPlan(t.owner, {
      name: 'p',
      intervalMinutes: 60,
      recipeIds: [recipe.id],
      productProfileIds: [],
    });
    await hold(t, ['discovery']);

    const tick = await runCrawlEngineTick();
    expect(tick).toMatchObject({ totalStartedRuns: 0, held: 1 });
    const direct = await processDueCrawlPlans(t.auto);
    expect(direct).toMatchObject({ totalStartedRuns: 0 });
    expect(direct.heldReason).toContain('Discovery is on hold');
    await expectGateError(runCrawlPlanNow(t.member, plan.id));
    await expectGateError(startRun(t.member, { connectorId: conn.id, recipeId: recipe.id }));
    const audits = await auditRows(t.workspaceId, 'connector_run.start');
    expect(audits).toHaveLength(0);
  });
});

describe('(1) Autopilot hold blocks runOnce', { timeout: 60_000 }, () => {
  it('runOnce runs no step; the tick skips the workspace', async () => {
    const t = await tenant();
    await updateAutopilotSettings(t.owner, {
      autopilotEnabled: true,
      enableAutoApproveProjects: true,
    });
    await hold(t, ['autopilot'], 'autopilot misfired');
    const r = await runOnce(t.owner);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]).toMatchObject({ step: 'guard', outcome: 'skipped' });
    expect(r.steps[0]!.detail).toContain('autopilot misfired');
    expect(await runAutopilotTick()).toMatchObject({ stepsRun: 0, held: 1 });
  });
});

describe(
  '(1) CRM-sync hold blocks autopilot steps and the manual push',
  { timeout: 60_000 },
  () => {
    it('steps are skipped as held; pushLeadToCrm / pushDeal / pushThreadAsNotes refuse', async () => {
      const t = await tenant();
      await updateAutopilotSettings(t.owner, {
        autopilotEnabled: true,
        enableAutoCrmContactSync: true,
        enableAutoCrmDealOnQualified: true,
      });
      await hold(t, ['crm_sync'], 'CRM credentials rotated');
      const r = await runOnce(t.owner);
      const crmSteps = r.steps.filter((s) => s.step.startsWith('auto_crm'));
      expect(crmSteps).toHaveLength(2);
      for (const s of crmSteps) {
        expect(s.outcome).toBe('skipped');
        expect(s.detail).toContain('CRM credentials rotated');
      }
      await expectGateError(pushLeadToCrm(t.member, { connectionId: 1n, leadId: 1n }));
      await expectGateError(pushDeal(t.member, { connectionId: 1n, leadId: 1n }));
      await expectGateError(pushThreadAsNotes(t.member, { connectionId: 1n, threadId: 1n }));
    });

    it('without the hold the push reaches its own checks', async () => {
      const t = await tenant();
      await expect(pushLeadToCrm(t.member, { connectionId: 1n, leadId: 1n })).rejects.toMatchObject(
        {
          code: 'not_found',
        },
      );
    });
  },
);

describe(
  '(1) Background-AI hold blocks compaction, synthesis, health AI and reply drafting',
  { timeout: 60_000 },
  () => {
    it('compaction and synthesis: manual refused, unattended skipped, tick held', async () => {
      const t = await tenant();
      await hold(t, ['background_ai']);
      await expectGateError(compactWorkspaceKnowledge(t.admin));
      await expectGateError(compactWorkspaceKnowledgeUnattended(t.workspaceId));
      await expectGateError(synthesizeWorkspaceLearning(t.admin));
      expect(await synthesizeWorkspaceLearningUnattended(t.workspaceId)).toMatchObject({
        ran: false,
        skippedReason: 'held',
      });
      expect(await runKnowledgeCompactTick()).toMatchObject({ processed: 0, held: 1 });
    });

    it('health check: the rules run, the AI review makes 0 calls (manual and scheduled)', async () => {
      const t = await tenant();
      await seedHealthThread(t);
      const ai = new CountingAi();
      _setAIProviderForTests(ai);
      // Counterfactual first: without a hold the review calls the AI.
      const before = await runWorkspaceHealthCheck({ workspaceId: t.workspaceId });
      expect(ai.calls).toBe(1);
      expect((before.commReview as unknown[]).length).toBe(1);

      await hold(t, ['background_ai']);
      const scheduled = await runWorkspaceHealthCheck({ workspaceId: t.workspaceId });
      const manual = await runHealthCheckNow(t.admin);
      expect(ai.calls).toBe(1);
      expect(scheduled.commReview).toEqual([]);
      expect(manual.commReview).toEqual([]);
      expect((manual.findings as unknown[]).length).toBeGreaterThan(0);
    });

    it('reply drafting: no draft under the hold; the decision is still recorded', async () => {
      const t = await tenant();
      const free = await replyFixture(t, 'How does this work?');
      const ok = await handleClassifiedReply(t.owner, free.messageId, questionVerdict);
      expect(ok.action.kind).toBe('draft');
      expect(ok.draftIds.length).toBeGreaterThan(0);

      const t2 = await tenant('held');
      const held = await replyFixture(t2, 'How does this work?');
      await hold(t2, ['background_ai']);
      const r = await handleClassifiedReply(t2.owner, held.messageId, questionVerdict);
      expect(r.action.kind).toBe('draft');
      expect(r.draftIds).toEqual([]);
      expect(await auditRows(t2.workspaceId, 'outreach.reply_handled')).toHaveLength(1);
    });
  },
);

describe('(1) Reply auto-actions and auto top-up holds', { timeout: 60_000 }, () => {
  it('a Reply auto-actions hold leaves an unsubscribe reply for the operator', async () => {
    const t = await tenant();
    await updateReplyAutoActions(t.owner, { autoSuppressUnsubscribe: true });
    const { messageId, leadId } = await replyFixture(t, 'please unsubscribe');
    await hold(t, ['inbound_actions']);
    await handleClassifiedReply(t.owner, messageId, unsubscribeVerdict);
    const [lead] = await db.select().from(qualifiedLeads).where(eq(qualifiedLeads.id, leadId));
    expect(lead!.state).toBe('relevant');
    expect(await auditRows(t.workspaceId, 'reply.auto_actions_held')).toHaveLength(1);
  });

  it('an Auto top-up hold skips the charge before the rate-limit claim', async () => {
    const t = await tenant();
    await db
      .update(workspaces)
      .set({ autoTopupEnabled: true, autoTopupPackId: 'pack_s' })
      .where(eq(workspaces.id, t.workspaceId));
    await hold(t, ['auto_topup']);
    expect(await attemptAutoTopup(t.workspaceId)).toBe('skipped');
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, t.workspaceId));
    expect(ws!.autoTopupLastAt).toBeNull();
  });
});

// ---- (2) scope 'all' and expiry ----------------------------------------

describe("(2) scope 'all' and expiry", { timeout: 60_000 }, () => {
  it("scope 'all' stops automatic and manual capability work", async () => {
    const t = await tenant();
    const mb = await makeMailbox(t, { imap: true });
    await queueRow(t, mb.id);
    await hold(t, 'all', 'tenant under investigation');

    for (const c of AUTOMATION_CAPABILITIES) {
      expect((await checkGate(t.member, c)).allowed).toBe(false);
      expect((await checkGate(t.auto, c)).allowed).toBe(false);
    }
    await expectGateError(
      sendMessage(t.admin, {
        mode: 'one_to_one',
        origin: 'manual',
        mailboxId: mb.id,
        to: [{ address: 'anna@target.com' }],
        subject: 'hi',
        text: 'x',
        providerOverride: new MockMailProvider(),
      }),
    );
    await expectGateError(safeSyncOne(t.member, mb));
    const tick = await runDrainTick();
    expect(tick).toMatchObject({ totalSent: 0, held: 1 });
  });

  it('an expired hold stops applying with no job run; the row stays as it was', async () => {
    const t = await tenant();
    const placed = await placePlatformHold(pctx(), t.workspaceId, {
      scope: 'capabilities',
      capabilities: ['sending'],
      reason: 'cool-off',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    expect((await checkGate(t.member, 'sending')).allowed).toBe(false);
    // Time passes: move the expiry into the past (no job touches the row).
    await db
      .update(workspaceHolds)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(workspaceHolds.id, placed.id));
    expect((await checkGate(t.member, 'sending')).allowed).toBe(true);
    const [row] = await db.select().from(workspaceHolds).where(eq(workspaceHolds.id, placed.id));
    expect(row!.state).toBe('active');
    const listed = await listWorkspaceHolds(t.owner);
    expect(listed[0]).toMatchObject({ expired: true, enforced: false });
    expect((await getWorkspaceAutomationNotice(t.owner)).holds).toEqual([]);
  });
});

// ---- (3) the accountable-owner rule ------------------------------------

describe('(3) accountable owner', { timeout: 60_000 }, () => {
  it('a suspended owner stops automatic work; members still send by hand; one incident row', async () => {
    const t = await tenant();
    const mb = await makeMailbox(t);
    const row = await queueRow(t, mb.id);
    await setAccountStatus(pctx(), t.ownerId, 'suspended', 'chargeback');

    const first = await runDrainTick();
    const second = await runDrainTick();
    expect(first).toMatchObject({ totalSent: 0, held: 1 });
    expect(second).toMatchObject({ totalSent: 0, held: 1 });
    expect((await queueRowById(row.id)).status).toBe('queued');
    expect(await runAutopilotTick()).toMatchObject({ held: 1 });
    expect((await checkGate(t.auto, 'discovery')).allowed).toBe(false);
    const d = await checkGate(t.auto, 'sending');
    expect(d).toMatchObject({ allowed: false, reason: 'no_accountable_owner' });

    // Exactly one incident row (an audit row until PC-07), however many ticks.
    const incidents = await auditRows(t.workspaceId, OWNER_INCIDENT_KIND);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.payload).toMatchObject({
      ownerUserId: t.ownerId,
      problem: 'owner_inactive',
      ownerAccountStatus: 'suspended',
    });
    const notes = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.workspaceId, t.workspaceId),
          eq(notifications.kind, 'automation.owner_unaccountable'),
        ),
      );
    expect(notes.length).toBeGreaterThan(0);

    // Manual work by another member continues.
    const provider = new MockMailProvider();
    await sendMessage(t.admin, {
      mode: 'one_to_one',
      origin: 'manual',
      mailboxId: mb.id,
      to: [{ address: 'colleague@target.com' }],
      subject: 'manual',
      text: 'still works',
      providerOverride: provider,
    });
    expect(provider.sent).toHaveLength(1);
    // …but an automatic send is refused even when called directly.
    await expectGateError(
      sendMessage(t.admin, {
        mode: 'sequence',
        origin: 'manual',
        mailboxId: mb.id,
        to: [{ address: 'anna@target.com' }],
        subject: 'auto',
        text: 'x',
        automatic: true,
        providerOverride: provider,
      }),
      'no_accountable_owner',
    );

    // Back to active: the incident resolves (one row) and automation resumes.
    await setAccountStatus(pctx(), t.ownerId, 'active');
    const resumed = await runDrainTick();
    expect(resumed.held).toBe(0);
    expect(await auditRows(t.workspaceId, OWNER_INCIDENT_RESOLVED_KIND)).toHaveLength(1);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, t.workspaceId));
    expect(ws!.automationOwnerIncidentAt).toBeNull();
  });

  it('an owner who is no longer a member: no fallback to another member', async () => {
    const t = await tenant();
    await db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, t.workspaceId),
          eq(workspaceMembers.userId, t.ownerId),
        ),
      );
    const s = await loadAutomationState(t.workspaceId);
    expect(s.ownerProblem).toBe('owner_not_member');
    const [tick] = (await activeWorkspacesForTicks()).filter(
      (w) => w.workspaceId === t.workspaceId,
    );
    expect(tick!.ctx.userId).toBe(t.ownerId);
    expect(tick!.gate('sending')).toMatchObject({ allowed: false, reason: 'no_accountable_owner' });
    expect((await checkGate(t.admin, 'sending')).allowed).toBe(true);
    expect(await auditRows(t.workspaceId, OWNER_INCIDENT_KIND)).toHaveLength(1);
  });

  it('the users page warns that suspending an owner stops their workspace', () => {
    const user = { name: 'Ada', email: 'ada@x.test', role: 'member', accountStatus: 'active' };
    const owned = accountStatusConfirms(user, [{ name: 'Acme', slug: 'acme' }]);
    expect(owned.suspended).toContain('all automatic work there stops');
    expect(owned.suspended).toContain('Members can still work by hand');
    expect(accountStatusConfirms(user).suspended).not.toContain('automatic work');
  });
});

// ---- holds service ------------------------------------------------------

describe('holds service', { timeout: 60_000 }, () => {
  it('tenant holds: any write role places, owners/admins release; viewers cannot place', async () => {
    const t = await tenant();
    await expect(
      placeTenantHold(t.viewer, {
        scope: 'capabilities',
        capabilities: ['discovery'],
        reason: 'nope',
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    const h = await placeTenantHold(t.member, {
      scope: 'capabilities',
      capabilities: ['discovery', 'crm_sync'],
      reason: 'pausing discovery for the trade fair',
    });
    expect(h).toMatchObject({ source: 'tenant', state: 'active' });
    expect((await checkGate(t.member, 'crm_sync')).allowed).toBe(false);
    await expect(releaseTenantHold(t.member, h.id, 'done')).rejects.toMatchObject({
      code: 'permission_denied',
    });
    const released = await releaseTenantHold(t.admin, h.id, 'fair is over');
    expect(released).toMatchObject({
      state: 'released',
      endReason: 'fair is over',
      endedByUserId: t.adminId,
    });
    expect(released.history.map((e) => e.action)).toEqual(['placed', 'released']);
    await expect(releaseTenantHold(t.admin, h.id, 'again')).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('a tenant cannot release a platform hold; the platform can, and tenants are notified', async () => {
    const t = await tenant();
    const h = await hold(t, ['sending'], 'spam complaints');
    await expect(releaseTenantHold(t.owner, h.id, 'we fixed it')).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await releasePlatformHold(pctx(), t.workspaceId, h.id, 'reviewed');
    expect((await checkGate(t.member, 'sending')).allowed).toBe(true);
    const notes = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.workspaceId, t.workspaceId),
          eq(notifications.kind, 'automation.hold'),
        ),
      );
    // One per owner/admin for the placement and one each for the release.
    expect(notes.length).toBe(4);
  });

  it('validates input with Zod: reason, a non-empty capability list, a future expiry', async () => {
    const t = await tenant();
    const bad = [
      { scope: 'capabilities' as const, capabilities: [], reason: 'x is long enough' },
      { scope: 'capabilities' as const, capabilities: ['sending' as const], reason: ' ' },
      {
        scope: 'all' as const,
        reason: 'past expiry',
        expiresAt: new Date(Date.now() - 1000),
      },
    ];
    for (const input of bad) {
      await expect(placePlatformHold(pctx(), t.workspaceId, input)).rejects.toMatchObject({
        code: 'invalid_input',
      });
    }
    await expect(
      placePlatformHold(smuggled(t.owner), t.workspaceId, { scope: 'all', reason: 'smuggled' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('audit rows are filed on the target workspace, with the super-admin as actor', async () => {
    const t = await tenant();
    const h = await hold(t, ['inbox_sync']);
    await releasePlatformHold(pctx(), t.workspaceId, h.id, 'reviewed');
    const trail = await listAuditEvents({ workspaceId: t.workspaceId });
    const kinds = trail.map((r) => r.kind);
    expect(kinds).toContain('workspace.hold.place');
    expect(kinds).toContain('workspace.hold.release');
    for (const r of trail.filter((x) => x.kind.startsWith('workspace.hold.'))) {
      expect(r.userId).toBe(superAdminId);
    }
  });

  it('the shell banner shows enforced holds to every member', async () => {
    const t = await tenant();
    await hold(t, ['sending', 'inbox_sync'], 'abuse report #12');
    const notice = await getWorkspaceAutomationNotice(t.viewer);
    expect(notice.holds).toHaveLength(1);
    const html = renderToStaticMarkup(AutomationHoldBanner({ notice }));
    expect(html).toContain('Held by the platform');
    expect(html).toContain('Sending and Inbox sync');
    expect(html).toContain('abuse report #12');
    expect(
      renderToStaticMarkup(
        AutomationHoldBanner({
          notice: {
            platformOutboundStop: null,
            holds: [],
            ownerProblemMessage: null,
            pause: null,
            notLive: false,
          },
        }) ?? '',
      ),
    ).toBe('');
  });

  it('action errors show the gate sentence instead of a crash', async () => {
    const t = await tenant();
    await hold(t, ['discovery'], 'scraping complaint');
    let err: unknown = null;
    try {
      await startRun(t.member, { connectorId: 1n });
    } catch (e) {
      err = e;
    }
    expect(blocked(err)).toBe(true);
    expect(describeActionError(err, [AutomationGateError]).message).toContain('scraping complaint');
  });
});

// ---- platform-wide outbound stop ---------------------------------------

describe('platform-wide outbound stop', { timeout: 60_000 }, () => {
  it('super-admins only; every tenant sends 0 (ticks and manual); platform audit only', async () => {
    const a = await tenant('a');
    const b = await tenant('b');
    const mbA = await makeMailbox(a);
    const mbB = await makeMailbox(b);
    await queueRow(a, mbA.id);
    await queueRow(b, mbB.id);

    await expect(setPlatformOutboundStop(smuggled(a.owner), 'nope')).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await setPlatformOutboundStop(pctx(), 'SMTP relay blacklisted');
    await expect(setPlatformOutboundStop(pctx(), 'twice')).rejects.toMatchObject({
      code: 'conflict',
    });

    expect(await runDrainTick()).toMatchObject({ totalSent: 0, held: 2 });
    expect(await runFollowUpTick()).toMatchObject({ sent: 0, held: 2 });
    for (const [t, mb] of [
      [a, mbA],
      [b, mbB],
    ] as const) {
      await expectGateError(
        sendMessage(t.owner, {
          mode: 'one_to_one',
          origin: 'manual',
          mailboxId: mb.id,
          to: [{ address: 'x@y.test' }],
          subject: 's',
          text: 't',
          providerOverride: new MockMailProvider(),
        }),
        'platform_outbound_stop',
      );
      // Other capabilities keep working.
      expect((await checkGate(t.owner, 'inbox_sync')).allowed).toBe(true);
      const notice = await getWorkspaceAutomationNotice(t.member);
      expect(notice.platformOutboundStop?.reason).toBe('SMTP relay blacklisted');
      // Every tenant shows the banner.
      const html = renderToStaticMarkup(AutomationHoldBanner({ notice }));
      expect(html).toContain('Held by the platform');
      expect(html).toContain('SMTP relay blacklisted');
    }
    // A tenant has no way to lift it.
    await expect(clearPlatformOutboundStop(smuggled(a.admin), 'mine')).rejects.toMatchObject({
      code: 'permission_denied',
    });

    // Recorded in the platform audit log only, never in a tenant's trail.
    const rows = await auditRows(null, 'platform.outbound_stop.set');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: null, userId: superAdminId });
    for (const t of [a, b]) {
      const trail = await listAuditEvents({ workspaceId: t.workspaceId }, { limit: 1000 });
      expect(trail.some((r) => r.kind.startsWith('platform.outbound_stop'))).toBe(false);
    }

    await clearPlatformOutboundStop(pctx(), 'relay delisted');
    expect((await auditRows(null, 'platform.outbound_stop.clear'))[0]).toMatchObject({
      workspaceId: null,
    });
    expect((await runDrainTick()).held).toBe(0);
  });
});

// ---- (4)(5) legacy feature_flags import ----------------------------------

describe('(4)(5) legacy feature_flags import', { timeout: 60_000 }, () => {
  async function seedProdLikeFlags() {
    // Prod (2026-10-01): ws 2 has connector.serpapi, mailbox.imap_sync and
    // outreach.send off and rag.openai on; ws 4 has all four on.
    const w2 = await tenant('w2');
    const w4 = await tenant('w4');
    const setAt = new Date('2026-06-20T10:00:00Z');
    await db.insert(featureFlags).values([
      {
        workspaceId: w2.workspaceId,
        key: 'connector.serpapi',
        enabled: false,
        setBy: superAdminId,
        setAt,
      },
      {
        workspaceId: w2.workspaceId,
        key: 'mailbox.imap_sync',
        enabled: false,
        setBy: superAdminId,
        setAt,
      },
      {
        workspaceId: w2.workspaceId,
        key: 'outreach.send',
        enabled: false,
        setBy: superAdminId,
        setAt,
      },
      { workspaceId: w2.workspaceId, key: 'rag.openai', enabled: true, setBy: superAdminId, setAt },
      { workspaceId: w4.workspaceId, key: 'connector.serpapi', enabled: true, setAt },
      { workspaceId: w4.workspaceId, key: 'mailbox.imap_sync', enabled: true, setAt },
      { workspaceId: w4.workspaceId, key: 'outreach.send', enabled: true, setAt },
      { workspaceId: w4.workspaceId, key: 'rag.openai', enabled: true, setAt },
    ]);
    return { w2, w4 };
  }

  it('maps each legacy key', () => {
    expect(mapLegacyFlag({ key: 'outreach.send', enabled: false })).toMatchObject({
      action: 'hold',
      capabilities: ['sending'],
    });
    expect(mapLegacyFlag({ key: 'mailbox.imap_sync', enabled: false })).toMatchObject({
      action: 'hold',
      capabilities: ['inbox_sync'],
    });
    expect(mapLegacyFlag({ key: 'crm.hubspot', enabled: false })).toMatchObject({
      action: 'hold',
      capabilities: ['crm_sync'],
    });
    expect(mapLegacyFlag({ key: 'connector.serpapi', enabled: false }).action).toBe('note');
    expect(mapLegacyFlag({ key: 'rag.openai', enabled: false }).action).toBe('drop');
    expect(mapLegacyFlag({ key: 'outreach.send', enabled: true }).action).toBe('drop');
    expect(mapLegacyFlag({ key: 'something.else', enabled: false }).action).toBe('note');
  });

  it("the dry run lists exactly workspace 2's three rows and writes nothing", async () => {
    const { w2 } = await seedProdLikeFlags();
    const plan = await planLegacyFlagImport(db);
    const kept = plan.rows.filter((r) => r.action !== 'drop');
    expect(kept.map((r) => [r.workspaceId, r.key, r.action])).toEqual([
      [w2.workspaceId.toString(), 'connector.serpapi', 'note'],
      [w2.workspaceId.toString(), 'mailbox.imap_sync', 'hold'],
      [w2.workspaceId.toString(), 'outreach.send', 'hold'],
    ]);
    expect(plan.totals).toMatchObject({ flags: 8, holds: 2, notes: 1, dropped: 5, toInsert: 3 });
    const report = renderLegacyFlagReport(plan);
    const importSection = report.split('Dropped (not imported):')[0]!;
    expect(
      importSection.match(/\| (connector\.serpapi|mailbox\.imap_sync|outreach\.send) \|/g),
    ).toHaveLength(3);
    expect(await db.select().from(workspaceHolds)).toEqual([]);
  });

  it('apply imports pending_review rows that are NOT enforced, idempotently', async () => {
    const { w2 } = await seedProdLikeFlags();
    const first = await applyLegacyFlagImport(db);
    expect(first.inserted).toBe(3);
    expect((await applyLegacyFlagImport(db)).inserted).toBe(0);

    const rows = await db
      .select()
      .from(workspaceHolds)
      .where(eq(workspaceHolds.workspaceId, w2.workspaceId));
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r).toMatchObject({
        state: 'pending_review',
        source: 'platform',
        placedByUserId: superAdminId,
      });
    }
    expect(rows.find((r) => r.legacyFlagKey === 'connector.serpapi')).toMatchObject({
      kind: 'note',
      capabilities: [],
    });
    expect(await auditRows(w2.workspaceId, 'workspace.hold.import')).toHaveLength(3);
    expect(await auditRows(null, 'admin.legacy_flags.import')).toHaveLength(2);

    // (4) not enforced: every capability is still allowed for w2.
    for (const c of AUTOMATION_CAPABILITIES) {
      expect((await checkGate(w2.member, c)).allowed).toBe(true);
      expect((await checkGate(w2.auto, c)).allowed).toBe(true);
    }
    expect((await getWorkspaceAutomationNotice(w2.member)).holds).toEqual([]);
  });

  it('(4)+(5) X6: imap_sync syncs until confirmed; once confirmed the workspace syncs 0 messages', async () => {
    const { w2 } = await seedProdLikeFlags();
    await applyLegacyFlagImport(db);
    const mb = await makeMailbox(w2, { imap: true });
    const provider = new MockMailProvider();
    _setMailProviderFactoryForTests(() => provider);

    // Pending review: not enforced, the tick syncs (today's behaviour).
    provider.enqueueInbound(inbound(mb.fromAddress));
    expect((await runImapTick()).mailboxesSynced).toBe(1);
    expect(await messageCount(w2.workspaceId)).toBe(1);

    const imapRow = (await listWorkspaceHolds(w2.owner)).find(
      (h) => h.legacyFlagKey === 'mailbox.imap_sync',
    )!;
    const confirmed = await confirmLegacyHold(pctx(), w2.workspaceId, imapRow.id);
    expect(confirmed).toMatchObject({ state: 'active', confirmedByUserId: superAdminId });

    // X6 regression: 0 messages synced, by the tick and by hand.
    provider.enqueueInbound(inbound(mb.fromAddress), inbound(mb.fromAddress));
    await db.update(mailboxes).set({ imapNextSyncAfter: null }).where(eq(mailboxes.id, mb.id));
    const tick = await runImapTick();
    expect(tick).toMatchObject({ mailboxesSynced: 0, held: 1 });
    await expectGateError(safeSyncOne(w2.member, mb));
    expect(await messageCount(w2.workspaceId)).toBe(1);

    // The note cannot be confirmed; it is discarded once read.
    const note = (await listWorkspaceHolds(w2.owner)).find((h) => h.kind === 'note')!;
    await expect(confirmLegacyHold(pctx(), w2.workspaceId, note.id)).rejects.toBeInstanceOf(
      HoldServiceError,
    );
    const discarded = await discardLegacyHold(pctx(), w2.workspaceId, note.id);
    expect(discarded.state).toBe('discarded');
    // outreach.send stays pending (never confirmed): sending is still allowed.
    expect((await checkGate(w2.auto, 'sending')).allowed).toBe(true);
  });
});
