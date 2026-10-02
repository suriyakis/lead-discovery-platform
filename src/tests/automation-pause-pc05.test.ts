// PC-05 — the automation gate's workspace pause, per-item re-checks, the
// failing-mailbox deferral and the wallet gate; with flow:F-07's go-live
// hold and the backend of ia:F-18 / MOB-07 (pause / undo / resume).
//
// Acceptance:
//   (1) decideGate truth-table tests cover every input combination;
//   (2) while paused: the drain claims 0 rows, the follow-up tick makes 0
//       AI calls and 0 debits, the crawl tick starts 0 runs, runOnce does
//       nothing, the trash purge deletes 0 rows, auto top-up does not
//       charge, a manual reply sends (after "send anyway") and shows the
//       notice, POST unsubscribe still works. Owner decision (overrides
//       the spec line "the IMAP tick syncs 0 mailboxes"): inbox sync keeps
//       reading while paused, and reply auto-actions wait;
//   (3) a pause committed while the drain is on row k of 50: no row has
//       claimed_at later than paused_at, and rows after k stay queued;
//   (4) a failing mailbox's rows stay queued with the explanatory
//       last_error, none becomes failed (P0-F08: paused ones too);
//   (5) with an empty wallet compaction makes 0 AI calls, and the crawl
//       tick moves nextRunAt without recording recipe failures;
//   (6) pausing works on a lapsed plan;
//   (7) after resume the next tick of each kind runs normally.
// Plus: the go-live hold (cold / follow_up / ai_reply held, manual sends),
// pause / undo / resume permissions and audit (actor, device, source),
// held reply auto-actions, the legacy emergency_pause migration and the
// removal of their readers.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/connectors/mock';
import fs from 'node:fs';
import path from 'node:path';
import { and, count, eq, sql } from 'drizzle-orm';
import type { ZodSchema } from 'zod';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { db } from '@/lib/db/client';
import {
  _setAIProviderForTests,
  type AIGenInput,
  type AIGenResult,
  type IAIProvider,
} from '@/lib/ai';
import { auditLog } from '@/lib/db/schema/audit';
import { autopilotSettings } from '@/lib/db/schema/autopilot';
import { connectorRuns, crawlPlans, sourceRecords } from '@/lib/db/schema/connectors';
import { contactAssociations, contacts } from '@/lib/db/schema/contacts';
import { outreachFollowUps } from '@/lib/db/schema/follow-ups';
import { AUTOMATION_CAPABILITIES, type AutomationCapability } from '@/lib/db/schema/holds';
import {
  mailMessages,
  mailThreads,
  mailboxes,
  type Mailbox,
  type MailboxStatus,
} from '@/lib/db/schema/mailing';
import {
  outreachDrafts,
  outreachQueue,
  outreachSendSettings,
  outreachThreadState,
} from '@/lib/db/schema/outreach';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { productProfiles } from '@/lib/db/schema/products';
import { reviewItems } from '@/lib/db/schema/review';
import { tokenTransactions } from '@/lib/db/schema/tokens';
import { workspaces } from '@/lib/db/schema/workspaces';
import { MockMailProvider, type InboundMessage, type OutboundMessage, type SendResult } from '@/lib/mail';
import {
  runAutopilotTick,
  runCrawlEngineTick,
  runDrainTick,
  runFollowUpTick,
  runImapTick,
  runKnowledgeCompactTick,
  runMailTrashPurgeTick,
} from '@/lib/jobs/repeatables';
import {
  AutomationGateError,
  GATE_DEFER_MS,
  PAUSED_MANUAL_SEND_MESSAGE,
  PAUSED_MESSAGE,
  decideGate,
  getWorkspaceAutomationNotice,
  loadAutomationState,
  originForDraft,
  type AutomationState,
  type EnforcedHold,
  type GateDecision,
  type SendOrigin,
} from '@/lib/services/automation-gate';
import {
  AutomationPauseError,
  PAUSE_UNDO_WINDOW_MS,
  getAutomationPauseOverview,
  listHeldInboundActions,
  pauseAutomation,
  resumeAutomation,
  undoPause,
} from '@/lib/services/automation-pause';
import { GoLiveError, releaseOutreachLive, revokeOutreachLive } from '@/lib/services/go-live';
import { runOnce, updateAutopilotSettings } from '@/lib/services/autopilot';
import { attemptAutoTopup } from '@/lib/services/billing';
import { type WorkspaceContext, makeAutomationContext, makeWorkspaceContext } from '@/lib/services/context';
import { createConnector, createRecipe } from '@/lib/services/connector-run';
import { createCrawlPlan, processDueCrawlPlans, runCrawlPlanNow } from '@/lib/services/crawl-engine';
import {
  approveFollowUp,
  processDueFollowUps,
  scheduleFollowUps,
  updateFollowUpConfig,
} from '@/lib/services/follow-up';
import { runWorkspaceHealthCheck } from '@/lib/services/health-check';
import {
  compactWorkspaceKnowledge,
  compactWorkspaceKnowledgeUnattended,
} from '@/lib/services/knowledge-compaction';
import { synthesizeWorkspaceLearningUnattended } from '@/lib/services/learning-synthesis';
import {
  purgeOldTrashUnattended,
  retrySend,
  sendMessage,
  sendTestEmail,
} from '@/lib/services/mail';
import { placePlatformHold } from '@/lib/services/holds';
import { _setMailProviderFactoryForTests, createMailbox } from '@/lib/services/mailbox';
import { handleClassifiedReply } from '@/lib/services/outreach-reply-handler';
import { drainQueue } from '@/lib/services/outreach-queue';
import { updateReplyAutoActions } from '@/lib/services/reply-auto-actions';
import { analyseReply, type ReplyClassification } from '@/lib/services/reply-classifier';
import { isSuppressed } from '@/lib/services/suppression';
import { maybeAutoTranslateInbound } from '@/lib/services/translation';
import { createWorkspace } from '@/lib/services/workspace';
import { AutomationHoldBanner } from '@/components/AutomationHoldBanner';
import { AutomationPauseControl } from '@/components/AutomationPauseControl';
import { CommunicationReply } from '@/components/CommunicationReply';
import { POST as unsubscribePost } from '@/app/api/unsubscribe/[token]/route';
import { settleDetached } from '@/lib/detached';
import { platformCtx, smuggled } from './helpers/platform';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { expectRedirect } from './helpers/next-render';

// Server actions are called with a plain session instead of Auth.js
// (same harness as mailbox-queue.test.ts); the pause actions read the
// User-Agent for the audit's device.
const session = vi.hoisted(() => ({
  current: null as null | { user: { id: string; role: 'member'; accountStatus: 'active' } },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));
vi.mock('next/headers', () => ({
  headers: async () =>
    new Headers({ 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148' }),
  cookies: async () => ({ get: () => undefined }),
}));

function signInAs(userId: string): void {
  session.current = { user: { id: userId, role: 'member', accountStatus: 'active' } };
}

const SRC = path.resolve(__dirname, '..');
const REPO = path.resolve(SRC, '..');

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

async function tenant(
  opts: { name?: string; live?: boolean; plan?: 'free' | 'starter' | 'pro' } = {},
): Promise<Tenant> {
  seq++;
  const name = opts.name ?? 'pc05';
  const ownerId = await seedUser({ email: `${name}-owner-${seq}@test.local` });
  const adminId = await seedUser({ email: `${name}-admin-${seq}@test.local` });
  const memberId = await seedUser({ email: `${name}-member-${seq}@test.local` });
  const viewerId = await seedUser({ email: `${name}-viewer-${seq}@test.local` });
  const workspaceId = await seedWorkspace({
    name: `${name}-${seq}`,
    ownerUserId: ownerId,
    live: opts.live,
    plan: opts.plan,
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

const pctx = () => platformCtx(superAdminId);

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

/** A due queue row without a draft (its origin fails closed as cold). */
async function queueRow(t: Tenant, mailboxId: bigint, to = 'anna@target.com', ageMs = 60_000) {
  const [row] = await db
    .insert(outreachQueue)
    .values({
      workspaceId: t.workspaceId,
      mailboxId,
      toAddresses: [to],
      subject: 'Hello',
      bodyText: 'Hi there',
      delayMode: 'immediate',
      scheduledSendAt: new Date(Date.now() - ageMs),
      status: 'queued',
      createdBy: t.ownerId,
    })
    .returning();
  return row!;
}

async function queueRowsOf(t: Tenant) {
  return db
    .select()
    .from(outreachQueue)
    .where(eq(outreachQueue.workspaceId, t.workspaceId))
    .orderBy(outreachQueue.id);
}

async function auditRows(workspaceId: bigint, kind: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.kind, kind)));
}

async function ledgerRows(workspaceId: bigint): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(tokenTransactions)
    .where(eq(tokenTransactions.workspaceId, workspaceId));
  return Number(r?.n ?? 0);
}

async function setWallet(t: Tenant, balance: bigint) {
  await db.update(workspaces).set({ tokenBalance: balance }).where(eq(workspaces.id, t.workspaceId));
}

/** A queued draft-backed row of the given origin (cold first touch or an
 *  AI reply draft) for the go-live hold. */
async function draftRow(t: Tenant, mailboxId: bigint, origin: 'cold' | 'ai_reply', to: string) {
  const [sr] = await db
    .insert(sourceRecords)
    .values({
      workspaceId: t.workspaceId,
      sourceSystem: 'mock',
      sourceId: `pc05-${origin}-${seq}-${Math.random()}`,
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
    .values({ workspaceId: t.workspaceId, name: `P-${origin}` })
    .returning();
  const [draft] = await db
    .insert(outreachDrafts)
    .values({
      workspaceId: t.workspaceId,
      reviewItemId: ri!.id,
      sourceRecordId: sr!.id,
      productProfileId: product!.id,
      status: 'approved',
      stage: origin === 'cold' ? 'discovery' : 'engagement',
      triggeredByMessageId: origin === 'cold' ? null : 999n,
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
      scheduledSendAt: new Date(Date.now() - 60_000),
      status: 'queued',
      createdBy: t.ownerId,
    })
    .returning();
  return row!;
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

async function followUpRow(id: bigint) {
  const [row] = await db.select().from(outreachFollowUps).where(eq(outreachFollowUps.id, id));
  return row!;
}

/** A prospect reply on a thread linked to a lead (reply handler fixture). */
async function replyFixture(t: Tenant, body: string, from = 'anna@target.com') {
  const [mb] = await db
    .insert(mailboxes)
    .values({
      workspaceId: t.workspaceId,
      name: `inbox-${seq}`,
      fromAddress: `inbox-${seq}@nulife.pl`,
      smtpHost: 'smtp.x',
      smtpUser: 'inbox',
      smtpPasswordSecretKey: `mailbox.smtp_pc05_${seq}`,
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
      externalThreadKey: `subj:pc05-${seq}-${Date.now()}-${from}`,
      participants: [from, mb!.fromAddress],
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
      messageId: `<reply-pc05-${seq}-${Date.now()}-${from}>`,
      fromAddress: from,
      toAddresses: [mb!.fromAddress],
      subject: 'Re: hi',
      bodyText: body,
      outreachRelevance: 'prospect_reply',
    })
    .returning();
  const [contact] = await db
    .insert(contacts)
    .values({ workspaceId: t.workspaceId, email: from, name: 'Anna', status: 'active' })
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
  return { messageId: msg!.id, leadId: lead!.id, mailbox: mb!, threadId: thread!.id };
}

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

async function crawlFixture(t: Tenant) {
  const conn = await createConnector(t.owner, { templateType: 'mock', name: `c-${seq}` });
  const recipe = await createRecipe(t.owner, { connectorId: conn.id, name: `r-${seq}`, active: true });
  const plan = await createCrawlPlan(t.owner, {
    name: `p-${seq}`,
    intervalMinutes: 60,
    recipeIds: [recipe.id],
    productProfileIds: [],
  });
  await db
    .update(crawlPlans)
    .set({ nextRunAt: new Date(Date.now() - 60_000) })
    .where(eq(crawlPlans.id, plan.id));
  const [row] = await db.select().from(crawlPlans).where(eq(crawlPlans.id, plan.id));
  return { conn, recipe, plan: row! };
}

async function runsOf(t: Tenant): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(connectorRuns)
    .where(eq(connectorRuns.workspaceId, t.workspaceId));
  return Number(r?.n ?? 0);
}

async function trashedMessage(t: Tenant, mailboxId: bigint, daysAgo: number) {
  const [thread] = await db
    .insert(mailThreads)
    .values({
      workspaceId: t.workspaceId,
      mailboxId,
      subject: 'Old',
      externalThreadKey: `subj:trash-${seq}-${Math.random()}`,
      participants: [],
    })
    .returning();
  const [m] = await db
    .insert(mailMessages)
    .values({
      workspaceId: t.workspaceId,
      mailboxId,
      threadId: thread!.id,
      direction: 'inbound',
      status: 'received',
      messageId: `<trash-${seq}-${Math.random()}@x>`,
      fromAddress: 'old@x.com',
      toAddresses: ['me@x.com'],
      subject: 'Old',
      bodyText: 'old',
      trashedAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
    })
    .returning();
  return m!;
}

async function messageExists(id: bigint): Promise<boolean> {
  return (await db.select({ id: mailMessages.id }).from(mailMessages).where(eq(mailMessages.id, id)))
    .length > 0;
}

beforeEach(async () => {
  await truncateAll();
  superAdminId = await seedUser({ email: 'root@platform.test', role: 'super_admin' });
  _setMailProviderFactoryForTests(() => new MockMailProvider());
  _setAIProviderForTests(null);
  session.current = null;
});

afterEach(() => {
  _setMailProviderFactoryForTests(null);
  _setAIProviderForTests(null);
});

afterAll(async () => {
  await settleDetached();
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- (1) the pure gate: truth table ------------------------------------

interface Row {
  capability: AutomationCapability;
  manual: boolean;
  archived: boolean;
  platformStop: boolean;
  hold: boolean;
  ownerProblem: boolean;
  paused: boolean;
  confirmPaused: boolean;
  planAllowsAutopilot: boolean;
  origin: SendOrigin | undefined;
  live: boolean;
  mailboxStatus: MailboxStatus | undefined;
  spendsTokens: boolean;
  walletHasTokens: boolean;
}

const AT = new Date('2026-10-02T12:00:00Z');

function stateFor(r: Row): AutomationState {
  const hold: EnforcedHold = {
    id: 1n,
    scope: 'capabilities',
    capabilities: [r.capability],
    source: 'platform',
    reason: 'x',
    expiresAt: null,
    placedAt: AT,
    blocksAccess: false,
  };
  return {
    workspaceId: 1n,
    workspaceStatus: r.archived ? 'archived' : 'active',
    ownerUserId: 'owner',
    ownerAccountStatus: r.ownerProblem ? 'suspended' : 'active',
    ownerIsMember: true,
    ownerProblem: r.ownerProblem ? 'owner_inactive' : null,
    ownerIncidentOpenSince: null,
    holds: r.hold ? [hold] : [],
    platformOutboundStop: r.platformStop ? { since: AT, byUserId: null, reason: 'stop' } : null,
    pause: r.paused ? { since: AT, byUserId: 'u', reason: null, source: 'api' } : null,
    live: r.live ? { since: AT, byUserId: null } : null,
    walletHasTokens: r.walletHasTokens,
    planAllowsAutopilot: r.planAllowsAutopilot,
    evaluatedAt: AT,
  };
}

type Expected =
  | { allowed: true; pauseOverridden?: true }
  | { allowed: false; reason: string; scope: 'workspace' | 'item'; overridable: boolean };

/** The rule table of the gate, restated from the spec (first match wins). */
function expected(r: Row): Expected {
  const no = (reason: string, scope: 'workspace' | 'item' = 'workspace', overridable = false) =>
    ({ allowed: false, reason, scope, overridable }) as const;
  if (!r.manual && r.archived) return no('workspace_archived');
  if (r.capability === 'sending' && r.platformStop) return no('platform_outbound_stop');
  if (r.hold) return no('hold');
  if (!r.manual && r.ownerProblem) return no('no_accountable_owner');
  let overridden = false;
  if (r.paused && r.capability !== 'inbox_sync') {
    if (!r.manual) return no('paused');
    if (r.capability === 'sending') {
      if (!r.confirmPaused) return no('paused', 'workspace', true);
      overridden = true;
    }
  }
  if (r.capability === 'autopilot' && !r.planAllowsAutopilot) return no('plan_no_autopilot');
  if (r.capability === 'sending' && r.origin && r.origin !== 'manual' && !r.live) {
    return no('not_live', 'item');
  }
  if (!r.manual && r.mailboxStatus && r.mailboxStatus !== 'active') {
    return no('mailbox_not_active', 'item');
  }
  if (r.spendsTokens && !r.walletHasTokens) return no('wallet_empty');
  return overridden ? { allowed: true, pauseOverridden: true } : { allowed: true };
}

function same(d: GateDecision, e: Expected): boolean {
  if (d.allowed !== e.allowed) return false;
  if (d.allowed && e.allowed) return d.pauseOverridden === e.pauseOverridden;
  if (!d.allowed && !e.allowed) {
    return d.reason === e.reason && d.scope === e.scope && d.overridable === e.overridable;
  }
  return false;
}

describe('(1) decideGate — truth table over every input combination', () => {
  it('matches the rule table for all 460,800 combinations', () => {
    const bools = [false, true];
    const origins: Array<SendOrigin | undefined> = [undefined, 'cold', 'follow_up', 'ai_reply', 'manual'];
    const statuses: Array<MailboxStatus | undefined> = [undefined, 'active', 'paused', 'failing', 'archived'];
    let n = 0;
    const mismatches: string[] = [];
    for (const capability of AUTOMATION_CAPABILITIES)
      for (const manual of bools)
        for (const archived of bools)
          for (const platformStop of bools)
            for (const hold of bools)
              for (const ownerProblem of bools)
                for (const paused of bools)
                  for (const confirmPaused of bools)
                    for (const planAllowsAutopilot of bools)
                      for (const origin of origins)
                        for (const live of bools)
                          for (const mailboxStatus of statuses)
                            for (const spendsTokens of bools)
                              for (const walletHasTokens of bools) {
                                const r: Row = {
                                  capability,
                                  manual,
                                  archived,
                                  platformStop,
                                  hold,
                                  ownerProblem,
                                  paused,
                                  confirmPaused,
                                  planAllowsAutopilot,
                                  origin,
                                  live,
                                  mailboxStatus,
                                  spendsTokens,
                                  walletHasTokens,
                                };
                                const d = decideGate(stateFor(r), capability, {
                                  manual,
                                  origin,
                                  mailboxStatus,
                                  spendsTokens,
                                  confirmPaused,
                                });
                                n++;
                                if (!same(d, expected(r)) && mismatches.length < 10) {
                                  mismatches.push(`${JSON.stringify(r)} → ${JSON.stringify(d)}`);
                                }
                              }
    expect(mismatches).toEqual([]);
    expect(n).toBe(9 * 2 ** 11 * 5 * 5);
  });

  const neutral: Row = {
    capability: 'sending',
    manual: false,
    archived: false,
    platformStop: false,
    hold: false,
    ownerProblem: false,
    paused: false,
    confirmPaused: false,
    planAllowsAutopilot: true,
    origin: undefined,
    live: true,
    mailboxStatus: undefined,
    spendsTokens: false,
    walletHasTokens: true,
  };
  const decide = (r: Partial<Row>) => {
    const row = { ...neutral, ...r };
    return decideGate(stateFor(row), row.capability, {
      manual: row.manual,
      origin: row.origin,
      mailboxStatus: row.mailboxStatus,
      spendsTokens: row.spendsTokens,
      confirmPaused: row.confirmPaused,
    });
  };

  it('the pause stops every automatic capability except Inbox sync, workspace-wide', () => {
    for (const capability of AUTOMATION_CAPABILITIES) {
      const d = decide({ capability, paused: true });
      if (capability === 'inbox_sync') expect(d).toEqual({ allowed: true });
      else {
        expect(d).toMatchObject({ allowed: false, reason: 'paused', scope: 'workspace' });
        expect((d as { message: string }).message).toBe(PAUSED_MESSAGE);
      }
    }
  });

  it('a manual send under the pause is refused (overridable) until "send anyway"; other manual work goes on', () => {
    expect(decide({ manual: true, paused: true })).toMatchObject({
      allowed: false,
      reason: 'paused',
      overridable: true,
      message: PAUSED_MANUAL_SEND_MESSAGE,
    });
    expect(decide({ manual: true, paused: true, confirmPaused: true })).toEqual({
      allowed: true,
      pauseOverridden: true,
    });
    // confirmPaused means nothing without a pause, and nothing for automatic work.
    expect(decide({ manual: true, confirmPaused: true })).toEqual({ allowed: true });
    expect(decide({ paused: true, confirmPaused: true })).toMatchObject({ reason: 'paused' });
    for (const capability of ['discovery', 'crm_sync', 'background_ai', 'inbox_sync'] as const) {
      expect(decide({ capability, manual: true, paused: true })).toEqual({ allowed: true });
    }
  });

  it('the go-live hold holds cold, follow-up and AI-reply mail (manual too) per item, never manual mail', () => {
    for (const origin of ['cold', 'follow_up', 'ai_reply'] as const) {
      for (const manual of [false, true]) {
        expect(decide({ live: false, origin, manual })).toMatchObject({
          allowed: false,
          reason: 'not_live',
          scope: 'item',
        });
      }
      expect(decide({ live: true, origin })).toEqual({ allowed: true });
    }
    expect(decide({ live: false, origin: 'manual', manual: true })).toEqual({ allowed: true });
    // Asked about sending in general (no origin), not live is not a stop.
    expect(decide({ live: false })).toEqual({ allowed: true });
  });

  it('a mailbox that is not active defers automatic work on it (item), not manual work', () => {
    for (const mailboxStatus of ['paused', 'failing', 'archived'] as const) {
      expect(decide({ mailboxStatus })).toMatchObject({
        allowed: false,
        reason: 'mailbox_not_active',
        scope: 'item',
      });
      expect(decide({ mailboxStatus, manual: true })).toEqual({ allowed: true });
    }
    expect(decide({ mailboxStatus: 'failing' })).toMatchObject({
      message: expect.stringMatching(/^Held: the mailbox is failing/),
    });
  });

  it('an empty wallet stops token-spending work (manual too); plan gates only autopilot', () => {
    expect(decide({ spendsTokens: true, walletHasTokens: false, capability: 'background_ai' })).toMatchObject({
      reason: 'wallet_empty',
    });
    expect(
      decide({ spendsTokens: true, walletHasTokens: false, capability: 'discovery', manual: true }),
    ).toMatchObject({ reason: 'wallet_empty' });
    expect(decide({ walletHasTokens: false, capability: 'sending' })).toEqual({ allowed: true });
    expect(decide({ capability: 'autopilot', planAllowsAutopilot: false })).toMatchObject({
      reason: 'plan_no_autopilot',
    });
    expect(decide({ capability: 'sending', planAllowsAutopilot: false })).toEqual({ allowed: true });
  });

  it('origins come from the draft: a reply-triggered draft past discovery is an AI reply, else cold', () => {
    expect(originForDraft({ stage: 'discovery', triggeredByMessageId: null })).toBe('cold');
    expect(originForDraft({ stage: 'discovery', triggeredByMessageId: 5n })).toBe('cold');
    expect(originForDraft({ stage: 'engagement', triggeredByMessageId: 5n })).toBe('ai_reply');
    expect(originForDraft({ stage: 'pitch', triggeredByMessageId: null })).toBe('cold');
  });
});

// ---- (2) while paused ----------------------------------------------------

describe('(2) while paused nothing runs on its own', { timeout: 60_000 }, () => {
  it('the drain claims 0 rows: rows stay queued, never stamped, untouched; ticks count it held', async () => {
    const t = await tenant();
    const mb = await makeMailbox(t);
    const a = await queueRow(t, mb.id, 'a@target.com');
    const b = await queueRow(t, mb.id, 'b@target.com');
    await pauseAutomation(t.member, { source: 'api' });

    const provider = new MockMailProvider();
    const r = await drainQueue(t.owner, { providerOverride: provider });
    expect(r).toEqual({
      picked: 0,
      sent: 0,
      failed: 0,
      retrying: 0,
      blocked: 'paused',
      skipped: 0,
      deferred: 0,
      heldReason: PAUSED_MESSAGE,
    });
    expect(await runDrainTick()).toMatchObject({ totalSent: 0, held: 1 });
    expect(provider.sent).toHaveLength(0);
    for (const before of [a, b]) {
      const [row] = await db.select().from(outreachQueue).where(eq(outreachQueue.id, before.id));
      expect(row).toMatchObject({
        status: 'queued',
        attemptCount: 0,
        claimedAt: null,
        lastError: null,
        scheduledSendAt: before.scheduledSendAt,
        updatedAt: before.updatedAt,
      });
    }
  });

  it('the follow-up tick makes 0 AI calls and 0 debits; the step stays pending', async () => {
    const t = await tenant();
    const provider = new MockMailProvider();
    const { step } = await followUpFixture(t, provider);
    const ai = new CountingAi();
    _setAIProviderForTests(ai);
    _setMailProviderFactoryForTests(() => provider);
    await pauseAutomation(t.member, { source: 'api' });
    const sentBefore = provider.sent.length;
    const ledgerBefore = await ledgerRows(t.workspaceId);

    expect(await runFollowUpTick()).toMatchObject({ sent: 0, failed: 0, held: 1 });
    const direct = await processDueFollowUps(t.auto, { mailProviderOverride: provider });
    expect(direct).toMatchObject({ checked: 0, sent: 0, heldReason: PAUSED_MESSAGE });
    expect(ai.calls).toBe(0);
    expect(await ledgerRows(t.workspaceId)).toBe(ledgerBefore);
    expect(provider.sent.length).toBe(sentBefore);
    expect((await followUpRow(step.id)).status).toBe('pending');
  });

  it('the crawl tick starts 0 runs and due plans stay due; Run now by a person still runs', async () => {
    const t = await tenant();
    const { plan } = await crawlFixture(t);
    await pauseAutomation(t.member, { source: 'api' });

    expect(await runCrawlEngineTick()).toMatchObject({ totalStartedRuns: 0, held: 1 });
    expect((await processDueCrawlPlans(t.auto)).heldReason).toBe(PAUSED_MESSAGE);
    expect(await runsOf(t)).toBe(0);
    const [after] = await db.select().from(crawlPlans).where(eq(crawlPlans.id, plan.id));
    expect(after!.nextRunAt).toEqual(plan.nextRunAt);
    expect(after!.lastRunAt).toBeNull();
    // The pause stops automation, not a person.
    const manual = await runCrawlPlanNow(t.member, plan.id);
    expect(manual.startedRuns).toHaveLength(1);
  });

  it('runOnce does nothing (any trigger) and the autopilot tick skips the workspace', async () => {
    const t = await tenant();
    await updateAutopilotSettings(t.owner, {
      autopilotEnabled: true,
      enableAutoApproveProjects: true,
      enableAutoCrmContactSync: true,
    });
    await pauseAutomation(t.member, { source: 'api' });
    for (const c of [t.owner, t.auto]) {
      const r = await runOnce(c);
      expect(r.steps).toEqual([{ step: 'guard', outcome: 'skipped', detail: `held: ${PAUSED_MESSAGE}` }]);
    }
    expect(await runAutopilotTick()).toMatchObject({ stepsRun: 0, held: 1 });
  });

  it('owner decision: inbox sync keeps reading while paused; reply auto-actions, AI drafts and translations wait', async () => {
    const t = await tenant();
    const mb = await makeMailbox(t, { imap: true });
    const provider = new MockMailProvider();
    const inbound: InboundMessage = {
      uid: 1,
      messageId: `<paused-in-${seq}@sender.example>`,
      inReplyTo: null,
      references: [],
      from: { address: 'sender@sender.example' },
      to: [{ address: mb.fromAddress }],
      cc: [],
      subject: 'Hello',
      textBody: 'Hello there',
      htmlBody: null,
      receivedAt: new Date(Date.now() - 1000),
      headers: {},
      attachments: [],
    };
    provider.enqueueInbound(inbound);
    _setMailProviderFactoryForTests(() => provider);
    await pauseAutomation(t.member, { source: 'api' });

    expect(await runImapTick()).toMatchObject({ mailboxesSynced: 1, held: 0, failed: 0 });
    const [msg] = await db
      .select()
      .from(mailMessages)
      .where(and(eq(mailMessages.workspaceId, t.workspaceId), eq(mailMessages.direction, 'inbound')));
    expect(msg).toBeDefined();

    // An "unsubscribe" reply to our outreach: 0 suppressions, 0 translations,
    // 0 AI drafts, 1 held action (MOB-07 / ia:F-18).
    await updateReplyAutoActions(t.owner, { autoSuppressUnsubscribe: true, autoCloseNegative: true });
    const ai = new CountingAi();
    _setAIProviderForTests(ai);
    const unsub = await replyFixture(t, 'please unsubscribe me from this list');
    await analyseReply(t.owner, unsub.messageId);
    expect(await isSuppressed(t.owner, 'anna@target.com')).toBe(false);
    const [lead] = await db.select().from(qualifiedLeads).where(eq(qualifiedLeads.id, unsub.leadId));
    expect(lead!.state).toBe('relevant');
    expect(await maybeAutoTranslateInbound(t.owner, unsub.messageId)).toBe('skipped:held');
    const question = await replyFixture(t, 'How does this work?', 'bob@other.example');
    const drafted = await handleClassifiedReply(t.owner, question.messageId, questionVerdict);
    expect(drafted.draftIds).toEqual([]);
    expect(ai.calls).toBe(0);

    const overview = await getAutomationPauseOverview(t.admin);
    expect(overview.impact.heldInboundActions).toBe(1);
    expect(await listHeldInboundActions(t.admin)).toEqual([
      expect.objectContaining({ messageId: unsub.messageId.toString() }),
    ]);
    const resumed = await resumeAutomation(t.admin, { source: 'api' });
    expect(resumed).toMatchObject({ wasPaused: true, heldInboundActions: 1 });
  });

  it('only a reply that would trigger an auto-action counts as held: positive and out-of-office replies write no held row', async () => {
    const t = await tenant();
    await updateReplyAutoActions(t.owner, {
      autoSuppressUnsubscribe: true,
      autoSuppressBounce: true,
      autoCloseNegative: true,
      autoExtractRedirects: true,
    });
    await pauseAutomation(t.member, { source: 'api' });
    const positive = await replyFixture(t, 'Sounds good, happy to talk next week.');
    const away = await replyFixture(t, 'I am out of the office until Monday.', 'bob@other.example');
    expect((await analyseReply(t.owner, positive.messageId)).type).toBe('positive');
    expect((await analyseReply(t.owner, away.messageId)).type).toBe('out_of_office');
    expect(await auditRows(t.workspaceId, 'reply.auto_actions_held')).toHaveLength(0);
    expect((await getAutomationPauseOverview(t.admin)).impact.heldInboundActions).toBe(0);
    expect(await resumeAutomation(t.admin, { source: 'api' })).toMatchObject({
      wasPaused: true,
      heldInboundActions: 0,
    });
  });

  it('redirect extraction is an inbound auto-action: while paused it creates no contact and counts as one held action', async () => {
    const body = 'I am not the right person. Please contact john@buyer.example about this.';
    const contactsNamed = async (t: Tenant, email: string) =>
      db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.workspaceId, t.workspaceId), eq(contacts.email, email)));

    // Counterfactual: not paused, the same reply creates the contact.
    const free = await tenant();
    const freeReply = await replyFixture(free, body);
    const verdict = await analyseReply(free.owner, freeReply.messageId);
    expect(verdict).toMatchObject({ type: 'redirect', extractedEmails: ['john@buyer.example'] });
    expect(await contactsNamed(free, 'john@buyer.example')).toHaveLength(1);

    // The defaults (only redirect extraction on): paused, no contact.
    const t = await tenant({ name: 'paused' });
    await pauseAutomation(t.member, { source: 'api' });
    const reply = await replyFixture(t, body);
    expect((await analyseReply(t.owner, reply.messageId)).type).toBe('redirect');
    expect(await contactsNamed(t, 'john@buyer.example')).toHaveLength(0);
    const held = await auditRows(t.workspaceId, 'reply.auto_actions_held');
    expect(held).toHaveLength(1);
    expect(held[0]!.payload).toMatchObject({
      classification: 'redirect',
      action: 'extract_redirects',
      gate: 'paused',
    });
    expect((await getAutomationPauseOverview(t.admin)).impact.heldInboundActions).toBe(1);
  });

  it('the trash purge deletes 0 rows (tick and direct)', async () => {
    const t = await tenant();
    const mb = await makeMailbox(t);
    const old = await trashedMessage(t, mb.id, 90);
    await pauseAutomation(t.member, { source: 'api' });
    expect(await runMailTrashPurgeTick()).toMatchObject({ deleted: 0, held: 1 });
    expect(await purgeOldTrashUnattended(t.workspaceId)).toMatchObject({
      deleted: 0,
      heldReason: PAUSED_MESSAGE,
    });
    expect(await messageExists(old.id)).toBe(true);
  });

  it('auto top-up does not charge', async () => {
    const t = await tenant();
    await db
      .update(workspaces)
      .set({ autoTopupEnabled: true, autoTopupPackId: 'pack_s' })
      .where(eq(workspaces.id, t.workspaceId));
    await pauseAutomation(t.member, { source: 'api' });
    expect(await attemptAutoTopup(t.workspaceId)).toBe('skipped');
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, t.workspaceId));
    expect(ws!.autoTopupLastAt).toBeNull();
  });

  it('a manual reply shows the notice, then sends after "send anyway" with one outbound.override audit row', async () => {
    const t = await tenant();
    const mb = await makeMailbox(t);
    await pauseAutomation(t.member, { source: 'api' });
    const provider = new MockMailProvider();
    const reply = {
      mode: 'one_to_one' as const,
      origin: 'manual' as const,
      mailboxId: mb.id,
      to: [{ address: 'anna@target.com' }],
      subject: 'Re: Quick question',
      text: 'Tuesday works.',
      providerOverride: provider,
    };
    let refused: unknown = null;
    try {
      await sendMessage(t.member, reply);
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(AutomationGateError);
    expect(refused).toMatchObject({
      reason: 'paused',
      overridable: true,
      message: PAUSED_MANUAL_SEND_MESSAGE,
    });
    expect(provider.sent).toHaveLength(0);

    const sent = await sendMessage(t.member, { ...reply, confirmPaused: true });
    expect(sent.status).toBe('sent');
    expect(provider.sent).toHaveLength(1);
    const audits = await auditRows(t.workspaceId, 'outbound.override');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.userId).toBe(t.memberId);
    expect(audits[0]!.payload).toMatchObject({
      override: 'automation_paused',
      origin: 'manual',
      to: ['anna@target.com'],
    });

    // The thread composer shows the notice and the confirm when paused.
    const html = renderToStaticMarkup(
      createElement(CommunicationReply, {
        threadId: '1',
        mailboxId: mb.id.toString(),
        defaultTo: 'anna@target.com',
        defaultSubject: 'Re: Quick question',
        inReplyTo: null,
        references: [],
        signatures: [],
        defaultSignatureId: null,
        nativeLanguage: 'en',
        targetLanguage: null,
        automationPaused: true,
      }),
    );
    expect(html).toContain('Automation is paused in this workspace. Send this reply anyway');
  });

  it('approving a follow-up needs the confirm too; a bulk retry is refused with the reason', async () => {
    const t = await tenant();
    const provider = new MockMailProvider();
    const { step } = await followUpFixture(t, provider);
    await db
      .update(outreachFollowUps)
      .set({ status: 'awaiting_approval', stagedSubject: 'Re: Hi', stagedBody: 'Following up' })
      .where(eq(outreachFollowUps.id, step.id));
    await pauseAutomation(t.member, { source: 'api' });

    await expect(
      approveFollowUp(t.member, step.id, undefined, { mailProviderOverride: provider }),
    ).rejects.toMatchObject({ reason: 'paused', overridable: true });
    expect((await followUpRow(step.id)).status).toBe('awaiting_approval');
    const approved = await approveFollowUp(
      t.member,
      step.id,
      { confirmPaused: true },
      { mailProviderOverride: provider },
    );
    expect(approved.status).toBe('sent');
    expect(await auditRows(t.workspaceId, 'outbound.override')).toHaveLength(1);

    await expect(retrySend(t.member, [1n])).rejects.toMatchObject({
      reason: 'paused',
      overridable: false,
      message: expect.stringContaining('failed emails are not retried'),
    });
  });

  it('a mailbox test email still sends while paused, but never under a Sending hold', async () => {
    const t = await tenant();
    const mb = await makeMailbox(t);
    await pauseAutomation(t.member, { source: 'api' });
    const provider = new MockMailProvider();
    const input = {
      mailboxId: mb.id,
      to: 'me@nulife.pl',
      subject: 'Test',
      body: 'Checking the mailbox',
      providerOverride: provider,
    };
    await expect(sendTestEmail(t.member, input)).resolves.toBeDefined();
    expect(provider.sent).toHaveLength(1);
    await placePlatformHold(pctx(), t.workspaceId, {
      scope: 'capabilities',
      capabilities: ['sending'],
      reason: 'abuse report',
    });
    await expect(sendTestEmail(t.member, input)).rejects.toMatchObject({ reason: 'hold' });
    expect(provider.sent).toHaveLength(1);
  });

  it('POST unsubscribe still works', async () => {
    const t = await tenant();
    const mb = await makeMailbox(t);
    const token = 'ffeedd0123456789abcdef01';
    await db.insert(mailMessages).values({
      workspaceId: t.workspaceId,
      mailboxId: mb.id,
      direction: 'outbound',
      status: 'sent',
      messageId: `<pc05-unsub-${seq}@nulife.pl>`,
      fromAddress: mb.fromAddress,
      toAddresses: ['leaver@target.com'],
      subject: 'Concrete sealing',
      bodyText: 'Hello',
      trackingToken: token,
    });
    await pauseAutomation(t.member, { source: 'api' });
    const res = await unsubscribePost(
      new Request(`http://app.test/api/unsubscribe/${token}`, {
        method: 'POST',
        body: 'List-Unsubscribe=One-Click',
      }),
      { params: Promise.resolve({ token }) },
    );
    expect(res.status).toBe(200);
    expect(await isSuppressed(t.owner, 'leaver@target.com')).toBe(true);
  });

  it('background AI: compaction, synthesis and the scheduled health review skip', async () => {
    const t = await tenant();
    const ai = new CountingAi();
    _setAIProviderForTests(ai);
    await pauseAutomation(t.member, { source: 'api' });
    await expect(compactWorkspaceKnowledgeUnattended(t.workspaceId)).rejects.toMatchObject({
      reason: 'paused',
    });
    expect(await runKnowledgeCompactTick()).toMatchObject({ processed: 0, held: 1 });
    expect(await synthesizeWorkspaceLearningUnattended(t.workspaceId)).toMatchObject({
      ran: false,
      skippedReason: 'held',
    });
    const report = await runWorkspaceHealthCheck({ workspaceId: t.workspaceId });
    expect(report.commReview).toEqual([]);
    expect(ai.calls).toBe(0);
  });
});

// ---- (3) a pause committed mid-drain ------------------------------------

/** Pauses the workspace (as a member) when the k-th email is being sent. */
class PausingProvider extends MockMailProvider {
  constructor(
    private readonly k: number,
    private readonly ctx: WorkspaceContext,
  ) {
    super();
  }
  override async send(message: OutboundMessage): Promise<SendResult> {
    const result = await super.send(message);
    if (this.sent.length === this.k) await pauseAutomation(this.ctx, { source: 'api' });
    return result;
  }
}

/** Sends slowly, so a concurrent pause lands while the drain runs. */
class SlowProvider extends MockMailProvider {
  public firstSent: Promise<void>;
  private markFirst: () => void = () => {};
  constructor(private readonly delayMs: number) {
    super();
    this.firstSent = new Promise((resolve) => {
      this.markFirst = resolve;
    });
  }
  override async send(message: OutboundMessage): Promise<SendResult> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    const result = await super.send(message);
    if (this.sent.length === 1) this.markFirst();
    return result;
  }
}

async function pausedAtOf(t: Tenant): Promise<Date> {
  const [ws] = await db
    .select({ at: workspaces.automationPausedAt })
    .from(workspaces)
    .where(eq(workspaces.id, t.workspaceId));
  return ws!.at!;
}

describe('(3) a pause committed while the drain is on row k of 50', { timeout: 120_000 }, () => {
  it('rows after k stay queued and no row has claimed_at later than paused_at', async () => {
    const t = await tenant();
    const mb = await makeMailbox(t);
    await db
      .insert(outreachSendSettings)
      .values({ workspaceId: t.workspaceId, dailyEmailLimit: 500, domainCooldownHours: 0 })
      .onConflictDoUpdate({
        target: outreachSendSettings.workspaceId,
        set: { dailyEmailLimit: 500, domainCooldownHours: 0 },
      });
    for (let i = 0; i < 50; i++) {
      await queueRow(t, mb.id, `r${i}@d${i}.example`, 60_000 + (50 - i) * 1000);
    }
    const k = 7;
    const provider = new PausingProvider(k, t.member);
    const r = await drainQueue(t.owner, { providerOverride: provider, limit: 50 });

    expect(r.sent).toBe(k);
    expect(r.heldReason).toBe(PAUSED_MESSAGE);
    expect(provider.sent).toHaveLength(k);
    const pausedAt = await pausedAtOf(t);
    const rows = await queueRowsOf(t);
    const sent = rows.filter((x) => x.status === 'sent');
    const rest = rows.filter((x) => x.status !== 'sent');
    expect(sent).toHaveLength(k);
    expect(rest).toHaveLength(50 - k);
    for (const row of rest) {
      expect(row).toMatchObject({ status: 'queued', claimedAt: null, attemptCount: 0 });
    }
    for (const row of sent) {
      expect(row.claimedAt).not.toBeNull();
      expect(row.claimedAt!.getTime()).toBeLessThanOrEqual(pausedAt.getTime());
    }
  });

  it('a concurrent pause: every claim precedes paused_at (the claim and the pause lock the workspace row)', async () => {
    const t = await tenant();
    const mb = await makeMailbox(t);
    await db
      .insert(outreachSendSettings)
      .values({ workspaceId: t.workspaceId, dailyEmailLimit: 500, domainCooldownHours: 0 })
      .onConflictDoUpdate({
        target: outreachSendSettings.workspaceId,
        set: { dailyEmailLimit: 500, domainCooldownHours: 0 },
      });
    for (let i = 0; i < 30; i++) {
      await queueRow(t, mb.id, `c${i}@e${i}.example`, 60_000 + (30 - i) * 1000);
    }
    const provider = new SlowProvider(15);
    const drain = drainQueue(t.owner, { providerOverride: provider, limit: 50 });
    await provider.firstSent;
    await pauseAutomation(t.member, { source: 'api' });
    const r = await drain;

    const pausedAt = await pausedAtOf(t);
    const rows = await queueRowsOf(t);
    expect(r.heldReason).toBe(PAUSED_MESSAGE);
    expect(rows.filter((x) => x.status === 'queued').length).toBeGreaterThan(0);
    for (const row of rows) {
      if (row.claimedAt) expect(row.claimedAt.getTime()).toBeLessThanOrEqual(pausedAt.getTime());
      if (row.status === 'queued') expect(row.claimedAt).toBeNull();
      expect(row.status).not.toBe('failed');
    }
  });
});

// ---- (4) mailboxes that are not active defer, never fail -----------------

describe('(4) a failing, paused or archived mailbox defers its rows', { timeout: 60_000 }, () => {
  it.each(['failing', 'paused', 'archived'] as const)(
    'a %s mailbox: rows stay queued with the explanatory last_error, none fails',
    async (status) => {
      const t = await tenant();
      const mb = await makeMailbox(t);
      const a = await queueRow(t, mb.id, 'a@target.com');
      const b = await queueRow(t, mb.id, 'b@other.com');
      await db.update(mailboxes).set({ status }).where(eq(mailboxes.id, mb.id));
      const provider = new MockMailProvider();
      const before = Date.now();

      const r = await drainQueue(t.owner, { providerOverride: provider });
      expect(r).toMatchObject({ picked: 2, sent: 0, failed: 0, deferred: 2 });
      expect(provider.sent).toHaveLength(0);
      for (const id of [a.id, b.id]) {
        const [row] = await db.select().from(outreachQueue).where(eq(outreachQueue.id, id));
        expect(row!.status).toBe('queued');
        expect(row!.attemptCount).toBe(0);
        expect(row!.claimedAt).toBeNull();
        expect(row!.lastError).toMatch(new RegExp(`^Held: the mailbox is ${status}`));
        expect(row!.scheduledSendAt.getTime()).toBeGreaterThanOrEqual(before + GATE_DEFER_MS - 5_000);
      }
      // The tick does the same; nothing fails on later passes either.
      await runDrainTick();
      const rows = await queueRowsOf(t);
      expect(rows.every((x) => x.status === 'queued')).toBe(true);
    },
  );

  it('P0-F08: a paused mailbox leaves its follow-up pending with the reason (no compose, no failure)', async () => {
    const t = await tenant();
    const provider = new MockMailProvider();
    const { mb, step } = await followUpFixture(t, provider);
    await db.update(mailboxes).set({ status: 'paused' }).where(eq(mailboxes.id, mb.id));
    const ai = new CountingAi();
    _setAIProviderForTests(ai);
    const r = await processDueFollowUps(t.auto, { mailProviderOverride: provider });
    expect(r).toMatchObject({ failed: 0, sent: 0 });
    expect(ai.calls).toBe(0);
    const row = await followUpRow(step.id);
    expect(row.status).toBe('pending');
    expect(row.lastError).toMatch(/^Held: the mailbox is paused/);
    expect(row.scheduledFor.getTime()).toBeGreaterThan(Date.now());
  });

  it('other rows go on: one active and one failing mailbox in the same drain', async () => {
    const t = await tenant();
    const good = await makeMailbox(t);
    const bad = await makeMailbox(t);
    await db.update(mailboxes).set({ status: 'failing' }).where(eq(mailboxes.id, bad.id));
    await queueRow(t, bad.id, 'held@target.com', 120_000);
    await queueRow(t, good.id, 'sent@other.com', 60_000);
    const provider = new MockMailProvider();
    const r = await drainQueue(t.owner, { providerOverride: provider });
    expect(r).toMatchObject({ sent: 1, deferred: 1, failed: 0 });
    expect(provider.sent[0]!.message.to[0]!.address).toBe('sent@other.com');
  });
});

// ---- (5) the wallet gate ---------------------------------------------------

describe('(5) an empty wallet', { timeout: 60_000 }, () => {
  it('compaction makes 0 AI calls: manual and unattended refused, the tick holds it', async () => {
    const t = await tenant();
    await setWallet(t, 0n);
    const ai = new CountingAi();
    _setAIProviderForTests(ai);
    await expect(compactWorkspaceKnowledge(t.admin)).rejects.toMatchObject({ reason: 'wallet_empty' });
    await expect(compactWorkspaceKnowledgeUnattended(t.workspaceId)).rejects.toMatchObject({
      reason: 'wallet_empty',
    });
    expect(await runKnowledgeCompactTick()).toMatchObject({ processed: 0, held: 1, failed: 0 });
    expect(ai.calls).toBe(0);
  });

  it('the crawl tick moves nextRunAt one interval on, starts nothing and records no recipe failure', async () => {
    const t = await tenant();
    const { plan } = await crawlFixture(t);
    await setWallet(t, 0n);
    const before = Date.now();
    const tick = await runCrawlEngineTick();
    expect(tick).toMatchObject({ totalStartedRuns: 0, totalFailedRecipes: 0, walletEmptySkipped: 1 });
    const [after] = await db.select().from(crawlPlans).where(eq(crawlPlans.id, plan.id));
    expect(after!.nextRunAt!.getTime()).toBeGreaterThanOrEqual(before + 60 * 60_000 - 5_000);
    expect(after!.lastRunAt).toBeNull();
    expect(after!.lastRunSummary).toEqual(plan.lastRunSummary);
    expect(await runsOf(t)).toBe(0);
    expect(await auditRows(t.workspaceId, 'crawl_plan.run')).toHaveLength(0);
  });

  it('I093: reply auto-drafting makes no draft and no AI call', async () => {
    const t = await tenant();
    const ai = new CountingAi();
    _setAIProviderForTests(ai);
    const { messageId } = await replyFixture(t, 'How does this work?');
    await setWallet(t, 0n);
    const r = await handleClassifiedReply(t.owner, messageId, questionVerdict);
    expect(r.draftIds).toEqual([]);
    expect(ai.calls).toBe(0);
  });
});

// ---- (6) lapsed plan -------------------------------------------------------

describe('(6) pausing works on a lapsed plan with an empty wallet', { timeout: 60_000 }, () => {
  it('a member pauses; an admin resumes', async () => {
    const t = await tenant({ plan: 'free' });
    await db
      .update(workspaces)
      .set({ subscriptionStatus: 'canceled', tokenBalance: 0n })
      .where(eq(workspaces.id, t.workspaceId));
    await expect(pauseAutomation(t.member, { source: 'api' })).resolves.toMatchObject({
      alreadyPaused: false,
    });
    expect((await loadAutomationState(t.workspaceId)).pause).not.toBeNull();
    await expect(resumeAutomation(t.admin, { source: 'api' })).resolves.toMatchObject({ wasPaused: true });
  });
});

// ---- (7) after resume ----------------------------------------------------

describe('(7) after resume the next tick of each kind runs normally', { timeout: 120_000 }, () => {
  it('drain, follow-up, crawl, autopilot and trash purge ticks all run again', async () => {
    const t = await tenant();
    const provider = new MockMailProvider();
    _setMailProviderFactoryForTests(() => provider);
    const { step } = await followUpFixture(t, provider);
    const mb2 = await makeMailbox(t);
    // Another domain than the follow-up's lead (24 h domain cooldown).
    await queueRow(t, mb2.id, 'queued@other.example');
    const { plan } = await crawlFixture(t);
    const old = await trashedMessage(t, mb2.id, 90);
    await updateAutopilotSettings(t.owner, { autopilotEnabled: true, enableAutoApproveProjects: true });
    const ai = new CountingAi();
    _setAIProviderForTests(ai);

    await pauseAutomation(t.member, { source: 'api' });
    expect(await runDrainTick()).toMatchObject({ held: 1 });
    expect(await runFollowUpTick()).toMatchObject({ held: 1 });
    expect(await runCrawlEngineTick()).toMatchObject({ held: 1 });
    expect(await runAutopilotTick()).toMatchObject({ held: 1 });
    expect(await runMailTrashPurgeTick()).toMatchObject({ held: 1 });

    await resumeAutomation(t.admin, { source: 'api' });
    expect(await runDrainTick()).toMatchObject({ totalSent: 1, held: 0 });
    expect(await runFollowUpTick()).toMatchObject({ sent: 1, held: 0 });
    expect(ai.calls).toBeGreaterThan(0);
    expect((await followUpRow(step.id)).status).toBe('sent');
    expect(await runCrawlEngineTick()).toMatchObject({ totalStartedRuns: 1, held: 0 });
    const [planAfter] = await db.select().from(crawlPlans).where(eq(crawlPlans.id, plan.id));
    expect(planAfter!.lastRunAt).not.toBeNull();
    const ap = await runAutopilotTick();
    expect(ap).toMatchObject({ held: 0 });
    expect(ap.stepsRun).toBeGreaterThan(0);
    expect(await runMailTrashPurgeTick()).toMatchObject({ deleted: 1, held: 0 });
    expect(await messageExists(old.id)).toBe(false);
  });
});

// ---- the pause / undo / resume service --------------------------------------

describe('pause service (ia:F-18 / MOB-07 backend)', { timeout: 60_000 }, () => {
  it('any write role pauses; a viewer cannot; pausing twice changes nothing', async () => {
    const t = await tenant();
    await expect(pauseAutomation(t.viewer, { source: 'api' })).rejects.toMatchObject({
      code: 'permission_denied',
    });
    const first = await pauseAutomation(t.member, { source: 'api', reason: 'wrong list', device: 'mobile' });
    expect(first.alreadyPaused).toBe(false);
    expect(first.undoUntil!.getTime() - first.pausedAt.getTime()).toBe(PAUSE_UNDO_WINDOW_MS);
    const second = await pauseAutomation(t.owner, { source: 'api' });
    expect(second).toMatchObject({ alreadyPaused: true, pausedByUserId: t.memberId, undoUntil: null });
    expect(await auditRows(t.workspaceId, 'automation.paused')).toHaveLength(1);
    // Managers can pause too (they can write).
    const t2 = await tenant({ name: 'mgr' });
    const manager = makeWorkspaceContext({ workspaceId: t2.workspaceId, userId: t2.memberId, role: 'manager' });
    await expect(pauseAutomation(manager, { source: 'api' })).resolves.toMatchObject({ alreadyPaused: false });
  });

  it('only owners, admins (and super-admins) resume; resuming a running workspace is a no-op', async () => {
    const t = await tenant();
    await pauseAutomation(t.member, { source: 'api' });
    await expect(resumeAutomation(t.member, { source: 'api' })).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await expect(resumeAutomation(t.viewer, { source: 'api' })).rejects.toBeInstanceOf(
      AutomationPauseError,
    );
    const god = makeWorkspaceContext({ workspaceId: t.workspaceId, userId: superAdminId, role: 'super_admin' });
    await expect(resumeAutomation(god, { source: 'api' })).resolves.toMatchObject({ wasPaused: true });
    await expect(resumeAutomation(t.owner, { source: 'api' })).resolves.toEqual({
      wasPaused: false,
      pausedAt: null,
      heldInboundActions: 0,
    });
    expect(await auditRows(t.workspaceId, 'automation.resumed')).toHaveLength(1);
  });

  it('the person who paused can undo within 10 seconds; nobody else, and not later', async () => {
    const t = await tenant();
    await pauseAutomation(t.member, { source: 'api' });
    await expect(undoPause(t.admin)).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(undoPause(t.member, { device: 'mobile' })).resolves.toMatchObject({ undone: true });
    expect((await loadAutomationState(t.workspaceId)).pause).toBeNull();
    await expect(undoPause(t.member)).rejects.toMatchObject({ code: 'not_paused' });

    await pauseAutomation(t.member, { source: 'api' });
    // Raw SQL: move the pause 11 s into the past on the database clock.
    await db
      .update(workspaces)
      .set({ automationPausedAt: sql`clock_timestamp() - interval '11 seconds'` })
      .where(eq(workspaces.id, t.workspaceId));
    await expect(undoPause(t.member)).rejects.toMatchObject({ code: 'too_late' });
    expect((await loadAutomationState(t.workspaceId)).pause).not.toBeNull();
    expect(await auditRows(t.workspaceId, 'automation.pause_undone')).toHaveLength(1);
  });

  it('audit rows carry actor, device and source; the legacy columns mirror the pause', async () => {
    const t = await tenant();
    await pauseAutomation(t.member, { source: 'autopilot_page', device: 'mobile', reason: 'complaint' });
    const [paused] = await auditRows(t.workspaceId, 'automation.paused');
    expect(paused!.userId).toBe(t.memberId);
    expect(paused!.payload).toMatchObject({
      source: 'autopilot_page',
      device: 'mobile',
      reason: 'complaint',
      role: 'member',
    });
    const mirror = async () => {
      const [a] = await db
        .select({ v: autopilotSettings.emergencyPause })
        .from(autopilotSettings)
        .where(eq(autopilotSettings.workspaceId, t.workspaceId));
      const [s] = await db
        .select({ v: outreachSendSettings.emergencyPause })
        .from(outreachSendSettings)
        .where(eq(outreachSendSettings.workspaceId, t.workspaceId));
      return [a?.v, s?.v];
    };
    expect(await mirror()).toEqual([true, true]);

    await resumeAutomation(t.admin, { source: 'send_queue_page', device: 'desktop' });
    const [resumed] = await auditRows(t.workspaceId, 'automation.resumed');
    expect(resumed!.userId).toBe(t.adminId);
    expect(resumed!.payload).toMatchObject({
      source: 'send_queue_page',
      device: 'desktop',
      pausedByUserId: t.memberId,
      pauseReason: 'complaint',
    });
    expect(await mirror()).toEqual([false, false]);
  });

  it('validates input at the boundary (Zod): reason length, reserved source', async () => {
    const t = await tenant();
    await expect(
      pauseAutomation(t.member, { source: 'api', reason: 'x'.repeat(501) }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      pauseAutomation(t.member, { source: 'legacy_flag_migration' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('the overview lists what stops (with counts) and, while paused, what restarts', async () => {
    const t = await tenant();
    const mb = await makeMailbox(t);
    await queueRow(t, mb.id, 'due@target.com');
    await queueRow(t, mb.id, 'later@target.com', -3_600_000);
    await crawlFixture(t);
    const running = await getAutomationPauseOverview(t.member);
    expect(running).toMatchObject({ pause: null, canPause: true, canResume: false, undoUntil: null });
    expect(running.impact).toMatchObject({ queued: 2, queuedDue: 1, enabledCrawlPlans: 1 });

    await pauseAutomation(t.member, { source: 'api', reason: 'check copy' });
    const paused = await getAutomationPauseOverview(t.member);
    expect(paused.pause).toMatchObject({ byUserId: t.memberId, reason: 'check copy' });
    expect(paused.pause!.byLabel).toContain('pc05-member');
    expect(paused.undoUntil).not.toBeNull();
    expect((await getAutomationPauseOverview(t.admin)).undoUntil).toBeNull();
  });

  it('server actions: a member pauses from a phone (device recorded) and lands back on the page', async () => {
    const t = await tenant();
    signInAs(t.memberId);
    const { pauseAutomationAction, resumeAutomationAction } = await import(
      '@/lib/automation-pause-actions'
    );
    const fd = new FormData();
    fd.set('returnTo', '/mailbox/queue');
    fd.set('reason', 'bad list');
    const target = await expectRedirect(() => pauseAutomationAction(fd));
    const url = new URL(target, 'http://app.test');
    expect(url.pathname).toBe('/mailbox/queue');
    expect(url.hash).toBe('#pause');
    expect(url.searchParams.get('message')).toContain('Automation paused');
    const [row] = await auditRows(t.workspaceId, 'automation.paused');
    expect(row!.payload).toMatchObject({ source: 'send_queue_page', device: 'mobile', reason: 'bad list' });

    const refused = await expectRedirect(() => resumeAutomationAction(fd));
    expect(new URL(refused, 'http://app.test').searchParams.get('error')).toContain('Owners and admins resume');
    signInAs(t.adminId);
    const ok = await expectRedirect(() => resumeAutomationAction(fd));
    expect(new URL(ok, 'http://app.test').searchParams.get('message')).toBe('Automation resumed.');
  });

  it('renders the control and the banner from the existing primitives', async () => {
    const t = await tenant({ live: false });
    await pauseAutomation(t.member, { source: 'api', reason: 'audit' });
    const control = renderToStaticMarkup(
      AutomationPauseControl({ overview: await getAutomationPauseOverview(t.admin), returnTo: '/autopilot' }),
    );
    expect(control).toContain('Automation is paused');
    expect(control).toContain('Resume automation');
    const banner = renderToStaticMarkup(
      AutomationHoldBanner({ notice: await getWorkspaceAutomationNotice(t.viewer) }) ?? '',
    );
    expect(banner).toContain('Automation is paused');
    expect(banner).toContain('Reason: audit');
    expect(banner).toContain('Not live for outreach yet');
  });
});

// ---- the go-live hold (flow:F-07) ------------------------------------------

describe('go-live hold (flow:F-07)', { timeout: 60_000 }, () => {
  it('new workspaces start not live', async () => {
    const ownerId = await seedUser({ email: `golive-${seq}@test.local` });
    const { workspace } = await createWorkspace({
      name: 'Fresh tenant',
      slug: `fresh-tenant-${seq}`,
      ownerUserId: ownerId,
    });
    expect((await loadAutomationState(workspace.id)).live).toBeNull();
  });

  it('cold, follow-up and AI-reply mail is held as not_live while a manual compose sends', async () => {
    const t = await tenant({ live: false });
    const mb = await makeMailbox(t);
    const cold = await draftRow(t, mb.id, 'cold', 'cold@a.example');
    const aiReply = await draftRow(t, mb.id, 'ai_reply', 'reply@b.example');
    const provider = new MockMailProvider();

    const r = await drainQueue(t.owner, { providerOverride: provider });
    expect(r).toMatchObject({ sent: 0, failed: 0, deferred: 2 });
    for (const id of [cold.id, aiReply.id]) {
      const [row] = await db.select().from(outreachQueue).where(eq(outreachQueue.id, id));
      expect(row!.status).toBe('queued');
      expect(row!.lastError).toMatch(/not live/);
    }

    const ai = new CountingAi();
    _setAIProviderForTests(ai);
    const fuProvider = new MockMailProvider();
    const { step } = await followUpFixture(t, fuProvider);
    expect(await processDueFollowUps(t.auto, { mailProviderOverride: fuProvider })).toMatchObject({
      sent: 0,
      heldReason: expect.stringContaining('not live'),
    });
    expect(ai.calls).toBe(0);
    expect((await followUpRow(step.id)).status).toBe('pending');

    const manual = await sendMessage(t.member, {
      mode: 'one_to_one',
      origin: 'manual',
      mailboxId: mb.id,
      to: [{ address: 'someone@c.example' }],
      subject: 'Hi',
      text: 'written by hand',
      providerOverride: provider,
    });
    expect(manual.status).toBe('sent');
  });

  it('only a super-admin releases (audited with the reason, tenant notified); then the queue sends; revoke holds it again', async () => {
    const t = await tenant({ live: false });
    const mb = await makeMailbox(t);
    await draftRow(t, mb.id, 'cold', 'cold@a.example');

    await expect(
      releaseOutreachLive(smuggled(t.owner), t.workspaceId, 'checklist done'),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(releaseOutreachLive(pctx(), t.workspaceId, ' ')).rejects.toBeInstanceOf(GoLiveError);

    const live = await releaseOutreachLive(pctx(), t.workspaceId, 'SPF/DKIM verified, owner test sent');
    expect(live.live).toBe(true);
    const [audit] = await auditRows(t.workspaceId, 'outreach.go_live.release');
    expect(audit!.userId).toBe(superAdminId);
    expect(audit!.payload).toMatchObject({ reason: 'SPF/DKIM verified, owner test sent' });
    await expect(releaseOutreachLive(pctx(), t.workspaceId, 'again')).rejects.toMatchObject({
      code: 'conflict',
    });

    // Deferred rows wait GATE_DEFER_MS; this one was never deferred.
    const provider = new MockMailProvider();
    expect(await drainQueue(t.owner, { providerOverride: provider })).toMatchObject({ sent: 1 });

    await revokeOutreachLive(pctx(), t.workspaceId, 'complaint received');
    await draftRow(t, mb.id, 'cold', 'second@a.example');
    expect(await drainQueue(t.owner, { providerOverride: provider })).toMatchObject({
      sent: 0,
      deferred: 1,
    });
    expect(await auditRows(t.workspaceId, 'outreach.go_live.revoke')).toHaveLength(1);
  });
});

// ---- legacy emergency_pause flags ------------------------------------------

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

describe('legacy emergency_pause flags', { timeout: 60_000 }, () => {
  it('the migration carries either legacy flag into the workspace pause, audits it and mirrors it into the legacy rows that exist', async () => {
    const t1 = await tenant({ name: 'legacy-ap' });
    const t2 = await tenant({ name: 'legacy-q' });
    const t3 = await tenant({ name: 'legacy-none' });
    await db.insert(autopilotSettings).values({ workspaceId: t1.workspaceId, emergencyPause: true });
    await db.insert(outreachSendSettings).values({ workspaceId: t2.workspaceId, emergencyPause: true });
    await db.insert(outreachSendSettings).values({ workspaceId: t3.workspaceId, emergencyPause: false });

    const file = fs
      .readdirSync(path.join(REPO, 'drizzle'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => fs.readFileSync(path.join(REPO, 'drizzle', f), 'utf8'))
      .find((s) => s.includes('PC-05: the two legacy Emergency pause switches'));
    expect(file).toBeDefined();
    const custom = file!.slice(file!.indexOf('-- custom:begin'), file!.indexOf('-- custom:end'));
    for (const stmt of custom.split('--> statement-breakpoint')) {
      if (stmt.replace(/--.*$/gm, '').trim()) await db.execute(sql.raw(stmt));
    }

    for (const t of [t1, t2]) {
      const state = await loadAutomationState(t.workspaceId);
      expect(state.pause).toMatchObject({ byUserId: null, source: 'legacy_flag_migration' });
      const [audit] = await auditRows(t.workspaceId, 'automation.paused');
      expect(audit!.payload).toMatchObject({ source: 'legacy_flag_migration' });
    }
    const [mirror] = await db
      .select()
      .from(outreachSendSettings)
      .where(eq(outreachSendSettings.workspaceId, t1.workspaceId));
    expect(mirror).toBeUndefined(); // no send-settings row existed: nothing to mirror into
    const [apMirror] = await db
      .select()
      .from(autopilotSettings)
      .where(eq(autopilotSettings.workspaceId, t1.workspaceId));
    expect(apMirror!.emergencyPause).toBe(true);
    expect((await loadAutomationState(t3.workspaceId)).pause).toBeNull();
    expect(await auditRows(t3.workspaceId, 'automation.paused')).toHaveLength(0);
  });

  it('nothing reads them any more, and no form field writes them', () => {
    const offenders: string[] = [];
    const allowed = new Set([
      // the columns themselves (dropped one release later)
      'lib/db/schema/autopilot.ts',
      'lib/db/schema/outreach.ts',
      // the write-only mirror
      'lib/services/automation-pause.ts',
    ]);
    for (const file of [...walk(path.join(SRC, 'app')), ...walk(path.join(SRC, 'lib')), ...walk(path.join(SRC, 'components'))]) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (allowed.has(rel)) continue;
      const text = fs.readFileSync(file, 'utf8');
      // Readers of the two workspace-level flags (the per-product overlay
      // column of the same name is a separate, product-scoped setting).
      if (/(settings|base|autopilot|sendSettings)\.emergencyPause\b/.test(text)) offenders.push(rel);
      if (/name="emergencyPause"|get\('emergencyPause'\)/.test(text)) offenders.push(`${rel} (form)`);
      if (/outreachSendSettings\.emergencyPause|autopilotSettings\.emergencyPause/.test(text)) {
        offenders.push(`${rel} (column)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('I062 (PC-13): the Crawl Engine page has no autopilot form, so nothing on it can switch autopilot off', async () => {
    const page = readSrc('app/connectors/engine/page.tsx');
    expect(page).not.toMatch(/name="(autopilotEnabled|enableAutoApproveProjects|enableAutoEnqueueOutreach|autoApproveThreshold)"/);
    const actions = await import('@/app/connectors/engine/actions');
    expect(Object.keys(actions)).not.toContain('saveAutopilot');
    const t = await tenant();
    await updateAutopilotSettings(t.owner, { autopilotEnabled: true });
    await pauseAutomation(t.member, { source: 'api' });
    const [row] = await db
      .select()
      .from(autopilotSettings)
      .where(eq(autopilotSettings.workspaceId, t.workspaceId));
    expect(row!.autopilotEnabled).toBe(true);
    expect((await loadAutomationState(t.workspaceId)).pause).not.toBeNull();
  });

  it('the old checkboxes are gone: both pages host the one pause control', () => {
    for (const rel of ['app/autopilot/page.tsx', 'app/mailbox/queue/page.tsx']) {
      const page = readSrc(rel);
      expect(page).toContain('<AutomationPauseControl');
      expect(page).not.toContain('name="emergencyPause"');
      expect(page).not.toMatch(/Emergency pause \(kill switch\)<\/span>/);
    }
  });
});

