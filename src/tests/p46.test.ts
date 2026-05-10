// P46: research-grounded outreach drafts. Verifies the engine
// surfaces the research context inside the AI prompt when supplied,
// and that the per-product flag drives whether research is fetched
// during generateOutreachDraft.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { outreachDrafts } from '@/lib/db/schema/outreach';
import { leadResearch } from '@/lib/db/schema/pipeline';
import type { ProductProfile } from '@/lib/db/schema/products';
import { reviewItems } from '@/lib/db/schema/review';
import {
  _setAIProviderForTests,
  type IAIProvider,
} from '@/lib/ai';
import {
  _setResearchProviderForTests,
  type IResearchProvider,
} from '@/lib/research';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { createConnector, createRecipe, startRun } from '@/lib/services/connector-run';
import { composeAiDraft } from '@/lib/services/outreach-engine';
import {
  createProductProfile,
  updateProductProfile,
} from '@/lib/services/product-profile';
import { ensureQualifiedLead, updateContact } from '@/lib/services/pipeline';
import { generateOutreachDraft } from '@/lib/services/outreach';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  ownerA: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'p46-owner@test.local' });
  const workspaceA = await seedWorkspace({ name: 'p46', ownerUserId: ownerA });
  return { workspaceA, ownerA };
}

function ctx(workspaceId: bigint, userId: string): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role: 'owner' });
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
    selectors: { seed: 'p46', count: 1 },
  });
  await startRun(c, { connectorId: conn.id, recipeId: recipe.id, wait: true });
  const rows = await db
    .select()
    .from(reviewItems)
    .where(eq(reviewItems.workspaceId, workspaceId));
  return rows[0]!;
}

beforeEach(async () => {
  _setAIProviderForTests(null);
  _setResearchProviderForTests(null);
  await truncateAll();
});

afterEach(() => {
  _setAIProviderForTests(null);
  _setResearchProviderForTests(null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ─── Pure engine: research context flows into the prompt ───────────────

describe('composeAiDraft (research context)', () => {
  function makeProduct(): ProductProfile {
    return {
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
      enrichDraftsWithResearch: true,
      researchQuestionTemplate: 'q?',
      discoveryAngle: null,
      engagementAngle: null,
      pitchAngle: null,
      documentSourceIds: [],
      pricingSnapshotId: null,
      crmMapping: {} as never,
      createdBy: null,
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  it('injects the research block into the user prompt when supplied', async () => {
    let capturedPrompt = '';
    const stub: IAIProvider = {
      id: 'stub',
      model: 'stub-model',
      async generateText(input) {
        capturedPrompt = input.prompt;
        return {
          text: 'reply',
          model: 'stub',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
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
    };
    await composeAiDraft(
      { domain: 'acme.test', title: 'Acme' },
      makeProduct(),
      [],
      { channel: 'email', language: 'en' },
      stub,
      'Acme is a Polish concrete waterproofing company that recently expanded to Germany.',
    );
    expect(capturedPrompt).toContain('Research context');
    expect(capturedPrompt).toContain('recently expanded to Germany');
  });

  it('omits the research block when researchContext is undefined', async () => {
    let capturedPrompt = '';
    const stub: IAIProvider = {
      id: 'stub',
      model: 'stub-model',
      async generateText(input) {
        capturedPrompt = input.prompt;
        return {
          text: 'reply',
          model: 'stub',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
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
    };
    await composeAiDraft(
      { domain: 'acme.test', title: 'Acme' },
      makeProduct(),
      [],
      { channel: 'email', language: 'en' },
      stub,
    );
    expect(capturedPrompt).not.toContain('Research context');
  });
});

// ─── End-to-end: generateOutreachDraft with the flag on ───────────────

describe('generateOutreachDraft with enrichDraftsWithResearch=true', () => {
  it('runs research, persists to lead_research, and includes context in the AI prompt', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    const product = await createProductProfile(c, {
      name: 'Vetrofluid',
      enrichDraftsWithResearch: true,
      researchQuestionTemplate: 'tell me about {company} ({domain})',
      discoveryAngle: null,
      engagementAngle: null,
      pitchAngle: null,
    });
    const ri = await seedReviewItem(s.workspaceA, s.ownerA);
    const lead = await ensureQualifiedLead(c, ri.id, product.id);
    await updateContact(c, lead.id, {
      contactEmail: 'cto@acme.test',
      contactName: 'CTO',
    });

    // Inject stub research provider that yields a deterministic answer.
    const researchStub: IResearchProvider = {
      id: 'gemini',
      async research(_c, q) {
        return {
          answer: `Research answer about: ${q}`,
          citations: [
            { rank: 1, url: 'https://acme.test/about', domain: 'acme.test', title: 'About Acme' },
          ],
          queriesIssued: [q],
          providerId: 'gemini',
          usage: {
            inputTokens: 100,
            outputTokens: 200,
            searchQueries: 1,
            costEstimateCents: 5,
            keySource: 'platform',
          },
        };
      },
      async testConnection() { return { ok: true }; },
      estimateUsageCost() { return 5; },
    };
    _setResearchProviderForTests(researchStub);

    // Inject AI stub that captures the prompt.
    let capturedPrompt = '';
    let capturedSystem = '';
    const aiStub: IAIProvider = {
      id: 'stub-ai',
      model: 'stub-model',
      async generateText(input) {
        capturedPrompt = input.prompt;
        capturedSystem = input.system ?? '';
        return {
          text: 'Drafted body',
          model: 'stub',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      async generateJson() { throw new Error('not used'); },
      estimateCost() { return 0; },
      async healthCheck() { return { ok: true }; },
    };
    _setAIProviderForTests(aiStub);

    const draft = await generateOutreachDraft(c, {
      reviewItemId: ri.id,
      productProfileId: product.id,
      method: 'ai',
    });

    // Prompt has research context with our stubbed answer.
    expect(capturedPrompt).toContain('Research context');
    expect(capturedPrompt).toContain('Research answer about');
    expect(capturedPrompt).toContain('acme.test');
    void capturedSystem;

    // Research entry persisted on the lead (cache).
    const cached = await db
      .select()
      .from(leadResearch)
      .where(eq(leadResearch.qualifiedLeadId, lead.id));
    expect(cached).toHaveLength(1);

    // Draft evidence references the research entry id.
    const evidence = draft.evidence as Record<string, unknown>;
    expect(evidence.researchEntryId).toBe(cached[0]!.id.toString());
  });

  it('does NOT call research when the product flag is off', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    const product = await createProductProfile(c, { name: 'NoEnrich' });
    const ri = await seedReviewItem(s.workspaceA, s.ownerA);
    const lead = await ensureQualifiedLead(c, ri.id, product.id);
    await updateContact(c, lead.id, { contactEmail: 'a@b.test', contactName: 'X' });

    let researchCalls = 0;
    _setResearchProviderForTests({
      id: 'never',
      async research() {
        researchCalls += 1;
        throw new Error('should not be called');
      },
      async testConnection() { return { ok: true }; },
      estimateUsageCost() { return 0; },
    });

    let capturedPrompt = '';
    _setAIProviderForTests({
      id: 'stub-ai',
      model: 'stub-model',
      async generateText(input) {
        capturedPrompt = input.prompt;
        return {
          text: 'body',
          model: 'stub',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      async generateJson() { throw new Error('not used'); },
      estimateCost() { return 0; },
      async healthCheck() { return { ok: true }; },
    });

    const draft = await generateOutreachDraft(c, {
      reviewItemId: ri.id,
      productProfileId: product.id,
      method: 'ai',
    });

    expect(researchCalls).toBe(0);
    expect(capturedPrompt).not.toContain('Research context');
    const evidence = draft.evidence as Record<string, unknown>;
    expect(evidence.researchEntryId).toBeNull();
  });

  it('skips enrichment gracefully when no qualified lead exists for the pair', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    const product = await createProductProfile(c, {
      name: 'EnrichButNoLead',
      enrichDraftsWithResearch: true,
    });
    const ri = await seedReviewItem(s.workspaceA, s.ownerA);
    // Intentionally do NOT call ensureQualifiedLead — the lookup returns null.

    let researchCalls = 0;
    _setResearchProviderForTests({
      id: 'never',
      async research() {
        researchCalls += 1;
        throw new Error('should not be called when no lead exists');
      },
      async testConnection() { return { ok: true }; },
      estimateUsageCost() { return 0; },
    });
    _setAIProviderForTests({
      id: 'stub-ai',
      model: 'stub-model',
      async generateText() {
        return {
          text: 'body',
          model: 'stub',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      async generateJson() { throw new Error('not used'); },
      estimateCost() { return 0; },
      async healthCheck() { return { ok: true }; },
    });

    await generateOutreachDraft(c, {
      reviewItemId: ri.id,
      productProfileId: product.id,
      method: 'ai',
    });
    expect(researchCalls).toBe(0);

    const drafts = await db
      .select()
      .from(outreachDrafts)
      .where(eq(outreachDrafts.workspaceId, s.workspaceA));
    expect(drafts).toHaveLength(1);
    const evidence = drafts[0]!.evidence as Record<string, unknown>;
    expect(evidence.researchEntryId).toBeNull();
  });
});
