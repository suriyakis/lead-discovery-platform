// KL-02: the decision record — transactional outbox, operator verdict as
// state, supersession, autopilot tagging (I032, I034, I018, I036, I030).
// One describe block per acceptance criterion of the deliverable, plus the
// behaviour the criteria rest on (defaults, snapshot, processor, hooks).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { _setAIProviderForTests, type IAIProvider } from '@/lib/ai';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import { sourceRecords } from '@/lib/db/schema/connectors';
import { contactAssociations, contacts } from '@/lib/db/schema/contacts';
import {
  learningDecisions,
  learningEvents,
  learningLessons,
  lessonScopes,
} from '@/lib/db/schema/learning';
import { mailMessages, mailThreads, mailboxes } from '@/lib/db/schema/mailing';
import { outreachDrafts } from '@/lib/db/schema/outreach';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { qualifications } from '@/lib/db/schema/qualifications';
import { reviewComments, reviewItems } from '@/lib/db/schema/review';
import { settleDetached } from '@/lib/detached';
import { InMemoryJobQueue, _setJobQueueForTests, getJobQueue } from '@/lib/jobs';
import { registerJobHandlers } from '@/lib/jobs/bootstrap';
import {
  runOnce,
  updateAutopilotSettings,
  upsertProductAutopilotSettings,
} from '@/lib/services/autopilot';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import { registerDecisionHook, type ProductsDecidedEvent } from '@/lib/services/decision-hooks';
import { createLesson } from '@/lib/services/learning';
import { DecisionContextSchema } from '@/lib/services/learning-decisions';
import { processDecision } from '@/lib/services/learning-processor';
import { synthesizeWorkspaceLearning } from '@/lib/services/learning-synthesis';
import { createMailbox } from '@/lib/services/mailbox';
import { generateOutreachDraft } from '@/lib/services/outreach';
import { handleClassifiedReply } from '@/lib/services/outreach-reply-handler';
import type { ReplyClassification } from '@/lib/services/reply-classifier';
import { ensureQualifiedLead } from '@/lib/services/pipeline';
import { createProductProfile } from '@/lib/services/product-profile';
import { classifySourceRecord } from '@/lib/services/qualification';
import {
  approveReviewItem,
  archiveReviewItem,
  bulkArchiveReviewItems,
  bulkDeleteReviewItems,
  commentOnReviewItem,
  flagForReview,
  ignoreReviewItem,
  rejectReviewItem,
  seedReviewItem,
} from '@/lib/services/review';
import { getLearnFromReplies, updateLearnFromReplies } from '@/lib/services/workspace';
import LeadsPage from '@/app/leads/page';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { renderToHtml } from './helpers/next-render';

const session = vi.hoisted(() => ({
  current: null as null | { user: { id: string; role: 'member'; accountStatus: 'active' } },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => children,
}));

// ---- fixtures -------------------------------------------------------------

interface Setup {
  ws: bigint;
  owner: string;
  admin: string;
  member: string;
}

let seq = 0;

async function setup(): Promise<Setup> {
  seq += 1;
  const owner = await seedUser({ email: `kl02-owner-${seq}@test.local` });
  const admin = await seedUser({ email: `kl02-admin-${seq}@test.local` });
  const member = await seedUser({ email: `kl02-member-${seq}@test.local` });
  const ws = await seedWorkspace({
    name: `KL02 ${seq}`,
    ownerUserId: owner,
    extraMembers: [
      { userId: admin, role: 'admin' },
      { userId: member, role: 'member' },
    ],
  });
  return { ws, owner, admin, member };
}

const ownerCtx = (s: Setup): WorkspaceContext =>
  makeWorkspaceContext({ workspaceId: s.ws, userId: s.owner, role: 'owner' });
const adminCtx = (s: Setup): WorkspaceContext =>
  makeWorkspaceContext({ workspaceId: s.ws, userId: s.admin, role: 'admin' });
const memberCtx = (s: Setup): WorkspaceContext =>
  makeWorkspaceContext({ workspaceId: s.ws, userId: s.member, role: 'member' });

async function product(s: Setup, name: string) {
  return createProductProfile(ownerCtx(s), { name, relevanceThreshold: 50 });
}

/** A discovered record (Vertex-redirect URL, real domain) + its review item. */
async function record(
  s: Setup,
  opts: { domain?: string; snippet?: string | null; title?: string } = {},
) {
  seq += 1;
  const [sr] = await db
    .insert(sourceRecords)
    .values({
      workspaceId: s.ws,
      sourceSystem: 'mock',
      sourceId: `kl02-${seq}`,
      rawData: {},
      normalizedData: {
        title: opts.title ?? `Company ${seq}`,
        domain: opts.domain ?? `www.company-${seq}.example.com`,
        url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC',
        ...(opts.snippet === null
          ? {}
          : { snippet: opts.snippet ?? 'Roofing contractor, 40 vans' }),
      },
      sourceUrl: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC',
    })
    .returning();
  const item = await seedReviewItem(s.ws, sr!.id);
  return { sourceRecordId: sr!.id, itemId: item.id };
}

async function qualify(
  s: Setup,
  sourceRecordId: bigint,
  productProfileId: bigint,
  opts: {
    relevant?: boolean;
    score?: number;
    method?: string;
    matchedLessonIds?: bigint[];
    geoStatus?: string;
    targetCountry?: string;
  } = {},
) {
  const [q] = await db
    .insert(qualifications)
    .values({
      workspaceId: s.ws,
      sourceRecordId,
      productProfileId,
      isRelevant: opts.relevant ?? true,
      relevanceScore: opts.score ?? 80,
      confidence: 70,
      method: opts.method ?? 'ai',
      qualificationReason: 'Fits the ICP',
      evidence: {
        contributions: [],
        matchedLessonIds: (opts.matchedLessonIds ?? []).map((id) => id.toString()),
      },
      geoStatus: opts.geoStatus ?? 'no_gate',
      targetCountry: opts.targetCountry ?? null,
    })
    .returning();
  return q!;
}

async function eventsOf(s: Setup) {
  return db
    .select()
    .from(learningEvents)
    .where(eq(learningEvents.workspaceId, s.ws))
    .orderBy(asc(learningEvents.id));
}

async function qualOf(s: Setup, sourceRecordId: bigint, productProfileId: bigint) {
  const [q] = await db
    .select()
    .from(qualifications)
    .where(
      and(
        eq(qualifications.workspaceId, s.ws),
        eq(qualifications.sourceRecordId, sourceRecordId),
        eq(qualifications.productProfileId, productProfileId),
      ),
    );
  return q!;
}

async function itemOf(id: bigint) {
  const [row] = await db.select().from(reviewItems).where(eq(reviewItems.id, id));
  return row!;
}

async function auditKinds(s: Setup, kind: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, s.ws), eq(auditLog.kind, kind)));
}

async function drainLearning(): Promise<void> {
  await getJobQueue().drain?.();
}

/** An AI provider whose every JSON answer is `reply`; counts the calls. */
function stubAi(reply: () => unknown): IAIProvider & { calls: number } {
  const stub = {
    id: 'stub',
    model: 'stub-1',
    calls: 0,
    async generateText() {
      return { text: '', model: 'stub-1', usage: { inputTokens: 0, outputTokens: 0 } };
    },
    async generateJson<T>(_input: unknown, schema: { parse: (v: unknown) => T }): Promise<T> {
      stub.calls += 1;
      return schema.parse(reply());
    },
    estimateCost() {
      return 0;
    },
    async healthCheck() {
      return { ok: true };
    },
  };
  return stub as IAIProvider & { calls: number };
}

beforeAll(() => {
  registerJobHandlers();
});

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  _setAIProviderForTests(null);
  session.current = null;
});

afterAll(async () => {
  await settleDetached();
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- acceptance 1: one transaction ----------------------------------------------

describe('a review decision is one transaction (acceptance 1)', () => {
  it('approve with A=fit and B=not_fit writes the state, both operator verdicts and 2 events under one decision_id', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const b = await product(s, 'Beta');
    const r = await record(s);
    await qualify(s, r.sourceRecordId, a.id, { score: 85 });
    await qualify(s, r.sourceRecordId, b.id, { score: 70 });

    const item = await approveReviewItem(memberCtx(s), r.itemId, 'Right buyer role', {
      productVerdicts: [
        { productProfileId: a.id, verdict: 'fit' },
        { productProfileId: b.id, verdict: 'not_fit' },
      ],
    });
    expect(item.state).toBe('approved');
    expect(item.approvedByUserId).toBe(s.member);

    const events = await eventsOf(s);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.decisionId)).size).toBe(1);
    const [decision] = await db
      .select()
      .from(learningDecisions)
      .where(eq(learningDecisions.workspaceId, s.ws));
    expect(decision).toMatchObject({
      id: events[0]!.decisionId,
      kind: 'review.approve',
      origin: 'operator',
      subjectType: 'review_item',
      subjectId: r.itemId.toString(),
      userId: s.member,
    });
    const ea = events.find((e) => e.productProfileId === a.id)!;
    const eb = events.find((e) => e.productProfileId === b.id)!;
    expect(ea).toMatchObject({
      verdict: 'fit',
      polarity: 1,
      weight: '1.00',
      explicit: true,
      origin: 'operator',
      actionType: 'qualification_positive',
      originalComment: 'Right buyer role',
      entityType: 'review_item',
      entityId: r.itemId.toString(),
      userId: s.member,
    });
    expect(eb).toMatchObject({ verdict: 'not_fit', polarity: -1, actionType: 'false_positive' });
    expect(['pending', 'processing', 'done', 'no_rule']).toContain(ea.processingStatus);

    const qa = await qualOf(s, r.sourceRecordId, a.id);
    const qb = await qualOf(s, r.sourceRecordId, b.id);
    expect(qa).toMatchObject({
      operatorVerdict: 'fit',
      operatorDecidedBy: s.member,
      operatorEventId: ea.id,
    });
    expect(qa.operatorDecidedAt).toBeInstanceOf(Date);
    expect(qb).toMatchObject({ operatorVerdict: 'not_fit', operatorEventId: eb.id });
    expect(await auditKinds(s, 'review.approved')).toHaveLength(1);
  });

  it('an injected failure after the event insert rolls the state change back too', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const r = await record(s);
    await qualify(s, r.sourceRecordId, a.id);
    // The audit row is written after the events, in the same transaction.
    await db.execute(
      sql.raw(`CREATE OR REPLACE FUNCTION kl02_fail_review_audit() RETURNS trigger AS $$
        BEGIN
          IF NEW.kind = 'review.approved' THEN RAISE EXCEPTION 'injected failure'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`),
    );
    await db.execute(
      sql.raw(`CREATE TRIGGER kl02_fail_review_audit BEFORE INSERT ON audit_log
        FOR EACH ROW EXECUTE FUNCTION kl02_fail_review_audit()`),
    );
    try {
      await expect(approveReviewItem(ownerCtx(s), r.itemId, 'good fit')).rejects.toThrow();
    } finally {
      await db.execute(sql.raw('DROP TRIGGER IF EXISTS kl02_fail_review_audit ON audit_log'));
      await db.execute(sql.raw('DROP FUNCTION IF EXISTS kl02_fail_review_audit()'));
    }
    expect((await itemOf(r.itemId)).state).toBe('new');
    expect(await eventsOf(s)).toHaveLength(0);
    expect(
      await db.select().from(learningDecisions).where(eq(learningDecisions.workspaceId, s.ws)),
    ).toHaveLength(0);
    expect((await qualOf(s, r.sourceRecordId, a.id)).operatorVerdict).toBeNull();
  });
});

// ---- acceptance 2: idempotency ------------------------------------------------------

describe('decision keys make a decision idempotent (acceptance 2)', () => {
  it('a repeated decision_key writes no new events and no audit row', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const r = await record(s);
    await qualify(s, r.sourceRecordId, a.id);
    const key = '6f0d3c4e-1b8a-4f4e-9d2a-0c7b5e1a9f33';

    await approveReviewItem(ownerCtx(s), r.itemId, 'fit', { decisionKey: key });
    const again = await approveReviewItem(ownerCtx(s), r.itemId, 'fit', { decisionKey: key });
    expect(again.state).toBe('approved');
    // The same nonce on another control (a stale form) is a replay too.
    const stale = await rejectReviewItem(ownerCtx(s), r.itemId, 'nope', { decisionKey: key });
    expect(stale.state).toBe('approved');

    expect(await eventsOf(s)).toHaveLength(1);
    expect(await auditKinds(s, 'review.approved')).toHaveLength(1);
    expect(await auditKinds(s, 'review.rejected')).toHaveLength(0);
  });

  it('two concurrent submits with one key record the decision once', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const r = await record(s);
    await qualify(s, r.sourceRecordId, a.id);
    const key = 'double-click-0001';
    await Promise.all([
      approveReviewItem(ownerCtx(s), r.itemId, null, { decisionKey: key }),
      approveReviewItem(ownerCtx(s), r.itemId, null, { decisionKey: key }),
    ]);
    expect(await eventsOf(s)).toHaveLength(1);
    expect(await auditKinds(s, 'review.approved')).toHaveLength(1);
  });

  it('a malformed key is refused', async () => {
    const s = await setup();
    const r = await record(s);
    await expect(
      approveReviewItem(ownerCtx(s), r.itemId, null, { decisionKey: "x'; drop" }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('a same-state transition is a no-op: no audit, no events (I018)', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const r = await record(s);
    await qualify(s, r.sourceRecordId, a.id);
    await approveReviewItem(ownerCtx(s), r.itemId);
    const firstApprovedAt = (await itemOf(r.itemId)).approvedAt;
    await approveReviewItem(adminCtx(s), r.itemId, 'again');
    expect(await eventsOf(s)).toHaveLength(1);
    expect(await auditKinds(s, 'review.approved')).toHaveLength(1);
    const after = await itemOf(r.itemId);
    expect(after.approvedByUserId).toBe(s.owner);
    expect(after.approvedAt).toEqual(firstApprovedAt);

    // Archive is terminal; archiving again is equally silent.
    await archiveReviewItem(adminCtx(s), r.itemId);
    await archiveReviewItem(adminCtx(s), r.itemId);
    expect(await auditKinds(s, 'review.archived')).toHaveLength(1);
  });

  it('an explicit verdict change on an approved item is recorded without touching the approval', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const b = await product(s, 'Beta');
    const r = await record(s);
    await qualify(s, r.sourceRecordId, a.id);
    await qualify(s, r.sourceRecordId, b.id);
    await approveReviewItem(ownerCtx(s), r.itemId);
    await approveReviewItem(ownerCtx(s), r.itemId, null, {
      productVerdicts: [{ productProfileId: b.id, verdict: 'not_fit' }],
    });
    expect((await qualOf(s, r.sourceRecordId, a.id)).operatorVerdict).toBe('fit');
    expect((await qualOf(s, r.sourceRecordId, b.id)).operatorVerdict).toBe('not_fit');
    expect(await auditKinds(s, 'review.verdicts_changed')).toHaveLength(1);
    expect(await auditKinds(s, 'review.approved')).toHaveLength(1);
    // Turning the last Fit into Not a fit is a rejection, not an approve.
    await expect(
      approveReviewItem(ownerCtx(s), r.itemId, null, {
        productVerdicts: [{ productProfileId: a.id, verdict: 'not_fit' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

// ---- acceptance 3: supersession ------------------------------------------------------

describe('a newer decision supersedes the older one (acceptance 3)', () => {
  it('approve then reject voids the approve events (voided_by set)', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const b = await product(s, 'Beta');
    const r = await record(s);
    await qualify(s, r.sourceRecordId, a.id);
    await qualify(s, r.sourceRecordId, b.id);

    await approveReviewItem(ownerCtx(s), r.itemId, 'good');
    await rejectReviewItem(ownerCtx(s), r.itemId, 'changed my mind — consultancy');

    const events = await eventsOf(s);
    expect(events).toHaveLength(4);
    const [approveA, approveB] = events.filter((e) => e.verdict === 'fit');
    const rejects = events.filter((e) => e.verdict === 'not_fit');
    expect(rejects).toHaveLength(2);
    for (const approve of [approveA!, approveB!]) {
      const replacement = rejects.find((e) => e.productProfileId === approve.productProfileId)!;
      expect(approve.voidedAt).toBeInstanceOf(Date);
      expect(approve.voidedByEventId).toBe(replacement.id);
      expect(approve.voidReason).toBe('changed_mind');
      expect(replacement.voidedAt).toBeNull();
      expect(replacement.overridesAutopilot).toBe(false);
    }
    const qa = await qualOf(s, r.sourceRecordId, a.id);
    expect(qa.operatorVerdict).toBe('not_fit');
    expect(qa.operatorEventId).toBe(rejects.find((e) => e.productProfileId === a.id)!.id);
  });

  it('a comment never voids a verdict', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const r = await record(s);
    await qualify(s, r.sourceRecordId, a.id);
    await approveReviewItem(ownerCtx(s), r.itemId);
    await commentOnReviewItem(ownerCtx(s), r.itemId, 'Their fleet is the reason this fits.');
    const events = await eventsOf(s);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.voidedAt === null)).toBe(true);
  });
});

// ---- I032 / I036: which products, and what the event remembers ------------------------

describe('defaults and the record snapshot (I032, I036)', () => {
  it('only AI-relevant products (method ai, at or above threshold) get a default verdict', async () => {
    const s = await setup();
    const relevant = await product(s, 'Relevant');
    const fallback = await product(s, 'Fallback');
    const ruledOut = await product(s, 'RuledOut');
    const below = await product(s, 'Below');
    const r = await record(s, { domain: 'www.Acme-Roofing.co.uk', title: 'Acme Roofing' });
    await qualify(s, r.sourceRecordId, relevant.id, { score: 80 });
    await qualify(s, r.sourceRecordId, fallback.id, { score: 90, method: 'rules_fallback' });
    await qualify(s, r.sourceRecordId, ruledOut.id, { score: 20, relevant: false });
    await qualify(s, r.sourceRecordId, below.id, { score: 40 });

    await approveReviewItem(ownerCtx(s), r.itemId);
    const events = await eventsOf(s);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      productProfileId: relevant.id,
      verdict: 'fit',
      // A default left untouched that agrees with the AI is half weight.
      weight: '0.50',
      explicit: false,
      confidence: 60,
    });
    for (const p of [fallback, ruledOut, below]) {
      expect((await qualOf(s, r.sourceRecordId, p.id)).operatorVerdict).toBeNull();
    }

    // The snapshot honours the DecisionContext contract the processor reads.
    const ctx = DecisionContextSchema.parse(events[0]!.context);
    expect(ctx.v).toBe(1);
    expect(ctx.outcome).toBe('fit_confirmed');
    expect(ctx.subject).toEqual({ type: 'review_item', id: r.itemId.toString() });
    expect(ctx.record).toMatchObject({
      title: 'Acme Roofing',
      domain: 'acme-roofing.co.uk',
      sourceSystem: 'mock',
      evidenceQuality: 'snippet',
    });
    expect(JSON.stringify(ctx)).not.toContain('vertexaisearch');
    const names = ctx.products.map((p) => p.name).sort();
    expect(names).toEqual(['Below', 'Fallback', 'Relevant', 'RuledOut']);
    const belowSnap = ctx.products.find((p) => p.name === 'Below')!;
    expect(belowSnap.ai).toMatchObject({
      relevant: true,
      method: 'ai',
      score: 40,
      threshold: 50,
      belowThreshold: true,
      reason: 'Fits the ICP',
    });
  });

  it('with no relevant product and no explicit choice, one unscoped event with no verdict is recorded', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const r = await record(s, { snippet: null, domain: 'vertexaisearch.cloud.google.com' });
    await qualify(s, r.sourceRecordId, a.id, { relevant: false, score: 10 });
    await rejectReviewItem(ownerCtx(s), r.itemId, 'Not a company');
    const events = await eventsOf(s);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      productProfileId: null,
      verdict: null,
      polarity: -1,
      actionType: 'qualification_negative',
      confidence: 75,
    });
    const ctx = DecisionContextSchema.parse(events[0]!.context);
    expect(ctx.outcome).toBe('unscoped');
    // Never the Vertex redirect host; nothing better known → no domain.
    expect(ctx.record?.domain).toBeNull();
    expect(ctx.record?.evidenceQuality).toBe('domain_only');
    expect((await qualOf(s, r.sourceRecordId, a.id)).operatorVerdict).toBeNull();
  });

  it('an operator Fit on a geo-unverified product confirms the location', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const r = await record(s);
    await qualify(s, r.sourceRecordId, a.id, { geoStatus: 'unverified', targetCountry: 'GB' });
    await approveReviewItem(ownerCtx(s), r.itemId);
    const q = await qualOf(s, r.sourceRecordId, a.id);
    expect(q.geoConfirmedBy).toBe(s.owner);
    expect(q.geoConfirmedAt).toBeInstanceOf(Date);
  });
});

// ---- acceptance 8: archive / ignore / flag ------------------------------------------

describe('archive, ignore and flag (acceptance 8)', () => {
  it('archive and ignore write half-weight not_fit events; flag writes none', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const r1 = await record(s);
    const r2 = await record(s);
    const r3 = await record(s);
    for (const r of [r1, r2, r3]) await qualify(s, r.sourceRecordId, a.id);

    await ignoreReviewItem(ownerCtx(s), r1.itemId);
    await archiveReviewItem(adminCtx(s), r2.itemId);
    await flagForReview(ownerCtx(s), r3.itemId);

    const events = await eventsOf(s);
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e).toMatchObject({
        verdict: 'not_fit',
        polarity: -1,
        weight: '0.50',
        explicit: false,
      });
      expect((e.context as Record<string, unknown>).outcome).toBe('dismissed');
    }
    expect(events.map((e) => e.entityId).sort()).toEqual(
      [r1.itemId.toString(), r2.itemId.toString()].sort(),
    );
    expect((await qualOf(s, r1.sourceRecordId, a.id)).operatorVerdict).toBe('not_fit');
    expect((await qualOf(s, r3.sourceRecordId, a.id)).operatorVerdict).toBeNull();
    expect((await itemOf(r3.itemId)).state).toBe('needs_review');
    expect(await auditKinds(s, 'review.needs_review')).toHaveLength(1);
  });

  it('a bulk archive is one decision with a half-weight event per item; archived items are skipped', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const r1 = await record(s);
    const r2 = await record(s);
    const r3 = await record(s);
    for (const r of [r1, r2, r3]) await qualify(s, r.sourceRecordId, a.id);
    await archiveReviewItem(adminCtx(s), r3.itemId);

    const res = await bulkArchiveReviewItems(adminCtx(s), [r1.itemId, r2.itemId, r3.itemId]);
    expect(res).toEqual({ archived: 2, requested: 3 });
    const bulk = (await eventsOf(s)).filter((e) => e.entityId !== r3.itemId.toString());
    expect(bulk).toHaveLength(2);
    expect(new Set(bulk.map((e) => e.decisionId)).size).toBe(1);
    expect(bulk.every((e) => e.weight === '0.50' && e.verdict === 'not_fit')).toBe(true);
    const [decision] = await db
      .select()
      .from(learningDecisions)
      .where(eq(learningDecisions.id, bulk[0]!.decisionId!));
    expect(decision).toMatchObject({ kind: 'review.archive', subjectId: null });
    const [audit] = await auditKinds(s, 'review.bulk_archive');
    expect((audit!.payload as Record<string, unknown>).decisionId).toBe(decision!.id);
  });
});

// ---- comments ---------------------------------------------------------------------

describe('comments go through the decision record', () => {
  it('a comment applies to the AI-relevant product by default; a mention-only comment records no event; a resubmit posts once', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const b = await product(s, 'Beta');
    const r = await record(s);
    await qualify(s, r.sourceRecordId, a.id);
    await qualify(s, r.sourceRecordId, b.id, { relevant: false, score: 15 });

    const key = 'comment-nonce-0001';
    await commentOnReviewItem(ownerCtx(s), r.itemId, 'Fleet operators like this convert well.', {
      decisionKey: key,
    });
    await commentOnReviewItem(ownerCtx(s), r.itemId, 'Fleet operators like this convert well.', {
      decisionKey: key,
    });
    await commentOnReviewItem(ownerCtx(s), r.itemId, `@kl02-admin-${seq}@test.local look`);

    const comments = await db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.reviewItemId, r.itemId));
    expect(comments).toHaveLength(2);
    const events = await eventsOf(s);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      productProfileId: a.id,
      verdict: null,
      polarity: 0,
      actionType: 'general_instruction',
      originalComment: 'Fleet operators like this convert well.',
    });
    expect(await auditKinds(s, 'review.comment')).toHaveLength(2);

    await commentOnReviewItem(ownerCtx(s), r.itemId, 'Applies to every product we sell.', {
      appliesTo: 'workspace',
    });
    const last = (await eventsOf(s)).at(-1)!;
    expect(last).toMatchObject({ productProfileId: null, explicit: true });
  });
});

// ---- post-commit hooks ---------------------------------------------------------------

describe('post-commit decision hooks', () => {
  it('onApprovedProducts / onRejectedProducts receive the products a decision marked', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const b = await product(s, 'Beta');
    const r = await record(s);
    await qualify(s, r.sourceRecordId, a.id);
    await qualify(s, r.sourceRecordId, b.id);
    const seen: Array<{ kind: string; event: ProductsDecidedEvent }> = [];
    const off1 = registerDecisionHook('onApprovedProducts', 'test', (e) => {
      seen.push({ kind: 'approved', event: e });
    });
    const off2 = registerDecisionHook('onRejectedProducts', 'test', () => {
      throw new Error('a broken hook never undoes the decision');
    });
    const off3 = registerDecisionHook('onRejectedProducts', 'test-2', (e) => {
      seen.push({ kind: 'rejected', event: e });
    });
    try {
      await approveReviewItem(ownerCtx(s), r.itemId, null, {
        productVerdicts: [{ productProfileId: b.id, verdict: 'not_fit' }],
      });
    } finally {
      off1();
      off2();
      off3();
    }
    expect((await itemOf(r.itemId)).state).toBe('approved');
    expect(seen.map((x) => x.kind)).toEqual(['approved', 'rejected']);
    expect(seen[0]!.event.productProfileIds).toEqual([a.id]);
    expect(seen[1]!.event.productProfileIds).toEqual([b.id]);
    expect(seen[0]!.event).toMatchObject({
      kind: 'review.approve',
      origin: 'operator',
      reviewItemId: r.itemId,
      sourceRecordId: r.sourceRecordId,
    });
  });
});

// ---- learning.process ---------------------------------------------------------------

describe('learning.process works the outbox', () => {
  it('one extraction per decision: a reason over A and B gives one rule scoped to both (I032)', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const b = await product(s, 'Beta');
    const r = await record(s);
    await qualify(s, r.sourceRecordId, a.id);
    await qualify(s, r.sourceRecordId, b.id);
    const ai = stubAi(() => ({
      category: 'qualification_positive',
      rule: 'Roofing contractors running a van fleet are a fit.',
      confidence: 80,
      polarity: 'prefer',
    }));
    _setAIProviderForTests(ai);

    await approveReviewItem(
      ownerCtx(s),
      r.itemId,
      'Exactly our buyer: roofing contractor with 40 vans',
    );
    await drainLearning();

    expect(ai.calls).toBe(1);
    const lessons = await db
      .select()
      .from(learningLessons)
      .where(eq(learningLessons.workspaceId, s.ws));
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ scopeKind: 'products', polarity: 1, lifecycle: 'active' });
    const scopes = await db
      .select()
      .from(lessonScopes)
      .where(eq(lessonScopes.lessonId, lessons[0]!.id));
    expect(scopes.map((x) => x.productProfileId).sort()).toEqual([a.id, b.id].sort());
    const events = await eventsOf(s);
    expect(events.every((e) => e.processingStatus === 'done')).toBe(true);
    expect(events.every((e) => e.extractedLessonId === lessons[0]!.id)).toBe(true);
    expect(events.every((e) => e.processedAt instanceof Date)).toBe(true);
  });

  it('a comment-less decision is processed as no_rule; a voided event is never mined', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const r = await record(s);
    await qualify(s, r.sourceRecordId, a.id);
    // A queue with no handler: the test drives the processor itself.
    const previous = getJobQueue();
    _setJobQueueForTests(new InMemoryJobQueue());
    const ai = stubAi(() => ({
      category: 'qualification_negative',
      rule: 'Skip consultancies.',
      confidence: 80,
      polarity: 'avoid',
    }));
    _setAIProviderForTests(ai);
    try {
      await approveReviewItem(ownerCtx(s), r.itemId, 'Looks like an installer to me');
      await rejectReviewItem(ownerCtx(s), r.itemId, 'It is a consultancy');
      const [approveEvent, rejectEvent] = await eventsOf(s);
      expect(approveEvent!.voidedAt).toBeInstanceOf(Date);

      const voided = await processDecision(ownerCtx(s), approveEvent!.decisionId!);
      expect(voided).toMatchObject({ claimed: 1, lessonId: null, statuses: { skipped: 1 } });
      expect(ai.calls).toBe(0);

      const live = await processDecision(ownerCtx(s), rejectEvent!.decisionId!);
      expect(live.claimed).toBe(1);
      expect(live.lessonId).not.toBeNull();
      expect(ai.calls).toBe(1);
      // Already processed: a second run claims nothing.
      expect((await processDecision(ownerCtx(s), rejectEvent!.decisionId!)).claimed).toBe(0);

      const r2 = await record(s);
      await qualify(s, r2.sourceRecordId, a.id);
      await ignoreReviewItem(ownerCtx(s), r2.itemId);
      const ignoreEvent = (await eventsOf(s)).at(-1)!;
      const res = await processDecision(ownerCtx(s), ignoreEvent.decisionId!);
      expect(res.statuses).toEqual({ no_rule: 1 });
      expect(ai.calls).toBe(1);
    } finally {
      _setJobQueueForTests(previous);
    }
  });

  it('verdicts move the rules an AI verdict used; a rules-fallback row never reinforces', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const b = await product(s, 'Beta');
    const avoid = await createLesson(ownerCtx(s), {
      category: 'qualification_negative',
      rule: 'Skip councils.',
      confidence: 60,
    });
    const r = await record(s);
    await qualify(s, r.sourceRecordId, a.id, { matchedLessonIds: [avoid.id] });
    const r2 = await record(s);
    await qualify(s, r2.sourceRecordId, b.id, {
      method: 'rules_fallback',
      matchedLessonIds: [avoid.id],
    });
    await rejectReviewItem(ownerCtx(s), r.itemId);
    await rejectReviewItem(ownerCtx(s), r2.itemId, null, {
      productVerdicts: [{ productProfileId: b.id, verdict: 'not_fit' }],
    });
    await drainLearning();
    const [row] = await db.select().from(learningLessons).where(eq(learningLessons.id, avoid.id));
    // +2 once (the AI-method reject), never from the fallback row.
    expect(row!.confidence).toBe(62);
  });
});

// ---- acceptance 4: autopilot --------------------------------------------------------

describe('autopilot auto-approve (acceptance 4, I018, I034)', () => {
  async function seedCandidates(s: Setup) {
    const a = await product(s, 'Alpha');
    const b = await product(s, 'Beta');
    const c = await product(s, 'OptedOut');
    await upsertProductAutopilotSettings(ownerCtx(s), {
      productProfileId: c.id,
      enableAutoApproveProjects: false,
    });
    // Five records relevant only to the opted-out product, scored highest:
    // before KL-02 they held the top slots of every run.
    const optedOut = [];
    for (let i = 0; i < 5; i++) {
      const r = await record(s);
      await qualify(s, r.sourceRecordId, c.id, { score: 99 });
      optedOut.push(r);
    }
    // One record relevant to A and B.
    const both = await record(s);
    await qualify(s, both.sourceRecordId, a.id, { score: 90 });
    await qualify(s, both.sourceRecordId, b.id, { score: 85 });
    // 24 more relevant to A: 25 eligible candidates in all.
    const others = [];
    for (let i = 0; i < 24; i++) {
      const r = await record(s);
      await qualify(s, r.sourceRecordId, a.id, { score: 60 + i });
      others.push(r);
    }
    await updateAutopilotSettings(ownerCtx(s), {
      autopilotEnabled: true,
      enableAutoApproveProjects: true,
      autoApproveThreshold: 50,
      maxApprovalsPerRun: 20,
    });
    return { a, b, c, optedOut, both, others };
  }

  it('25 candidates, cap 20, one record relevant to A and B, an opted-out product: each item approved once with origin autopilot', async () => {
    const s = await setup();
    const { a, b, optedOut, both } = await seedCandidates(s);

    const run = await runOnce(ownerCtx(s));
    expect(run.steps.find((x) => x.step === 'auto_approve_projects')?.detail).toBe(
      'approved=20/20',
    );

    const approved = await db
      .select()
      .from(reviewItems)
      .where(and(eq(reviewItems.workspaceId, s.ws), eq(reviewItems.state, 'approved')));
    expect(approved).toHaveLength(20);
    expect(
      approved.every((i) => i.approvedByUserId === null && i.approvalReason === 'autopilot'),
    ).toBe(true);
    for (const r of optedOut) expect((await itemOf(r.itemId)).state).toBe('new');
    expect(approved.some((i) => i.id === both.itemId)).toBe(true);

    const events = await eventsOf(s);
    expect(events).toHaveLength(21);
    expect(
      events.every(
        (e) =>
          e.origin === 'autopilot' &&
          e.userId === null &&
          e.processingStatus === 'skipped' &&
          e.actionType === 'auto_approval' &&
          e.verdict === 'fit',
      ),
    ).toBe(true);
    const bothEvents = events.filter((e) => e.entityId === both.itemId.toString());
    expect(bothEvents.map((e) => e.productProfileId).sort()).toEqual([a.id, b.id].sort());
    expect(new Set(bothEvents.map((e) => e.decisionId)).size).toBe(1);
    const audits = await auditKinds(s, 'review.approved');
    expect(audits).toHaveLength(20);
    expect(audits.every((x) => (x.payload as Record<string, unknown>).origin === 'autopilot')).toBe(
      true,
    );
    // Autopilot never writes an operator verdict.
    const verdicts = await db
      .select()
      .from(qualifications)
      .where(eq(qualifications.workspaceId, s.ws));
    expect(verdicts.every((q) => q.operatorVerdict === null)).toBe(true);

    // The next run takes the remaining 5 and approves nothing twice.
    const second = await runOnce(ownerCtx(s));
    expect(second.steps.find((x) => x.step === 'auto_approve_projects')?.detail).toBe(
      'approved=5/5',
    );
    expect(await auditKinds(s, 'review.approved')).toHaveLength(25);
  });

  it('skips records with any operator verdict; an operator decision on an autopilot approval voids it as an override', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const b = await product(s, 'Beta');
    const decided = await record(s);
    const q = await qualify(s, decided.sourceRecordId, a.id, { score: 95 });
    await db
      .update(qualifications)
      .set({ operatorVerdict: 'fit', operatorDecidedAt: new Date() })
      .where(eq(qualifications.id, q.id));
    const both = await record(s);
    await qualify(s, both.sourceRecordId, a.id, { score: 90 });
    await qualify(s, both.sourceRecordId, b.id, { score: 85 });
    await updateAutopilotSettings(ownerCtx(s), {
      autopilotEnabled: true,
      enableAutoApproveProjects: true,
      autoApproveThreshold: 50,
    });

    await runOnce(ownerCtx(s));
    expect((await itemOf(decided.itemId)).state).toBe('new');
    expect((await itemOf(both.itemId)).state).toBe('approved');

    await rejectReviewItem(memberCtx(s), both.itemId, 'Wholesaler, not an installer');
    const events = await eventsOf(s);
    const auto = events.filter((e) => e.origin === 'autopilot');
    const human = events.filter((e) => e.origin === 'operator');
    expect(auto).toHaveLength(2);
    expect(human).toHaveLength(2);
    for (const e of auto) {
      expect(e.voidReason).toBe('autopilot_override');
      expect(human.map((h) => h.id)).toContain(e.voidedByEventId);
    }
    expect(human.every((h) => h.overridesAutopilot && h.weight === '1.00')).toBe(true);
    expect((await qualOf(s, both.sourceRecordId, b.id)).operatorVerdict).toBe('not_fit');
  });
});

// ---- acceptance 5: the verdict binds downstream ------------------------------------

describe('Not a fit binds downstream (acceptance 5)', () => {
  it('[handbook H-32] ensureQualifiedLead, generateOutreachDraft and autopilot enqueue refuse a not_fit pair, and /leads hides Promote for it', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const b = await product(s, 'Beta');
    const r = await record(s);
    await qualify(s, r.sourceRecordId, a.id, { score: 90 });
    await qualify(s, r.sourceRecordId, b.id, { score: 80 });
    await approveReviewItem(ownerCtx(s), r.itemId, null, {
      productVerdicts: [{ productProfileId: b.id, verdict: 'not_fit' }],
    });

    await expect(ensureQualifiedLead(ownerCtx(s), r.itemId, b.id)).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      generateOutreachDraft(ownerCtx(s), {
        reviewItemId: r.itemId,
        productProfileId: b.id,
        method: 'rules',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // The Fit product is unaffected.
    const lead = await ensureQualifiedLead(ownerCtx(s), r.itemId, a.id);
    expect(lead.productProfileId).toBe(a.id);

    // /leads: Promote only for the Fit pair.
    session.current = { user: { id: s.owner, role: 'member', accountStatus: 'active' } };
    const html = (
      await renderToHtml(await LeadsPage({ searchParams: Promise.resolve({}) }))
    ).replaceAll('<!-- -->', '');
    expect(html.match(/Promote to pipeline/g) ?? []).toHaveLength(1);
    expect(html).toContain('marked Not a fit');

    // Autopilot's generate + enqueue drafts the Fit product only.
    await createMailbox(ownerCtx(s), {
      name: 'sales',
      fromAddress: 'sales@nulife.pl',
      fromName: 'Sales',
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: 'sales@nulife.pl',
      smtpPassword: 'secret',
      imap: null,
      isDefault: true,
    });
    await updateAutopilotSettings(ownerCtx(s), {
      autopilotEnabled: true,
      enableAutoEnqueueOutreach: true,
    });
    await runOnce(ownerCtx(s));
    const drafts = await db
      .select()
      .from(outreachDrafts)
      .where(eq(outreachDrafts.workspaceId, s.ws));
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every((d) => d.productProfileId === a.id)).toBe(true);
  });

  it('rejecting marks the AI-relevant products Not a fit', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const r = await record(s);
    await qualify(s, r.sourceRecordId, a.id);
    await rejectReviewItem(ownerCtx(s), r.itemId);
    await expect(ensureQualifiedLead(ownerCtx(s), r.itemId, a.id)).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});

// ---- acceptance 6: re-classification ----------------------------------------------

describe('re-classification keeps the operator verdict (acceptance 6)', () => {
  it('re-running classifySourceRecord keeps operator_* and geo_confirmed_* columns', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const r = await record(s);
    const first = await classifySourceRecord(ownerCtx(s), r.sourceRecordId);
    expect(first).toHaveLength(1);
    await approveReviewItem(ownerCtx(s), r.itemId, null, {
      productVerdicts: [{ productProfileId: a.id, verdict: 'fit' }],
    });
    await db
      .update(qualifications)
      .set({ geoConfirmedBy: s.owner, geoConfirmedAt: new Date() })
      .where(eq(qualifications.id, first[0]!.id));
    const before = await qualOf(s, r.sourceRecordId, a.id);
    expect(before.operatorVerdict).toBe('fit');

    await classifySourceRecord(ownerCtx(s), r.sourceRecordId);
    const after = await qualOf(s, r.sourceRecordId, a.id);
    expect(after.operatorVerdict).toBe('fit');
    expect(after.operatorDecidedBy).toBe(before.operatorDecidedBy);
    expect(after.operatorDecidedAt).toEqual(before.operatorDecidedAt);
    expect(after.operatorEventId).toBe(before.operatorEventId);
    expect(after.geoConfirmedBy).toBe(s.owner);
    expect(after.geoConfirmedAt).toEqual(before.geoConfirmedAt);
  });
});

// ---- acceptance 7: reply learning off --------------------------------------------------

describe('reply learning is off by default (acceptance 7)', () => {
  /** A linked thread: inbound prospect reply → contact → pipeline lead,
   *  whose last draft carries a rule (what a reply would reinforce). */
  async function linkedReply(s: Setup) {
    const lesson = await createLesson(ownerCtx(s), {
      category: 'outreach_style',
      rule: 'Be brief.',
      confidence: 50,
    });
    const p = await product(s, 'Alpha');
    const r = await record(s);
    const [mb] = await db
      .insert(mailboxes)
      .values({
        workspaceId: s.ws,
        name: 'sales',
        fromAddress: 'sales@nulife.pl',
        smtpHost: 'smtp.x',
        smtpUser: 'sales@nulife.pl',
        smtpPasswordSecretKey: 'mailbox.smtpPassword_fixedfortests',
        imapFolder: 'INBOX',
        status: 'active',
        isDefault: true,
      })
      .returning();
    const [thread] = await db
      .insert(mailThreads)
      .values({
        workspaceId: s.ws,
        mailboxId: mb!.id,
        subject: 'Re: hi',
        externalThreadKey: `kl02-thread-${seq}`,
        participants: ['anna@target.com', 'sales@nulife.pl'],
      })
      .returning();
    const [msg] = await db
      .insert(mailMessages)
      .values({
        workspaceId: s.ws,
        mailboxId: mb!.id,
        threadId: thread!.id,
        direction: 'inbound',
        status: 'received',
        messageId: `<kl02-${seq}@x.com>`,
        fromAddress: 'anna@target.com',
        toAddresses: ['sales@nulife.pl'],
        subject: 'Re: hi',
        bodyText: 'Not interested, thanks.',
        outreachRelevance: 'prospect_reply',
      })
      .returning();
    const [contact] = await db
      .insert(contacts)
      .values({ workspaceId: s.ws, email: 'anna@target.com', name: 'Anna', status: 'active' })
      .returning();
    const [lead] = await db
      .insert(qualifiedLeads)
      .values({
        workspaceId: s.ws,
        reviewItemId: r.itemId,
        productProfileId: p.id,
        state: 'relevant',
        relevantAt: new Date(),
      })
      .returning();
    await db.insert(contactAssociations).values([
      {
        workspaceId: s.ws,
        contactId: contact!.id,
        entityType: 'mail_thread',
        entityId: thread!.id.toString(),
      },
      {
        workspaceId: s.ws,
        contactId: contact!.id,
        entityType: 'qualified_lead',
        entityId: lead!.id.toString(),
      },
    ]);
    await db.insert(outreachDrafts).values({
      workspaceId: s.ws,
      reviewItemId: r.itemId,
      sourceRecordId: r.sourceRecordId,
      productProfileId: p.id,
      body: 'Hello',
      method: 'rules',
      matchedLessonIds: [lesson.id],
    });
    return { messageId: msg!.id, lessonId: lesson.id };
  }

  const negative: ReplyClassification = {
    type: 'negative',
    confidence: 90,
    rationale: 'test',
    extractedEmails: [],
    suggestedAction: 'close_lost',
  };

  async function replyEvents(s: Setup) {
    return db
      .select()
      .from(learningEvents)
      .where(
        and(
          eq(learningEvents.workspaceId, s.ws),
          inArray(learningEvents.actionType, ['reply_positive', 'reply_negative']),
        ),
      );
  }

  it('[handbook H-33] with learn_from_replies off, a classified inbound on a linked thread writes no event and no reinforcement', async () => {
    const s = await setup();
    expect(await getLearnFromReplies(ownerCtx(s))).toBe(false);
    const { messageId, lessonId } = await linkedReply(s);
    await handleClassifiedReply(ownerCtx(s), messageId, negative);
    await settleDetached();
    expect(await replyEvents(s)).toHaveLength(0);
    const [lesson] = await db
      .select()
      .from(learningLessons)
      .where(eq(learningLessons.id, lessonId));
    expect(lesson!.confidence).toBe(50);
  });

  it('only an owner can switch it on; then the same reply teaches', async () => {
    const s = await setup();
    await expect(updateLearnFromReplies(adminCtx(s), true)).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await updateLearnFromReplies(ownerCtx(s), true);
    const { messageId, lessonId } = await linkedReply(s);
    await handleClassifiedReply(ownerCtx(s), messageId, negative);
    await settleDetached();
    expect(await replyEvents(s)).toHaveLength(1);
    const [lesson] = await db
      .select()
      .from(learningLessons)
      .where(eq(learningLessons.id, lessonId));
    expect(lesson!.confidence).toBe(47);
  });
});

// ---- acceptance 9: the delete guard ------------------------------------------------

describe('bulk delete keeps items with decisions (acceptance 9, I030)', () => {
  it('bulkDeleteReviewItems keeps an item with decision events and reports it', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const decided = await record(s);
    const untouched = await record(s);
    await qualify(s, decided.sourceRecordId, a.id);
    await rejectReviewItem(ownerCtx(s), decided.itemId, 'wrong sector');

    const res = await bulkDeleteReviewItems(adminCtx(s), [decided.itemId, untouched.itemId]);
    expect(res.deleted).toBe(1);
    expect(res.requested).toBe(2);
    expect(res.kept).toEqual([decided.itemId]);
    expect((await itemOf(decided.itemId)).state).toBe('rejected');
    expect(
      await db.select().from(reviewItems).where(eq(reviewItems.id, untouched.itemId)),
    ).toHaveLength(0);
    const [audit] = await auditKinds(s, 'review.bulk_delete');
    expect((audit!.payload as Record<string, unknown>).keptWithDecisions).toEqual([
      decided.itemId.toString(),
    ]);
  });
});

// ---- synthesis never mines machines or voided decisions -------------------------------

describe('the weekly synthesis reads only live operator decisions (I034)', () => {
  it('autopilot and voided events are not examined', async () => {
    const s = await setup();
    const a = await product(s, 'Alpha');
    const auto = await record(s);
    await qualify(s, auto.sourceRecordId, a.id, { score: 95 });
    await updateAutopilotSettings(ownerCtx(s), {
      autopilotEnabled: true,
      enableAutoApproveProjects: true,
      autoApproveThreshold: 50,
    });
    await runOnce(ownerCtx(s));
    const human = await record(s);
    await qualify(s, human.sourceRecordId, a.id);
    await approveReviewItem(ownerCtx(s), human.itemId);
    await rejectReviewItem(ownerCtx(s), human.itemId);
    // autopilot 1 + approve 1 (voided) + reject 1
    expect(await eventsOf(s)).toHaveLength(3);
    const summary = await synthesizeWorkspaceLearning(ownerCtx(s));
    expect(summary.eventsExamined).toBe(1);
    expect(summary.skippedReason).toBe('insufficient_events');
  });
});
