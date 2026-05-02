import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { qualifications } from '@/lib/db/schema/qualifications';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import { classifyRecord } from '@/lib/services/qualification-engine';
import {
  classifySourceRecord,
  listQualificationsForRecord,
  reclassifyWorkspace,
  topQualification,
} from '@/lib/services/qualification';
import { createConnector, createRecipe, startRun } from '@/lib/services/connector-run';
import { createProductProfile, updateProductProfile } from '@/lib/services/product-profile';
import { createLesson } from '@/lib/services/learning';
import { sourceRecords } from '@/lib/db/schema/connectors';
import type { ProductProfile } from '@/lib/db/schema/products';
import type { LearningLesson } from '@/lib/db/schema/learning';
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

function ctx(workspaceId: bigint, userId: string): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role: 'owner' });
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ============ pure rule engine =========================================

describe('classifyRecord (pure engine)', () => {
  function makeProduct(overrides: Partial<ProductProfile> = {}): ProductProfile {
    const base: ProductProfile = {
      id: 1n,
      workspaceId: 1n,
      name: 'Test',
      shortDescription: null,
      fullDescription: null,
      targetCustomerTypes: [],
      targetSectors: [],
      targetProjectTypes: [],
      includeKeywords: [],
      excludeKeywords: [],
      qualificationCriteria: null,
      disqualificationCriteria: null,
      relevanceThreshold: 50,
      outreachInstructions: null,
      negativeOutreachInstructions: null,
      forbiddenPhrases: [],
      language: 'en',
      active: true,
      documentSourceIds: [],
      pricingSnapshotId: null,
      crmMapping: {} as never,
      createdBy: null,
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    return { ...base, ...overrides };
  }

  it('base score 50 with no signals', () => {
    const v = classifyRecord({ title: 'random text' }, makeProduct(), []);
    expect(v.relevanceScore).toBe(50);
    expect(v.isRelevant).toBe(true); // 50 >= threshold 50
    expect(v.method).toBe('rules');
  });

  it('include keywords boost score and surface in matchedKeywords', () => {
    const v = classifyRecord(
      { title: 'Acoustic glass facade for office tower', snippet: 'fire-rated' },
      makeProduct({ includeKeywords: ['acoustic', 'fire-rated', 'irrelevant'] }),
      [],
    );
    expect(v.matchedKeywords.sort()).toEqual(['acoustic', 'fire-rated']);
    expect(v.relevanceScore).toBe(50 + 6 + 6);
    expect(v.isRelevant).toBe(true);
    expect(v.qualificationReason).toContain('include');
  });

  it('exclude keywords lower score and surface in disqualifyingSignals', () => {
    const v = classifyRecord(
      { title: 'Residential apartment refurbishment' },
      makeProduct({
        includeKeywords: ['refurbishment'],
        excludeKeywords: ['residential'],
      }),
      [],
    );
    expect(v.matchedKeywords).toEqual(['refurbishment']);
    expect(v.disqualifyingSignals[0]).toMatch(/excluded:residential/);
    expect(v.relevanceScore).toBe(50 + 6 - 25);
    expect(v.isRelevant).toBe(false);
    expect(v.rejectionReason).toContain('threshold');
  });

  it('forbidden phrase forces rejection regardless of score', () => {
    const v = classifyRecord(
      { title: 'amazing acoustic glass with cheap pricing' },
      makeProduct({
        includeKeywords: ['acoustic', 'glass', 'amazing'],
        forbiddenPhrases: ['cheap'],
        relevanceThreshold: 30,
      }),
      [],
    );
    expect(v.isRelevant).toBe(false);
    expect(v.rejectionReason).toBe('forbidden phrase matched');
    expect(v.disqualifyingSignals).toContain('forbidden:cheap');
  });

  it('sector hits add bonuses', () => {
    const v = classifyRecord(
      { title: 'New construction project in Manchester', snippet: 'commercial property' },
      makeProduct({ targetSectors: ['construction', 'retail'] }),
      [],
    );
    expect(v.relevanceScore).toBe(50 + 10);
    expect(v.qualificationReason).toContain('sectors: construction');
  });

  it('positive lessons add to score; negative lessons subtract', () => {
    const positive: LearningLesson = {
      id: 1n,
      workspaceId: 1n,
      productProfileId: null,
      category: 'qualification_positive',
      rule: 'Healthcare projects with budget over £5M are great fits',
      evidenceEventIds: [],
      enabled: true,
      confidence: 80,
      embedding: null,
      embeddingModel: null,
      embeddingDim: 1536,
      embeddedAt: null,
      createdBy: null,
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const negative: LearningLesson = {
      ...positive,
      id: 2n,
      category: 'qualification_negative',
      rule: 'Skip residential schemes — wrong fit',
    };
    const v1 = classifyRecord(
      { title: 'Healthcare facility — large budget approval' },
      makeProduct(),
      [positive],
    );
    expect(v1.relevanceScore).toBe(50 + 10);

    const v2 = classifyRecord(
      { title: 'Residential schemes in london' },
      makeProduct(),
      [negative],
    );
    expect(v2.relevanceScore).toBe(50 - 15);
    expect(v2.disqualifyingSignals.some((s) => s.startsWith('lesson:'))).toBe(true);
  });

  it('disabled lessons are ignored', () => {
    const lesson: LearningLesson = {
      id: 1n,
      workspaceId: 1n,
      productProfileId: null,
      category: 'qualification_negative',
      rule: 'Skip residential',
      evidenceEventIds: [],
      enabled: false,
      confidence: 80,
      embedding: null,
      embeddingModel: null,
      embeddingDim: 1536,
      embeddedAt: null,
      createdBy: null,
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const v = classifyRecord(
      { title: 'Residential apartment' },
      makeProduct(),
      [lesson],
    );
    expect(v.relevanceScore).toBe(50); // no -15 from the disabled lesson
  });

  it('confidence grows with signal count', () => {
    const lowSignal = classifyRecord({ title: 'something' }, makeProduct(), []);
    const highSignal = classifyRecord(
      { title: 'acoustic glass facade for healthcare new construction' },
      makeProduct({
        includeKeywords: ['acoustic', 'glass', 'facade'],
        targetSectors: ['healthcare', 'construction'],
      }),
      [],
    );
    expect(highSignal.confidence).toBeGreaterThan(lowSignal.confidence);
  });

  it('score is clamped 0..100', () => {
    const veryNegative = classifyRecord(
      { title: 'cheap rubbish bad terrible avoid' },
      makeProduct({
        excludeKeywords: ['cheap', 'rubbish', 'bad', 'terrible', 'avoid'],
        forbiddenPhrases: ['rubbish'],
      }),
      [],
    );
    expect(veryNegative.relevanceScore).toBeGreaterThanOrEqual(0);

    const veryPositive = classifyRecord(
      { title: 'a b c d e f g h', snippet: 'i j k l m n o p q r' },
      makeProduct({
        includeKeywords: Array.from({ length: 30 }, (_, i) => String.fromCharCode(97 + (i % 18))),
      }),
      [],
    );
    expect(veryPositive.relevanceScore).toBeLessThanOrEqual(100);
  });
});

// ============ service: classifySourceRecord ============================

describe('classifySourceRecord (DB-backed)', () => {
  async function seedRecordViaConnectorRun(workspaceId: bigint, ownerId: string) {
    const c = await createConnector(ctx(workspaceId, ownerId), {
      templateType: 'mock',
      name: 'Mock',
      config: {},
    });
    const r = await createRecipe(ctx(workspaceId, ownerId), {
      connectorId: c.id,
      name: 'r',
      selectors: { seed: 'classification', count: 2, delayMs: 0 },
    });
    await startRun(ctx(workspaceId, ownerId), {
      connectorId: c.id,
      recipeId: r.id,
      wait: true,
    });
    const rows = await db.select().from(sourceRecords).where(eq(sourceRecords.workspaceId, workspaceId));
    return rows;
  }

  it('writes one qualification per active product profile in the workspace', async () => {
    const s = await setup();
    await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'P1',
      includeKeywords: ['mock'],
    });
    await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'P2',
      includeKeywords: ['nothing-matches'],
    });

    const records = await seedRecordViaConnectorRun(s.workspaceA, s.ownerA);
    expect(records.length).toBeGreaterThan(0);
    const first = records[0]!;

    const list = await listQualificationsForRecord(
      ctx(s.workspaceA, s.ownerA),
      first.id,
    );
    expect(list).toHaveLength(2);
    const names = list.map((q) => q.product.name).sort();
    expect(names).toEqual(['P1', 'P2']);
  });

  it('inactive product profiles are skipped', async () => {
    const s = await setup();
    const p1 = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P1' });
    await updateProductProfile(ctx(s.workspaceA, s.ownerA), p1.id, { active: false });
    const records = await seedRecordViaConnectorRun(s.workspaceA, s.ownerA);
    expect(records.length).toBeGreaterThan(0);

    const list = await listQualificationsForRecord(
      ctx(s.workspaceA, s.ownerA),
      records[0]!.id,
    );
    expect(list).toHaveLength(0);
  });

  it('runs idempotently — same input twice produces one row, updated', async () => {
    const s = await setup();
    const p1 = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'P1',
      includeKeywords: ['mock'],
      relevanceThreshold: 30,
    });
    const records = await seedRecordViaConnectorRun(s.workspaceA, s.ownerA);
    if (!records[0]) return;
    const first = await classifySourceRecord(ctx(s.workspaceA, s.ownerA), records[0].id);
    const second = await classifySourceRecord(ctx(s.workspaceA, s.ownerA), records[0].id);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);

    // Only ONE row exists for this (record, product) pair.
    const rows = await db
      .select()
      .from(qualifications)
      .where(eq(qualifications.productProfileId, p1.id));
    expect(rows).toHaveLength(records.length); // 1 per record, not 2x
  });

  it('topQualification returns the highest-scoring product fit', async () => {
    const s = await setup();
    await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'GoodFit',
      includeKeywords: ['mock', 'snippet'],
    });
    await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'BadFit',
      excludeKeywords: ['mock'],
    });
    const records = await seedRecordViaConnectorRun(s.workspaceA, s.ownerA);
    if (!records[0]) return;

    const top = await topQualification(ctx(s.workspaceA, s.ownerA), records[0].id);
    expect(top?.product.name).toBe('GoodFit');
    expect(top?.qualification.isRelevant).toBe(true);
  });

  it('product-scoped lessons influence only that product', async () => {
    const s = await setup();
    const a = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'A',
      includeKeywords: ['mock'],
    });
    const b = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'B',
      includeKeywords: ['mock'],
    });
    // Negative lesson scoped to A only.
    await createLesson(ctx(s.workspaceA, s.ownerA), {
      category: 'qualification_negative',
      rule: 'Skip records with synthetic content',
      productProfileId: a.id,
    });
    const records = await seedRecordViaConnectorRun(s.workspaceA, s.ownerA);
    if (!records[0]) return;

    const list = await listQualificationsForRecord(
      ctx(s.workspaceA, s.ownerA),
      records[0].id,
    );
    const aQ = list.find((x) => x.product.id === a.id);
    const bQ = list.find((x) => x.product.id === b.id);
    expect(aQ).toBeTruthy();
    expect(bQ).toBeTruthy();
    if (!aQ || !bQ) return;
    // A picked up the lesson penalty, B did not.
    expect(aQ.qualification.relevanceScore).toBeLessThan(bQ.qualification.relevanceScore);
  });

  it('runner auto-classifies new records', async () => {
    const s = await setup();
    await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P1' });
    // startRun -> runner emits records -> auto-classify hooks in.
    const records = await seedRecordViaConnectorRun(s.workspaceA, s.ownerA);
    for (const r of records) {
      const list = await listQualificationsForRecord(ctx(s.workspaceA, s.ownerA), r.id);
      expect(list).toHaveLength(1);
    }
  });

  it('reclassifyWorkspace re-evaluates every record', async () => {
    const s = await setup();
    await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'P1',
      includeKeywords: ['mock'],
    });
    const records = await seedRecordViaConnectorRun(s.workspaceA, s.ownerA);
    const result = await reclassifyWorkspace(ctx(s.workspaceA, s.ownerA));
    expect(result.recordCount).toBe(records.length);
    expect(result.qualificationCount).toBe(records.length);
  });

  it('does not leak across workspaces', async () => {
    const s = await setup();
    await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P1' });
    const records = await seedRecordViaConnectorRun(s.workspaceA, s.ownerA);
    if (!records[0]) return;
    const fromB = await listQualificationsForRecord(ctx(s.workspaceB, s.ownerB), records[0].id);
    expect(fromB).toHaveLength(0);
  });
});
