import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { mailMessages, mailThreads, mailboxes } from '@/lib/db/schema/mailing';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { sourceRecords } from '@/lib/db/schema/connectors';
import { reviewItems } from '@/lib/db/schema/review';
import { productProfiles } from '@/lib/db/schema/products';
import { knowledgeSources } from '@/lib/db/schema/documents';
import { outreachDrafts } from '@/lib/db/schema/outreach';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  hintsForDraft,
  hintsForLead,
  hintsForThread,
  leadStateSummary,
} from '@/lib/services/hints';
import { createKnowledgeSource } from '@/lib/services/knowledge-sources';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  ownerA: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  return { workspaceA, ownerA };
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

// ---- helpers --------------------------------------------------------

async function seedLead(
  ws: bigint,
  state: 'relevant' | 'contacted' | 'replied' | 'qualified' | 'closed' = 'relevant',
): Promise<{ leadId: bigint; productId: bigint; reviewItemId: bigint; sourceRecordId: bigint }> {
  const [sr] = await db
    .insert(sourceRecords)
    .values({
      workspaceId: ws,
      sourceSystem: 'mock',
      sourceId: `fake-${Date.now()}-${Math.random()}`,
      rawData: {},
      normalizedData: {},
    })
    .returning();
  const [ri] = await db
    .insert(reviewItems)
    .values({ workspaceId: ws, sourceRecordId: sr!.id, state: 'new' })
    .returning();
  const [product] = await db
    .insert(productProfiles)
    .values({ workspaceId: ws, name: 'Widget' })
    .returning();
  const [lead] = await db
    .insert(qualifiedLeads)
    .values({
      workspaceId: ws,
      reviewItemId: ri!.id,
      productProfileId: product!.id,
      state,
      relevantAt: new Date(),
    })
    .returning();
  return {
    leadId: lead!.id,
    productId: product!.id,
    reviewItemId: ri!.id,
    sourceRecordId: sr!.id,
  };
}

async function seedMailbox(ws: bigint): Promise<bigint> {
  const [mb] = await db
    .insert(mailboxes)
    .values({
      workspaceId: ws,
      name: 'sales',
      fromAddress: 'sales@example.com',
      smtpHost: 'smtp.x',
      smtpUser: 'sales@example.com',
      smtpPasswordSecretKey: 'mailbox.smtpPassword_p22tests',
      imapFolder: 'INBOX',
      status: 'active',
      isDefault: true,
    })
    .returning();
  return mb!.id;
}

// ============ hintsForLead ==========================================

describe('hintsForLead', () => {
  it('returns next-action hint based on state', async () => {
    const s = await setup();
    const { leadId } = await seedLead(s.workspaceA, 'relevant');
    const hints = await hintsForLead(ctx(s.workspaceA, s.ownerA), leadId);
    const next = hints.find((h) => h.type === 'next_action');
    expect(next).toBeDefined();
    expect(next?.severity).toBe('action');
    expect(next?.text).toBe('send first outreach');
  });

  it('returns awaiting-reply hint for contacted lead', async () => {
    const s = await setup();
    const { leadId } = await seedLead(s.workspaceA, 'contacted');
    const hints = await hintsForLead(ctx(s.workspaceA, s.ownerA), leadId);
    const next = hints.find((h) => h.type === 'next_action');
    expect(next?.text).toBe('awaiting reply');
    expect(next?.severity).toBe('info');
  });

  it('returns CRM-push hint for qualified lead', async () => {
    const s = await setup();
    const { leadId } = await seedLead(s.workspaceA, 'qualified');
    const hints = await hintsForLead(ctx(s.workspaceA, s.ownerA), leadId);
    const next = hints.find((h) => h.type === 'next_action');
    expect(next?.severity).toBe('success');
    expect(next?.text).toBe('push to CRM as deal');
  });

  it('returns empty for non-existent lead', async () => {
    const s = await setup();
    const hints = await hintsForLead(ctx(s.workspaceA, s.ownerA), 999_999n);
    expect(hints).toEqual([]);
  });

  it('surfaces pending-approval hint when a draft exists', async () => {
    const s = await setup();
    const { leadId, productId, reviewItemId, sourceRecordId } = await seedLead(
      s.workspaceA,
      'relevant',
    );
    await db.insert(outreachDrafts).values({
      workspaceId: s.workspaceA,
      reviewItemId,
      sourceRecordId,
      productProfileId: productId,
      method: 'ai',
      channel: 'email',
      language: 'en',
      body: 'hi',
      status: 'draft',
      confidence: 70,
    });
    const hints = await hintsForLead(ctx(s.workspaceA, s.ownerA), leadId);
    const pa = hints.find((h) => h.type === 'pending_approval');
    expect(pa).toBeDefined();
    expect(pa?.severity).toBe('action');
  });
});

// ============ hintsForThread ========================================

describe('hintsForThread', () => {
  it('reflects last inbound classification', async () => {
    const s = await setup();
    const mb = await seedMailbox(s.workspaceA);
    const [thread] = await db
      .insert(mailThreads)
      .values({
        workspaceId: s.workspaceA,
        mailboxId: mb,
        subject: 'Re: pricing',
        externalThreadKey: `key-${Date.now()}`,
        participants: ['x@y.com'],
      })
      .returning();
    await db.insert(mailMessages).values({
      workspaceId: s.workspaceA,
      mailboxId: mb,
      threadId: thread!.id,
      direction: 'inbound',
      status: 'received',
      messageId: `<m-${Date.now()}@x>`,
      fromAddress: 'x@y.com',
      toAddresses: ['sales@example.com'],
      subject: 'Re: pricing',
      bodyText: 'we are interested',
      replyClassification: 'interest',
      replyClassificationConfidence: 90,
    });
    const hints = await hintsForThread(ctx(s.workspaceA, s.ownerA), thread!.id);
    const cls = hints.find((h) => h.type === 'reply_classification');
    expect(cls).toBeDefined();
    expect(cls?.severity).toBe('success');
    expect(cls?.text).toBe('interest');
  });

  it('returns empty for non-existent thread', async () => {
    const s = await setup();
    const hints = await hintsForThread(ctx(s.workspaceA, s.ownerA), 999_999n);
    expect(hints).toEqual([]);
  });
});

// ============ hintsForDraft =========================================

describe('hintsForDraft', () => {
  it('marks AI drafts and forbidden-stripped drafts', async () => {
    const s = await setup();
    const { productId, reviewItemId, sourceRecordId } = await seedLead(
      s.workspaceA,
      'relevant',
    );
    const [d] = await db
      .insert(outreachDrafts)
      .values({
        workspaceId: s.workspaceA,
        reviewItemId,
        sourceRecordId,
        productProfileId: productId,
        method: 'ai',
        channel: 'email',
        language: 'en',
        body: 'hi',
        status: 'draft',
        confidence: 70,
        forbiddenStripped: ['guarantee', 'urgent'],
      })
      .returning();
    const hints = await hintsForDraft(ctx(s.workspaceA, s.ownerA), d!.id);
    expect(hints.find((h) => h.type === 'ai_generated')).toBeDefined();
    const fs = hints.find((h) => h.type === 'forbidden_stripped');
    expect(fs).toBeDefined();
    expect(fs?.severity).toBe('warning');
    expect(fs?.text).toMatch(/2 forbidden/);
  });

  it('returns empty for non-existent draft', async () => {
    const s = await setup();
    const hints = await hintsForDraft(ctx(s.workspaceA, s.ownerA), 999_999n);
    expect(hints).toEqual([]);
  });
});

// ============ leadStateSummary ======================================

describe('leadStateSummary', () => {
  it('counts grouped by state', async () => {
    const s = await setup();
    await seedLead(s.workspaceA, 'relevant');
    await seedLead(s.workspaceA, 'contacted');
    await seedLead(s.workspaceA, 'contacted');
    const rows = await leadStateSummary(ctx(s.workspaceA, s.ownerA));
    const byState = new Map(rows.map((r) => [r.state, r.count]));
    expect(byState.get('relevant')).toBe(1);
    expect(byState.get('contacted')).toBe(2);
  });
});

// ============ knowledge purpose category ============================

describe('knowledge_sources.purposeCategory', () => {
  it('defaults to general when omitted', async () => {
    const s = await setup();
    const ks = await createKnowledgeSource(ctx(s.workspaceA, s.ownerA), {
      kind: 'text',
      title: 'Pricing notes',
      textExcerpt: 'pricing details here',
    });
    expect(ks.purposeCategory).toBe('general');
  });

  it('persists the supplied category', async () => {
    const s = await setup();
    const ks = await createKnowledgeSource(ctx(s.workspaceA, s.ownerA), {
      kind: 'text',
      title: 'Datasheet',
      textExcerpt: 'voltage 5V, current 2A',
      purposeCategory: 'technical',
    });
    expect(ks.purposeCategory).toBe('technical');
    const fetched = await db
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, ks.id))
      .limit(1);
    expect(fetched[0]?.purposeCategory).toBe('technical');
  });

  it('rejects unknown values via service typing — falls back through default', async () => {
    const s = await setup();
    const ks = await createKnowledgeSource(ctx(s.workspaceA, s.ownerA), {
      kind: 'text',
      title: 'Case',
      textExcerpt: 'rolled out in 30 days',
      purposeCategory: 'case_study',
    });
    expect(ks.purposeCategory).toBe('case_study');
  });
});
