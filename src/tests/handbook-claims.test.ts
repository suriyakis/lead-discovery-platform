// Pins for the behavioural claims in the assistant handbook
// (src/lib/assistant/handbook.ts). Every test name carries the tag of the
// claim it pins — "[handbook H-xx]" — and assistant-handbook.test.ts fails
// when a tag in the handbook has no such test, or a test pins a tag the
// handbook no longer makes.
//
// The pins sit together, one describe block per owning service, so the
// handbook's guarantees read in one place. (The AP-01 spec asked for each
// pin in its owning service's suite; they are kept here instead because
// Phase 0 lanes edit those suites in parallel. The coverage check scans
// every *.test.ts, so a pin can move into its service's suite later
// without other changes.) If one of these fails because you changed the
// behaviour on purpose, rewrite the handbook sentence that carries the
// same tag in the same PR — the in-app guide quotes it to operators word
// for word.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/connectors/mock';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { _setAIProviderForTests, type IAIProvider } from '@/lib/ai';
import {
  InMemoryJobQueue,
  _setJobQueueForTests,
  getJobQueue,
  type JobPayload,
  type RepeatableJobOptions,
} from '@/lib/jobs';
import {
  AUTOPILOT_TICK_MS,
  _resetRepeatablesForTests,
  registerRepeatableJobs,
} from '@/lib/jobs/repeatables';
import { MockMailProvider } from '@/lib/mail';
import {
  connectorRecipes,
  connectorRuns,
  connectors,
  sourceRecords,
} from '@/lib/db/schema/connectors';
import { contactAssociations, contacts } from '@/lib/db/schema/contacts';
import { outreachFollowUps } from '@/lib/db/schema/follow-ups';
import { mailMessages, mailThreads, mailboxes } from '@/lib/db/schema/mailing';
import {
  outreachDrafts,
  outreachQueue,
  outreachThreadState,
} from '@/lib/db/schema/outreach';
import { pipelineState, qualifiedLeads } from '@/lib/db/schema/pipeline';
import { qualifications } from '@/lib/db/schema/qualifications';
import { reviewItems } from '@/lib/db/schema/review';
import { workspaces } from '@/lib/db/schema/workspaces';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import { createConnector, createRecipe, startRun } from '@/lib/services/connector-run';
import { createProductProfile } from '@/lib/services/product-profile';
import type { ProductProfile } from '@/lib/db/schema/products';
import { approveReviewItem } from '@/lib/services/review';
import {
  assign,
  ensureQualifiedLead,
  setOutreachLanguage,
  transition,
  updateContact,
} from '@/lib/services/pipeline';
import { approveOutreachDraft, generateOutreachDraft } from '@/lib/services/outreach';
import { createMailbox, updateMailbox } from '@/lib/services/mailbox';
import {
  drainQueue,
  enqueueDraft,
  getSendSettings,
  updateSendSettings,
} from '@/lib/services/outreach-queue';
import { saveSendSettingsAction } from '@/app/mailbox/queue/actions';
import { workspaceMembers } from '@/lib/db/schema/workspaces';
import { expectRedirect } from './helpers/next-render';
import {
  runOnce,
  updateAutopilotSettings,
  upsertProductAutopilotSettings,
} from '@/lib/services/autopilot';
import { sendMessage, syncInbound } from '@/lib/services/mail';
import {
  processDueFollowUps,
  scheduleFollowUps,
  updateFollowUpConfig,
} from '@/lib/services/follow-up';
import { analyseReply, classifyReply, type ReplyClass } from '@/lib/services/reply-classifier';
import {
  getReplyAutoActions,
  switchesOf,
  updateReplyAutoActions,
} from '@/lib/services/reply-auto-actions';
import { isSuppressed, recordUnsubscribeByToken } from '@/lib/services/suppression';
import { notifications } from '@/lib/db/schema/notifications';
import type { InboundMessage, OutboundMessage, SendResult } from '@/lib/mail';
import { resolveOutboundLanguage } from '@/lib/services/language-resolution';
import {
  updateWorkspaceNativeLanguage,
  updateWorkspaceOutreachLanguage,
} from '@/lib/services/workspace';
import { tokenTransactions } from '@/lib/db/schema/tokens';
import { askAssistant } from '@/lib/services/assistant';
import { getTokenWallet } from '@/lib/services/token-ledger';
import { recordUsage } from '@/lib/services/usage';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

const SRC = path.resolve(__dirname, '..');
/** Each pin runs a real mock discovery (+ drafting/sending); give it room. */
const DB_TEST_TIMEOUT_MS = 30_000;

// Server actions are called with a plain session instead of Auth.js;
// getWorkspaceContext() stays real, so the role comes from
// workspace_members exactly as in production (same harness as
// mailbox-queue.test.ts).
const session = vi.hoisted(() => ({
  current: null as null | { user: { id: string; role: 'member'; accountStatus: 'active' } },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));

function signInAs(userId: string): void {
  session.current = { user: { id: userId, role: 'member', accountStatus: 'active' } };
}

// ---- harness -------------------------------------------------------

interface Setup {
  workspaceId: bigint;
  ownerId: string;
  adminId: string;
}

let seq = 0;

async function setup(
  opts: { plan?: 'free' | 'starter' | 'pro' } = {},
): Promise<Setup> {
  seq += 1;
  const ownerId = await seedUser({ email: `hb-owner-${seq}@test.local` });
  const adminId = await seedUser({ email: `hb-admin-${seq}@test.local` });
  const workspaceId = await seedWorkspace({
    name: `Handbook ${seq}`,
    ownerUserId: ownerId,
    plan: opts.plan,
    extraMembers: [{ userId: adminId, role: 'admin' }],
  });
  return { workspaceId, ownerId, adminId };
}

/** The workspace owner — the identity the background ticks act as. */
function ctx(s: Setup): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId: s.workspaceId, userId: s.ownerId, role: 'owner' });
}

/** A human admin who is NOT the owner. */
function adminCtx(s: Setup): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId: s.workspaceId, userId: s.adminId, role: 'admin' });
}

/** Mock discovery run → review items qualified against `product`. */
async function discover(
  s: Setup,
  opts: { product?: ProductProfile; country?: string; count?: number } = {},
) {
  seq += 1;
  const product =
    opts.product ??
    (await createProductProfile(ctx(s), {
      name: `Sealer ${seq}`,
      shortDescription: 'concrete sealer',
      includeKeywords: ['mock'],
      relevanceThreshold: 50,
    }));
  const connector = await createConnector(ctx(s), {
    templateType: 'mock',
    name: `Mock ${seq}`,
    config: {},
  });
  const recipe = await createRecipe(ctx(s), {
    connectorId: connector.id,
    name: `recipe ${seq}`,
    selectors: {
      seed: `handbook-${seq}`,
      count: opts.count ?? 1,
      ...(opts.country ? { country: opts.country } : {}),
    },
  });
  await startRun(ctx(s), { connectorId: connector.id, recipeId: recipe.id, wait: true });
  const items = await db
    .select({ ri: reviewItems })
    .from(reviewItems)
    .innerJoin(sourceRecords, eq(sourceRecords.id, reviewItems.sourceRecordId))
    .where(
      and(eq(reviewItems.workspaceId, s.workspaceId), eq(sourceRecords.recipeId, recipe.id)),
    )
    .orderBy(reviewItems.id);
  return { product, recipe, items: items.map((r) => r.ri) };
}

async function makeMailbox(
  s: Setup,
  opts: { imap?: boolean; isDefault?: boolean; address?: string } = {},
) {
  const address = opts.address ?? 'sales@nulife.pl';
  return createMailbox(ctx(s), {
    name: address,
    fromAddress: address,
    fromName: 'Sales',
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: address,
    smtpPassword: 'secret',
    imap: opts.imap ? { host: 'imap.example.com', user: address, password: 'pw' } : null,
    isDefault: opts.isDefault ?? true,
  });
}

/** A promoted lead with a contact email and an approved draft. */
async function contactableLead(s: Setup, email = 'anna@target.com') {
  const { product, items } = await discover(s);
  const reviewItem = items[0]!;
  const lead = await ensureQualifiedLead(ctx(s), reviewItem.id, product.id);
  await updateContact(ctx(s), lead.id, { contactName: 'Anna', contactEmail: email });
  const draft = await generateOutreachDraft(ctx(s), {
    reviewItemId: reviewItem.id,
    productProfileId: product.id,
  });
  await approveOutreachDraft(ctx(s), draft.id);
  return { product, reviewItem, lead, draft };
}

/** contactableLead + a mailbox + a queue entry that is due now. */
async function queuedEmail(s: Setup, opts: { imap?: boolean } = {}) {
  const c = await contactableLead(s);
  const mailbox = await makeMailbox(s, { imap: opts.imap });
  const entry = await enqueueDraft(ctx(s), {
    draftId: c.draft.id,
    mailboxId: mailbox.id,
    delayMode: 'immediate',
  });
  return { ...c, mailbox, entry };
}

/**
 * Swap in `q` as the job queue for the duration of `fn`, then put the
 * process-wide queue back: connector runs register their handler on it
 * once per process, so leaving a different queue behind would strand
 * every later startRun().
 */
async function withJobQueue<T>(q: InMemoryJobQueue, fn: () => Promise<T>): Promise<T> {
  const previous = getJobQueue();
  _setJobQueueForTests(q);
  _resetRepeatablesForTests();
  try {
    return await fn();
  } finally {
    _setJobQueueForTests(previous);
    _resetRepeatablesForTests();
  }
}

/** Run one background tick exactly as the scheduler would. */
async function runTick(type: string): Promise<Record<string, number>> {
  const q = new InMemoryJobQueue();
  return withJobQueue(q, async () => {
    await registerRepeatableJobs({ skipSchedule: true });
    const id = await q.enqueue(type, {});
    await q.drain();
    const status = await q.status(id);
    if (status.state !== 'succeeded') {
      throw new Error(`${type} did not succeed: ${JSON.stringify(status)}`);
    }
    return status.result as Record<string, number>;
  });
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

/** Source files under src/<rel> (ts/tsx) that contain `needle`. */
function filesContaining(rel: string, needle: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && fs.readFileSync(full, 'utf8').includes(needle)) {
        out.push(path.relative(SRC, full).split(path.sep).join('/'));
      }
    }
  };
  walk(path.join(SRC, rel));
  return out;
}

async function reviewItem(id: bigint) {
  const [row] = await db.select().from(reviewItems).where(eq(reviewItems.id, id));
  return row!;
}

async function queueRows(s: Setup) {
  return db.select().from(outreachQueue).where(eq(outreachQueue.workspaceId, s.workspaceId));
}

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  _setAIProviderForTests(null);
  session.current = null;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- review service ------------------------------------------------

describe('review service', { timeout: DB_TEST_TIMEOUT_MS }, () => {
  it('[handbook H-01] approving a review item creates no pipeline lead, draft or queued email', async () => {
    const s = await setup();
    const { items } = await discover(s);
    await approveReviewItem(ctx(s), items[0]!.id);

    expect((await reviewItem(items[0]!.id)).state).toBe('approved');
    const leads = await db
      .select()
      .from(qualifiedLeads)
      .where(eq(qualifiedLeads.workspaceId, s.workspaceId));
    const drafts = await db
      .select()
      .from(outreachDrafts)
      .where(eq(outreachDrafts.workspaceId, s.workspaceId));
    expect(leads).toHaveLength(0);
    expect(drafts).toHaveLength(0);
    expect(await queueRows(s)).toHaveLength(0);
  });

  it('[handbook H-03] review items cannot be assigned from the app; pipeline leads can', async () => {
    // No page, component or API route offers review-item assignment.
    expect(filesContaining('app', 'assignReviewItem')).toEqual([]);
    expect(filesContaining('components', 'assignReviewItem')).toEqual([]);
    // The lead page does offer it…
    const leadPage = readSrc('app/pipeline/[id]/page.tsx');
    expect(leadPage).toContain("from '@/lib/services/pipeline'");
    expect(leadPage).toMatch(/await assign\(/);
    // …and the service behind it works.
    const s = await setup();
    const { product, items } = await discover(s);
    const lead = await ensureQualifiedLead(ctx(s), items[0]!.id, product.id);
    const assigned = await assign(ctx(s), lead.id, s.adminId);
    expect(assigned.assignedToUserId).toBe(s.adminId);
  });
});

// ---- pipeline service ----------------------------------------------

describe('pipeline service', { timeout: DB_TEST_TIMEOUT_MS }, () => {
  it('[handbook H-02] "Promote to pipeline" creates the lead at relevant, needs no approval, fills in no contact email', async () => {
    const s = await setup();
    const { product, items } = await discover(s);
    expect(items[0]!.state).toBe('new'); // never approved

    const lead = await ensureQualifiedLead(ctx(s), items[0]!.id, product.id);
    expect(lead.state).toBe('relevant');
    expect(lead.contactEmail).toBeNull();

    // The only app caller is the Promote button on /leads.
    expect(filesContaining('app', 'ensureQualifiedLead(')).toEqual(['app/leads/page.tsx']);
    expect(readSrc('app/leads/page.tsx')).toContain('Promote to pipeline');
  });

  it('[handbook H-05] the stage list is fixed and closing a lead needs a close reason', async () => {
    expect(pipelineState.enumValues).toEqual([
      'raw_discovered',
      'relevant',
      'contacted',
      'replied',
      'contact_identified',
      'qualified',
      'handed_over',
      'synced_to_crm',
      'closed',
    ]);
    const s = await setup();
    const { product, items } = await discover(s);
    const lead = await ensureQualifiedLead(ctx(s), items[0]!.id, product.id);
    await expect(transition(ctx(s), lead.id, { to: 'closed' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    const closed = await transition(ctx(s), lead.id, { to: 'closed', closeReason: 'lost' });
    expect(closed.state).toBe('closed');
    expect(closed.closeReason).toBe('lost');
  });

  it('[handbook H-21] sending a queued email does not move the lead past relevant', async () => {
    const s = await setup();
    const { lead } = await queuedEmail(s);
    const r = await drainQueue(ctx(s), { providerOverride: new MockMailProvider() });
    expect(r.sent).toBe(1);
    const [after] = await db.select().from(qualifiedLeads).where(eq(qualifiedLeads.id, lead.id));
    expect(after!.state).toBe('relevant');
  });
});

// ---- send queue (outreach-queue service) ---------------------------

describe('send queue', { timeout: DB_TEST_TIMEOUT_MS }, () => {
  it('[handbook H-04] only an approved draft whose lead has a contact email can be queued', async () => {
    const s = await setup();
    const { product, items } = await discover(s);
    const lead = await ensureQualifiedLead(ctx(s), items[0]!.id, product.id);
    const mailbox = await makeMailbox(s);
    const draft = await generateOutreachDraft(ctx(s), {
      reviewItemId: items[0]!.id,
      productProfileId: product.id,
    });
    const enqueue = () =>
      enqueueDraft(ctx(s), { draftId: draft.id, mailboxId: mailbox.id, delayMode: 'immediate' });

    // Not approved yet.
    await expect(enqueue()).rejects.toMatchObject({ code: 'conflict' });
    // Approved, but the lead has no contact email.
    await approveOutreachDraft(ctx(s), draft.id);
    await expect(enqueue()).rejects.toThrow(/no contact email/);
    // Approved + contact email: queued.
    await updateContact(ctx(s), lead.id, { contactEmail: 'anna@target.com' });
    const entry = await enqueue();
    expect(entry.status).toBe('queued');
    expect(entry.toAddresses).toEqual(['anna@target.com']);
  });

  it('[handbook H-06] the send caps are saved by the /mailbox/queue action, by owners and admins only, and the queue enforces them; mailbox limits sit on the mailbox page', async () => {
    const s = await setup();
    await queuedEmail(s);
    const before = await getSendSettings(ctx(s));
    const capsForm = (dailyEmailLimit: string) => {
      const fd = new FormData();
      fd.set('dailyEmailLimit', dailyEmailLimit);
      fd.set('domainCooldownHours', String(before.domainCooldownHours));
      fd.set('defaultDelayMode', before.defaultDelayMode);
      fd.set('fixedDelayMinutes', String(before.fixedDelayMinutes));
      fd.set('randomDelayMinMinutes', String(before.randomDelayMinMinutes));
      fd.set('randomDelayMaxMinutes', String(before.randomDelayMaxMinutes));
      return fd;
    };

    // A member's save on /mailbox/queue is refused and changes nothing…
    const memberId = await seedUser({ email: `hb-member-${seq}@test.local` });
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: s.workspaceId, userId: memberId, role: 'member' });
    signInAs(memberId);
    const refused = await expectRedirect(() => saveSendSettingsAction(capsForm('0')));
    expect(new URL(refused, 'http://app.test').searchParams.get('error')).toBeTruthy();
    expect((await getSendSettings(ctx(s))).dailyEmailLimit).toBe(before.dailyEmailLimit);

    // …an admin's save sets the cap, and the queue holds the email.
    signInAs(s.adminId);
    const saved = await expectRedirect(() => saveSendSettingsAction(capsForm('0')));
    expect(new URL(saved, 'http://app.test').pathname).toBe('/mailbox/queue');
    expect((await getSendSettings(ctx(s))).dailyEmailLimit).toBe(0);
    const r = await drainQueue(ctx(s), { providerOverride: new MockMailProvider() });
    expect(r.sent).toBe(0);
    expect((await queueRows(s))[0]!.status).toBe('queued');

    // That action is the only place in the app that saves send settings
    // (nothing on /settings/outreach does).
    expect(filesContaining('app', 'updateSendSettings(')).toEqual(['app/mailbox/queue/actions.ts']);
    // Each mailbox's own limits are on its page.
    const mailboxPage = readSrc('app/mailbox/[id]/page.tsx');
    expect(mailboxPage).toContain('Sending policy');
    expect(mailboxPage).toContain('Max per day');
  });

  it('[handbook H-22] without a reviewed translation the queue translates at send time, unreviewed', async () => {
    const s = await setup();
    const { lead, draft } = await queuedEmail(s);
    // The recipient's language differs from the workspace's (English).
    await setOutreachLanguage(ctx(s), lead.id, 'de');
    expect(draft.bodyTranslated ?? null).toBeNull();

    const taggingAi: IAIProvider = {
      id: 'stub',
      model: 'stub-model',
      async generateText() {
        throw new Error('generateText not used here');
      },
      async generateJson(input) {
        const m = (input.system ?? '').match(/natural .+ \(([a-z]{2})\)/);
        return { translatedText: `[${(m?.[1] ?? 'en').toUpperCase()}] ${input.prompt}` } as never;
      },
      estimateCost() {
        return 0;
      },
      async healthCheck() {
        return { ok: true };
      },
    };
    _setAIProviderForTests(taggingAi);
    const r = await drainQueue(ctx(s), { providerOverride: new MockMailProvider() });
    expect(r.sent).toBe(1);

    const [msg] = await db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.workspaceId, s.workspaceId));
    expect(msg!.targetLanguage).toBe('de');
    expect(msg!.bodyText).toContain('[DE]');
    expect(msg!.bodyTextNative).toBe(draft.body);
    // Nobody saw that German text before it went out.
    const [afterDraft] = await db
      .select()
      .from(outreachDrafts)
      .where(eq(outreachDrafts.id, draft.id));
    expect(afterDraft!.bodyTranslated ?? null).toBeNull();
  });
});

// ---- autopilot service ---------------------------------------------

describe('autopilot service', { timeout: DB_TEST_TIMEOUT_MS }, () => {
  it('[handbook H-07] the background tick auto-approves "new" items at the threshold in the owner\'s name, never needs_review ones', async () => {
    const s = await setup();
    const { items } = await discover(s, { count: 2 });
    expect(items).toHaveLength(2);
    const [fresh, geoHeld] = items as [typeof items[0], typeof items[0]];
    await db
      .update(reviewItems)
      .set({ state: 'needs_review' })
      .where(eq(reviewItems.id, geoHeld.id));
    // An admin (not the owner) switches auto-approve on.
    await updateAutopilotSettings(adminCtx(s), {
      autopilotEnabled: true,
      enableAutoApproveProjects: true,
      autoApproveThreshold: 50,
    });

    await runTick('autopilot.tick');

    const approved = await reviewItem(fresh.id);
    expect(approved.state).toBe('approved');
    expect(approved.approvedByUserId).toBe(s.ownerId);
    expect((await reviewItem(geoHeld.id)).state).toBe('needs_review');
  });

  it('[handbook H-08] generate + enqueue writes, approves (as the owner) and queues a draft with no human step', async () => {
    const s = await setup();
    const { product, items } = await discover(s);
    await approveReviewItem(adminCtx(s), items[0]!.id);
    const lead = await ensureQualifiedLead(ctx(s), items[0]!.id, product.id);
    await updateContact(ctx(s), lead.id, { contactEmail: 'anna@target.com' });
    await makeMailbox(s);
    await updateAutopilotSettings(adminCtx(s), {
      autopilotEnabled: true,
      enableAutoEnqueueOutreach: true,
    });

    await runTick('autopilot.tick');

    const drafts = await db
      .select()
      .from(outreachDrafts)
      .where(eq(outreachDrafts.workspaceId, s.workspaceId));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.status).toBe('approved');
    expect(drafts[0]!.approvedByUserId).toBe(s.ownerId);
    const queue = await queueRows(s);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.draftId).toBe(drafts[0]!.id);
    expect(queue[0]!.status).toBe('queued');
    expect(queue[0]!.toAddresses).toEqual(['anna@target.com']);
  });

  it('[handbook H-09] the autopilot emergency pause stops autopilot runs but not the send queue', async () => {
    const s = await setup();
    await queuedEmail(s);
    await updateAutopilotSettings(ctx(s), {
      autopilotEnabled: true,
      emergencyPause: true,
      enableAutoDrainQueue: true,
    });
    const run = await runOnce(ctx(s));
    expect(run.steps).toEqual([{ step: 'guard', outcome: 'skipped', detail: 'emergency_pause' }]);

    // What the 30-second drain tick does for every active workspace.
    const r = await drainQueue(ctx(s), { providerOverride: new MockMailProvider() });
    expect(r.sent).toBe(1);
    expect((await queueRows(s))[0]!.status).toBe('sent');
  });

  it('[handbook H-10] the send-queue emergency pause stops sending but autopilot keeps writing, approving and queueing', async () => {
    const s = await setup();
    const { product, items } = await discover(s);
    await approveReviewItem(ctx(s), items[0]!.id);
    const lead = await ensureQualifiedLead(ctx(s), items[0]!.id, product.id);
    await updateContact(ctx(s), lead.id, { contactEmail: 'anna@target.com' });
    await makeMailbox(s);
    await updateSendSettings(ctx(s), { emergencyPause: true });
    await updateAutopilotSettings(ctx(s), {
      autopilotEnabled: true,
      enableAutoEnqueueOutreach: true,
    });

    await runOnce(ctx(s));
    const queue = await queueRows(s);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.status).toBe('queued');

    const r = await drainQueue(ctx(s), { providerOverride: new MockMailProvider() });
    expect(r).toEqual({ picked: 0, sent: 0, failed: 0, skipped: 0 });
    expect((await queueRows(s))[0]!.status).toBe('queued');
  });

  it('[handbook H-11] autopilot needs Starter or Pro (or billing exempt); a lapsed plan stops the runs', async () => {
    const free = await setup({ plan: 'free' });
    await expect(
      updateAutopilotSettings(ctx(free), { autopilotEnabled: true }),
    ).rejects.toMatchObject({ code: 'plan_limit' });
    // Switching things OFF always works.
    await expect(
      updateAutopilotSettings(ctx(free), { emergencyPause: true }),
    ).resolves.toMatchObject({ emergencyPause: true });

    const exempt = await setup({ plan: 'free' });
    await db
      .update(workspaces)
      .set({ billingExempt: true })
      .where(eq(workspaces.id, exempt.workspaceId));
    await expect(
      updateAutopilotSettings(ctx(exempt), { autopilotEnabled: true }),
    ).resolves.toMatchObject({ autopilotEnabled: true });

    const starter = await setup({ plan: 'starter' });
    await updateAutopilotSettings(ctx(starter), {
      autopilotEnabled: true,
      enableAutoApproveProjects: true,
    });
    await db
      .update(workspaces)
      .set({ subscriptionStatus: 'canceled' })
      .where(eq(workspaces.id, starter.workspaceId));
    const run = await runOnce(ctx(starter));
    expect(run.steps).toEqual([{ step: 'guard', outcome: 'skipped', detail: 'plan_no_autopilot' }]);
  });

  it('[handbook H-12] autopilot runs every 5 minutes and after each discovery run with records, only while on and unpaused', async () => {
    expect(AUTOPILOT_TICK_MS).toBe(5 * 60 * 1000);
    class RecordingQueue extends InMemoryJobQueue {
      public schedules: Array<{ type: string; everyMs: number }> = [];
      override async enqueueRepeatable<P extends JobPayload>(
        type: string,
        _payload: P,
        options: RepeatableJobOptions,
      ): Promise<void> {
        this.schedules.push({ type, everyMs: options.everyMs });
      }
    }
    const q = new RecordingQueue();
    await withJobQueue(q, () => registerRepeatableJobs());
    expect(q.schedules).toContainEqual({ type: 'autopilot.tick', everyMs: AUTOPILOT_TICK_MS });

    // The post-crawl hook (skipped under Vitest, so pinned at source).
    expect(readSrc('lib/connectors/runner.ts')).toMatch(
      /finalStatus === 'succeeded' && recordCount > 0[\s\S]{0,400}await runOnce\(ctx\)/,
    );

    const s = await setup();
    expect((await runOnce(ctx(s))).steps[0]!.detail).toBe('autopilot_disabled');
    await updateAutopilotSettings(ctx(s), { autopilotEnabled: true, emergencyPause: true });
    expect((await runOnce(ctx(s))).steps[0]!.detail).toBe('emergency_pause');
  });

  it('[handbook H-13] per-product overrides only narrow a step; product master and emergency-pause overrides are not applied', async () => {
    const s = await setup();
    const { product, items } = await discover(s);
    const item = items[0]!;

    // The workspace step is off: a product "on" cannot widen it.
    await updateAutopilotSettings(ctx(s), {
      autopilotEnabled: true,
      enableAutoApproveProjects: false,
      autoApproveThreshold: 50,
    });
    await upsertProductAutopilotSettings(ctx(s), {
      productProfileId: product.id,
      enableAutoApproveProjects: true,
    });
    await runOnce(ctx(s));
    expect((await reviewItem(item.id)).state).toBe('new');

    // The workspace step is on: a product "off" narrows it.
    await updateAutopilotSettings(ctx(s), { enableAutoApproveProjects: true });
    await upsertProductAutopilotSettings(ctx(s), {
      productProfileId: product.id,
      enableAutoApproveProjects: false,
    });
    await runOnce(ctx(s));
    expect((await reviewItem(item.id)).state).toBe('new');

    // Product master OFF + product emergency pause ON are saved but ignored.
    await upsertProductAutopilotSettings(ctx(s), {
      productProfileId: product.id,
      enableAutoApproveProjects: null,
      autopilotEnabled: false,
      emergencyPause: true,
    });
    await runOnce(ctx(s));
    expect((await reviewItem(item.id)).state).toBe('approved');
  });
});

// ---- follow-up service ---------------------------------------------

describe('follow-up service', { timeout: DB_TEST_TIMEOUT_MS }, () => {
  it('[handbook H-14] a cold email sent through the queue schedules no follow-ups', async () => {
    const s = await setup();
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, s.workspaceId));
    expect(ws!.followUpEnabled).toBe(true);
    await queuedEmail(s);
    const r = await drainQueue(ctx(s), { providerOverride: new MockMailProvider() });
    expect(r.sent).toBe(1);

    const followUps = await db
      .select()
      .from(outreachFollowUps)
      .where(eq(outreachFollowUps.workspaceId, s.workspaceId));
    const threadState = await db
      .select()
      .from(outreachThreadState)
      .where(eq(outreachThreadState.workspaceId, s.workspaceId));
    expect(followUps).toHaveLength(0);
    expect(threadState).toHaveLength(0);
  });

  it('[handbook H-15] with follow-up approval switched off, a due AI follow-up is sent without review', async () => {
    const s = await setup();
    const { product, items } = await discover(s);
    const mailbox = await makeMailbox(s);
    const provider = new MockMailProvider();
    const sent = await sendMessage(ctx(s), {
      mailboxId: mailbox.id,
      to: [{ address: 'lead@target.com' }],
      subject: 'Hi',
      text: 'first touch',
      providerOverride: provider,
    });
    const lead = await ensureQualifiedLead(ctx(s), items[0]!.id, product.id);
    await updateContact(ctx(s), lead.id, { contactEmail: 'lead@target.com' });
    // Thread state is seeded by hand: nothing creates it for a cold send (H-14).
    await db.insert(outreachThreadState).values({
      workspaceId: s.workspaceId,
      qualifiedLeadId: lead.id,
      threadId: sent.threadId!,
      stage: 'discovery',
    });
    await updateFollowUpConfig(ctx(s), { requireApproval: false });
    await scheduleFollowUps(ctx(s), { threadId: sent.threadId!, qualifiedLeadId: lead.id });
    await db
      .update(outreachFollowUps)
      .set({ scheduledFor: new Date(Date.now() - 60_000) })
      .where(
        and(
          eq(outreachFollowUps.workspaceId, s.workspaceId),
          eq(outreachFollowUps.stepNumber, 1),
        ),
      );
    _setAIProviderForTests({
      id: 'stub-ai',
      model: 'stub-model',
      async generateText() {
        return { text: 'Just following up.', model: 'stub', usage: { inputTokens: 1, outputTokens: 1 } };
      },
      async generateJson() {
        throw new Error('not used');
      },
      estimateCost() {
        return 0;
      },
      async healthCheck() {
        return { ok: true };
      },
    });

    const result = await processDueFollowUps(ctx(s), { mailProviderOverride: provider });
    expect(result.sent).toBe(1);
    const [step1] = await db
      .select()
      .from(outreachFollowUps)
      .where(
        and(
          eq(outreachFollowUps.workspaceId, s.workspaceId),
          eq(outreachFollowUps.stepNumber, 1),
        ),
      );
    expect(step1!.status).toBe('sent');
  });
});

// ---- mail service: mailbox status ----------------------------------

describe('mail service — mailbox status', { timeout: DB_TEST_TIMEOUT_MS }, () => {
  it('[handbook H-16] a failing mailbox keeps sending queued email but is not synced', async () => {
    const s = await setup();
    const { mailbox } = await queuedEmail(s, { imap: true });
    await db.update(mailboxes).set({ status: 'failing' }).where(eq(mailboxes.id, mailbox.id));

    const r = await drainQueue(ctx(s), { providerOverride: new MockMailProvider() });
    expect(r.sent).toBe(1);

    // The 2-minute IMAP tick only looks at ACTIVE mailboxes: the failing
    // one is never considered; the active IMAP-less one is (and skipped).
    await makeMailbox(s, { isDefault: false, address: 'info@nulife.pl' });
    const tick = await runTick('mail.imap.tick');
    expect(tick).toMatchObject({ mailboxesSynced: 0, failed: 0, skipped: 1 });
  });

  it('[handbook H-23] a paused mailbox sends nothing, and its queued email fails instead of waiting', async () => {
    const s = await setup();
    const { mailbox } = await queuedEmail(s);
    await updateMailbox(ctx(s), mailbox.id, { status: 'paused' });

    await expect(
      sendMessage(ctx(s), {
        mailboxId: mailbox.id,
        to: [{ address: 'someone@target.com' }],
        subject: 'Hi',
        text: 'manual',
        providerOverride: new MockMailProvider(),
      }),
    ).rejects.toThrow(/paused/);

    const r = await drainQueue(ctx(s), { providerOverride: new MockMailProvider() });
    expect(r.failed).toBe(1);
    expect((await queueRows(s))[0]!.status).toBe('failed');
  });
});

// ---- reply classifier ----------------------------------------------

/** Our outbound + their reply on one thread, linked to a pipeline lead. */
async function leadThreadWithReply(
  s: Setup,
  mailboxId: bigint,
  from: string,
  body: string,
): Promise<{ messageId: bigint; leadId: bigint }> {
  seq += 1;
  const [thread] = await db
    .insert(mailThreads)
    .values({
      workspaceId: s.workspaceId,
      mailboxId,
      subject: 'Concrete sealing',
      externalThreadKey: `subj:handbook-${seq}`,
      participants: [from, 'sales@nulife.pl'],
    })
    .returning();
  await db.insert(mailMessages).values({
    workspaceId: s.workspaceId,
    mailboxId,
    threadId: thread!.id,
    direction: 'outbound',
    status: 'sent',
    messageId: `<out-${seq}@nulife.pl>`,
    fromAddress: 'sales@nulife.pl',
    toAddresses: [from],
    subject: 'Concrete sealing',
    bodyText: 'Who handles waterproofing at your firm?',
  });
  const [msg] = await db
    .insert(mailMessages)
    .values({
      workspaceId: s.workspaceId,
      mailboxId,
      threadId: thread!.id,
      direction: 'inbound',
      status: 'received',
      messageId: `<in-${seq}@target.com>`,
      inReplyTo: `<out-${seq}@nulife.pl>`,
      fromAddress: from,
      toAddresses: ['sales@nulife.pl'],
      subject: 'Re: Concrete sealing',
      bodyText: body,
    })
    .returning();
  const { product, items } = await discover(s);
  const lead = await ensureQualifiedLead(ctx(s), items[0]!.id, product.id);
  const [contact] = await db
    .insert(contacts)
    .values({ workspaceId: s.workspaceId, email: from, name: 'Prospect', status: 'active' })
    .returning();
  await db.insert(contactAssociations).values([
    {
      workspaceId: s.workspaceId,
      contactId: contact!.id,
      entityType: 'mail_thread',
      entityId: thread!.id.toString(),
    },
    {
      workspaceId: s.workspaceId,
      contactId: contact!.id,
      entityType: 'qualified_lead',
      entityId: lead.id.toString(),
    },
  ]);
  return { messageId: msg!.id, leadId: lead.id };
}

async function leadState(id: bigint) {
  const [row] = await db.select().from(qualifiedLeads).where(eq(qualifiedLeads.id, id));
  return row!.state;
}

async function replyClassOf(messageId: bigint) {
  const [row] = await db.select().from(mailMessages).where(eq(mailMessages.id, messageId));
  return row!.replyClassification;
}

describe('reply classifier', { timeout: DB_TEST_TIMEOUT_MS }, () => {
  it('[handbook H-17] every inbound message gets exactly one of the ten reply classes', () => {
    const samples: Record<ReplyClass, string> = {
      unsubscribe: 'Please unsubscribe me from this list.',
      bounce: 'Delivery failed: the recipient address was rejected.',
      out_of_office: 'I am out of the office until Monday.',
      negative: 'Thanks, but we are not interested.',
      redirect: 'Please contact my colleague piotr@target.com about this.',
      doc_request: 'Could you send the datasheet for the sealer.',
      question: 'What does it cost per square metre?',
      interest: 'We are interested in learning more.',
      positive: 'Sure, sounds good.',
      irrelevant: 'Thanks.',
    };
    for (const [cls, body] of Object.entries(samples)) {
      expect(classifyReply(body).type, body).toBe(cls);
    }
    expect(classifyReply('').type).toBe('irrelevant');
  });

  it('[handbook H-18] reply auto-actions are admin-only switches on /settings/outreach, off by default; the unsubscribe link and SMTP rejections suppress regardless', async () => {
    const s = await setup();
    const mailbox = await makeMailbox(s);

    // Defaults: the suppress and close switches are off.
    expect(switchesOf(await getReplyAutoActions(ctx(s)))).toEqual({
      autoSuppressUnsubscribe: false,
      autoSuppressBounce: false,
      autoCloseNegative: false,
      autoExtractRedirects: true,
    });

    // Switched off, the message is still classified; nothing else happens.
    const quiet = await leadThreadWithReply(s, mailbox.id, 'anna@target.com', 'Please unsubscribe me.');
    await analyseReply(ctx(s), quiet.messageId);
    expect(await replyClassOf(quiet.messageId)).toBe('unsubscribe');
    expect(await isSuppressed(ctx(s), 'anna@target.com')).toBe(false);
    expect(await leadState(quiet.leadId)).toBe('relevant');

    // Only owners and admins can change them, and the only app caller is
    // the /settings/outreach save action.
    const member = makeWorkspaceContext({ workspaceId: s.workspaceId, userId: s.adminId, role: 'member' });
    await expect(
      updateReplyAutoActions(member, { autoSuppressUnsubscribe: true }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    expect(filesContaining('app', 'updateReplyAutoActions(')).toEqual([
      'app/settings/outreach/actions.ts',
    ]);
    expect(filesContaining('components', 'updateReplyAutoActions')).toEqual([]);

    // Switched on by an admin: unsubscribe and bounce replies suppress the
    // sender and close the lead.
    await updateReplyAutoActions(adminCtx(s), {
      autoSuppressUnsubscribe: true,
      autoSuppressBounce: true,
    });
    const unsub = await leadThreadWithReply(s, mailbox.id, 'olga@target.com', 'Please unsubscribe me.');
    await analyseReply(ctx(s), unsub.messageId);
    expect(await isSuppressed(ctx(s), 'olga@target.com')).toBe(true);
    expect(await leadState(unsub.leadId)).toBe('closed');
    const bounce = await leadThreadWithReply(
      s,
      mailbox.id,
      'piotr@other.com',
      'Delivery failed: the recipient address was rejected.',
    );
    await analyseReply(ctx(s), bounce.messageId);
    expect(await isSuppressed(ctx(s), 'piotr@other.com')).toBe(true);
    expect(await leadState(bounce.leadId)).toBe('closed');
    // A negative reply still does nothing: its own switch is off.
    const no = await leadThreadWithReply(s, mailbox.id, 'ewa@third.com', 'Thanks, but we are not interested.');
    await analyseReply(ctx(s), no.messageId);
    expect(await isSuppressed(ctx(s), 'ewa@third.com')).toBe(false);
    expect(await leadState(no.leadId)).toBe('relevant');

    // Whatever the switches say: the unsubscribe link…
    await updateReplyAutoActions(adminCtx(s), {
      autoSuppressUnsubscribe: false,
      autoSuppressBounce: false,
    });
    const token = 'abcdef0123456789abcdef01';
    await db.insert(mailMessages).values({
      workspaceId: s.workspaceId,
      mailboxId: mailbox.id,
      direction: 'outbound',
      status: 'sent',
      messageId: '<link-out@nulife.pl>',
      fromAddress: 'sales@nulife.pl',
      toAddresses: ['link@target.com'],
      subject: 'Concrete sealing',
      bodyText: 'Hello',
      trackingToken: token,
    });
    await recordUnsubscribeByToken(token);
    expect(await isSuppressed(ctx(s), 'link@target.com')).toBe(true);
    // …and a rejection by the mail server while sending.
    class RejectingProvider extends MockMailProvider {
      override async send(_message: OutboundMessage): Promise<SendResult> {
        throw Object.assign(new Error('550 5.1.1 mailbox unavailable'), { responseCode: 550 });
      }
    }
    await expect(
      sendMessage(ctx(s), {
        mailboxId: mailbox.id,
        to: [{ address: 'gone@target.com' }],
        subject: 'Hi',
        text: 'manual',
        providerOverride: new RejectingProvider(),
      }),
    ).rejects.toThrow(/550/);
    expect(await isSuppressed(ctx(s), 'gone@target.com')).toBe(true);
  });
});

// ---- inbound sync (Known limitations X1) ----------------------------

function newsletter(uid: number, from: string): InboundMessage {
  return {
    uid,
    messageId: `<news-${uid}@${from.split('@')[1]}>`,
    inReplyTo: null,
    references: [],
    from: { address: from, name: 'Weekly News' },
    to: [{ address: 'sales@nulife.pl' }],
    cc: [],
    subject: 'This week in concrete',
    textBody: 'Top stories this week.\n\nClick here to unsubscribe from this newsletter.',
    htmlBody: null,
    // Later than the previous sync, so the mock's `since` filter keeps it.
    receivedAt: new Date(Date.now() + uid * 1000),
    headers: { 'list-unsubscribe': `<https://${from.split('@')[1]}/u>` },
    attachments: [],
  };
}

describe('inbound sync — classification of non-replies', { timeout: DB_TEST_TIMEOUT_MS }, () => {
  it('[handbook H-25] a synced newsletter is classified as if it were a reply and notifies; it suppresses its sender only while auto-suppress is on', async () => {
    const s = await setup();
    const mailbox = await makeMailbox(s, { imap: true });
    const provider = new MockMailProvider();

    provider.enqueueInbound(newsletter(1, 'news@letters.example'));
    await syncInbound(ctx(s), mailbox.id, provider);
    const [msg] = await db
      .select()
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.workspaceId, s.workspaceId),
          eq(mailMessages.fromAddress, 'news@letters.example'),
        ),
      );
    expect(msg!.inReplyTo ?? null).toBeNull();
    expect(msg!.replyClassification).toBe('unsubscribe');
    const replied = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.workspaceId, s.workspaceId), eq(notifications.kind, 'lead.replied')));
    expect(replied).toHaveLength(1);
    // The switches are off by default: the sender is not suppressed…
    expect(await isSuppressed(ctx(s), 'news@letters.example')).toBe(false);

    // …but with auto-suppress on, the next newsletter's sender is.
    await updateReplyAutoActions(adminCtx(s), { autoSuppressUnsubscribe: true });
    provider.enqueueInbound(newsletter(2, 'digest@other.example'));
    await syncInbound(ctx(s), mailbox.id, provider);
    expect(await isSuppressed(ctx(s), 'digest@other.example')).toBe(true);
  });
});

// ---- language resolution -------------------------------------------

describe('language resolution', { timeout: DB_TEST_TIMEOUT_MS }, () => {
  it('[handbook H-19] outbound language: lead, then recipe, then workspace default, then product, then workspace native', async () => {
    const s = await setup();
    await updateWorkspaceNativeLanguage(ctx(s), 'pl');
    await updateWorkspaceOutreachLanguage(ctx(s), 'it');

    const [connector] = await db
      .insert(connectors)
      .values({ workspaceId: s.workspaceId, templateType: 'mock', name: 'lang' })
      .returning();
    const [recipe] = await db
      .insert(connectorRecipes)
      .values({
        workspaceId: s.workspaceId,
        connectorId: connector!.id,
        name: 'lang',
        templateType: 'mock',
        selectors: { language: 'ja' },
      })
      .returning();
    const [run] = await db
      .insert(connectorRuns)
      .values({
        workspaceId: s.workspaceId,
        connectorId: connector!.id,
        recipeId: recipe!.id,
        status: 'succeeded',
      })
      .returning();
    const [sr] = await db
      .insert(sourceRecords)
      .values({
        workspaceId: s.workspaceId,
        sourceSystem: 'mock',
        sourceId: 'lang-1',
        recipeId: recipe!.id,
        runId: run!.id,
        rawData: {},
        normalizedData: {},
      })
      .returning();
    const [ri] = await db
      .insert(reviewItems)
      .values({ workspaceId: s.workspaceId, sourceRecordId: sr!.id, state: 'approved' })
      .returning();
    const product = await createProductProfile(ctx(s), { name: 'lang', language: 'de' });
    const [lead] = await db
      .insert(qualifiedLeads)
      .values({
        workspaceId: s.workspaceId,
        reviewItemId: ri!.id,
        productProfileId: product.id,
        outreachLanguage: 'fr',
      })
      .returning();
    const pair = { reviewItemId: ri!.id, productProfileId: product.id };
    const resolve = () => resolveOutboundLanguage(ctx(s), pair);

    expect(await resolve()).toEqual({ language: 'fr', source: 'lead' });
    await db
      .update(qualifiedLeads)
      .set({ outreachLanguage: null })
      .where(eq(qualifiedLeads.id, lead!.id));
    expect(await resolve()).toEqual({ language: 'ja', source: 'recipe' });
    await db
      .update(connectorRecipes)
      .set({ selectors: {} })
      .where(eq(connectorRecipes.id, recipe!.id));
    expect(await resolve()).toEqual({ language: 'it', source: 'workspace_default' });
    await updateWorkspaceOutreachLanguage(ctx(s), '');
    expect(await resolve()).toEqual({ language: 'de', source: 'product' });
    // A product description written in another language beats its field.
    const polish = await createProductProfile(ctx(s), {
      name: 'lang-pl',
      language: 'en',
      fullDescription:
        'Specjalizujemy się w technologii uszczelniania betonu i zapewniamy rozwiązania dla największych projektów budowlanych w kraju.',
    });
    expect(
      await resolveOutboundLanguage(ctx(s), { reviewItemId: ri!.id, productProfileId: polish.id }),
    ).toEqual({ language: 'pl', source: 'product' });
    // Nothing above resolves → workspace native.
    expect(
      await resolveOutboundLanguage(ctx(s), { reviewItemId: 999_999n, productProfileId: 999_999n }),
    ).toEqual({ language: 'pl', source: 'workspace' });
  });
});

// ---- qualification: geography gate ---------------------------------

describe('qualification — geography gate', { timeout: DB_TEST_TIMEOUT_MS }, () => {
  it('[handbook H-20] a recipe without a target country has no geography gate; with one, unlocatable leads go to needs_review', async () => {
    const s = await setup();
    const open = await discover(s, { count: 2 });
    const openQuals = await db
      .select()
      .from(qualifications)
      .where(eq(qualifications.workspaceId, s.workspaceId));
    expect(openQuals.length).toBeGreaterThan(0);
    expect(openQuals.every((q) => q.geoStatus === 'no_gate')).toBe(true);
    expect(openQuals.some((q) => q.isRelevant)).toBe(true);
    for (const item of open.items) expect(item.state).toBe('new');

    // Same product, but the recipe targets Poland: the mock companies
    // (example-*.test) cannot be located, so relevant ones are held.
    const gated = await discover(s, { product: open.product, country: 'PL', count: 2 });
    const gatedQuals = await db
      .select({ q: qualifications, ri: reviewItems })
      .from(qualifications)
      .innerJoin(reviewItems, eq(reviewItems.sourceRecordId, qualifications.sourceRecordId))
      .where(eq(qualifications.workspaceId, s.workspaceId));
    const fromGated = gatedQuals.filter((r) => gated.items.some((i) => i.id === r.ri.id));
    expect(fromGated.length).toBeGreaterThan(0);
    const relevant = fromGated.filter((r) => r.q.isRelevant);
    expect(relevant.length).toBeGreaterThan(0);
    for (const r of relevant) {
      expect(r.q.geoStatus).toBe('unverified');
      expect(r.ri.state).toBe('needs_review');
    }

    // A no-gate lead also passes the send-time geography check.
    const lead = await ensureQualifiedLead(ctx(s), open.items[0]!.id, open.product.id);
    await updateContact(ctx(s), lead.id, { contactEmail: 'anna@target.com' });
    const draft = await generateOutreachDraft(ctx(s), {
      reviewItemId: open.items[0]!.id,
      productProfileId: open.product.id,
    });
    await approveOutreachDraft(ctx(s), draft.id);
    const mailbox = await makeMailbox(s);
    await enqueueDraft(ctx(s), { draftId: draft.id, mailboxId: mailbox.id, delayMode: 'immediate' });
    const r = await drainQueue(ctx(s), { providerOverride: new MockMailProvider() });
    expect(r.sent).toBe(1);
  });
});

describe('assistant (Ask the platform)', { timeout: DB_TEST_TIMEOUT_MS }, () => {
  it('[handbook H-24] an empty wallet still gets a free built-in answer; platform-admin questions are never charged', async () => {
    const s = await setup();
    const calls: Array<{ support?: boolean }> = [];
    const stub: IAIProvider = {
      id: 'stub',
      model: 'stub-1',
      async generateText(_input, options) {
        calls.push({ support: options?.support });
        return { text: 'model answer', model: 'stub-1', usage: { inputTokens: 1, outputTokens: 1 } };
      },
      async generateJson() {
        throw new Error('not used');
      },
      estimateCost: () => 0,
      healthCheck: async () => ({ ok: true }),
    };
    _setAIProviderForTests(stub);

    // A platform admin's question is marked as support…
    const superCtx = makeWorkspaceContext({
      workspaceId: s.workspaceId,
      userId: s.adminId,
      role: 'super_admin',
    });
    await askAssistant(superCtx, 'why is nothing sending?');
    expect(calls).toEqual([{ support: true }]);
    // …and support usage is never debited, while the same usage is.
    const before = (await getTokenWallet(ctx(s))).balance;
    const usage = {
      kind: 'ai.assistant',
      provider: 'anthropic',
      units: 100,
      costEstimateCents: 2,
    };
    await recordUsage(ctx(s), { ...usage, payload: { keySource: 'platform', support: true } });
    expect((await getTokenWallet(ctx(s))).balance).toBe(before);
    await recordUsage(ctx(s), { ...usage, payload: { keySource: 'platform' } });
    expect((await getTokenWallet(ctx(s))).balance).toBeLessThan(before);

    // Empty wallet: the model is not called and nothing is charged.
    await db.update(workspaces).set({ tokenBalance: 0n }).where(eq(workspaces.id, s.workspaceId));
    const txBefore = await db
      .select()
      .from(tokenTransactions)
      .where(eq(tokenTransactions.workspaceId, s.workspaceId));
    const r = await askAssistant(ctx(s), 'why am I getting no leads?');
    expect(calls).toHaveLength(1);
    expect(r.source).toBe('deterministic');
    expect(r.answer).toContain('[/settings/billing]');
    expect(r.findings).toContain('tokens.empty');
    const txAfter = await db
      .select()
      .from(tokenTransactions)
      .where(eq(tokenTransactions.workspaceId, s.workspaceId));
    expect(txAfter).toHaveLength(txBefore.length);
  });
});
