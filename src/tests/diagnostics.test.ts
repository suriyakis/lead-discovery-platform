// AP-06 (absorbs PC-33, ia:F-16, MOB-02 getFindings): the diagnostics
// engine. One fixture per rule; the production-shaped and healthy-trial
// calibration fixtures with their scores and notifications; the notify
// sweep's policies and ledger; rule isolation; the weekly check's toggle,
// retry and incident; one source for /health, Today and the assistant;
// the shared send-cap usage (I070); the country-filter grep; performance.
// MOB-02: the qualification-gap, rules-fallback and blocked-draft rules,
// autopilot step errors, and the engine's stale-while-revalidate read.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/connectors/mock';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import type { ZodSchema } from 'zod';
import { db } from '@/lib/db/client';
import {
  _setAIProviderForTests,
  type AIGenInput,
  type AIGenOptions,
  type AIGenResult,
  type IAIProvider,
} from '@/lib/ai';
import { users } from '@/lib/db/schema/auth';
import { auditLog, usageLog } from '@/lib/db/schema/audit';
import { autopilotLog, autopilotSettings } from '@/lib/db/schema/autopilot';
import {
  connectorRecipes,
  connectorRuns,
  connectors,
  crawlPlans,
  sourceRecords,
} from '@/lib/db/schema/connectors';
import { diagnosticNotices } from '@/lib/db/schema/diagnostics';
import { knowledgeSources } from '@/lib/db/schema/documents';
import { outreachFollowUps } from '@/lib/db/schema/follow-ups';
import {
  mailMessages,
  mailThreads,
  mailboxes,
  suppressionList,
  type MailboxStatus,
} from '@/lib/db/schema/mailing';
import { notifications } from '@/lib/db/schema/notifications';
import { jobHeartbeats } from '@/lib/db/schema/ops';
import { outreachDrafts, outreachQueue } from '@/lib/db/schema/outreach';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { productProfiles } from '@/lib/db/schema/products';
import { qualifications } from '@/lib/db/schema/qualifications';
import { reviewItems } from '@/lib/db/schema/review';
import { workspaceProviderSettings, workspaces } from '@/lib/db/schema/workspaces';
import * as engine from '@/lib/diagnostics/engine';
import {
  DIAGNOSTICS_MEMO_TTL_MS,
  _ageDiagnosticsMemoForTests,
  getWorkspaceDiagnostics,
  invalidateDiagnostics,
} from '@/lib/diagnostics/engine';
import { notifyDiagnostics, runDiagnosticsSweep } from '@/lib/diagnostics/notify';
import { DIAGNOSTIC_RULES } from '@/lib/diagnostics/registry';
import { defineRule } from '@/lib/diagnostics/rule';
import { SUPPRESSION_SPIKE_FLOOR } from '@/lib/diagnostics/rules/mail';
import { blendConversationReview, scoreFindings } from '@/lib/diagnostics/score';
import {
  NOTIFY_ON_APPEAR,
  PARTIAL_CODE,
  notifyEveryDays,
  findingMessage,
  isProblem,
  type Finding,
} from '@/lib/diagnostics/types';
import { _setBootInfoForTests } from '@/lib/jobs/boot';
import { runHealthCheckTick } from '@/lib/jobs/repeatables';
import { resolveNavLocation, splitHref } from '@/lib/nav/resolve';
import { createTickIncidents } from '@/lib/ops/tick-incidents';
import { askAssistant } from '@/lib/services/assistant';
import { pauseAutomation } from '@/lib/services/automation-pause';
import { makeWorkspaceContext, type WorkspaceContext } from '@/lib/services/context';
import { getDashboardSignals } from '@/lib/services/dashboard-signals';
import {
  HealthCheckError,
  getHealthCheckSettings,
  processDueHealthChecks,
  readStoredFindings,
  runWorkspaceHealthCheck,
  updateHealthCheckSettings,
} from '@/lib/services/health-check';
import { placeTenantHold, setPlatformOutboundStop } from '@/lib/services/holds';
import { raiseOpsEvent } from '@/lib/services/ops-events';
import { drainQueue, getSendCapUsage, updateSendSettings } from '@/lib/services/outreach-queue';
import { createProductProfile } from '@/lib/services/product-profile';
import { setPlatformSecret } from '@/lib/services/secrets';
import { TodayAttention } from '@/app/(app)/today/_attention';
import { renderToHtml } from './helpers/next-render';
import { platformCtx } from './helpers/platform';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

// ---- providers -------------------------------------------------------------

/** Counts every AI call and answers the review / guide with fixed text. */
class CountingAi implements IAIProvider {
  public readonly id = 'stub';
  public readonly model = 'stub-1';
  public calls = 0;
  public lastInput: AIGenInput | null = null;
  async generateText(input: AIGenInput, _o?: AIGenOptions): Promise<AIGenResult> {
    this.calls += 1;
    this.lastInput = input;
    return { text: 'An answer.', model: this.model, usage: { inputTokens: 0, outputTokens: 0 } };
  }
  async generateJson<T>(_i: AIGenInput, schema: ZodSchema<T>): Promise<T> {
    this.calls += 1;
    return schema.parse({ naturalness: 90, issues: [], advice: [] });
  }
  estimateCost(): number {
    return 0;
  }
  async healthCheck() {
    return { ok: true, detail: 'stub' };
  }
}

// ---- fixtures ----------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const NOW = () => new Date();
const ago = (ms: number) => new Date(Date.now() - ms);

interface Tenant {
  workspaceId: bigint;
  ownerId: string;
  ctx: WorkspaceContext;
}

async function tenant(
  name = 'diag',
  options: { plan?: 'free' | 'pro'; live?: boolean } = {},
): Promise<Tenant> {
  const ownerId = await seedUser({ email: `${name}-owner@test.local`, name: `${name} owner` });
  const workspaceId = await seedWorkspace({
    name,
    ownerUserId: ownerId,
    plan: options.plan ?? 'pro',
    live: options.live ?? true,
  });
  return {
    workspaceId,
    ownerId,
    ctx: makeWorkspaceContext({ workspaceId, userId: ownerId, role: 'owner' }),
  };
}

async function diagnose(t: Tenant, now?: Date) {
  return getWorkspaceDiagnostics(t.ctx, now ? { now } : { fresh: true });
}

async function codes(t: Tenant, now?: Date): Promise<string[]> {
  return (await diagnose(t, now)).findings.map((f) => f.code);
}

async function finding(t: Tenant, code: string): Promise<Finding> {
  const f = (await diagnose(t)).findings.find((x) => x.code === code);
  if (!f) throw new Error(`no ${code} finding`);
  return f;
}

let mailboxSeq = 0;
async function mailbox(
  t: Tenant,
  status: MailboxStatus,
  extra: Partial<typeof mailboxes.$inferInsert> = {},
): Promise<bigint> {
  mailboxSeq += 1;
  const [row] = await db
    .insert(mailboxes)
    .values({
      workspaceId: t.workspaceId,
      name: extra.name ?? `box${mailboxSeq}`,
      fromAddress: `box${mailboxSeq}@test.local`,
      smtpHost: 'smtp.test.local',
      smtpUser: `box${mailboxSeq}`,
      smtpPasswordSecretKey: `mailbox.smtp_${mailboxSeq}`,
      imapFolder: 'INBOX',
      status,
      ...extra,
    })
    .returning({ id: mailboxes.id });
  return row!.id;
}

async function product(t: Tenant, name = 'Sealer'): Promise<bigint> {
  return (await createProductProfile(t.ctx, { name })).id;
}

async function connector(
  t: Tenant,
  templateType: 'internet_search' | 'mock' = 'internet_search',
  active = true,
): Promise<bigint> {
  const [row] = await db
    .insert(connectors)
    .values({ workspaceId: t.workspaceId, templateType, name: `${templateType}`, active })
    .returning({ id: connectors.id });
  return row!.id;
}

async function recipe(
  t: Tenant,
  connectorId: bigint,
  selectors: Record<string, unknown>,
  active = true,
): Promise<bigint> {
  const [row] = await db
    .insert(connectorRecipes)
    .values({
      workspaceId: t.workspaceId,
      connectorId,
      name: `r-${JSON.stringify(selectors)}`,
      templateType: 'internet_search',
      selectors,
      active,
    })
    .returning({ id: connectorRecipes.id });
  return row!.id;
}

let recordSeq = 0;

/** `n` open review items, `relevant` of them with a relevant
 *  qualification; the rest rejected by the qualifier. */
async function reviewQueue(
  t: Tenant,
  productId: bigint,
  n: number,
  relevant: number,
  options: { updatedAt?: Date } = {},
): Promise<void> {
  const records = await db
    .insert(sourceRecords)
    .values(
      Array.from({ length: n }, (_, i) => ({
        workspaceId: t.workspaceId,
        sourceSystem: 'mock',
        sourceId: `rq-${t.workspaceId}-${(recordSeq += 1)}-${i}`,
        rawData: {},
        normalizedData: {},
      })),
    )
    .returning({ id: sourceRecords.id });
  const at = options.updatedAt ?? NOW();
  await db.insert(reviewItems).values(
    records.map((r) => ({
      workspaceId: t.workspaceId,
      sourceRecordId: r.id,
      state: 'new' as const,
      createdAt: at,
      updatedAt: at,
    })),
  );
  await db.insert(qualifications).values(
    records.map((r, i) => ({
      workspaceId: t.workspaceId,
      sourceRecordId: r.id,
      productProfileId: productId,
      isRelevant: i < relevant,
      relevanceScore: i < relevant ? 85 : 20,
      confidence: 70,
      method: 'ai',
    })),
  );
}

/** A lead (approved review item + qualified lead) and its draft. `lead:
 *  false` = no qualified lead for the pair (production's one draft);
 *  `contactEmail: null` = a lead without an address. */
async function draftFor(
  t: Tenant,
  productId: bigint,
  draft: {
    status: 'draft' | 'needs_edit' | 'approved' | 'rejected';
    updatedAt?: Date;
    approvedAt?: Date;
    lead?: boolean;
    contactEmail?: string | null;
  },
): Promise<{ leadId: bigint | null; draftId: bigint }> {
  const [sr] = await db
    .insert(sourceRecords)
    .values({
      workspaceId: t.workspaceId,
      sourceSystem: 'mock',
      sourceId: `draft-${t.workspaceId}-${Math.random()}`,
      rawData: {},
      normalizedData: {},
    })
    .returning();
  const [ri] = await db
    .insert(reviewItems)
    .values({ workspaceId: t.workspaceId, sourceRecordId: sr!.id, state: 'approved' })
    .returning();
  const [lead] =
    draft.lead === false
      ? [null]
      : await db
          .insert(qualifiedLeads)
          .values({
            workspaceId: t.workspaceId,
            reviewItemId: ri!.id,
            productProfileId: productId,
            state: 'contacted',
            contactEmail:
              draft.contactEmail === undefined ? 'lead@prospect.test' : draft.contactEmail,
          })
          .returning();
  const [row] = await db
    .insert(outreachDrafts)
    .values({
      workspaceId: t.workspaceId,
      reviewItemId: ri!.id,
      sourceRecordId: sr!.id,
      productProfileId: productId,
      status: draft.status,
      subject: 'Quick question',
      body: 'Who handles concrete repair?',
      method: 'rules',
      ...(draft.updatedAt ? { createdAt: draft.updatedAt, updatedAt: draft.updatedAt } : {}),
      ...(draft.approvedAt ? { approvedAt: draft.approvedAt } : {}),
    })
    .returning({ id: outreachDrafts.id });
  return { leadId: lead?.id ?? null, draftId: row!.id };
}

/** Qualify every record of the workspace's review queue that `productId`
 *  has not judged yet (none relevant); the first `fallback` of them by
 *  the rules fallback. */
async function qualifyAll(t: Tenant, productId: bigint, fallback = 0): Promise<void> {
  const rows = await db
    .select({ id: reviewItems.sourceRecordId })
    .from(reviewItems)
    .where(eq(reviewItems.workspaceId, t.workspaceId))
    .orderBy(reviewItems.id);
  await db.insert(qualifications).values(
    rows.map((r, i) => ({
      workspaceId: t.workspaceId,
      sourceRecordId: r.id,
      productProfileId: productId,
      isRelevant: false,
      relevanceScore: 20,
      confidence: 70,
      method: i < fallback ? 'rules_fallback' : 'ai',
    })),
  ).onConflictDoNothing();
}

async function autoSuppressions(t: Tenant, n: number, createdAt = ago(10 * DAY)): Promise<void> {
  await db.insert(suppressionList).values(
    Array.from({ length: n }, (_, i) => ({
      workspaceId: t.workspaceId,
      kind: 'email' as const,
      address: `sup${i}@news.test`,
      value: `sup${i}@news.test`,
      reason: i % 4 === 0 ? ('bounce_hard' as const) : ('unsubscribe' as const),
      source: 'legacy_auto' as const,
      createdAt,
    })),
  );
}

async function inboundFrom(t: Tenant, mailboxId: bigint, senders: number): Promise<void> {
  await db.insert(mailMessages).values(
    Array.from({ length: senders }, (_, i) => ({
      workspaceId: t.workspaceId,
      mailboxId,
      direction: 'inbound' as const,
      status: 'received' as const,
      messageId: `<in-${t.workspaceId}-${i}@test>`,
      fromAddress: `Sender${i}@Example${i % 40}.test`,
      toAddresses: ['sales@test.local'],
      subject: 'Newsletter',
      createdAt: ago(5 * DAY),
    })),
  );
}

async function outboundSent(t: Tenant, mailboxId: bigint, n: number): Promise<void> {
  await db.insert(mailMessages).values(
    Array.from({ length: n }, (_, i) => ({
      workspaceId: t.workspaceId,
      mailboxId,
      direction: 'outbound' as const,
      status: 'sent' as const,
      messageId: `<out-${t.workspaceId}-${i}-${Math.random()}@test>`,
      fromAddress: 'sales@test.local',
      toAddresses: [`lead${i}@prospect.test`],
      subject: 'Follow-up',
      createdAt: ago(60 * 60 * 1000),
    })),
  );
}

/** The diagnostics notifications a workspace's owner has. */
async function sweepNotifications(t: Tenant) {
  return db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.workspaceId, t.workspaceId),
        inArray(notifications.kind, ['health.finding', 'health.critical', 'mailbox.failing']),
      ),
    );
}

beforeEach(async () => {
  await truncateAll();
  _setBootInfoForTests({ id: 'test-boot', startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) });
});

afterEach(() => {
  _setAIProviderForTests(null);
  _setBootInfoForTests(null);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- the registry ----------------------------------------------------------------

describe('the rule registry', () => {
  it('has the ported, new and contributed rules, each id once', () => {
    const ids = DIAGNOSTIC_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      // ported (8)
      'tokens.empty',
      'products.none',
      'mailbox.none',
      'recipes.no_country',
      'runs.failed',
      'review.backlog',
      'drafts.stale',
      'follow_ups.pending',
      // new, owned here
      'mailbox.failing',
      'mailbox.paused',
      'outreach.paused',
      'autopilot.state',
      'search.mock',
      'runs.zero_results',
      'review.noise',
      'suppression.spike',
      'knowledge.index_failed',
      'plan.limits',
      'learning.unfed',
      // holds, the platform stop, the owner, go-live, ops
      'automation.hold',
      'automation.platform_stop',
      'automation.owner',
      'golive.not_live',
      'ops.incidents',
      'jobs.stale',
      'queue.failed_24h',
      'send.cap_exhausted',
      // MOB-02's live signals
      'records.unqualified',
      'qualification.rules_fallback',
      'drafts.blocked',
    ]) {
      expect(ids, id).toContain(id);
    }
  });
});

// ---- one fixture per rule ------------------------------------------------------------

describe('rules', () => {
  it('tokens.empty: an empty, non-exempt wallet is critical; billing-exempt is not', async () => {
    const t = await tenant();
    await db.update(workspaces).set({ tokenBalance: 0n }).where(eq(workspaces.id, t.workspaceId));
    const f = await finding(t, 'tokens.empty');
    expect(f.severity).toBe('critical');
    expect(f.href).toBe('/settings/billing');
    await db.update(workspaces).set({ billingExempt: true }).where(eq(workspaces.id, t.workspaceId));
    expect(await codes(t)).not.toContain('tokens.empty');
  });

  it('products.none: no ACTIVE product profile', async () => {
    const t = await tenant();
    expect(await codes(t)).toContain('products.none');
    await product(t);
    expect(await codes(t)).not.toContain('products.none');
  });

  it('mailbox.none: nothing connected, then only failing / paused ones', async () => {
    const t = await tenant();
    let f = await finding(t, 'mailbox.none');
    expect(f.title).toBe('No mailbox connected');
    expect(f.detail).toContain('Nothing can be sent or received');
    expect(f.href).toBe('/mailbox/new');
    await mailbox(t, 'paused');
    f = await finding(t, 'mailbox.none');
    expect(f.detail).toContain('Nothing can be sent or received: no mailbox is active (each one is paused).');
    expect(f.href).toBe('/mailbox');
    await mailbox(t, 'active');
    expect(await codes(t)).not.toContain('mailbox.none');
  });

  it('mailbox.failing: one critical finding per mailbox, I095 copy, backoff fact, the source key', async () => {
    const t = await tenant();
    await mailbox(t, 'active');
    const id = await mailbox(t, 'failing', {
      name: 'Sales',
      lastError: 'IMAP: Command failed',
      imapConsecutiveFailures: 13,
      imapNextSyncAfter: null,
      failingSince: new Date('2026-07-01T10:00:00Z'),
    });
    const f = await finding(t, 'mailbox.failing');
    expect(f.severity).toBe('critical');
    expect(f.title).toBe('Mailbox "Sales" is failing');
    expect(f.detail).toContain('no longer received');
    expect(f.detail).toContain('held');
    expect(f.facts).toMatchObject({ consecutiveFailures: 13, backoffMissing: true });
    expect(f.href).toBe(`/mailbox/${id}`);
    expect(f.since).toBe('2026-07-01T10:00:00.000Z');
    expect(f.notify).toMatchObject({
      policy: { kind: 'on_appear' },
      dedupeKey: `mailbox.failing:${id}`,
      kind: 'mailbox.failing',
    });
  });

  it('mailbox.paused: info per paused mailbox, never notified', async () => {
    const t = await tenant();
    await mailbox(t, 'active');
    await mailbox(t, 'paused', { name: 'Old box' });
    const f = await finding(t, 'mailbox.paused');
    expect(f).toMatchObject({ severity: 'info', title: 'Mailbox "Old box" is paused' });
    expect(f.notify.policy.kind).toBe('never');
  });

  it('recipes.no_country: counts only active recipes on active connectors; blank is no country', async () => {
    const t = await tenant();
    const live = await connector(t);
    const off = await connector(t, 'internet_search', false);
    // The acceptance case: an archived recipe WITH a country and an active
    // one without → "of 1 active recipes … gate OFF".
    await recipe(t, live, { country: 'PL', queries: ['a'] }, false);
    await recipe(t, live, { queries: ['b'] });
    // Ignored: a recipe on a switched-off connector.
    await recipe(t, off, { queries: ['c'] });
    let f = await finding(t, 'recipes.no_country');
    expect(f.title).toBe('1 of 1 active recipes have no target country');
    expect(findingMessage(f)).toContain('of 1 active recipes');
    expect(f.detail).toContain('geography gate is OFF');
    // A blank or whitespace country is no country (nullif(btrim(...), '')).
    await recipe(t, live, { country: '  ', queries: ['d'] });
    await recipe(t, live, { country: 'GB', queries: ['e'] });
    f = await finding(t, 'recipes.no_country');
    expect(f.title).toBe('2 of 3 active recipes have no target country');
  });

  it('runs.failed: failed runs of the last 7 days only', async () => {
    const t = await tenant();
    const c = await connector(t, 'mock');
    await db.insert(connectorRuns).values([
      { workspaceId: t.workspaceId, connectorId: c, status: 'failed', createdAt: ago(2 * DAY) },
      { workspaceId: t.workspaceId, connectorId: c, status: 'failed', createdAt: ago(9 * DAY) },
    ]);
    const f = await finding(t, 'runs.failed');
    expect(f.title).toBe('1 discovery run failed in the last 7 days');
  });

  it("runs.zero_results: a 'succeeded' run with recordCount 0 in 7 days", async () => {
    const t = await tenant();
    const c = await connector(t, 'mock');
    await db.insert(connectorRuns).values([
      { workspaceId: t.workspaceId, connectorId: c, status: 'succeeded', recordCount: 0, createdAt: ago(DAY) },
    ]);
    let f = await finding(t, 'runs.zero_results');
    expect(f.severity).toBe('warning'); // every successful run found nothing
    await db.insert(connectorRuns).values([
      { workspaceId: t.workspaceId, connectorId: c, status: 'succeeded', recordCount: 12, createdAt: ago(DAY) },
      // Outside the window: ignored.
      { workspaceId: t.workspaceId, connectorId: c, status: 'succeeded', recordCount: 0, createdAt: ago(8 * DAY) },
    ]);
    f = await finding(t, 'runs.zero_results');
    expect(f.severity).toBe('info');
    expect(f.title).toBe('1 of 2 discovery runs in the last 7 days found nothing');
  });

  it('search.mock: Gemini chosen without a key falls back to the mock (warning); mock usage is critical', async () => {
    const t = await tenant();
    // No web-search recipe: the fallback cannot hurt yet.
    expect(await codes(t)).not.toContain('search.mock');
    const c = await connector(t);
    await recipe(t, c, { country: 'GB', queries: ['waterproofing'] });
    await db.insert(workspaceProviderSettings).values({
      workspaceId: t.workspaceId,
      researchProvider: 'gemini',
    });
    let f = await finding(t, 'search.mock');
    expect(f.severity).toBe('warning');
    expect(f.detail).toContain('Gemini is chosen for web search, but no key');
    expect(f.href).toBe('/settings/integrations');
    // Dormant (no schedule): never notified.
    expect(f.notify.policy.kind).toBe('never');
    await db.insert(crawlPlans).values({
      workspaceId: t.workspaceId,
      name: 'weekly',
      enabled: true,
      recipeIds: [],
    } as typeof crawlPlans.$inferInsert);
    f = await finding(t, 'search.mock');
    expect(f.notify.policy).toEqual({ kind: 'max_once_per_days', days: 1 });
    await db.insert(usageLog).values({
      workspaceId: t.workspaceId,
      kind: 'search.query',
      provider: 'mock',
      units: 1n,
      payload: { keySource: 'mock' },
    });
    f = await finding(t, 'search.mock');
    expect(f.severity).toBe('critical');
    expect(f.facts).toMatchObject({ mockQueries7d: 1 });
    // A real key (the platform's) ends the fallback; the 7-day usage stays.
    const root = await seedUser({ email: 'root@test.local', role: 'super_admin' });
    await setPlatformSecret(platformCtx(root), 'gemini.apiKey', 'test-gemini-key');
    f = await finding(t, 'search.mock');
    expect(f.facts).toMatchObject({ wouldUseMock: false });
  });

  it('knowledge.index_failed: sources whose last run failed', async () => {
    const t = await tenant();
    const [row] = await db
      .insert(knowledgeSources)
      .values({ workspaceId: t.workspaceId, kind: 'text', title: 'Price list', indexStatus: 'failed' })
      .returning({ id: knowledgeSources.id });
    const f = await finding(t, 'knowledge.index_failed');
    expect(f).toMatchObject({ severity: 'warning', href: `/knowledge/${row!.id}` });
  });

  it('plan.limits: advisory on Free / a trial, silent on an active paid plan', async () => {
    const paid = await tenant('paid');
    expect(await codes(paid)).not.toContain('plan.limits');
    const free = await tenant('free', { plan: 'free' });
    const f = await finding(free, 'plan.limits');
    expect(f).toMatchObject({ severity: 'info', advisory: true });
    expect(f.detail).toContain('up to 1 product');
    expect(f.notify.policy.kind).toBe('never');
  });

  it('learning.unfed: advisory until a rule or an operator decision exists', async () => {
    const t = await tenant();
    expect(await codes(t)).not.toContain('learning.unfed'); // no product yet
    await product(t);
    const f = await finding(t, 'learning.unfed');
    expect(f).toMatchObject({ severity: 'info', advisory: true });
  });

  it('suppression.spike: automatic suppressions above max(10, 20% of distinct senders)', async () => {
    const t = await tenant();
    const box = await mailbox(t, 'active');
    await autoSuppressions(t, SUPPRESSION_SPIKE_FLOOR);
    expect(await codes(t)).not.toContain('suppression.spike'); // = floor, not above
    await db.insert(suppressionList).values({
      workspaceId: t.workspaceId,
      kind: 'email',
      address: 'one-more@news.test',
      value: 'one-more@news.test',
      reason: 'unsubscribe',
      source: 'reply',
    });
    const f = await finding(t, 'suppression.spike');
    expect(f.severity).toBe('critical');
    expect(f.facts).toMatchObject({ autoSuppressed: 11, threshold: 10 });
    expect(f.href).toBe('/mailbox/suppression');
    expect(f.notify.policy.kind).toBe('on_appear');
    // With 100 distinct senders the threshold is 20.
    await inboundFrom(t, box, 100);
    expect(await codes(t)).not.toContain('suppression.spike');
  });

  it('queue.failed_24h: queue rows failed in the last 24 hours', async () => {
    const t = await tenant();
    const box = await mailbox(t, 'active');
    await db.insert(outreachQueue).values({
      workspaceId: t.workspaceId,
      mailboxId: box,
      toAddresses: ['a@x.test'],
      subject: 'Hi',
      status: 'failed',
    });
    expect((await finding(t, 'queue.failed_24h')).href).toBe('/mailbox/queue');
  });

  it('send.cap_exhausted: the cap is used up while due emails wait', async () => {
    const t = await tenant();
    const box = await mailbox(t, 'active');
    await updateSendSettings(t.ctx, { dailyEmailLimit: 2 });
    await outboundSent(t, box, 2);
    expect(await codes(t)).not.toContain('send.cap_exhausted'); // nothing waits
    await db.insert(outreachQueue).values({
      workspaceId: t.workspaceId,
      mailboxId: box,
      toAddresses: ['a@x.test'],
      subject: 'Hi',
      status: 'queued',
      scheduledSendAt: ago(60_000),
    });
    const f = await finding(t, 'send.cap_exhausted');
    expect(f.facts).toMatchObject({ used: 2, cap: 2, waiting: 1 });
  });

  it('review.backlog / review.noise: old open items, and a queue the qualifier rejected', async () => {
    const t = await tenant();
    const p = await product(t);
    await reviewQueue(t, p, 49, 0, { updatedAt: ago(10 * DAY) });
    let c = await codes(t);
    expect(c).toContain('review.backlog');
    expect(c).not.toContain('review.noise'); // under 50 open items
    await reviewQueue(t, p, 1, 0);
    const noise = await finding(t, 'review.noise');
    expect(noise.facts).toMatchObject({ open: 50, relevant: 0 });
    expect(noise.notify.policy).toEqual({ kind: 'max_once_per_days', days: 30 });
    await reviewQueue(t, p, 10, 10);
    c = await codes(t);
    expect(c).not.toContain('review.noise'); // 10 of 60 relevant: over 10%
  });

  it('drafts.stale / follow_ups.pending: waiting work', async () => {
    const t = await tenant();
    const p = await product(t);
    const box = await mailbox(t, 'active');
    await draftFor(t, p, { status: 'draft', updatedAt: ago(2 * DAY) });
    expect(await codes(t)).not.toContain('drafts.stale');
    const { leadId } = await draftFor(t, p, { status: 'needs_edit', updatedAt: ago(9 * DAY) });
    const [thread] = await db
      .insert(mailThreads)
      .values({
        workspaceId: t.workspaceId,
        mailboxId: box,
        subject: 'Quick question',
        externalThreadKey: `fu-${t.workspaceId}`,
        participants: ['lead@prospect.test'],
      })
      .returning();
    await db.insert(outreachFollowUps).values({
      workspaceId: t.workspaceId,
      qualifiedLeadId: leadId!,
      threadId: thread!.id,
      stepNumber: 1,
      totalSteps: 3,
      scheduledFor: NOW(),
      status: 'awaiting_approval',
    });
    const c = await codes(t);
    expect(c).toContain('drafts.stale');
    expect((await finding(t, 'drafts.stale')).title).toBe('1 draft has waited over a week for approval');
    expect(c).toContain('follow_ups.pending');
  });

  it('outreach.paused / automation.hold / automation.platform_stop / golive.not_live', async () => {
    const t = await tenant('stops', { live: false });
    expect(await codes(t)).toContain('golive.not_live');
    await pauseAutomation(t.ctx, { source: 'api', reason: 'checking the copy' });
    const paused = await finding(t, 'outreach.paused');
    expect(paused.title).toBe('All automation is paused');
    expect(paused.detail).toContain('checking the copy');
    expect(paused.detail).toContain('Inbox sync keeps reading');
    expect(paused.href).toBe('/autopilot#pause');
    await placeTenantHold(t.ctx, {
      scope: 'capabilities',
      capabilities: ['sending'],
      reason: 'new copy under review',
    });
    const hold = await finding(t, 'automation.hold');
    expect(hold.title).toBe('Sending is on hold');
    expect(hold.detail).toContain('new copy under review');
    const root = await seedUser({ email: 'root@test.local', role: 'super_admin' });
    await setPlatformOutboundStop(platformCtx(root), 'provider incident');
    const stop = await finding(t, 'automation.platform_stop');
    expect(stop.detail).toContain('provider incident');
    expect(stop.href).toBe('/support');
  });

  it('automation.owner: no accountable owner is critical', async () => {
    const t = await tenant();
    await db.update(users).set({ accountStatus: 'suspended' }).where(eq(users.id, t.ownerId));
    const f = await finding(t, 'automation.owner');
    expect(f.severity).toBe('critical');
    expect(f.detail).toContain('Automatic work is stopped');
  });

  it("autopilot.state: armed while off (I057), on with its steps, absent when off and disarmed", async () => {
    const t = await tenant();
    expect(await codes(t)).not.toContain('autopilot.state');
    await db.insert(autopilotSettings).values({
      workspaceId: t.workspaceId,
      autopilotEnabled: false,
      enableAutoApproveProjects: true,
      autoApproveThreshold: 70,
    });
    let f = await finding(t, 'autopilot.state');
    expect(f).toMatchObject({ severity: 'warning', title: 'Auto-approve armed while autopilot is off' });
    expect(f.detail).toContain('scored 70 or more');
    await db
      .update(autopilotSettings)
      .set({ autopilotEnabled: true })
      .where(eq(autopilotSettings.workspaceId, t.workspaceId));
    f = await finding(t, 'autopilot.state');
    expect(f).toMatchObject({ severity: 'info', title: 'Autopilot is on' });
    expect(f.facts).toMatchObject({ errors24h: 0, stepsOn: 'auto_approve_projects' });
    // MOB-02: autopilot_log errors in the last 24 h are a live problem.
    await db.insert(autopilotLog).values({
      workspaceId: t.workspaceId,
      runId: 'r1',
      step: 'approve_project',
      outcome: 'error',
    });
    f = await finding(t, 'autopilot.state');
    expect(f).toMatchObject({
      severity: 'warning',
      title: 'Autopilot is on, with 1 step error in the last 24 hours',
    });
    expect(f.facts).toMatchObject({ errors24h: 1, stepsOn: 'auto_approve_projects' });
    // An error older than 24 h is history, not a problem.
    await db
      .update(autopilotLog)
      .set({ createdAt: ago(2 * DAY) })
      .where(eq(autopilotLog.workspaceId, t.workspaceId));
    expect((await finding(t, 'autopilot.state')).severity).toBe('info');
  });

  it('records.unqualified (I077): in-play records an active product never judged; the grace hour; products.none takes over', async () => {
    const t = await tenant();
    const p1 = await product(t, 'Sealer');
    await reviewQueue(t, p1, 5, 1, { updatedAt: ago(3 * DAY) });
    // Every record judged by the only product: nothing to report.
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    expect(await codes(t, later)).not.toContain('records.unqualified');
    // A second product created after the records were found.
    await product(t, 'Primer');
    // Within the grace hour it may still be classifying: quiet.
    expect(await codes(t)).not.toContain('records.unqualified');
    const f = (await diagnose(t, later)).findings.find((x) => x.code === 'records.unqualified')!;
    expect(f).toMatchObject({
      severity: 'warning',
      title: '5 records were never qualified for "Primer"',
      href: '/connectors/engine',
    });
    expect(f.facts).toMatchObject({ recordsInPlay: 5, neverQualified: 0, worstProductMissing: 5 });
    expect(f.detail).toContain('"Primer" (5 of 5)');
    // Rejected records no longer matter.
    await db.update(reviewItems).set({ state: 'rejected' }).where(eq(reviewItems.workspaceId, t.workspaceId));
    expect(await codes(t, later)).not.toContain('records.unqualified');
  });

  it('records.unqualified: records found while no product was active count as never qualified', async () => {
    const t = await tenant();
    const records = await db
      .insert(sourceRecords)
      .values(
        [0, 1, 2].map((i) => ({
          workspaceId: t.workspaceId,
          sourceSystem: 'mock',
          sourceId: `orphan-${i}`,
          rawData: {},
          normalizedData: {},
        })),
      )
      .returning({ id: sourceRecords.id });
    await db.insert(reviewItems).values(
      records.map((r) => ({
        workspaceId: t.workspaceId,
        sourceRecordId: r.id,
        state: 'new' as const,
        createdAt: ago(5 * DAY),
      })),
    );
    expect(await codes(t)).toContain('products.none');
    expect(await codes(t)).not.toContain('records.unqualified');
    await product(t);
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const f = (await diagnose(t, later)).findings.find((x) => x.code === 'records.unqualified')!;
    expect(f.title).toBe('3 records were never qualified');
    expect(f.facts).toMatchObject({ neverQualified: 3 });
    expect(f.notify.policy).toEqual(notifyEveryDays(30));
  });

  it('qualification.rules_fallback (I025): relevant fallback verdicts are a warning, the rest info', async () => {
    const t = await tenant();
    const p = await product(t);
    await reviewQueue(t, p, 4, 0);
    expect(await codes(t)).not.toContain('qualification.rules_fallback');
    await db
      .update(qualifications)
      .set({ method: 'rules_fallback' })
      .where(eq(qualifications.workspaceId, t.workspaceId));
    let f = await finding(t, 'qualification.rules_fallback');
    expect(f).toMatchObject({
      severity: 'info',
      title: '4 verdicts were made without the AI',
      href: '/settings/integrations',
    });
    expect(f.notify.policy.kind).toBe('never');
    // One of them came out relevant (a zero-signal record scores 50).
    const [one] = await db
      .select({ id: qualifications.id })
      .from(qualifications)
      .where(eq(qualifications.workspaceId, t.workspaceId))
      .limit(1);
    await db
      .update(qualifications)
      .set({ isRelevant: true, relevanceScore: 50 })
      .where(eq(qualifications.id, one!.id));
    f = await finding(t, 'qualification.rules_fallback');
    expect(f).toMatchObject({ severity: 'warning', title: '1 record was marked relevant without the AI' });
    expect(f.facts).toMatchObject({ fallbackVerdicts: 4, relevantByFallback: 1 });
    expect(f.detail).toContain('scores 50');
    expect(f.notify.policy).toEqual(notifyEveryDays(7));
    // An archived product's verdicts do not count.
    await db
      .update(productProfiles)
      .set({ active: false })
      .where(eq(productProfiles.id, p));
    expect(await codes(t)).not.toContain('qualification.rules_fallback');
  });

  it('drafts.blocked: approved but never queued, approved without an email, awaiting without an email', async () => {
    const t = await tenant();
    const p = await product(t);
    const box = await mailbox(t, 'active');
    // Fine: awaiting with an email; approved and queued; rejected without an email.
    await draftFor(t, p, { status: 'draft' });
    const queued = await draftFor(t, p, { status: 'approved', approvedAt: ago(3 * DAY) });
    await db.insert(outreachQueue).values({
      workspaceId: t.workspaceId,
      mailboxId: box,
      draftId: queued.draftId,
      toAddresses: ['lead@prospect.test'],
      subject: 'Quick question',
      bodyText: 'Hi',
      status: 'sent',
    });
    await draftFor(t, p, { status: 'rejected', lead: false });
    expect(await codes(t)).not.toContain('drafts.blocked');

    // C: awaiting approval, the lead has no address -> info, linked to it.
    const c = await draftFor(t, p, { status: 'needs_edit', contactEmail: '  ' });
    let f = await finding(t, 'drafts.blocked');
    expect(f).toMatchObject({
      severity: 'info',
      title: '1 draft has no contact email',
      href: `/drafts/${c.draftId}`,
    });
    expect(f.facts).toMatchObject({ approvedNotQueued: 0, approvedNoContactEmail: 0, awaitingNoContactEmail: 1 });

    // A: approved minutes ago is in the grace; approved 3 days ago is stuck.
    await draftFor(t, p, { status: 'approved', approvedAt: ago(5 * 60 * 1000) });
    expect((await finding(t, 'drafts.blocked')).facts.approvedNotQueued).toBe(0);
    await draftFor(t, p, { status: 'approved', approvedAt: ago(3 * DAY) });
    // B: approved, no lead at all (production's one draft).
    await draftFor(t, p, { status: 'approved', lead: false });
    f = await finding(t, 'drafts.blocked');
    expect(f).toMatchObject({ severity: 'warning', title: '2 approved drafts are stuck', href: '/drafts' });
    expect(f.facts).toMatchObject({ approvedNotQueued: 1, approvedNoContactEmail: 1, awaitingNoContactEmail: 1 });
    expect(f.detail).toContain('never queued');
    expect(f.detail).toContain('no contact email');
    expect(f.notify.policy.kind).toBe('never');
  });

  it('ops.incidents: open workspace incidents, one finding per kind; covered kinds left out', async () => {
    const t = await tenant();
    await raiseOpsEvent({
      scope: 'workspace',
      workspaceId: t.workspaceId,
      kind: 'send.interrupted',
      severity: 'error',
      source: 'ops.reaper.tick',
      dedupeKey: 'outreach_queue:1',
      title: 'A queued email was interrupted mid-send; delivery unknown',
    });
    await raiseOpsEvent({
      scope: 'workspace',
      workspaceId: t.workspaceId,
      kind: 'run.failed',
      severity: 'warning',
      source: 'connector.run',
      dedupeKey: 'connector:1:recipe:1',
      title: 'A discovery run failed',
    });
    const c = await codes(t);
    expect(c).toContain('ops.send.interrupted');
    expect(c).not.toContain('ops.run.failed'); // runs.failed reports it
    const f = await finding(t, 'ops.send.interrupted');
    expect(f).toMatchObject({ severity: 'warning', source: 'ops_event', href: '/mailbox/queue' });
  });

  it('jobs.stale: a tick that missed its slot; nothing while no heartbeat exists', async () => {
    const t = await tenant();
    expect(await codes(t)).not.toContain('jobs.stale');
    await db.insert(jobHeartbeats).values({
      name: 'outreach.drain.tick',
      kind: 'tick',
      intervalMs: 30_000,
      queueProvider: 'memory',
      registeredAt: ago(3 * 60 * 60 * 1000),
      lastStartedAt: ago(2 * 60 * 60 * 1000),
    });
    const f = await finding(t, 'jobs.stale');
    expect(f.detail).toContain('Send queue');
    expect(f.notify.policy.kind).toBe('never');
  });

  it('every fix link is a page of the navigation registry', async () => {
    const t = await tenant('links', { plan: 'free', live: false });
    await mailbox(t, 'failing', { lastError: 'SMTP: connect ECONNREFUSED 192.0.2.1:587' });
    await mailbox(t, 'paused');
    await db.update(workspaces).set({ tokenBalance: 0n }).where(eq(workspaces.id, t.workspaceId));
    await pauseAutomation(t.ctx, { source: 'api' });
    const report = await diagnose(t);
    expect(report.findings.length).toBeGreaterThan(5);
    for (const f of report.findings) {
      if (!f.href) continue;
      const { pathname, query } = splitHref(f.href);
      expect(resolveNavLocation(pathname, query), `${f.code} → ${f.href}`).not.toBeNull();
    }
  });
});

// ---- the engine --------------------------------------------------------------------------

describe('the engine', () => {
  it('one rule throwing still returns the other findings plus diagnostics.partial', async () => {
    const t = await tenant();
    const boom = defineRule({
      id: 'test.boom',
      owner: 'diagnostics',
      summary: 'throws',
      async evaluate() {
        throw new Error('rule exploded');
      },
    });
    const mislabelled = defineRule({
      id: 'test.mislabelled',
      owner: 'diagnostics',
      summary: 'returns a code that is not its own',
      async evaluate() {
        return [{ code: 'other.code', severity: 'critical', title: 'x', detail: 'y', href: null }];
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const report = await getWorkspaceDiagnostics(t.ctx, {
      now: NOW(),
      rules: [...DIAGNOSTIC_RULES, boom, mislabelled],
    });
    expect(report.partial).toBe(true);
    expect(report.failedRules).toEqual(['test.boom', 'test.mislabelled']);
    const c = report.findings.map((f) => f.code);
    expect(c).toContain('products.none');
    expect(c).toContain('mailbox.none');
    expect(c).toContain(PARTIAL_CODE);
    const partial = report.findings.find((f) => f.code === PARTIAL_CODE)!;
    expect(partial.detail).toContain('test.boom');
    // A failing check costs no score of its own.
    expect(report.score).toBe(scoreFindings(report.findings.filter((f) => f.code !== PARTIAL_CODE)));
  });

  it('sorts most severe first and scores each rule once at its worst severity', async () => {
    const t = await tenant();
    await mailbox(t, 'failing', { lastError: 'IMAP: x' });
    await mailbox(t, 'failing', { lastError: 'IMAP: y' });
    const report = await diagnose(t);
    const ranks = report.findings.map((f) => (f.advisory ? 3 : { critical: 0, warning: 1, info: 2 }[f.severity]));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    // Two failing mailboxes (critical) + mailbox.none + products.none.
    expect(report.findings.filter((f) => f.code === 'mailbox.failing')).toHaveLength(2);
    expect(report.score).toBe(100 - 25 - 10 - 10);
    expect(blendConversationReview(55, [])).toBe(55);
    expect(blendConversationReview(55, [80, 100])).toBe(Math.round(55 * 0.6 + 90 * 0.4));
  });

  it('memoises 30 s per workspace; fresh and invalidate re-read', async () => {
    const t = await tenant();
    expect(DIAGNOSTICS_MEMO_TTL_MS).toBe(30_000);
    const first = await getWorkspaceDiagnostics(t.ctx);
    await product(t);
    expect(await getWorkspaceDiagnostics(t.ctx)).toBe(first); // memo
    const fresh = await getWorkspaceDiagnostics(t.ctx, { fresh: true });
    expect(fresh.findings.map((f) => f.code)).not.toContain('products.none');
    await mailbox(t, 'active');
    invalidateDiagnostics(t.workspaceId);
    expect((await getWorkspaceDiagnostics(t.ctx)).findings.map((f) => f.code)).not.toContain(
      'mailbox.none',
    );
  });
});

// ---- calibration fixtures ------------------------------------------------------------

/**
 * Production-shaped (prod_report 2026-10-01, workspaces 1+2 folded into
 * one): a trial workspace, not live, two products; two failing mailboxes —
 * one with 13 consecutive failures and imap_next_sync_after NULL — and one
 * active; 310 open review items (stale since July) of which 1 is relevant,
 * each judged by both products (620 verdicts, 28 by the rules fallback);
 * 141 automatic suppressions in 30 days against 110 distinct inbound
 * senders; auto-approve armed while autopilot is off; Gemini chosen for web
 * search with no key, its crawl plans all disabled; one stale draft whose
 * pair has no lead (so no contact email).
 *
 * Expected findings and DOCUMENTED SCORE 20:
 *   critical  mailbox.failing ×2 (one rule: −25), suppression.spike (−25)
 *   warning   search.mock (−10), review.noise (−10), autopilot.state (−10)
 *   info      review.backlog, drafts.stale, golive.not_live,
 *             qualification.rules_fallback (none relevant), drafts.blocked
 *             (awaiting, no email) (0)
 *   advisory  plan.limits, learning.unfed (0)
 * Notifications from one sweep: 3 — mailbox.failing (both folded into
 * one), suppression.spike, review.noise. search.mock stays quiet: nothing
 * would run it (no enabled schedule, no mock usage).
 */
async function productionShaped(): Promise<Tenant> {
  const t = await tenant('prod', { live: false });
  const p1 = await product(t, 'Vetrofluid');
  const p2 = await product(t, 'Concrete repair');
  // Every production workspace is on the trial (they predate plan limits,
  // which only gate NEW resources: two products stay).
  await db
    .update(workspaces)
    .set({ plan: 'trial', subscriptionStatus: 'trial' })
    .where(eq(workspaces.id, t.workspaceId));
  await mailbox(t, 'failing', {
    name: 'office',
    lastError: 'SMTP: connect ECONNREFUSED 51.89.234.14:587',
    lastErrorAt: new Date('2026-05-08T09:00:00Z'),
    failingSince: new Date('2026-05-08T09:00:00Z'),
    imapNextSyncAfter: new Date(Date.now() + 6 * 60 * 60 * 1000),
  });
  await mailbox(t, 'failing', {
    name: 'sales',
    lastError: 'IMAP: Command failed',
    imapConsecutiveFailures: 13,
    imapNextSyncAfter: null,
  });
  const active = await mailbox(t, 'active', { name: 'inbox' });
  await reviewQueue(t, p1, 310, 1, { updatedAt: new Date('2026-07-08T12:00:00Z') });
  await autoSuppressions(t, 141);
  await inboundFrom(t, active, 110);
  await db.insert(autopilotSettings).values({
    workspaceId: t.workspaceId,
    autopilotEnabled: false,
    enableAutoApproveProjects: true,
    autoApproveThreshold: 70,
  });
  await db.insert(workspaceProviderSettings).values({
    workspaceId: t.workspaceId,
    researchProvider: 'gemini',
  });
  const c = await connector(t);
  const r = await recipe(t, c, { country: 'GB', queries: ['waterproofing contractor'] });
  await db.insert(crawlPlans).values({
    workspaceId: t.workspaceId,
    name: 'weekly',
    enabled: false,
    recipeIds: [r],
  } as typeof crawlPlans.$inferInsert);
  await draftFor(t, p1, {
    status: 'draft',
    updatedAt: new Date('2026-07-08T12:00:00Z'),
    lead: false,
  });
  // Both products judged every record, the draft's included.
  await qualifyAll(t, p1);
  await qualifyAll(t, p2, 28);
  return t;
}

describe('calibration: the production-shaped fixture', () => {
  it('yields the expected findings and the documented score 20', async () => {
    const t = await productionShaped();
    const report = await diagnose(t);
    const by = (code: string) => report.findings.filter((f) => f.code === code);

    const failing = by('mailbox.failing');
    expect(failing).toHaveLength(2);
    expect(failing.filter((f) => f.facts.backoffMissing === true)).toHaveLength(1);
    expect(failing.find((f) => f.facts.backoffMissing)!.facts.consecutiveFailures).toBe(13);
    for (const f of failing) expect(f.detail).toContain('no longer received');

    expect(by('review.noise')[0]!.facts).toMatchObject({ open: 310, relevant: 1 });
    expect(by('suppression.spike')[0]!.facts).toMatchObject({
      autoSuppressed: 141,
      distinctInboundSenders: 110,
    });
    expect(by('autopilot.state')[0]!.title).toMatch(/auto-approve armed while autopilot is off/i);
    expect(by('search.mock')[0]!.detail).toContain('Gemini is chosen for web search');

    const problems = report.findings.filter(isProblem).map((f) => `${f.severity}:${f.code}`);
    expect(new Set(problems)).toEqual(
      new Set([
        'critical:mailbox.failing',
        'critical:suppression.spike',
        'warning:search.mock',
        'warning:review.noise',
        'warning:autopilot.state',
      ]),
    );
    const context = report.findings.filter((f) => !isProblem(f)).map((f) => f.code);
    expect(new Set(context)).toEqual(
      new Set([
        'review.backlog',
        'drafts.stale',
        'golive.not_live',
        'plan.limits',
        'learning.unfed',
        'qualification.rules_fallback',
        'drafts.blocked',
      ]),
    );
    expect(by('qualification.rules_fallback')[0]!.facts).toMatchObject({
      fallbackVerdicts: 28,
      relevantByFallback: 0,
    });
    expect(by('drafts.blocked')[0]!.facts).toMatchObject({ awaitingNoContactEmail: 1 });
    expect(report.score).toBe(20);
    // Both products judged every record: no qualification gap, even after
    // the grace hour.
    const later = await diagnose(t, new Date(Date.now() + 2 * 60 * 60 * 1000));
    expect(later.findings.map((f) => f.code)).not.toContain('records.unqualified');
  });

  it('the sweep sends at most 3 notifications, and none again within 24 hours', async () => {
    const t = await productionShaped();
    const first = await runDiagnosticsSweep({ workspaceIds: [t.workspaceId] });
    expect(first).toMatchObject({ workspaces: 1, notified: 3, failed: 0, partial: 0 });
    const rows = await sweepNotifications(t);
    expect(rows).toHaveLength(3);
    expect(rows.map((n) => n.kind).sort()).toEqual(['health.critical', 'health.finding', 'mailbox.failing']);
    const folded = rows.find((n) => n.kind === 'mailbox.failing')!;
    expect(folded.title).toMatch(/is failing \(and 1 more\)$/);
    expect(folded.href).toBe('/health');
    // Every recipient copy is targeted at an owner / admin.
    expect(rows.every((n) => n.userId === t.ownerId)).toBe(true);

    const second = await runDiagnosticsSweep({
      workspaceIds: [t.workspaceId],
      now: new Date(Date.now() + 60 * 60 * 1000),
    });
    expect(second.notified).toBe(0);
    expect(await sweepNotifications(t)).toHaveLength(3);
  });
});

/** A healthy trial workspace: products, an active mailbox, web-search
 *  recipes with a country on a real (platform) key; on a trial, so
 *  plan.limits fires, and nothing has taught the qualifier yet, so
 *  learning.unfed fires. */
async function healthyTrial(): Promise<Tenant> {
  const t = await tenant('healthy', { plan: 'free', live: true });
  await product(t);
  await mailbox(t, 'active');
  const c = await connector(t);
  await recipe(t, c, { country: 'GB', queries: ['architects'] });
  await recipe(t, c, { country: 'PL', queries: ['architekci'] });
  const root = await seedUser({ email: 'root@test.local', role: 'super_admin' });
  await setPlatformSecret(platformCtx(root), 'gemini.apiKey', 'test-gemini-key');
  return t;
}

describe('calibration: a healthy trial workspace', () => {
  it('scores at least 90 and gets 0 notifications although plan.limits and learning.unfed fire', async () => {
    const t = await healthyTrial();
    const report = await diagnose(t);
    const c = report.findings.map((f) => f.code);
    expect(c).toContain('plan.limits');
    expect(c).toContain('learning.unfed');
    expect(report.findings.filter(isProblem)).toEqual([]);
    expect(report.score).toBeGreaterThanOrEqual(90);
    const sweep = await runDiagnosticsSweep({ workspaceIds: [t.workspaceId] });
    expect(sweep.notified).toBe(0);
    expect(await sweepNotifications(t)).toHaveLength(0);
  });
});

// ---- the notify ledger -----------------------------------------------------------

describe('the notify sweep', () => {
  function alarmRule(state: { present: boolean; throws: boolean }) {
    return defineRule({
      id: 'test.alarm',
      owner: 'diagnostics',
      summary: 'a switchable critical finding',
      async evaluate() {
        if (state.throws) throw new Error('unknown this time');
        return state.present
          ? [
              {
                code: 'test.alarm',
                severity: 'critical',
                title: 'Alarm',
                detail: 'Something broke.',
                href: '/health',
                notify: { policy: NOTIFY_ON_APPEAR },
              },
            ]
          : [];
      },
    });
  }

  async function pass(t: Tenant, rule: ReturnType<typeof alarmRule>, at: Date) {
    return notifyDiagnostics(await getWorkspaceDiagnostics(t.ctx, { now: at, rules: [rule] }));
  }

  it('on_appear: once per episode; a new episode notifies again after the 24 h rule cap', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = await tenant();
    const state = { present: true, throws: false };
    const rule = alarmRule(state);
    const t0 = NOW();
    const h = (n: number) => new Date(t0.getTime() + n * 60 * 60 * 1000);

    expect((await pass(t, rule, t0)).sent).toHaveLength(1);
    expect((await pass(t, rule, h(1))).sent).toHaveLength(0); // same episode

    // A rule that throws is unknown, not gone: the episode stays open.
    state.throws = true;
    expect((await pass(t, rule, h(2))).cleared).toEqual([]);
    state.throws = false;
    expect((await pass(t, rule, h(3))).sent).toHaveLength(0);

    // Gone: the episode closes and its unread alert is resolved.
    state.present = false;
    expect((await pass(t, rule, h(4))).cleared).toEqual(['test.alarm']);
    const [n] = await sweepNotifications(t);
    expect(n!.readAt).not.toBeNull();

    // Back within 24 h of the last notification: capped, not lost…
    state.present = true;
    expect((await pass(t, rule, h(5))).capped).toEqual(['test.alarm']);
    // …and announced once the cap allows.
    expect((await pass(t, rule, h(25))).sent).toHaveLength(1);
    const [ledger] = await db
      .select()
      .from(diagnosticNotices)
      .where(eq(diagnosticNotices.workspaceId, t.workspaceId));
    expect(ledger).toMatchObject({ noticeKey: 'test.alarm', ruleCode: 'test.alarm', notifyCount: 2 });
  });

  it('max_once_per_days: again only after n days while the finding stays', async () => {
    const t = await tenant();
    const rule = defineRule({
      id: 'test.nudge',
      owner: 'diagnostics',
      summary: 'a standing problem',
      async evaluate() {
        return [
          {
            code: 'test.nudge',
            severity: 'warning',
            title: 'Standing problem',
            detail: 'Still there.',
            href: '/health',
            notify: { policy: notifyEveryDays(2) },
          },
        ];
      },
    });
    const t0 = NOW();
    const at = (h: number) => new Date(t0.getTime() + h * 60 * 60 * 1000);
    const run = async (h: number) =>
      notifyDiagnostics(await getWorkspaceDiagnostics(t.ctx, { now: at(h), rules: [rule] }));
    expect((await run(0)).sent).toHaveLength(1);
    // Due every 2 days, not daily.
    expect(await run(25)).toMatchObject({ sent: [], alreadyOpen: [], capped: [] });
    // Due again, but the first nudge is still unread: no second copy.
    expect(await run(49)).toMatchObject({ sent: [], alreadyOpen: ['test.nudge'] });
    // Once read, the next due pass nudges again.
    await db
      .update(notifications)
      .set({ readAt: at(50) })
      .where(eq(notifications.workspaceId, t.workspaceId));
    expect((await run(98)).sent).toHaveLength(1);
    expect((await sweepNotifications(t)).map((n) => n.kind)).toEqual(['health.finding', 'health.finding']);
  });

  it('a folded notification is resolved once every finding of its rule is gone', async () => {
    const t = await tenant();
    await mailbox(t, 'active');
    const a = await mailbox(t, 'failing', { lastError: 'IMAP: x' });
    const b = await mailbox(t, 'failing', { lastError: 'IMAP: y' });
    const first = await notifyDiagnostics(await diagnose(t));
    expect(first.sent).toEqual([
      expect.objectContaining({ rule: 'mailbox.failing', dedupeKey: 'mailbox.failing', findings: 2 }),
    ]);
    await db.update(mailboxes).set({ status: 'active' }).where(inArray(mailboxes.id, [a, b]));
    const second = await notifyDiagnostics(await diagnose(t));
    expect(new Set(second.cleared)).toEqual(new Set([`mailbox.failing:${a}`, `mailbox.failing:${b}`]));
    const rows = await sweepNotifications(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.readAt).not.toBeNull();
  });

  it('an alert the source already raised and nobody read is not repeated', async () => {
    const t = await tenant();
    await mailbox(t, 'active');
    const id = await mailbox(t, 'failing', { lastError: 'IMAP: Socket timed out' });
    // The IMAP tick's own alert (markMailboxFailing), still unread.
    await db.insert(notifications).values({
      workspaceId: t.workspaceId,
      userId: t.ownerId,
      kind: 'mailbox.failing',
      title: 'Mailbox is failing',
      dedupeKey: `mailbox.failing:${id}:user:${t.ownerId}`,
    });
    const r = await notifyDiagnostics(await diagnose(t));
    expect(r.sent).toEqual([]);
    expect(r.alreadyOpen).toEqual([`mailbox.failing:${id}`]);
    expect(await sweepNotifications(t)).toHaveLength(1);
  });

  it('the 6-hourly tick sweeps every active workspace, health check on or off', async () => {
    const t = await productionShaped();
    await updateHealthCheckSettings(t.ctx, { enabled: false, intervalDays: 7 });
    const ai = new CountingAi();
    _setAIProviderForTests(ai);
    const r = await runHealthCheckTick();
    expect(r.sweep).toMatchObject({ workspaces: 1, notified: 3 });
    expect(r.checked).toBe(0);
    expect(ai.calls).toBe(0);
  });
});

// ---- the weekly check (I069) -------------------------------------------------------------

async function conversation(t: Tenant): Promise<void> {
  const box = await mailbox(t, 'active');
  const [thread] = await db
    .insert(mailThreads)
    .values({
      workspaceId: t.workspaceId,
      mailboxId: box,
      subject: 'Inquiry',
      externalThreadKey: `subj:${t.workspaceId}`,
      participants: ['anna@x.test'],
      messageCount: 3,
      lastMessageAt: NOW(),
    })
    .returning();
  const mk = (direction: 'inbound' | 'outbound', i: number) => ({
    workspaceId: t.workspaceId,
    mailboxId: box,
    threadId: thread!.id,
    direction,
    status: direction === 'inbound' ? ('received' as const) : ('sent' as const),
    messageId: `<c${t.workspaceId}-${i}@x>`,
    fromAddress: direction === 'inbound' ? 'anna@x.test' : 'sales@test.local',
    toAddresses: ['x@test.local'],
    subject: 'Inquiry',
    bodyText: `message ${i}`,
  });
  await db.insert(mailMessages).values([mk('outbound', 1), mk('inbound', 2), mk('outbound', 3)]);
}

describe('the scheduled health check (I069)', () => {
  it('admins switch it and set the interval; audited; members cannot; bad input refused', async () => {
    const t = await tenant();
    expect(await getHealthCheckSettings(t.ctx)).toMatchObject({ enabled: true, intervalDays: 7 });
    const after = await updateHealthCheckSettings(t.ctx, { enabled: false, intervalDays: 14 });
    expect(after).toMatchObject({ enabled: false, intervalDays: 14, nextDueAt: null });
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, t.workspaceId), eq(auditLog.kind, 'health_check.settings_update')));
    expect(audit!.payload).toEqual({
      before: { enabled: true, intervalDays: 7 },
      after: { enabled: false, intervalDays: 14 },
    });
    const member = makeWorkspaceContext({ workspaceId: t.workspaceId, userId: t.ownerId, role: 'member' });
    await expect(updateHealthCheckSettings(member, { enabled: true, intervalDays: 7 })).rejects.toThrow(
      HealthCheckError,
    );
    await expect(updateHealthCheckSettings(t.ctx, { enabled: true, intervalDays: 5 })).rejects.toThrow(
      /interval/,
    );
  });

  it('with the AI review toggled off, the weekly tick makes no provider call', async () => {
    const t = await tenant();
    await conversation(t);
    const ai = new CountingAi();
    _setAIProviderForTests(ai);
    await updateHealthCheckSettings(t.ctx, { enabled: false, intervalDays: 7 });
    const off = await runHealthCheckTick();
    expect(off.checked).toBe(0);
    expect(ai.calls).toBe(0);
    // Counterfactual: switched on, the same tick reviews the conversation.
    await updateHealthCheckSettings(t.ctx, { enabled: true, intervalDays: 7 });
    const on = await runHealthCheckTick();
    expect(on.checked).toBe(1);
    expect(ai.calls).toBe(1);
  });

  it('a thrown check restores healthCheckLastAt, retries on the next tick and raises an incident', async () => {
    const t = await tenant();
    const prior = new Date(Date.now() - 8 * DAY);
    await db.update(workspaces).set({ healthCheckLastAt: prior }).where(eq(workspaces.id, t.workspaceId));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(engine, 'getWorkspaceDiagnostics').mockRejectedValueOnce(new Error('database went away'));
    const incidents = createTickIncidents({
      source: 'health.check.tick',
      label: 'Workspace health check',
      open: null,
    });
    const r = await processDueHealthChecks({
      onWorkspaceFailed: (id, err) => incidents.failed({ workspaceId: id }, err),
    });
    expect(r).toMatchObject({ checked: 0, failed: 1, retrying: 1 });
    const [ws] = await db
      .select({ lastAt: workspaces.healthCheckLastAt })
      .from(workspaces)
      .where(eq(workspaces.id, t.workspaceId));
    expect(ws!.lastAt!.getTime()).toBe(prior.getTime());
    // The incident is a finding until a check succeeds.
    const f = await finding(t, 'ops.tick.workspace_failed');
    expect(f.href).toBe('/health');
    expect(f.detail).toContain('database went away');
    // Due again at once: the next tick retries and succeeds.
    const retry = await processDueHealthChecks();
    expect(retry).toMatchObject({ checked: 1, failed: 0 });
  });
});

// ---- one source (PC-33, MOB-02) ------------------------------------------------------------

describe('one diagnostic source: /health, Today and the assistant', () => {
  it('list the same open problems; a failing mailbox is in all three', async () => {
    const t = await tenant();
    await product(t);
    await mailbox(t, 'active');
    const failing = await mailbox(t, 'failing', { name: 'Sales', lastError: 'IMAP: Socket timed out' });
    await pauseAutomation(t.ctx, { source: 'api' });

    const engineProblems = (await diagnose(t)).findings.filter(isProblem).map((f) => f.code);
    expect(engineProblems).toEqual(['mailbox.failing', 'outreach.paused']);

    // The weekly report.
    _setAIProviderForTests(new CountingAi());
    const report = await runWorkspaceHealthCheck(t.ctx, { manual: true });
    const reportProblems = readStoredFindings(report.findings).filter(isProblem).map((f) => f.code);
    expect(reportProblems).toEqual(engineProblems);

    // Today.
    const today = await renderToHtml(await TodayAttention({ ctx: t.ctx }));
    const todayCodes = [...today.matchAll(/data-code="([^"]+)"/g)].map((m) => m[1]);
    expect(todayCodes).toEqual(engineProblems);
    expect(today).toContain(`/mailbox/${failing}`);

    // The assistant: every finding code is in its prompt.
    const ai = new CountingAi();
    _setAIProviderForTests(ai);
    const answer = await askAssistant(t.ctx, 'why are replies missing?');
    for (const code of engineProblems) expect(ai.lastInput!.prompt).toContain(`] ${code}: `);
    expect(answer.findings).toEqual(expect.arrayContaining(engineProblems));
  });

  it('Today shows nothing when every check passes, and a warning when the checks fail', async () => {
    const t = await healthyTrial();
    expect(await TodayAttention({ ctx: t.ctx })).toBeNull();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(engine, 'getWorkspaceDiagnostics').mockRejectedValueOnce(new Error('db down'));
    const html = await renderToHtml(await TodayAttention({ ctx: t.ctx }));
    expect(html).toContain('The workspace checks could not run');
  });
});

describe('stale-while-revalidate for the attention summary (MOB-02)', () => {
  it('maxAgeMs serves a settled result past the TTL at once and refreshes it in the background', async () => {
    const t = await tenant();
    await product(t);
    await mailbox(t, 'active');
    const first = await getWorkspaceDiagnostics(t.ctx);
    // A change the next fresh evaluation sees.
    await mailbox(t, 'failing', { name: 'Late', lastError: 'IMAP: Socket timed out' });
    _ageDiagnosticsMemoForTests(t.workspaceId, DIAGNOSTICS_MEMO_TTL_MS + 1000);
    const stale = await getWorkspaceDiagnostics(t.ctx, { maxAgeMs: 5 * 60_000 });
    expect(stale).toBe(first); // served from the memo, no waiting
    expect(stale.findings.map((f) => f.code)).not.toContain('mailbox.failing');
    // The background refresh lands; the next read within the TTL sees it.
    await vi.waitFor(async () => {
      const next = await getWorkspaceDiagnostics(t.ctx);
      expect(next.findings.map((f) => f.code)).toContain('mailbox.failing');
    });
  });

  it('past maxAgeMs (or without it) the caller waits for a fresh evaluation', async () => {
    const t = await tenant();
    const first = await getWorkspaceDiagnostics(t.ctx);
    _ageDiagnosticsMemoForTests(t.workspaceId, 10 * 60_000);
    const again = await getWorkspaceDiagnostics(t.ctx, { maxAgeMs: 5 * 60_000 });
    expect(again).not.toBe(first);
    expect(again.evaluatedAt.getTime()).toBeGreaterThan(first.evaluatedAt.getTime() - 1);
  });

  it('a refresh that started before an invalidation never writes its result back', async () => {
    const t = await tenant();
    await getWorkspaceDiagnostics(t.ctx);
    _ageDiagnosticsMemoForTests(t.workspaceId, DIAGNOSTICS_MEMO_TTL_MS + 1000);
    await getWorkspaceDiagnostics(t.ctx, { maxAgeMs: 5 * 60_000 }); // starts a refresh
    invalidateDiagnostics(t.workspaceId);
    const invalidatedAt = Date.now();
    await new Promise((r) => setTimeout(r, 750)); // the refresh settles
    // Had the refresh written back, this read (within the TTL) would get
    // its evaluation from before the invalidation.
    const next = await getWorkspaceDiagnostics(t.ctx);
    expect(next.evaluatedAt.getTime()).toBeGreaterThanOrEqual(invalidatedAt);
  });
});

describe('the daily cap: one usage for the drain, Today and the finding (I070)', () => {
  it('follow-ups and manual sends that fill the cap show the same used/cap as the drain applies', async () => {
    const t = await tenant();
    const box = await mailbox(t, 'active');
    await updateSendSettings(t.ctx, { dailyEmailLimit: 3 });
    // Sent outside the queue (follow-ups, compose, replies) — 2 of 3.
    await outboundSent(t, box, 2);
    let signals = await getDashboardSignals(t.ctx);
    expect(signals.degraded).toBe(false);
    expect(signals.sendQueue).toMatchObject({ sent24h: 2, dailyCap: 3 });
    expect((await getSendCapUsage(t.ctx)).remaining).toBe(1);
    expect((await drainQueue(t.ctx)).blocked).toBeUndefined();

    await outboundSent(t, box, 1);
    signals = await getDashboardSignals(t.ctx);
    expect(signals.sendQueue).toMatchObject({ sent24h: 3, dailyCap: 3 });
    expect((await drainQueue(t.ctx)).blocked).toBe('daily_limit');
  });
});

describe('the handbook', () => {
  it('[handbook H-61] live checks with fix links; the free 6-hourly check notifies owners and admins at most once a day per kind; the scheduled report switches off and then spends no tokens', async () => {
    const t = await tenant();
    await conversation(t); // an active mailbox and a thread the AI could review
    const failing = await mailbox(t, 'failing', { name: 'Sales', lastError: 'IMAP: Socket timed out' });
    await pauseAutomation(t.ctx, { source: 'api' });
    const report = await diagnose(t);
    const problems = report.findings.filter(isProblem);
    expect(problems.map((f) => f.code)).toEqual(
      expect.arrayContaining(['mailbox.failing', 'outreach.paused', 'products.none']),
    );
    expect(problems.every((f) => f.href !== null)).toBe(true);

    await updateHealthCheckSettings(t.ctx, { enabled: false, intervalDays: 7 });
    const ai = new CountingAi();
    _setAIProviderForTests(ai);
    const tick = await runHealthCheckTick();
    expect(tick.sweep.notified).toBe(1);
    expect(ai.calls).toBe(0);
    const [n] = await sweepNotifications(t);
    expect(n).toMatchObject({ userId: t.ownerId, href: `/mailbox/${failing}` });
    expect((await runHealthCheckTick()).sweep.notified).toBe(0);
  });
});

// ---- guards --------------------------------------------------------------------------------

describe('guards', () => {
  it('no module outside src/lib/diagnostics filters connector recipes by country (I182)', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (entry.isDirectory()) {
          if (rel === 'lib/diagnostics' || rel === 'tests') continue;
          walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          if (/->>\s*'country'/.test(text) || /selectors\s*->>/.test(text)) offenders.push(rel);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('the engine runs in under 300 ms on a seeded 10k-row workspace', async () => {
    const t = await tenant('big');
    const p = await product(t);
    const box = await mailbox(t, 'active');
    // 3 × 3000 review items, records and qualifications + 1000 inbound.
    for (let i = 0; i < 3; i += 1) await reviewQueue(t, p, 1000, 50, { updatedAt: ago(10 * DAY) });
    await inboundFrom(t, box, 1000);
    await autoSuppressions(t, 5);
    await getWorkspaceDiagnostics(t.ctx, { fresh: true }); // warm-up
    const runs: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const started = performance.now();
      await getWorkspaceDiagnostics(t.ctx, { fresh: true });
      runs.push(performance.now() - started);
    }
    runs.sort((a, b) => a - b);
    expect(runs[1]!).toBeLessThan(300);
    // Seeding 10k rows takes longer than the default 5 s on a busy machine;
    // only the evaluation itself is timed.
  }, 60_000);
});
