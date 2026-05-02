import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { pipelineEvents, qualifiedLeads } from '@/lib/db/schema/pipeline';
import { reviewItems } from '@/lib/db/schema/review';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { createConnector, createRecipe, startRun } from '@/lib/services/connector-run';
import { createProductProfile } from '@/lib/services/product-profile';
import {
  assign,
  ensureQualifiedLead,
  getLead,
  getStateCounts,
  listLeads,
  setNotes,
  transition,
  updateContact,
} from '@/lib/services/pipeline';
import type { PipelineState } from '@/lib/db/schema/pipeline';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  ownerB: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const ownerB = await seedUser({ email: 'ownerB@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  return { workspaceA, workspaceB, ownerA, ownerB };
}

function ctx(workspaceId: bigint, userId: string, role: WorkspaceContext['role'] = 'owner'): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

async function seedReviewItemFor(workspaceId: bigint, ownerId: string) {
  const c = await createConnector(ctx(workspaceId, ownerId), {
    templateType: 'mock',
    name: 'Mock',
    config: {},
  });
  const r = await createRecipe(ctx(workspaceId, ownerId), {
    connectorId: c.id,
    name: 'r',
    selectors: { seed: 'pipeline', count: 1 },
  });
  await startRun(ctx(workspaceId, ownerId), {
    connectorId: c.id,
    recipeId: r.id,
    wait: true,
  });
  const reviews = await db
    .select()
    .from(reviewItems)
    .where(eq(reviewItems.workspaceId, workspaceId));
  return reviews[0]!;
}

// ============ ensure ===============================================

describe('ensureQualifiedLead', () => {
  it('creates a row in initial state with the right timestamp set', async () => {
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P' });
    const ri = await seedReviewItemFor(s.workspaceA, s.ownerA);
    const lead = await ensureQualifiedLead(ctx(s.workspaceA, s.ownerA), ri.id, product.id);
    expect(lead.state).toBe('relevant');
    expect(lead.relevantAt).toBeInstanceOf(Date);
    expect(lead.contactedAt).toBe(null);
    expect(lead.workspaceId).toBe(s.workspaceA);
  });

  it('is idempotent — second call returns the same row', async () => {
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P' });
    const ri = await seedReviewItemFor(s.workspaceA, s.ownerA);
    const a = await ensureQualifiedLead(ctx(s.workspaceA, s.ownerA), ri.id, product.id);
    const b = await ensureQualifiedLead(ctx(s.workspaceA, s.ownerA), ri.id, product.id);
    expect(a.id).toBe(b.id);
    const all = await db
      .select()
      .from(qualifiedLeads)
      .where(eq(qualifiedLeads.workspaceId, s.workspaceA));
    expect(all).toHaveLength(1);
  });

  it('refuses cross-workspace pair', async () => {
    const s = await setup();
    const productA = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'A' });
    const riB = await seedReviewItemFor(s.workspaceB, s.ownerB);
    await expect(
      ensureQualifiedLead(ctx(s.workspaceA, s.ownerA), riB.id, productA.id),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('viewer-denied', async () => {
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P' });
    const ri = await seedReviewItemFor(s.workspaceA, s.ownerA);
    await expect(
      ensureQualifiedLead(ctx(s.workspaceA, s.ownerA, 'viewer'), ri.id, product.id),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

// ============ transitions ===========================================

describe('transition', () => {
  async function seedLead(s: Setup) {
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P' });
    const ri = await seedReviewItemFor(s.workspaceA, s.ownerA);
    const lead = await ensureQualifiedLead(ctx(s.workspaceA, s.ownerA), ri.id, product.id);
    return { product, lead };
  }

  it('walks the canonical path relevant -> contacted -> replied -> ... -> closed', async () => {
    const s = await setup();
    const { lead } = await seedLead(s);
    const path: PipelineState[] = [
      'contacted',
      'replied',
      'contact_identified',
      'qualified',
      'handed_over',
      'synced_to_crm',
    ];
    let id = lead.id;
    for (const next of path) {
      const updated = await transition(ctx(s.workspaceA, s.ownerA), id, { to: next });
      expect(updated.state).toBe(next);
      id = updated.id;
    }
    const final = await transition(ctx(s.workspaceA, s.ownerA), id, {
      to: 'closed',
      closeReason: 'won',
    });
    expect(final.state).toBe('closed');
    expect(final.closeReason).toBe('won');
    expect(final.closedAt).toBeInstanceOf(Date);

    // history has 1 creation event + 7 transitions
    const events = await db
      .select()
      .from(pipelineEvents)
      .where(eq(pipelineEvents.qualifiedLeadId, id));
    expect(events.length).toBeGreaterThanOrEqual(8);
  });

  it('refuses non-forward transition without force', async () => {
    const s = await setup();
    const { lead } = await seedLead(s);
    await expect(
      transition(ctx(s.workspaceA, s.ownerA), lead.id, { to: 'qualified' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('admin can force a non-forward transition', async () => {
    const s = await setup();
    const { lead } = await seedLead(s);
    // Owner is admin — force jump from relevant -> qualified.
    const jumped = await transition(ctx(s.workspaceA, s.ownerA), lead.id, {
      to: 'qualified',
      force: true,
    });
    expect(jumped.state).toBe('qualified');
    expect(jumped.qualifiedAt).toBeInstanceOf(Date);

    const events = await db
      .select()
      .from(pipelineEvents)
      .where(eq(pipelineEvents.qualifiedLeadId, lead.id));
    const forced = events.find((e) =>
      (e.payload as { forced?: boolean }).forced === true,
    );
    expect(forced).toBeDefined();
  });

  it('member cannot force a non-forward transition', async () => {
    const s = await setup();
    const { lead } = await seedLead(s);
    await expect(
      transition(ctx(s.workspaceA, s.ownerA, 'member'), lead.id, {
        to: 'qualified',
        force: true,
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('closing requires closeReason', async () => {
    const s = await setup();
    const { lead } = await seedLead(s);
    await expect(
      transition(ctx(s.workspaceA, s.ownerA), lead.id, { to: 'closed' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    const closed = await transition(ctx(s.workspaceA, s.ownerA), lead.id, {
      to: 'closed',
      closeReason: 'lost',
      closeNote: 'budget gone',
    });
    expect(closed.closeNote).toBe('budget gone');
  });

  it('idempotent re-transition to current state is a no-op', async () => {
    const s = await setup();
    const { lead } = await seedLead(s);
    const a = await transition(ctx(s.workspaceA, s.ownerA), lead.id, { to: 'relevant' });
    expect(a.id).toBe(lead.id);
    const events = await db
      .select()
      .from(pipelineEvents)
      .where(eq(pipelineEvents.qualifiedLeadId, lead.id));
    // Only the initial 'creation' event — no transition event for the no-op.
    expect(events.filter((e) => e.eventKind === 'transition')).toHaveLength(0);
  });
});

// ============ contact + assign + notes =============================

describe('updateContact / assign / setNotes', () => {
  async function seedLead(s: Setup) {
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P' });
    const ri = await seedReviewItemFor(s.workspaceA, s.ownerA);
    return ensureQualifiedLead(ctx(s.workspaceA, s.ownerA), ri.id, product.id);
  }

  it('updateContact stores email lowercased and validates format', async () => {
    const s = await setup();
    const lead = await seedLead(s);
    const updated = await updateContact(ctx(s.workspaceA, s.ownerA), lead.id, {
      contactName: 'Anna Kowalska',
      contactEmail: 'Anna.Kowalska@Example.com',
      contactRole: 'COO',
      contactPhone: '+48 555 123 123',
    });
    expect(updated.contactEmail).toBe('anna.kowalska@example.com');
    expect(updated.contactName).toBe('Anna Kowalska');
    expect(updated.contactRole).toBe('COO');

    await expect(
      updateContact(ctx(s.workspaceA, s.ownerA), lead.id, {
        contactEmail: 'not-an-email',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('assign + assignment event', async () => {
    const s = await setup();
    const lead = await seedLead(s);
    const otherUser = await seedUser({ email: 'sales@test.local' });
    const updated = await assign(ctx(s.workspaceA, s.ownerA), lead.id, otherUser);
    expect(updated.assignedToUserId).toBe(otherUser);

    const events = await db
      .select()
      .from(pipelineEvents)
      .where(eq(pipelineEvents.qualifiedLeadId, lead.id));
    expect(events.find((e) => e.eventKind === 'assignment')).toBeDefined();

    const cleared = await assign(ctx(s.workspaceA, s.ownerA), lead.id, null);
    expect(cleared.assignedToUserId).toBe(null);
  });

  it('setNotes trims and stores', async () => {
    const s = await setup();
    const lead = await seedLead(s);
    const updated = await setNotes(ctx(s.workspaceA, s.ownerA), lead.id, '   needs follow-up\n');
    expect(updated.notes).toBe('needs follow-up');
  });
});

// ============ read =================================================

describe('listLeads + getLead + getStateCounts', () => {
  it('list filters by state and product, getStateCounts aggregates', async () => {
    const s = await setup();
    const p1 = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P1' });
    const p2 = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P2' });
    const ri1 = await seedReviewItemFor(s.workspaceA, s.ownerA);

    const a = await ensureQualifiedLead(ctx(s.workspaceA, s.ownerA), ri1.id, p1.id);
    const b = await ensureQualifiedLead(ctx(s.workspaceA, s.ownerA), ri1.id, p2.id);
    await transition(ctx(s.workspaceA, s.ownerA), b.id, { to: 'contacted' });

    const justRelevant = await listLeads(ctx(s.workspaceA, s.ownerA), { state: 'relevant' });
    expect(justRelevant.map((r) => r.lead.id)).toEqual([a.id]);

    const onlyP2 = await listLeads(ctx(s.workspaceA, s.ownerA), { productProfileId: p2.id });
    expect(onlyP2.map((r) => r.lead.id)).toEqual([b.id]);

    const counts = await getStateCounts(ctx(s.workspaceA, s.ownerA));
    expect(counts.relevant).toBe(1);
    expect(counts.contacted).toBe(1);
    expect(counts.qualified).toBe(0);
  });

  it('getLead returns the lead, joined product/review, and event history', async () => {
    const s = await setup();
    const p = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P' });
    const ri = await seedReviewItemFor(s.workspaceA, s.ownerA);
    const lead = await ensureQualifiedLead(ctx(s.workspaceA, s.ownerA), ri.id, p.id);
    await transition(ctx(s.workspaceA, s.ownerA), lead.id, { to: 'contacted' });
    const detail = await getLead(ctx(s.workspaceA, s.ownerA), lead.id);
    expect(detail.product.id).toBe(p.id);
    expect(detail.reviewItem.id).toBe(ri.id);
    expect(detail.events.length).toBeGreaterThanOrEqual(2); // creation + transition
  });

  it('does not leak across workspaces', async () => {
    const s = await setup();
    const pA = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'A' });
    const riA = await seedReviewItemFor(s.workspaceA, s.ownerA);
    const lead = await ensureQualifiedLead(ctx(s.workspaceA, s.ownerA), riA.id, pA.id);

    const listB = await listLeads(ctx(s.workspaceB, s.ownerB));
    expect(listB).toHaveLength(0);
    await expect(
      getLead(ctx(s.workspaceB, s.ownerB), lead.id),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
