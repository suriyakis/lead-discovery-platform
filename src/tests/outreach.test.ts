import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { sourceRecords } from '@/lib/db/schema/connectors';
import { reviewItems } from '@/lib/db/schema/review';
import { outreachDrafts } from '@/lib/db/schema/outreach';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { createConnector, createRecipe, startRun } from '@/lib/services/connector-run';
import { createProductProfile } from '@/lib/services/product-profile';
import { createLesson } from '@/lib/services/learning';
import {
  OutreachServiceError,
  approveOutreachDraft,
  archiveOutreachDraft,
  editOutreachDraft,
  generateOutreachDraft,
  getOutreachDraft,
  listOutreachDrafts,
  rejectOutreachDraft,
  activeDraftFor,
} from '@/lib/services/outreach';
import {
  composeAiDraft,
  composeRulesDraft,
} from '@/lib/services/outreach-engine';
import { _setAIProviderForTests, type IAIProvider } from '@/lib/ai';
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

function ctx(workspaceId: bigint, userId: string, role: WorkspaceContext['role'] = 'owner'): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

beforeEach(async () => {
  _setAIProviderForTests(null);
  await truncateAll();
});

afterAll(async () => {
  _setAIProviderForTests(null);
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ============ pure engine ==============================================

describe('composeRulesDraft (pure engine)', () => {
  function makeProduct(overrides: Partial<ProductProfile> = {}): ProductProfile {
    const base: ProductProfile = {
      id: 1n,
      workspaceId: 1n,
      name: 'TestProduct',
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

  function makeLesson(overrides: Partial<LearningLesson> = {}): LearningLesson {
    const base: LearningLesson = {
      id: 1n,
      workspaceId: 1n,
      productProfileId: null,
      category: 'outreach_style',
      rule: 'Keep it short and friendly.',
      confidence: 80,
      enabled: true,
      sourceEventIds: [],
      sampleCount: 1,
      embedding: null,
      lastAppliedAt: null,
      createdBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as LearningLesson;
    return { ...base, ...overrides };
  }

  it('emits subject, body, evidence; method=rules', () => {
    const v = composeRulesDraft(
      { title: 'Office tower glazing project', domain: 'example.com' },
      makeProduct({ name: 'Glass Co', shortDescription: 'We supply curtain walls.' }),
      [],
      { channel: 'email', language: 'en' },
    );
    expect(v.method).toBe('rules');
    expect(v.subject).toContain('Glass Co');
    expect(v.subject).toContain('Office tower');
    expect(v.body).toContain('Hello');
    expect(v.body).toContain('Office tower glazing project');
    expect(v.body).toContain('curtain walls');
    expect(v.evidence.fields.productName).toBe('Glass Co');
    expect(v.evidence.fields.recordDomain).toBe('example.com');
    expect(v.forbiddenStripped).toEqual([]);
    expect(v.confidence).toBeGreaterThan(40);
    expect(v.confidence).toBeLessThanOrEqual(90);
  });

  it('strips forbidden phrases case-insensitively and records them', () => {
    const v = composeRulesDraft(
      { title: 'Lead' },
      makeProduct({
        name: 'X',
        shortDescription: 'We are the cheapest provider, guaranteed!',
        forbiddenPhrases: ['cheapest', 'guaranteed'],
      }),
      [],
      { channel: 'email', language: 'en' },
    );
    expect(v.body).not.toMatch(/cheapest/i);
    expect(v.body).not.toMatch(/guaranteed/i);
    expect(v.body).toContain('[redacted]');
    expect(v.forbiddenStripped.sort()).toEqual(['cheapest', 'guaranteed']);
  });

  it('injects outreach_style lesson hints into the body', () => {
    const v = composeRulesDraft(
      { title: 'Lead' },
      makeProduct(),
      [
        makeLesson({ category: 'outreach_style', rule: 'Mention regional projects when possible.' }),
        makeLesson({ id: 2n, category: 'qualification_negative', rule: 'Avoid asking about budget early.' }),
      ],
      { channel: 'email', language: 'en' },
    );
    // Only outreach_style / product_positioning / contact_role nudges go into the body.
    expect(v.body).toContain('Mention regional projects');
    expect(v.body).not.toContain('budget');
    // matchedLessonIds includes ALL passed lessons (audit), even non-injected.
    expect(v.matchedLessonIds.map((id) => id.toString()).sort()).toEqual(['1', '2']);
  });

  it('confidence rises with more signals', () => {
    const minimal = composeRulesDraft(
      { title: null },
      makeProduct(),
      [],
      { channel: 'email', language: 'en' },
    );
    const rich = composeRulesDraft(
      { title: 'X', domain: 'y.com' },
      makeProduct({ outreachInstructions: 'Stay concise.' }),
      [
        { ...({ id: 1n } as unknown as LearningLesson), category: 'outreach_style', rule: 'a' } as LearningLesson,
        { ...({ id: 2n } as unknown as LearningLesson), category: 'outreach_style', rule: 'b' } as LearningLesson,
      ],
      { channel: 'email', language: 'en' },
    );
    expect(rich.confidence).toBeGreaterThan(minimal.confidence);
  });
});

describe('composeAiDraft (pure engine)', () => {
  function makeProduct(): ProductProfile {
    return {
      id: 7n,
      workspaceId: 1n,
      name: 'AIProduct',
      shortDescription: 'Short pitch.',
      fullDescription: null,
      targetCustomerTypes: [],
      targetSectors: ['logistics'],
      targetProjectTypes: [],
      includeKeywords: [],
      excludeKeywords: [],
      qualificationCriteria: null,
      disqualificationCriteria: null,
      relevanceThreshold: 50,
      outreachInstructions: 'Sound human.',
      negativeOutreachInstructions: 'No buzzwords.',
      forbiddenPhrases: ['synergy', 'leverage'],
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
  }

  it('uses AI provider, strips forbidden output, marks method=ai', async () => {
    const stub: IAIProvider = {
      id: 'stub',
      async generateText(_input) {
        void _input;
        return {
          text: 'Hello team — we want to leverage our synergy here.',
          model: 'stub-1',
          usage: { inputTokens: 10, outputTokens: 10 },
        };
      },
      async generateJson() { throw new Error('not used'); },
      estimateCost() { return 0; },
      async healthCheck() { return { ok: true }; },
    };

    const v = await composeAiDraft(
      { title: 'Lead', domain: 'lead.example' },
      makeProduct(),
      [],
      { channel: 'email', language: 'en' },
      stub,
    );
    expect(v.method).toBe('ai');
    expect(v.model).toBe('stub-1');
    expect(v.body).not.toMatch(/synergy/i);
    expect(v.body).not.toMatch(/leverage/i);
    expect(v.forbiddenStripped.sort()).toEqual(['leverage', 'synergy']);
    expect(v.evidence.promptSystem).toContain('AIProduct');
    expect(v.evidence.promptUser).toContain('lead.example');
  });

  it('confidence drops as forbidden strips multiply', async () => {
    const noStrip: IAIProvider = {
      id: 'clean',
      async generateText() {
        return { text: 'Clean output.', model: 'm', usage: { inputTokens: 1, outputTokens: 1 } };
      },
      async generateJson() { throw new Error('not used'); },
      estimateCost() { return 0; },
      async healthCheck() { return { ok: true }; },
    };
    const dirty: IAIProvider = {
      id: 'dirty',
      async generateText() {
        return { text: 'synergy leverage synergy', model: 'm', usage: { inputTokens: 1, outputTokens: 1 } };
      },
      async generateJson() { throw new Error('not used'); },
      estimateCost() { return 0; },
      async healthCheck() { return { ok: true }; },
    };
    const a = await composeAiDraft({}, makeProduct(), [], { channel: 'email', language: 'en' }, noStrip);
    const b = await composeAiDraft({}, makeProduct(), [], { channel: 'email', language: 'en' }, dirty);
    expect(a.confidence).toBeGreaterThan(b.confidence);
  });
});

// ============ DB-backed service ==========================================

describe('generateOutreachDraft (DB-backed)', () => {
  async function seedRecordViaConnectorRun(workspaceId: bigint, ownerId: string) {
    const c = await createConnector(ctx(workspaceId, ownerId), {
      templateType: 'mock',
      name: 'Mock',
      config: {},
    });
    const r = await createRecipe(ctx(workspaceId, ownerId), {
      connectorId: c.id,
      name: 'r',
      selectors: { seed: 'outreach', count: 2, delayMs: 0 },
    });
    await startRun(ctx(workspaceId, ownerId), {
      connectorId: c.id,
      recipeId: r.id,
      wait: true,
    });
    const records = await db
      .select()
      .from(sourceRecords)
      .where(eq(sourceRecords.workspaceId, workspaceId));
    const reviews = await db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.workspaceId, workspaceId));
    return { records, reviews };
  }

  it('writes a draft for a (review_item, product) pair', async () => {
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'PA',
      shortDescription: 'thing we sell',
    });
    const { reviews } = await seedRecordViaConnectorRun(s.workspaceA, s.ownerA);
    const reviewItem = reviews[0]!;

    const draft = await generateOutreachDraft(ctx(s.workspaceA, s.ownerA), {
      reviewItemId: reviewItem.id,
      productProfileId: product.id,
    });

    expect(draft.workspaceId).toBe(s.workspaceA);
    expect(draft.reviewItemId).toBe(reviewItem.id);
    expect(draft.productProfileId).toBe(product.id);
    expect(draft.status).toBe('draft');
    expect(draft.method).toBe('rules');
    expect(draft.body).toContain('Hello');
    expect(draft.subject).toContain('PA');
    expect(draft.qualificationId).not.toBeNull(); // runner auto-classified
  });

  it('a second generate for the same pair supersedes the prior draft', async () => {
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P' });
    const { reviews } = await seedRecordViaConnectorRun(s.workspaceA, s.ownerA);
    const reviewItem = reviews[0]!;

    const first = await generateOutreachDraft(ctx(s.workspaceA, s.ownerA), {
      reviewItemId: reviewItem.id,
      productProfileId: product.id,
    });
    const second = await generateOutreachDraft(ctx(s.workspaceA, s.ownerA), {
      reviewItemId: reviewItem.id,
      productProfileId: product.id,
    });

    expect(second.id).not.toBe(first.id);

    const all = await db
      .select()
      .from(outreachDrafts)
      .where(eq(outreachDrafts.workspaceId, s.workspaceA));
    expect(all).toHaveLength(2);
    const firstReloaded = all.find((d) => d.id === first.id)!;
    const secondReloaded = all.find((d) => d.id === second.id)!;
    expect(firstReloaded.status).toBe('superseded');
    expect(secondReloaded.status).toBe('draft');
  });

  it('forbidden phrases are stripped and recorded', async () => {
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'Promo',
      shortDescription: 'We are the absolutely cheapest, guaranteed.',
      forbiddenPhrases: ['cheapest', 'guaranteed'],
    });
    const { reviews } = await seedRecordViaConnectorRun(s.workspaceA, s.ownerA);
    const draft = await generateOutreachDraft(ctx(s.workspaceA, s.ownerA), {
      reviewItemId: reviews[0]!.id,
      productProfileId: product.id,
    });
    expect(draft.body).not.toMatch(/cheapest/i);
    expect(draft.body).not.toMatch(/guaranteed/i);
    expect(draft.forbiddenStripped.sort()).toEqual(['cheapest', 'guaranteed']);
  });

  it('product-scoped outreach lessons influence the draft body', async () => {
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'P',
      shortDescription: 'we do things',
    });
    await createLesson(ctx(s.workspaceA, s.ownerA), {
      category: 'outreach_style',
      rule: 'Reference cross-border logistics expertise when relevant.',
      productProfileId: product.id,
    });
    const { reviews } = await seedRecordViaConnectorRun(s.workspaceA, s.ownerA);
    const draft = await generateOutreachDraft(ctx(s.workspaceA, s.ownerA), {
      reviewItemId: reviews[0]!.id,
      productProfileId: product.id,
    });
    expect(draft.body).toContain('cross-border logistics');
    expect(draft.matchedLessonIds.length).toBeGreaterThan(0);
  });

  it('uses AI provider when method=ai', async () => {
    const s = await setup();
    _setAIProviderForTests({
      id: 'stub',
      async generateText() {
        return {
          text: 'Crafted by AI. This is the body.',
          model: 'ai-1',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      async generateJson() { throw new Error('n/a'); },
      estimateCost() { return 0; },
      async healthCheck() { return { ok: true }; },
    });
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P' });
    const { reviews } = await seedRecordViaConnectorRun(s.workspaceA, s.ownerA);
    const draft = await generateOutreachDraft(ctx(s.workspaceA, s.ownerA), {
      reviewItemId: reviews[0]!.id,
      productProfileId: product.id,
      method: 'ai',
    });
    expect(draft.method).toBe('ai');
    expect(draft.model).toBe('ai-1');
    expect(draft.body).toContain('Crafted by AI');
  });

  it('refuses to generate against an archived product profile', async () => {
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P' });
    // Archive directly via service module
    const { archiveProductProfile } = await import('@/lib/services/product-profile');
    await archiveProductProfile(ctx(s.workspaceA, s.ownerA), product.id);
    const { reviews } = await seedRecordViaConnectorRun(s.workspaceA, s.ownerA);
    await expect(
      generateOutreachDraft(ctx(s.workspaceA, s.ownerA), {
        reviewItemId: reviews[0]!.id,
        productProfileId: product.id,
      }),
    ).rejects.toBeInstanceOf(OutreachServiceError);
  });

  it('refuses when review_item is in another workspace', async () => {
    const s = await setup();
    const productA = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'A' });
    const { reviews: reviewsB } = await seedRecordViaConnectorRun(s.workspaceB, s.ownerB);
    await expect(
      generateOutreachDraft(ctx(s.workspaceA, s.ownerA), {
        reviewItemId: reviewsB[0]!.id,
        productProfileId: productA.id,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('viewers cannot generate', async () => {
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P' });
    const { reviews } = await seedRecordViaConnectorRun(s.workspaceA, s.ownerA);
    await expect(
      generateOutreachDraft(
        ctx(s.workspaceA, s.ownerA, 'viewer'),
        { reviewItemId: reviews[0]!.id, productProfileId: product.id },
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

describe('outreach lifecycle (DB-backed)', () => {
  async function seedDraft(s: Setup) {
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'P',
      shortDescription: 'descr',
    });
    const c = await createConnector(ctx(s.workspaceA, s.ownerA), {
      templateType: 'mock',
      name: 'Mock',
      config: {},
    });
    const r = await createRecipe(ctx(s.workspaceA, s.ownerA), {
      connectorId: c.id,
      name: 'r',
      selectors: { seed: 'lifecycle', count: 1 },
    });
    await startRun(ctx(s.workspaceA, s.ownerA), {
      connectorId: c.id,
      recipeId: r.id,
      wait: true,
    });
    const reviews = await db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.workspaceId, s.workspaceA));
    const draft = await generateOutreachDraft(ctx(s.workspaceA, s.ownerA), {
      reviewItemId: reviews[0]!.id,
      productProfileId: product.id,
    });
    return { product, reviewItem: reviews[0]!, draft };
  }

  it('approve marks status=approved with approver + timestamp', async () => {
    const s = await setup();
    const { draft } = await seedDraft(s);
    const approved = await approveOutreachDraft(ctx(s.workspaceA, s.ownerA), draft.id);
    expect(approved.status).toBe('approved');
    expect(approved.approvedByUserId).toBe(s.ownerA);
    expect(approved.approvedAt).toBeInstanceOf(Date);
  });

  it('reject marks status=rejected with reason', async () => {
    const s = await setup();
    const { draft } = await seedDraft(s);
    const rejected = await rejectOutreachDraft(
      ctx(s.workspaceA, s.ownerA),
      draft.id,
      'too generic',
    );
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionReason).toBe('too generic');
    expect(rejected.rejectedByUserId).toBe(s.ownerA);
  });

  it('edit moves status to needs_edit and re-strips forbidden in body', async () => {
    const s = await setup();
    const { draft, product } = await seedDraft(s);
    // Add a forbidden phrase to the product, then edit body containing it.
    const { updateProductProfile } = await import('@/lib/services/product-profile');
    await updateProductProfile(ctx(s.workspaceA, s.ownerA), product.id, {
      forbiddenPhrases: ['guaranteed'],
    });
    const edited = await editOutreachDraft(ctx(s.workspaceA, s.ownerA), draft.id, {
      subject: 'New subject',
      body: 'We are guaranteed to help. Best, X.',
    });
    expect(edited.status).toBe('needs_edit');
    expect(edited.subject).toBe('New subject');
    expect(edited.body).not.toMatch(/guaranteed/i);
    expect(edited.forbiddenStripped).toContain('guaranteed');
    expect(edited.editedByUserId).toBe(s.ownerA);
  });

  it('cannot approve a draft already in a terminal status', async () => {
    const s = await setup();
    const { draft } = await seedDraft(s);
    await approveOutreachDraft(ctx(s.workspaceA, s.ownerA), draft.id);
    await expect(
      approveOutreachDraft(ctx(s.workspaceA, s.ownerA), draft.id),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('archive (admin-only) sets status=superseded', async () => {
    const s = await setup();
    const { draft } = await seedDraft(s);
    const archived = await archiveOutreachDraft(ctx(s.workspaceA, s.ownerA), draft.id);
    expect(archived.status).toBe('superseded');
  });

  it('archive denied for non-admin members', async () => {
    const s = await setup();
    const { draft } = await seedDraft(s);
    await expect(
      archiveOutreachDraft(ctx(s.workspaceA, s.ownerA, 'member'), draft.id),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

describe('listOutreachDrafts + activeDraftFor', () => {
  it('list excludes superseded by default', async () => {
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P' });
    const c = await createConnector(ctx(s.workspaceA, s.ownerA), {
      templateType: 'mock',
      name: 'Mock',
      config: {},
    });
    const r = await createRecipe(ctx(s.workspaceA, s.ownerA), {
      connectorId: c.id,
      name: 'r',
      selectors: { seed: 'list', count: 1 },
    });
    await startRun(ctx(s.workspaceA, s.ownerA), {
      connectorId: c.id,
      recipeId: r.id,
      wait: true,
    });
    const reviews = await db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.workspaceId, s.workspaceA));
    await generateOutreachDraft(ctx(s.workspaceA, s.ownerA), {
      reviewItemId: reviews[0]!.id,
      productProfileId: product.id,
    });
    const v2 = await generateOutreachDraft(ctx(s.workspaceA, s.ownerA), {
      reviewItemId: reviews[0]!.id,
      productProfileId: product.id,
    });

    const list = await listOutreachDrafts(ctx(s.workspaceA, s.ownerA));
    expect(list).toHaveLength(1);
    expect(list[0]!.draft.id).toBe(v2.id);

    // Including superseded:
    const all = await listOutreachDrafts(
      ctx(s.workspaceA, s.ownerA),
      { excludeSuperseded: false },
    );
    expect(all).toHaveLength(2);
  });

  it('does not leak across workspaces', async () => {
    const s = await setup();
    const productA = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'A' });
    const productB = await createProductProfile(ctx(s.workspaceB, s.ownerB), { name: 'B' });

    for (const ws of [s.workspaceA, s.workspaceB] as const) {
      const owner = ws === s.workspaceA ? s.ownerA : s.ownerB;
      const c = await createConnector(ctx(ws, owner), {
        templateType: 'mock',
        name: 'Mock',
        config: {},
      });
      const r = await createRecipe(ctx(ws, owner), {
        connectorId: c.id,
        name: 'r',
        selectors: { seed: `iso-${ws}`, count: 1 },
      });
      await startRun(ctx(ws, owner), { connectorId: c.id, recipeId: r.id, wait: true });
    }
    const reviewsA = await db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.workspaceId, s.workspaceA));
    const reviewsB = await db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.workspaceId, s.workspaceB));
    await generateOutreachDraft(ctx(s.workspaceA, s.ownerA), {
      reviewItemId: reviewsA[0]!.id,
      productProfileId: productA.id,
    });
    await generateOutreachDraft(ctx(s.workspaceB, s.ownerB), {
      reviewItemId: reviewsB[0]!.id,
      productProfileId: productB.id,
    });

    const onlyA = await listOutreachDrafts(ctx(s.workspaceA, s.ownerA));
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0]!.draft.workspaceId).toBe(s.workspaceA);

    const onlyB = await listOutreachDrafts(ctx(s.workspaceB, s.ownerB));
    expect(onlyB).toHaveLength(1);
    expect(onlyB[0]!.draft.workspaceId).toBe(s.workspaceB);
  });

  it('activeDraftFor returns the most-recent non-superseded draft', async () => {
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P' });
    const c = await createConnector(ctx(s.workspaceA, s.ownerA), {
      templateType: 'mock',
      name: 'Mock',
      config: {},
    });
    const r = await createRecipe(ctx(s.workspaceA, s.ownerA), {
      connectorId: c.id,
      name: 'r',
      selectors: { seed: 'active', count: 1 },
    });
    await startRun(ctx(s.workspaceA, s.ownerA), { connectorId: c.id, recipeId: r.id, wait: true });
    const reviews = await db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.workspaceId, s.workspaceA));
    await generateOutreachDraft(ctx(s.workspaceA, s.ownerA), {
      reviewItemId: reviews[0]!.id,
      productProfileId: product.id,
    });
    const v2 = await generateOutreachDraft(ctx(s.workspaceA, s.ownerA), {
      reviewItemId: reviews[0]!.id,
      productProfileId: product.id,
    });

    const active = await activeDraftFor(
      ctx(s.workspaceA, s.ownerA),
      reviews[0]!.id,
      product.id,
    );
    expect(active?.id).toBe(v2.id);
  });

  it('getOutreachDraft refuses cross-workspace lookup', async () => {
    const s = await setup();
    const productA = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'A' });
    const c = await createConnector(ctx(s.workspaceA, s.ownerA), {
      templateType: 'mock',
      name: 'Mock',
      config: {},
    });
    const r = await createRecipe(ctx(s.workspaceA, s.ownerA), {
      connectorId: c.id,
      name: 'r',
      selectors: { seed: 'cross', count: 1 },
    });
    await startRun(ctx(s.workspaceA, s.ownerA), { connectorId: c.id, recipeId: r.id, wait: true });
    const reviews = await db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.workspaceId, s.workspaceA));
    const draft = await generateOutreachDraft(ctx(s.workspaceA, s.ownerA), {
      reviewItemId: reviews[0]!.id,
      productProfileId: productA.id,
    });
    await expect(
      getOutreachDraft(ctx(s.workspaceB, s.ownerB), draft.id),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
