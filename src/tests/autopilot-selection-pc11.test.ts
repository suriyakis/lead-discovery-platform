// PC-11: autopilot candidate selection and CRM sync correctness (I018,
// I072, with I001 and I034 at the edges).
//
// Acceptance map:
//   (1) more candidates than maxEnqueuesPerRun → every eligible pair is
//       enqueued across successive runs ("generate + queue")
//   (2) an item relevant to two products changes state once per run, one
//       audit row, the learning feed once with origin 'autopilot'
//       ("auto-approve")
//   (3) re-approving an approved item writes nothing ("same-state no-op")
//   (4) a product that opts out does not block the others ("auto-approve",
//       "generate + queue")
//   (5) a second CRM tick makes 0 connector calls; a deal without a contact
//       is skipped with no error row; pushes are on the lead's timeline
//       ("CRM sync")
//   (6) a step error → one ops incident per step per day ("step errors")

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/connectors/mock';
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import type { CrmLeadPayload, ICRMConnector, SyncResult } from '@/lib/crm';
import { auditLog } from '@/lib/db/schema/audit';
import { autopilotLog } from '@/lib/db/schema/autopilot';
import { sourceRecords } from '@/lib/db/schema/connectors';
import { learningDecisions, learningEvents } from '@/lib/db/schema/learning';
import { type Mailbox } from '@/lib/db/schema/mailing';
import { outreachDrafts, outreachQueue } from '@/lib/db/schema/outreach';
import { pipelineEvents, qualifiedLeads } from '@/lib/db/schema/pipeline';
import { productProfiles } from '@/lib/db/schema/products';
import { qualifications } from '@/lib/db/schema/qualifications';
import { reviewItems } from '@/lib/db/schema/review';
import {
  AUTOPILOT_STEP_FAILED,
  LOG_ONCE_INCIDENT_SINK,
  autopilotIncidentDedupeKey,
  autopilotStepIncident,
  type AutopilotIncidentInput,
} from '@/lib/services/autopilot-incidents';
import {
  ENQUEUE_RETRY_MS,
  runOnce,
  updateAutopilotSettings,
  upsertProductAutopilotSettings,
} from '@/lib/services/autopilot';
import * as outreachService from '@/lib/services/outreach';
import { isPlausibleEmail, plausibleEmailSql } from '@/lib/services/contacts';
import {
  type WorkspaceContext,
  makeAutomationContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { createCrmConnection, pushLeadToCrm } from '@/lib/services/crm';
import { createMailbox } from '@/lib/services/mailbox';
import {
  approveReviewItem,
  autopilotApproveReviewItem,
  rejectReviewItem,
} from '@/lib/services/review';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

const SRC = path.resolve(__dirname, '..');

// ---- fixtures -------------------------------------------------------------

interface Tenant {
  workspaceId: bigint;
  ownerId: string;
  owner: WorkspaceContext;
  auto: WorkspaceContext;
}

let seq = 0;

async function tenant(): Promise<Tenant> {
  seq++;
  const ownerId = await seedUser({ email: `pc11-owner-${seq}@test.local` });
  const workspaceId = await seedWorkspace({ name: `pc11-${seq}`, ownerUserId: ownerId });
  return {
    workspaceId,
    ownerId,
    owner: makeWorkspaceContext({ workspaceId, userId: ownerId, role: 'owner' }),
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

/**
 * A source record + review item with one relevant qualification per entry
 * of `products`; for each product with `email` (or `leadState`), a pipeline
 * lead carrying that contact email.
 */
async function item(
  t: Tenant,
  state: 'new' | 'approved',
  products: ReadonlyArray<{
    id: bigint;
    score?: number;
    email?: string | null;
    leadState?: 'relevant' | 'qualified';
  }>,
  opts: { approvedAt?: Date } = {},
) {
  seq++;
  const [sr] = await db
    .insert(sourceRecords)
    .values({
      workspaceId: t.workspaceId,
      sourceSystem: 'mock',
      sourceId: `pc11-${seq}-${Math.random()}`,
      rawData: {},
      normalizedData: { title: `Project ${seq}`, companyName: `Company ${seq}` },
      sourceUrl: `https://example.com/${seq}`,
    })
    .returning();
  const [ri] = await db
    .insert(reviewItems)
    .values({
      workspaceId: t.workspaceId,
      sourceRecordId: sr!.id,
      state,
      approvedAt: state === 'approved' ? (opts.approvedAt ?? new Date()) : null,
    })
    .returning();
  const leads: Array<typeof qualifiedLeads.$inferSelect> = [];
  for (const p of products) {
    await db.insert(qualifications).values({
      workspaceId: t.workspaceId,
      sourceRecordId: sr!.id,
      productProfileId: p.id,
      isRelevant: true,
      relevanceScore: p.score ?? 90,
      confidence: 80,
      method: 'rules',
    });
    if (p.email !== undefined || p.leadState) {
      const [lead] = await db
        .insert(qualifiedLeads)
        .values({
          workspaceId: t.workspaceId,
          reviewItemId: ri!.id,
          productProfileId: p.id,
          state: p.leadState ?? 'relevant',
          contactEmail: p.email ?? null,
        })
        .returning();
      leads.push(lead!);
    }
  }
  return { sourceRecord: sr!, reviewItem: ri!, leads };
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

async function reviewRow(id: bigint) {
  const [row] = await db.select().from(reviewItems).where(eq(reviewItems.id, id));
  return row!;
}

async function queuedReviewItems(t: Tenant): Promise<Set<string>> {
  const rows = await db
    .select({ reviewItemId: outreachDrafts.reviewItemId })
    .from(outreachQueue)
    .innerJoin(outreachDrafts, eq(outreachDrafts.id, outreachQueue.draftId))
    .where(eq(outreachQueue.workspaceId, t.workspaceId));
  return new Set(rows.map((r) => r.reviewItemId.toString()));
}

async function draftCount(t: Tenant, reviewItemId: bigint) {
  const rows = await db
    .select({ id: outreachDrafts.id })
    .from(outreachDrafts)
    .where(
      and(
        eq(outreachDrafts.workspaceId, t.workspaceId),
        eq(outreachDrafts.reviewItemId, reviewItemId),
      ),
    );
  return rows.length;
}

async function auditFor(t: Tenant, kind: string, entityId: bigint) {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.workspaceId, t.workspaceId),
        eq(auditLog.kind, kind),
        eq(auditLog.entityId, entityId.toString()),
      ),
    );
}

/** KL-02: the learning decisions recorded in the workspace. */
async function decisionsIn(t: Tenant) {
  return db
    .select()
    .from(learningDecisions)
    .where(eq(learningDecisions.workspaceId, t.workspaceId));
}

async function learningEventsFor(t: Tenant, reviewItemId: bigint) {
  return db
    .select()
    .from(learningEvents)
    .where(
      and(
        eq(learningEvents.workspaceId, t.workspaceId),
        eq(learningEvents.entityType, 'review_item'),
        eq(learningEvents.entityId, reviewItemId.toString()),
      ),
    );
}

async function errorRows(t: Tenant) {
  return db
    .select()
    .from(autopilotLog)
    .where(and(eq(autopilotLog.workspaceId, t.workspaceId), eq(autopilotLog.outcome, 'error')));
}

/** A CRM connector with scripted outcomes that records every call. */
class ScriptedCrm implements ICRMConnector {
  public readonly id = 'scripted-crm';
  public readonly contactPrev: Array<string | null> = [];
  public dealCalls = 0;
  constructor(
    public contact: 'succeeded' | 'failed' = 'succeeded',
    public deal: 'succeeded' | 'failed' = 'succeeded',
  ) {}
  async push(_p: CrmLeadPayload, prevExternalId: string | null): Promise<SyncResult> {
    this.contactPrev.push(prevExternalId);
    return this.contact === 'succeeded'
      ? {
          outcome: 'succeeded',
          externalId: prevExternalId ?? `contact-${this.contactPrev.length}`,
          payload: {},
          response: {},
        }
      : { outcome: 'failed', error: 'HTTP 500 contact', payload: {}, response: {} };
  }
  async pushDeal(): Promise<SyncResult> {
    this.dealCalls++;
    return this.deal === 'succeeded'
      ? { outcome: 'succeeded', externalId: `deal-${this.dealCalls}`, payload: {}, response: {} }
      : { outcome: 'failed', error: 'HTTP 500 deal', payload: {}, response: {} };
  }
  async testConnection() {
    return { ok: true };
  }
  get calls(): number {
    return this.contactPrev.length + this.dealCalls;
  }
}

/** Stands in for PC-07's ops_events: dedupes by fingerprint (scope +
 *  workspace + kind + dedupe key) and counts occurrences while open. */
class FakeOpsStream {
  readonly events = new Map<string, { input: AutopilotIncidentInput; occurrences: number }>();
  readonly calls: AutopilotIncidentInput[] = [];
  readonly sink = async (input: AutopilotIncidentInput): Promise<void> => {
    this.calls.push(input);
    const fp = [input.scope, input.workspaceId, input.kind, input.dedupeKey].join('|');
    const open = this.events.get(fp);
    if (open) open.occurrences += input.occurrences;
    else this.events.set(fp, { input, occurrences: input.occurrences });
  };
}

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

// ---- (1), (4): generate + queue ---------------------------------------------

describe(
  'generate + queue selects in SQL before the cap (PC-11 (1), (4), I018, I001)',
  { timeout: 60_000 },
  () => {
    it('with more candidates than maxEnqueuesPerRun, every eligible pair is queued across runs, oldest approval first', async () => {
      const t = await tenant();
      await makeMailbox(t);
      const A = await product(t, 'Alpha');
      // The oldest approvals are pairs autopilot cannot or must not draft. With
      // the cap applied before the filters they held every slot (I018).
      const noLead = await item(t, 'approved', [{ id: A.id }], { approvedAt: minutesAgo(100) });
      const noEmail = await item(t, 'approved', [{ id: A.id, email: null }], {
        approvedAt: minutesAgo(99),
      });
      const junkEmail = await item(t, 'approved', [{ id: A.id, email: 'logo@2x.png' }], {
        approvedAt: minutesAgo(98),
      });
      const drafted = await item(t, 'approved', [{ id: A.id, email: 'old@drafted.example' }], {
        approvedAt: minutesAgo(97),
      });
      await db.insert(outreachDrafts).values({
        workspaceId: t.workspaceId,
        reviewItemId: drafted.reviewItem.id,
        sourceRecordId: drafted.sourceRecord.id,
        productProfileId: A.id,
        status: 'needs_edit',
        stage: 'discovery',
        subject: 'Hi',
        body: 'Body',
        method: 'rules',
      });
      const eligible = [];
      for (let i = 0; i < 5; i++) {
        eligible.push(
          await item(t, 'approved', [{ id: A.id, email: `buyer${i}@target${i}.example` }], {
            approvedAt: minutesAgo(50 - i),
          }),
        );
      }
      await updateAutopilotSettings(t.owner, {
        autopilotEnabled: true,
        enableAutoEnqueueOutreach: true,
        maxEnqueuesPerRun: 2,
      });

      const r1 = await runOnce(t.auto);
      expect(r1.steps).toEqual([
        {
          step: 'auto_enqueue_outreach',
          outcome: 'success',
          detail: 'enqueued=2/2 needs_contact=3',
        },
      ]);
      // Oldest eligible approvals first.
      expect(await queuedReviewItems(t)).toEqual(
        new Set([eligible[0]!.reviewItem.id.toString(), eligible[1]!.reviewItem.id.toString()]),
      );

      const r2 = await runOnce(t.auto);
      expect(r2.steps[0]!.detail).toBe('enqueued=2/2 needs_contact=3');
      const r3 = await runOnce(t.auto);
      expect(r3.steps[0]!.detail).toBe('enqueued=1/1 needs_contact=3');
      const r4 = await runOnce(t.auto);
      expect(r4.steps[0]!.detail).toBe('enqueued=0/0 needs_contact=3');

      expect(await queuedReviewItems(t)).toEqual(
        new Set(eligible.map((e) => e.reviewItem.id.toString())),
      );
      // No draft was written for a lead nobody can be emailed at (I001), and
      // the already-drafted pair got no second draft.
      expect(await draftCount(t, noLead.reviewItem.id)).toBe(0);
      expect(await draftCount(t, noEmail.reviewItem.id)).toBe(0);
      expect(await draftCount(t, junkEmail.reviewItem.id)).toBe(0);
      expect(await draftCount(t, drafted.reviewItem.id)).toBe(1);
      expect(await errorRows(t)).toHaveLength(0);

      // Once the lead gets an email, the next run picks the pair up.
      await db
        .update(qualifiedLeads)
        .set({ contactEmail: 'anna@finally.example' })
        .where(eq(qualifiedLeads.id, noEmail.leads[0]!.id));
      const r5 = await runOnce(t.auto);
      expect(r5.steps[0]!.detail).toBe('enqueued=1/1 needs_contact=2');
      expect((await queuedReviewItems(t)).has(noEmail.reviewItem.id.toString())).toBe(true);
    });

    it('a product that opts out of generate + queue does not use up the cap of the others', async () => {
      const t = await tenant();
      await makeMailbox(t);
      const A = await product(t, 'Alpha');
      const B = await product(t, 'Beta');
      for (let i = 0; i < 3; i++) {
        await item(t, 'approved', [{ id: A.id, email: `a${i}@alpha.example` }], {
          approvedAt: minutesAgo(90 - i),
        });
      }
      const b = await item(t, 'approved', [{ id: B.id, email: 'b@beta.example' }], {
        approvedAt: minutesAgo(10),
      });
      await updateAutopilotSettings(t.owner, {
        autopilotEnabled: true,
        enableAutoEnqueueOutreach: true,
        maxEnqueuesPerRun: 1,
      });
      await upsertProductAutopilotSettings(t.owner, {
        productProfileId: A.id,
        enableAutoEnqueueOutreach: false,
      });
      const run = await runOnce(t.auto);
      expect(run.steps[0]!.detail).toBe('enqueued=1/1');
      expect(await queuedReviewItems(t)).toEqual(new Set([b.reviewItem.id.toString()]));
    });

    it('pairs on an archived product never take the cap: newer eligible pairs are queued in the first run', async () => {
      const t = await tenant();
      await makeMailbox(t);
      const A = await product(t, 'Archived later');
      const B = await product(t, 'Beta');
      // The oldest approvals are on A, with a lead and an email; then A is
      // archived. Drafting for an archived product throws, so before the
      // fix these pairs failed on every run and held every slot.
      const onArchived = [];
      for (let i = 0; i < 3; i++) {
        onArchived.push(
          await item(t, 'approved', [{ id: A.id, email: `a${i}@archived.example` }], {
            approvedAt: minutesAgo(100 - i),
          }),
        );
      }
      // An item without an email on A is not "waiting" for a contact either.
      await item(t, 'approved', [{ id: A.id, email: null }], { approvedAt: minutesAgo(95) });
      await db.update(productProfiles).set({ active: false }).where(eq(productProfiles.id, A.id));
      const eligible = [];
      for (let i = 0; i < 2; i++) {
        eligible.push(
          await item(t, 'approved', [{ id: B.id, email: `b${i}@beta.example` }], {
            approvedAt: minutesAgo(10 - i),
          }),
        );
      }
      await updateAutopilotSettings(t.owner, {
        autopilotEnabled: true,
        enableAutoEnqueueOutreach: true,
        maxEnqueuesPerRun: 2,
      });

      const run = await runOnce(t.auto);
      expect(run.steps).toEqual([
        { step: 'auto_enqueue_outreach', outcome: 'success', detail: 'enqueued=2/2' },
      ]);
      expect(await queuedReviewItems(t)).toEqual(
        new Set(eligible.map((e) => e.reviewItem.id.toString())),
      );
      for (const a of onArchived) expect(await draftCount(t, a.reviewItem.id)).toBe(0);
      expect(await errorRows(t)).toHaveLength(0);
    });

    it('auto-approve leaves an item relevant only to an archived product for the operator', async () => {
      const t = await tenant();
      const A = await product(t, 'Archived');
      const B = await product(t, 'Beta');
      const onArchived = await item(t, 'new', [{ id: A.id, score: 99 }]);
      const onBoth = await item(t, 'new', [
        { id: A.id, score: 99 },
        { id: B.id, score: 90 },
      ]);
      await db.update(productProfiles).set({ active: false }).where(eq(productProfiles.id, A.id));
      await updateAutopilotSettings(t.owner, {
        autopilotEnabled: true,
        enableAutoApproveProjects: true,
        autoApproveThreshold: 80,
      });

      const run = await runOnce(t.auto);
      expect(run.steps[0]).toMatchObject({ step: 'auto_approve_projects', outcome: 'success' });
      expect((await reviewRow(onArchived.reviewItem.id)).state).toBe('new');
      expect((await reviewRow(onBoth.reviewItem.id)).state).toBe('approved');
      // Approved for the active product only.
      const audits = await auditFor(t, 'review.approved', onBoth.reviewItem.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.payload).toMatchObject({ productProfileIds: [B.id.toString()] });
    });

    it('a pair that fails waits ENQUEUE_RETRY_MS: the next runs reach newer pairs and count it as retry_later', async () => {
      const t = await tenant();
      await makeMailbox(t);
      const A = await product(t, 'Alpha');
      const failing = await item(t, 'approved', [{ id: A.id, email: 'old@failing.example' }], {
        approvedAt: minutesAgo(100),
      });
      const newer = [];
      for (let i = 0; i < 2; i++) {
        newer.push(
          await item(t, 'approved', [{ id: A.id, email: `n${i}@newer.example` }], {
            approvedAt: minutesAgo(50 - i),
          }),
        );
      }
      await updateAutopilotSettings(t.owner, {
        autopilotEnabled: true,
        enableAutoEnqueueOutreach: true,
        maxEnqueuesPerRun: 1,
      });
      const ops = new FakeOpsStream();
      vi.spyOn(outreachService, 'generateOutreachDraft').mockRejectedValueOnce(
        new Error('drafting failed'),
      );

      const r1 = await runOnce(t.auto, { incidentSink: ops.sink });
      expect(r1.steps[0]!.detail).toBe('enqueued=0/1');
      const errors = await errorRows(t);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        entityType: 'review_item',
        entityId: failing.reviewItem.id.toString(),
        payload: { productProfileId: A.id.toString() },
      });

      // The failed pair no longer takes the only slot.
      const r2 = await runOnce(t.auto, { incidentSink: ops.sink });
      expect(r2.steps[0]!.detail).toBe('enqueued=1/1 retry_later=1');
      const r3 = await runOnce(t.auto, { incidentSink: ops.sink });
      expect(r3.steps[0]!.detail).toBe('enqueued=1/1 retry_later=1');
      expect(await queuedReviewItems(t)).toEqual(
        new Set(newer.map((n) => n.reviewItem.id.toString())),
      );

      // An hour later it is tried again (and now succeeds).
      await db
        .update(autopilotLog)
        .set({ createdAt: new Date(Date.now() - ENQUEUE_RETRY_MS - 60_000) })
        .where(eq(autopilotLog.id, errors[0]!.id));
      const r4 = await runOnce(t.auto, { incidentSink: ops.sink });
      expect(r4.steps[0]!.detail).toBe('enqueued=1/1');
      expect((await queuedReviewItems(t)).has(failing.reviewItem.id.toString())).toBe(true);
    });

    it('the candidate query uses the Drizzle builder (notExists / exists / inArray), no raw ANY', () => {
      const src = fs.readFileSync(path.join(SRC, 'lib/services/autopilot.ts'), 'utf8');
      expect(src).not.toMatch(/=\s*ANY\s*\(/i);
      expect(src).toMatch(/notExists\(\s*db\s*\.select\(\{ id: outreachDrafts\.id \}\)/);
      expect(src).toMatch(/orderBy\(asc\(reviewItems\.approvedAt\)/);
    });
  },
);

describe(
  'plausibleEmailSql agrees with isPlausibleEmail (PC-11, I001)',
  { timeout: 60_000 },
  () => {
    it('the SQL and the JS check give the same answer on normalized samples', async () => {
      const samples = [
        'anna.kowalska@acme.pl',
        ' Sales+Tag@Sub.Domain.co.uk ',
        "o'brien@irish-firm.ie",
        'logo@2x.png',
        'icon@small.svg',
        'bundle@v3.min.js',
        'no-at-sign.example.com',
        'two@@ats.com',
        'a@b.c',
        '',
        'x@-bad.example',
        `${'a'.repeat(65)}@toolong.example`,
        `a@${'b'.repeat(250)}.com`,
        'tab@example.com\t',
      ];
      for (const s of samples) {
        const rows = await db.execute<{ ok: boolean }>(
          sql`select ${plausibleEmailSql(sql`${s}::text`)} as ok`,
        );
        const js = isPlausibleEmail(s.trim().toLowerCase());
        expect({ s, ok: Boolean(rows[0]?.ok) }).toEqual({ s, ok: js });
      }
      const nullRows = await db.execute<{ ok: boolean | null }>(
        sql`select coalesce(${plausibleEmailSql(sql`null::text`)}, false) as ok`,
      );
      expect(nullRows[0]?.ok).toBe(false);
    });
  },
);

// ---- (2), (4): auto-approve -------------------------------------------------

describe(
  'auto-approve: one candidate per item, origin autopilot (PC-11 (2), (4), I018, I034)',
  { timeout: 60_000 },
  () => {
    it('an item relevant to two products changes state once, writes one audit row and feeds learning once with origin autopilot', async () => {
      const t = await tenant();
      const A = await product(t, 'Alpha');
      const B = await product(t, 'Beta');
      const both = await item(t, 'new', [
        { id: A.id, score: 92 },
        { id: B.id, score: 81 },
      ]);
      await updateAutopilotSettings(t.owner, {
        autopilotEnabled: true,
        enableAutoApproveProjects: true,
        autoApproveThreshold: 70,
      });
      const run = await runOnce(t.auto);
      expect(run.steps).toEqual([
        { step: 'auto_approve_projects', outcome: 'success', detail: 'approved=1/1' },
      ]);

      const row = await reviewRow(both.reviewItem.id);
      expect(row.state).toBe('approved');
      // A machine decision: no person's name on it.
      expect(row.approvedByUserId).toBeNull();
      expect(row.approvalReason).toBe('autopilot');

      const audits = await auditFor(t, 'review.approved', both.reviewItem.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.payload).toMatchObject({
        origin: 'autopilot',
        previousState: 'new',
        runId: run.runId,
        productProfileIds: [A.id.toString(), B.id.toString()],
      });

      // Learning is fed once (KL-02's decision record replaced the feed):
      // one autopilot decision keyed by the run and the item, with one
      // event per approved product, all origin autopilot and none
      // attributed to a person.
      const decisions = await decisionsIn(t);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        origin: 'autopilot',
        decisionKey: `autopilot:${run.runId}:${both.reviewItem.id}`,
        userId: null,
      });
      const events = await learningEventsFor(t, both.reviewItem.id);
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.userId === null && e.origin === 'autopilot')).toBe(true);
      expect(new Set(events.map((e) => String(e.productProfileId)))).toEqual(
        new Set([A.id.toString(), B.id.toString()]),
      );

      const log = await db
        .select()
        .from(autopilotLog)
        .where(
          and(
            eq(autopilotLog.workspaceId, t.workspaceId),
            eq(autopilotLog.step, 'auto_approve_projects'),
          ),
        );
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        outcome: 'success',
        entityId: both.reviewItem.id.toString(),
        detail: `score=92 products=${A.id},${B.id}`,
      });

      // A second run finds nothing to do and writes nothing.
      const again = await runOnce(t.auto);
      expect(again.steps[0]!.detail).toBe('approved=0/0');
      expect(await auditFor(t, 'review.approved', both.reviewItem.id)).toHaveLength(1);
      expect(await learningEventsFor(t, both.reviewItem.id)).toHaveLength(2);
    });

    it('the cap counts items, not (item, product) rows', async () => {
      const t = await tenant();
      const A = await product(t, 'Alpha');
      const B = await product(t, 'Beta');
      const items = [];
      for (let i = 0; i < 3; i++) {
        items.push(
          await item(t, 'new', [
            { id: A.id, score: 90 - i },
            { id: B.id, score: 85 - i },
          ]),
        );
      }
      await updateAutopilotSettings(t.owner, {
        autopilotEnabled: true,
        enableAutoApproveProjects: true,
        autoApproveThreshold: 70,
        maxApprovalsPerRun: 2,
      });
      const run = await runOnce(t.auto);
      expect(run.steps[0]!.detail).toBe('approved=2/2');
      expect((await reviewRow(items[0]!.reviewItem.id)).state).toBe('approved');
      expect((await reviewRow(items[1]!.reviewItem.id)).state).toBe('approved');
      expect((await reviewRow(items[2]!.reviewItem.id)).state).toBe('new');
      await runOnce(t.auto);
      expect((await reviewRow(items[2]!.reviewItem.id)).state).toBe('approved');
    });

    it("a product that opts out, or raises its threshold, never holds the others' slots", async () => {
      const t = await tenant();
      const A = await product(t, 'Alpha (opted out)');
      const C = await product(t, 'Gamma (threshold 95)');
      const B = await product(t, 'Beta');
      // A's and C's items score highest; with the cap applied before the
      // product checks they took every slot on every run (I018).
      const aItems = [];
      for (let i = 0; i < 3; i++) aItems.push(await item(t, 'new', [{ id: A.id, score: 99 }]));
      const cItems = [];
      for (let i = 0; i < 3; i++) cItems.push(await item(t, 'new', [{ id: C.id, score: 94 }]));
      const bItems = [];
      for (let i = 0; i < 2; i++) bItems.push(await item(t, 'new', [{ id: B.id, score: 75 }]));
      await updateAutopilotSettings(t.owner, {
        autopilotEnabled: true,
        enableAutoApproveProjects: true,
        autoApproveThreshold: 70,
        maxApprovalsPerRun: 2,
      });
      await upsertProductAutopilotSettings(t.owner, {
        productProfileId: A.id,
        enableAutoApproveProjects: false,
      });
      await upsertProductAutopilotSettings(t.owner, {
        productProfileId: C.id,
        autoApproveThreshold: 95,
      });

      const run = await runOnce(t.auto);
      expect(run.steps[0]!.detail).toBe('approved=2/2');
      for (const b of bItems) expect((await reviewRow(b.reviewItem.id)).state).toBe('approved');
      for (const x of [...aItems, ...cItems]) {
        expect((await reviewRow(x.reviewItem.id)).state).toBe('new');
      }
    });

    it('an item relevant to an opted-out product and another is approved for the other only', async () => {
      const t = await tenant();
      const A = await product(t, 'Alpha (opted out)');
      const B = await product(t, 'Beta');
      const both = await item(t, 'new', [
        { id: A.id, score: 99 },
        { id: B.id, score: 80 },
      ]);
      await updateAutopilotSettings(t.owner, {
        autopilotEnabled: true,
        enableAutoApproveProjects: true,
        autoApproveThreshold: 70,
      });
      await upsertProductAutopilotSettings(t.owner, {
        productProfileId: A.id,
        enableAutoApproveProjects: false,
      });
      await runOnce(t.auto);
      const [audit] = await auditFor(t, 'review.approved', both.reviewItem.id);
      expect(audit!.payload).toMatchObject({ productProfileIds: [B.id.toString()] });
    });
  },
);

// ---- (3): same-state no-op --------------------------------------------------

describe('a same-state decision writes nothing (PC-11 (3), I018)', { timeout: 60_000 }, () => {
  it('re-approving an approved item writes no audit row and no learning event', async () => {
    const t = await tenant();
    const A = await product(t, 'Alpha');
    const x = await item(t, 'new', [{ id: A.id }]);
    const first = await approveReviewItem(t.owner, x.reviewItem.id, 'good fit');
    expect(first.approvedByUserId).toBe(t.ownerId);
    const audits = await auditFor(t, 'review.approved', x.reviewItem.id);
    const events = await learningEventsFor(t, x.reviewItem.id);
    expect(audits).toHaveLength(1);
    expect(events).toHaveLength(1);
    const decisionsBefore = (await decisionsIn(t)).length;

    const again = await approveReviewItem(t.owner, x.reviewItem.id, 'still a good fit');
    expect(again.approvedAt?.getTime()).toBe(first.approvedAt?.getTime());
    expect(again.approvalReason).toBe('good fit');
    expect(
      await autopilotApproveReviewItem(t.auto, x.reviewItem.id, {
        runId: 'r',
        productProfileIds: [A.id],
      }),
    ).toEqual({ approved: false });

    expect(await auditFor(t, 'review.approved', x.reviewItem.id)).toHaveLength(1);
    expect(await learningEventsFor(t, x.reviewItem.id)).toHaveLength(1);
    expect(await decisionsIn(t)).toHaveLength(decisionsBefore);
  });

  it('a repeated reject writes nothing either, and autopilot leaves an item a person decided alone', async () => {
    const t = await tenant();
    const A = await product(t, 'Alpha');
    const x = await item(t, 'new', [{ id: A.id }]);
    await rejectReviewItem(t.owner, x.reviewItem.id, 'not our market');
    await rejectReviewItem(t.owner, x.reviewItem.id, 'not our market');
    expect(await auditFor(t, 'review.rejected', x.reviewItem.id)).toHaveLength(1);
    expect(await learningEventsFor(t, x.reviewItem.id)).toHaveLength(1);

    // Rejected is not 'new': autopilot's conditional approve does nothing.
    expect(
      await autopilotApproveReviewItem(t.auto, x.reviewItem.id, {
        runId: 'r',
        productProfileIds: [A.id],
      }),
    ).toEqual({ approved: false });
    expect((await reviewRow(x.reviewItem.id)).state).toBe('rejected');
    expect(await auditFor(t, 'review.approved', x.reviewItem.id)).toHaveLength(0);
  });
});

// ---- (5): CRM sync ----------------------------------------------------------

describe(
  'CRM sync pushes only new or changed leads, on their timeline (PC-11 (5), I072)',
  { timeout: 60_000 },
  () => {
    async function crmFixture() {
      const t = await tenant();
      const A = await product(t, 'Alpha');
      const a = await item(t, 'approved', [
        { id: A.id, email: 'a@a.example', leadState: 'qualified' },
      ]);
      const b = await item(t, 'approved', [
        { id: A.id, email: 'b@b.example', leadState: 'qualified' },
      ]);
      const conn = await createCrmConnection(t.owner, {
        system: 'hubspot',
        name: 'HS',
        credential: 'pat-test',
      });
      return { t, A, leadA: a.leads[0]!, leadB: b.leads[0]!, conn };
    }

    async function timeline(t: Tenant) {
      return db
        .select()
        .from(pipelineEvents)
        .where(eq(pipelineEvents.workspaceId, t.workspaceId))
        .orderBy(asc(pipelineEvents.id));
    }

    it('a second tick makes 0 connector calls and writes nothing; each push is one pipeline event with no person as actor', async () => {
      const { t, leadA, leadB, conn } = await crmFixture();
      await updateAutopilotSettings(t.owner, {
        autopilotEnabled: true,
        enableAutoCrmContactSync: true,
        enableAutoCrmDealOnQualified: true,
      });
      const crm = new ScriptedCrm();
      await runOnce(t.auto, { crmConnectorOverride: crm });
      expect(crm.calls).toBe(4);
      const events = await timeline(t);
      expect(events.map((e) => [e.qualifiedLeadId, e.eventKind, e.fromState, e.toState])).toEqual([
        [leadA.id, 'crm_contact_sync', 'qualified', 'qualified'],
        [leadB.id, 'crm_contact_sync', 'qualified', 'qualified'],
        [leadA.id, 'crm_deal_sync', 'qualified', 'qualified'],
        [leadB.id, 'crm_deal_sync', 'qualified', 'qualified'],
      ]);
      expect(events.every((e) => e.actorUserId === null)).toBe(true);
      expect(events[0]!.payload).toMatchObject({
        crm: 'contact',
        connectionId: conn.id.toString(),
        system: 'hubspot',
        externalId: 'contact-1',
        origin: 'autopilot',
      });

      const second = await runOnce(t.auto, { crmConnectorOverride: crm });
      expect(crm.calls).toBe(4);
      expect(second.steps).toEqual([
        { step: 'auto_crm_contact_sync', outcome: 'success', detail: 'synced=0/0' },
        { step: 'auto_crm_deal_on_qualified', outcome: 'success', detail: 'created=0/0' },
      ]);
      expect(await timeline(t)).toHaveLength(4);
    });

    it("a changed lead's contact is re-pushed with its contact id, never the deal id", async () => {
      const { t, leadA } = await crmFixture();
      await updateAutopilotSettings(t.owner, {
        autopilotEnabled: true,
        enableAutoCrmContactSync: true,
        enableAutoCrmDealOnQualified: true,
      });
      const crm = new ScriptedCrm();
      await runOnce(t.auto, { crmConnectorOverride: crm });
      await db
        .update(qualifiedLeads)
        .set({ contactName: 'Anna', updatedAt: new Date(Date.now() + 1000) })
        .where(eq(qualifiedLeads.id, leadA.id));
      await runOnce(t.auto, { crmConnectorOverride: crm });
      // Contact pushes: A, B (new), then A again with A's contact id.
      expect(crm.contactPrev).toEqual([null, null, 'contact-1']);
    });

    it('a deal without a synced contact is skipped quietly: no call, no error row', async () => {
      const { t } = await crmFixture();
      await updateAutopilotSettings(t.owner, {
        autopilotEnabled: true,
        enableAutoCrmDealOnQualified: true,
      });
      const crm = new ScriptedCrm();
      const run = await runOnce(t.auto, { crmConnectorOverride: crm });
      expect(crm.calls).toBe(0);
      expect(run.steps).toEqual([
        { step: 'auto_crm_deal_on_qualified', outcome: 'success', detail: 'created=0/0' },
      ]);
      expect(await errorRows(t)).toHaveLength(0);
    });

    it('a manual push that advances the lead is a transition on its timeline, by the person', async () => {
      const { t, leadA, conn } = await crmFixture();
      await pushLeadToCrm(t.owner, {
        connectionId: conn.id,
        leadId: leadA.id,
        advanceState: true,
        connectorOverride: new ScriptedCrm(),
      });
      const events = await timeline(t);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        eventKind: 'transition',
        fromState: 'qualified',
        toState: 'synced_to_crm',
        actorUserId: t.ownerId,
      });
      expect(events[0]!.payload).toMatchObject({ crm: 'contact', origin: 'operator' });
    });
  },
);

// ---- (6): step errors → ops incidents ---------------------------------------

describe(
  'a step error raises one ops incident per step per day (PC-11 (6))',
  { timeout: 60_000 },
  () => {
    it('repeated errors of a step on one day are one incident with occurrences counted; another step is another incident', async () => {
      const t = await tenant();
      const A = await product(t, 'Alpha');
      await item(t, 'approved', [{ id: A.id, email: 'a@a.example', leadState: 'qualified' }]);
      await item(t, 'approved', [{ id: A.id, email: 'b@b.example', leadState: 'qualified' }]);
      const conn = await createCrmConnection(t.owner, {
        system: 'hubspot',
        name: 'HS',
        credential: 'pat-test',
      });
      await updateAutopilotSettings(t.owner, {
        autopilotEnabled: true,
        enableAutoCrmContactSync: true,
        enableAutoCrmDealOnQualified: true,
        // A chosen connection keeps being used while it is failing.
        defaultCrmConnectionId: conn.id,
      });
      const ops = new FakeOpsStream();
      const crm = new ScriptedCrm('succeeded', 'failed');

      // Run 1: both deals fail → ONE report for the deal step, 2 occurrences.
      const r1 = await runOnce(t.auto, { crmConnectorOverride: crm, incidentSink: ops.sink });
      expect(ops.calls).toHaveLength(1);
      expect(ops.calls[0]).toMatchObject({
        scope: 'workspace',
        workspaceId: t.workspaceId,
        kind: AUTOPILOT_STEP_FAILED,
        severity: 'error',
        source: 'autopilot.tick',
        occurrences: 2,
        payload: { step: 'auto_crm_deal_on_qualified', runId: r1.runId, errors: 2 },
      });
      expect(ops.calls[0]!.message).toContain('HTTP 500 deal');
      expect((await errorRows(t)).map((e) => e.step)).toEqual([
        'auto_crm_deal_on_qualified',
        'auto_crm_deal_on_qualified',
      ]);

      // Run 2, same day: a new lead's deal fails too → the same incident.
      await item(t, 'approved', [{ id: A.id, email: 'c@c.example', leadState: 'qualified' }]);
      await runOnce(t.auto, { crmConnectorOverride: crm, incidentSink: ops.sink });
      expect(ops.calls).toHaveLength(2);
      expect(ops.events.size).toBe(1);
      expect([...ops.events.values()][0]!.occurrences).toBe(3);

      // Contacts start failing: the contact step is a second incident.
      crm.contact = 'failed';
      await item(t, 'approved', [{ id: A.id, email: 'd@d.example', leadState: 'qualified' }]);
      await runOnce(t.auto, { crmConnectorOverride: crm, incidentSink: ops.sink });
      expect(ops.events.size).toBe(2);
      expect(new Set([...ops.events.values()].map((e) => e.input.payload.step))).toEqual(
        new Set(['auto_crm_deal_on_qualified', 'auto_crm_contact_sync']),
      );

      // A clean run reports nothing.
      const before = ops.calls.length;
      await runOnce(t.auto, { crmConnectorOverride: crm, incidentSink: ops.sink });
      expect(ops.calls.length).toBe(before);
    });

    it('the incident key is per step and UTC day', () => {
      const base = {
        workspaceId: 7n,
        step: 'auto_enqueue_outreach' as const,
        runId: 'run',
        errors: { count: 1, first: 'boom' },
      };
      const morning = autopilotStepIncident({ ...base, at: new Date('2026-10-02T00:05:00Z') });
      const evening = autopilotStepIncident({ ...base, at: new Date('2026-10-02T23:55:00Z') });
      const nextDay = autopilotStepIncident({ ...base, at: new Date('2026-10-03T00:05:00Z') });
      expect(morning.dedupeKey).toBe(
        autopilotIncidentDedupeKey('auto_enqueue_outreach', '2026-10-02'),
      );
      expect(evening.dedupeKey).toBe(morning.dedupeKey);
      expect(nextDay.dedupeKey).not.toBe(morning.dedupeKey);
      expect(
        autopilotStepIncident({
          ...base,
          step: 'auto_approve_projects',
          at: new Date('2026-10-02T12:00:00Z'),
        }).dedupeKey,
      ).not.toBe(morning.dedupeKey);
    });

    it('a step that throws is recorded as an error, reported, and the next step still runs', async () => {
      const t = await tenant();
      const A = await product(t, 'Alpha');
      await item(t, 'new', [{ id: A.id }]);
      await createCrmConnection(t.owner, { system: 'hubspot', name: 'HS', credential: 'pat-test' });
      await updateAutopilotSettings(t.owner, {
        autopilotEnabled: true,
        enableAutoApproveProjects: true,
        autoApproveThreshold: 50,
        enableAutoCrmContactSync: true,
      });
      const crmService = await import('@/lib/services/crm');
      vi.spyOn(crmService, 'listCrmConnections').mockRejectedValue(
        new Error('connections unreadable'),
      );
      const ops = new FakeOpsStream();
      const run = await runOnce(t.auto, { incidentSink: ops.sink });
      expect(run.steps).toEqual([
        { step: 'auto_approve_projects', outcome: 'success', detail: 'approved=1/1' },
        { step: 'auto_crm_contact_sync', outcome: 'error', detail: 'connections unreadable' },
      ]);
      expect(ops.calls).toHaveLength(1);
      expect(ops.calls[0]!.payload).toMatchObject({ step: 'auto_crm_contact_sync', errors: 1 });
    });

    it('a failing sink never breaks the run, and the default sink logs a key once per day', async () => {
      const t = await tenant();
      const A = await product(t, 'Alpha');
      await item(t, 'approved', [{ id: A.id, email: 'a@a.example', leadState: 'qualified' }]);
      const conn = await createCrmConnection(t.owner, {
        system: 'hubspot',
        name: 'HS',
        credential: 'pat-test',
      });
      await updateAutopilotSettings(t.owner, {
        autopilotEnabled: true,
        enableAutoCrmContactSync: true,
        defaultCrmConnectionId: conn.id,
      });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const run = await runOnce(t.auto, {
        crmConnectorOverride: new ScriptedCrm('failed'),
        incidentSink: async () => {
          throw new Error('ops stream down');
        },
      });
      expect(run.steps[0]).toMatchObject({ step: 'auto_crm_contact_sync', outcome: 'success' });

      errors.mockClear();
      const incident = autopilotStepIncident({
        workspaceId: t.workspaceId,
        step: 'auto_crm_contact_sync',
        runId: 'r',
        at: new Date('2026-10-02T10:00:00Z'),
        errors: { count: 1, first: 'boom' },
      });
      await LOG_ONCE_INCIDENT_SINK(incident);
      await LOG_ONCE_INCIDENT_SINK(incident);
      expect(errors).toHaveBeenCalledTimes(1);
    });
  },
);
