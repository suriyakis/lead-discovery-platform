import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog, usageLog } from '@/lib/db/schema/audit';
import { leadResearch } from '@/lib/db/schema/pipeline';
import { reviewItems } from '@/lib/db/schema/review';
import {
  MockResearchProvider,
  _setResearchProviderForTests,
  dedupeAndRankCitations,
  extractDomain,
  type IResearchProvider,
} from '@/lib/research';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { createConnector, createRecipe, startRun } from '@/lib/services/connector-run';
import { createProductProfile } from '@/lib/services/product-profile';
import { ensureQualifiedLead } from '@/lib/services/pipeline';
import {
  LeadResearchError,
  deleteLeadResearch,
  listLeadResearch,
  researchLead,
} from '@/lib/services/lead-research';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  ownerA: string;
  leadId: bigint;
}

async function seedReviewItem(workspaceId: bigint, ownerId: string) {
  const c = ctx(workspaceId, ownerId);
  const conn = await createConnector(c, {
    templateType: 'mock',
    name: 'Mock',
    config: {},
  });
  const recipe = await createRecipe(c, {
    connectorId: conn.id,
    name: 'r',
    selectors: { seed: 'research', count: 1 },
  });
  await startRun(c, { connectorId: conn.id, recipeId: recipe.id, wait: true });
  const rows = await db
    .select()
    .from(reviewItems)
    .where(eq(reviewItems.workspaceId, workspaceId));
  return rows[0]!;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA-research@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A-research', ownerUserId: ownerA });
  const c = ctx(workspaceA, ownerA);
  const product = await createProductProfile(c, { name: 'Test Product' });
  const ri = await seedReviewItem(workspaceA, ownerA);
  const lead = await ensureQualifiedLead(c, ri.id, product.id);
  return { workspaceA, ownerA, leadId: lead.id };
}

function ctx(workspaceId: bigint, userId: string): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role: 'owner' });
}

beforeEach(async () => {
  _setResearchProviderForTests(new MockResearchProvider());
  await truncateAll();
});

afterEach(() => {
  _setResearchProviderForTests(null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ─── extractDomain / dedupeAndRankCitations ──────────────────────────

describe('extractDomain', () => {
  it('lowercases and strips path', () => {
    expect(extractDomain('https://Example.COM/foo/bar?x=1')).toBe('example.com');
  });

  it('returns empty for invalid urls', () => {
    expect(extractDomain('not a url')).toBe('');
  });
});

describe('dedupeAndRankCitations', () => {
  it('drops duplicates by url and re-ranks', () => {
    const input = [
      { rank: 1, url: 'https://a.com/1', domain: 'a.com', title: 'a1' },
      { rank: 2, url: 'https://A.COM/1', domain: 'a.com', title: 'a1-dup' },
      { rank: 3, url: 'https://b.com/1', domain: 'b.com', title: 'b1' },
    ];
    const out = dedupeAndRankCitations(input, 5);
    expect(out).toHaveLength(2);
    expect(out[0]!.rank).toBe(1);
    expect(out[1]!.rank).toBe(2);
  });

  it('caps to the requested length', () => {
    const lots = Array.from({ length: 20 }).map((_, i) => ({
      rank: i,
      url: `https://x${i}.com`,
      domain: `x${i}.com`,
      title: `x${i}`,
    }));
    expect(dedupeAndRankCitations(lots, 3)).toHaveLength(3);
  });
});

// ─── MockResearchProvider ─────────────────────────────────────────────

describe('MockResearchProvider', () => {
  it('returns deterministic output for the same question', async () => {
    const p = new MockResearchProvider();
    const a = await p.research({ workspaceId: BigInt(1) }, 'What does Acme do?');
    const b = await p.research({ workspaceId: BigInt(1) }, 'What does Acme do?');
    expect(a.answer).toBe(b.answer);
    expect(a.citations).toHaveLength(b.citations.length);
  });

  it('reports zero cost and mock keySource', async () => {
    const p = new MockResearchProvider();
    const r = await p.research({ workspaceId: BigInt(1) }, 'q');
    expect(r.usage.costEstimateCents).toBe(0);
    expect(r.usage.keySource).toBe('mock');
    expect(r.providerId).toBe('mock');
  });

  it('respects maxCitations', async () => {
    const p = new MockResearchProvider();
    const r = await p.research({ workspaceId: BigInt(1) }, 'q', { maxCitations: 5 });
    expect(r.citations.length).toBeLessThanOrEqual(5);
  });
});

// ─── researchLead service ─────────────────────────────────────────────

describe('researchLead', () => {
  it('runs research and persists it on the lead', async () => {
    const s = await setup();
    const r = await researchLead(ctx(s.workspaceA, s.ownerA), {
      qualifiedLeadId: s.leadId,
      question: 'What does this company do?',
    });
    expect(r.cached).toBe(false);
    expect(r.entry.providerId).toBe('mock');
    expect(r.entry.answer).toContain('mock-research');
    expect(r.entry.workspaceId).toBe(s.workspaceA);
    expect(r.entry.qualifiedLeadId).toBe(s.leadId);
  });

  it('hits the cache on second call with the same question', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    const a = await researchLead(c, {
      qualifiedLeadId: s.leadId,
      question: 'cached?',
    });
    const b = await researchLead(c, {
      qualifiedLeadId: s.leadId,
      question: 'cached?',
    });
    expect(b.cached).toBe(true);
    expect(b.entry.id).toBe(a.entry.id);
    const rows = await db
      .select()
      .from(leadResearch)
      .where(eq(leadResearch.qualifiedLeadId, s.leadId));
    expect(rows).toHaveLength(1);
  });

  it('refresh=true bypasses the cache and inserts a new row', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await researchLead(c, { qualifiedLeadId: s.leadId, question: 'forced' });
    await researchLead(c, {
      qualifiedLeadId: s.leadId,
      question: 'forced',
      refresh: true,
    });
    const rows = await db
      .select()
      .from(leadResearch)
      .where(eq(leadResearch.qualifiedLeadId, s.leadId));
    expect(rows).toHaveLength(2);
  });

  it('emits an audit event but no usage_log for mock', async () => {
    const s = await setup();
    await researchLead(ctx(s.workspaceA, s.ownerA), {
      qualifiedLeadId: s.leadId,
      question: 'audit test',
    });
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.workspaceId, s.workspaceA));
    expect(audits.some((a) => a.kind === 'lead_research.run')).toBe(true);
    const usages = await db
      .select()
      .from(usageLog)
      .where(eq(usageLog.workspaceId, s.workspaceA));
    expect(usages.some((u) => u.kind === 'research.query')).toBe(false);
  });

  it('emits a usage_log row when the provider keySource is real', async () => {
    const s = await setup();
    const stub: IResearchProvider = {
      id: 'gemini',
      async research(_c, q) {
        return {
          answer: `real: ${q}`,
          citations: [],
          queriesIssued: [q],
          providerId: 'gemini',
          usage: {
            inputTokens: 100,
            outputTokens: 200,
            searchQueries: 1,
            costEstimateCents: 25,
            keySource: 'platform',
          },
        };
      },
      async testConnection() { return { ok: true }; },
      estimateUsageCost() { return 25; },
    };
    _setResearchProviderForTests(stub);
    await researchLead(ctx(s.workspaceA, s.ownerA), {
      qualifiedLeadId: s.leadId,
      question: 'real call',
    });
    const usages = await db
      .select()
      .from(usageLog)
      .where(eq(usageLog.workspaceId, s.workspaceA));
    const row = usages.find((u) => u.kind === 'research.query');
    expect(row).toBeTruthy();
    expect(row!.provider).toBe('gemini');
    expect(row!.costEstimateCents).toBe(25);
  });

  it('rejects empty + oversized questions', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await expect(
      researchLead(c, { qualifiedLeadId: s.leadId, question: '   ' }),
    ).rejects.toThrow(LeadResearchError);
    await expect(
      researchLead(c, {
        qualifiedLeadId: s.leadId,
        question: 'a'.repeat(601),
      }),
    ).rejects.toThrow(/exceeds/);
  });

  it('refuses cross-workspace lead access', async () => {
    const s = await setup();
    const otherUser = await seedUser({ email: 'other-r@test.local' });
    const otherWs = await seedWorkspace({ name: 'OtherR', ownerUserId: otherUser });
    await expect(
      researchLead(ctx(otherWs, otherUser), {
        qualifiedLeadId: s.leadId,
        question: 'q',
      }),
    ).rejects.toThrow(/not found/);
  });

  it('viewer role cannot run', async () => {
    const s = await setup();
    const viewerCtx = makeWorkspaceContext({
      workspaceId: s.workspaceA,
      userId: s.ownerA,
      role: 'viewer',
    });
    await expect(
      researchLead(viewerCtx, { qualifiedLeadId: s.leadId, question: 'q' }),
    ).rejects.toThrow(/Permission denied/);
  });
});

// ─── listLeadResearch / deleteLeadResearch ────────────────────────────

describe('list + delete leadResearch', () => {
  it('lists newest first', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await researchLead(c, { qualifiedLeadId: s.leadId, question: 'a' });
    await researchLead(c, { qualifiedLeadId: s.leadId, question: 'b' });
    await researchLead(c, { qualifiedLeadId: s.leadId, question: 'c' });
    const rows = await listLeadResearch(c, s.leadId);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.question).toBe('c');
  });

  it('delete removes the row and audit-logs', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    const r = await researchLead(c, {
      qualifiedLeadId: s.leadId,
      question: 'del',
    });
    await deleteLeadResearch(c, r.entry.id);
    const rows = await listLeadResearch(c, s.leadId);
    expect(rows).toHaveLength(0);
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.workspaceId, s.workspaceA));
    expect(audits.some((a) => a.kind === 'lead_research.delete')).toBe(true);
  });
});
