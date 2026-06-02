// P62-08 tests — Wandizz-style AI qualification.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ZodSchema } from 'zod';
import { db } from '@/lib/db/client';
import { eq } from 'drizzle-orm';
import type {
  AIGenInput,
  AIGenOptions,
  AIGenResult,
  IAIProvider,
} from '@/lib/ai';
import { _setAIProviderForTests } from '@/lib/ai';
import { qualifications } from '@/lib/db/schema/qualifications';
import { sourceRecords } from '@/lib/db/schema/connectors';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { createProductProfile } from '@/lib/services/product-profile';
import { classifyRecordWithAI } from '@/lib/services/qualification-ai';
import { classifySourceRecord } from '@/lib/services/qualification';
import {
  createConnector,
  createRecipe,
  startRun,
} from '@/lib/services/connector-run';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  ownerA: string;
}
async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ai-qual@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  return { workspaceA, ownerA };
}
function ctx(
  workspaceId: bigint,
  userId: string,
  role: 'owner' | 'admin' | 'member' | 'viewer' = 'owner',
): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

class StubAIProvider implements IAIProvider {
  public readonly id = 'stub';
  public readonly model = 'stub-1';
  public lastPrompt: AIGenInput | null = null;
  public callCount = 0;
  constructor(
    private readonly responder: (
      input: AIGenInput,
    ) => Record<string, unknown> | (() => Record<string, unknown> | never),
  ) {}
  async generateText(input: AIGenInput): Promise<AIGenResult> {
    this.lastPrompt = input;
    this.callCount += 1;
    return {
      text: JSON.stringify(this.responder(input)),
      model: this.model,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
  async generateJson<T>(
    input: AIGenInput,
    schema: ZodSchema<T>,
    _options: AIGenOptions = {},
  ): Promise<T> {
    this.lastPrompt = input;
    this.callCount += 1;
    const r = this.responder(input);
    if (typeof r === 'function') {
      r();
    }
    return schema.parse(r);
  }
  estimateCost(): number {
    return 0;
  }
  async healthCheck() {
    return { ok: true, detail: 'stub' };
  }
}

class ThrowingAIProvider implements IAIProvider {
  public readonly id = 'throw';
  public readonly model = 'throw-1';
  async generateText(): Promise<AIGenResult> {
    throw new Error('upstream offline');
  }
  async generateJson<T>(): Promise<T> {
    throw new Error('upstream offline');
  }
  estimateCost(): number {
    return 0;
  }
  async healthCheck() {
    return { ok: false, detail: 'offline' };
  }
}

beforeEach(async () => {
  await truncateAll();
  _setAIProviderForTests(null);
});

afterAll(async () => {
  _setAIProviderForTests(null);
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('classifyRecordWithAI', () => {
  it('returns a verdict in the rules-engine shape with method="ai"', async () => {
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'R3 Repair Mortar',
      shortDescription: 'Two-component cementitious mortar for concrete repair',
      targetSectors: ['infrastructure', 'commercial construction'],
      includeKeywords: ['concrete repair', 'patching', 'restoration'],
      qualificationCriteria: 'Companies offering concrete repair services',
      relevanceThreshold: 60,
    });
    const stub = new StubAIProvider(() => ({
      isRelevant: true,
      relevanceScore: 82,
      confidence: 78,
      matchedKeywords: ['concrete repair', 'infrastructure'],
      disqualifyingSignals: [],
      reason:
        'Concrete repair contractor in Glasgow, services match target sectors.',
    }));

    const verdict = await classifyRecordWithAI(
      ctx(s.workspaceA, s.ownerA),
      {
        title: 'Concrete Repairs - Glasgow',
        snippet: 'Balmore offers expert concrete repair solutions.',
        url: 'https://balmore-ltd.co.uk/concrete-repairs/',
        domain: 'balmore-ltd.co.uk',
        body: null,
      },
      product,
      [],
      { providerOverride: stub },
    );

    expect(verdict.isRelevant).toBe(true);
    expect(verdict.relevanceScore).toBe(82);
    expect(verdict.confidence).toBe(78);
    expect(verdict.method).toBe('ai');
    expect(verdict.matchedKeywords).toContain('concrete repair');
    expect(verdict.qualificationReason).toMatch(/Concrete repair contractor/);
    expect(verdict.rejectionReason).toBeNull();
    expect(stub.callCount).toBe(1);
  });

  it('prompt carries the product profile + record fields the LLM needs', async () => {
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'Vetrofluid Sealer',
      shortDescription: 'Deep-penetrating concrete sealer',
      targetCustomerTypes: ['civil engineers', 'facility managers'],
      targetSectors: ['water and utilities'],
      includeKeywords: ['waterproofing concrete', 'cement matrix'],
      excludeKeywords: ['DIY', 'homeowner'],
      qualificationCriteria: 'Project owners with concrete waterproofing need',
      disqualificationCriteria: 'Residential retail customers',
      relevanceThreshold: 65,
    });
    const stub = new StubAIProvider(() => ({
      isRelevant: false,
      relevanceScore: 12,
      confidence: 60,
      matchedKeywords: [],
      disqualifyingSignals: ['homeowner'],
      reason: 'Residential retail site, not the target customer.',
    }));

    await classifyRecordWithAI(
      ctx(s.workspaceA, s.ownerA),
      {
        title: 'DIY concrete sealer for your driveway',
        snippet: 'Best products for homeowners, no contractor needed.',
        url: null,
        domain: 'diyhome.example',
        body: null,
      },
      product,
      [],
      { providerOverride: stub },
    );

    const prompt = stub.lastPrompt!.prompt;
    // Product fields land in the prompt
    expect(prompt).toContain('Vetrofluid Sealer');
    expect(prompt).toContain('Deep-penetrating');
    expect(prompt).toContain('civil engineers');
    expect(prompt).toContain('water and utilities');
    expect(prompt).toContain('waterproofing concrete');
    expect(prompt).toContain('DIY'); // exclude keyword visible
    expect(prompt).toContain('Project owners with concrete waterproofing');
    expect(prompt).toContain('Residential retail customers');
    expect(prompt).toContain('minRelevanceThreshold: 65');
    // Record fields land in the prompt
    expect(prompt).toContain('DIY concrete sealer for your driveway');
    expect(prompt).toContain('diyhome.example');
    // System prompt asks for JSON in the right shape
    expect(stub.lastPrompt!.system).toContain('"isRelevant"');
    expect(stub.lastPrompt!.system).toContain('"relevanceScore"');
  });

  it('injects a hard geo gate into the prompt when targetCountry is set', async () => {
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'Ecobeton Coating',
      includeKeywords: ['concrete coating'],
      relevanceThreshold: 60,
    });
    const stub = new StubAIProvider(() => ({
      isRelevant: false,
      relevanceScore: 10,
      confidence: 70,
      matchedKeywords: [],
      disqualifyingSignals: ['out of target country'],
      reason: 'US-based company, recipe targets uk.',
    }));

    await classifyRecordWithAI(
      ctx(s.workspaceA, s.ownerA),
      {
        title: 'Concrete coatings USA',
        snippet: 'Texas-based contractor',
        url: null,
        domain: 'example.us',
        body: null,
      },
      product,
      [],
      { providerOverride: stub, targetCountry: 'uk' },
    );

    const prompt = stub.lastPrompt!.prompt;
    expect(prompt).toContain('TARGET GEOGRAPHY');
    expect(prompt).toContain('targets companies in: uk');
    expect(prompt).toMatch(/OUTSIDE uk/);
  });

  it('omits the geo gate when the recipe sets no targetCountry', async () => {
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'Ecobeton Coating',
      relevanceThreshold: 60,
    });
    const stub = new StubAIProvider(() => ({
      isRelevant: true,
      relevanceScore: 70,
      confidence: 70,
      matchedKeywords: [],
      reason: 'fits',
    }));

    await classifyRecordWithAI(
      ctx(s.workspaceA, s.ownerA),
      { title: 't', snippet: 's', url: null, domain: null, body: null },
      product,
      [],
      { providerOverride: stub },
    );

    expect(stub.lastPrompt!.prompt).not.toContain('TARGET GEOGRAPHY');
  });

  it('classifySourceRecord falls back to rules when the AI provider throws', async () => {
    const s = await setup();
    _setAIProviderForTests(new ThrowingAIProvider());
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'Strutturale',
      includeKeywords: ['concrete repair'],
      relevanceThreshold: 60,
    });
    void product;
    // Seed a source record via a mock connector run so classification
    // gets a real row to score against.
    const connector = await createConnector(ctx(s.workspaceA, s.ownerA), {
      templateType: 'mock',
      name: 'mock conn',
    });
    const recipe = await createRecipe(ctx(s.workspaceA, s.ownerA), {
      connectorId: connector.id,
      name: 'mock recipe',
      active: true,
    });
    const { run } = await startRun(ctx(s.workspaceA, s.ownerA), {
      connectorId: connector.id,
      recipeId: recipe.id,
      wait: true,
      waitTimeoutMs: 5000,
    });
    void run;
    // Pull any one source record the mock connector wrote.
    const records = await db
      .select()
      .from(sourceRecords)
      .where(eq(sourceRecords.workspaceId, s.workspaceA))
      .limit(1);
    expect(records.length).toBeGreaterThan(0);
    // Run an extra classification call directly.
    const verdicts = await classifySourceRecord(
      ctx(s.workspaceA, s.ownerA),
      records[0]!.id,
    );
    expect(verdicts.length).toBeGreaterThan(0);
    // method should be 'rules_fallback' since AI threw.
    const rows = await db
      .select({ method: qualifications.method })
      .from(qualifications)
      .where(eq(qualifications.workspaceId, s.workspaceA));
    expect(rows.every((r) => r.method === 'rules_fallback')).toBe(true);
  });
});

describe('Verdict shape', () => {
  it('zod schema rejects out-of-range score', async () => {
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'P',
      relevanceThreshold: 60,
    });
    const stub = new StubAIProvider(() => ({
      isRelevant: true,
      relevanceScore: 9000, // out of range
      confidence: 50,
      matchedKeywords: [],
      reason: 'bad score',
    }));
    await expect(
      classifyRecordWithAI(
        ctx(s.workspaceA, s.ownerA),
        { title: 't', snippet: 's', url: null, domain: null, body: null },
        product,
        [],
        { providerOverride: stub },
      ),
    ).rejects.toThrow(z.ZodError);
  });
});
