// Locality enforcement tests — the geo gate must hold on EVERY path:
// AI qualification, rules fallback, and the send-time guard.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { _setAIProviderForTests, type IAIProvider } from '@/lib/ai';
import type { AIGenInput, AIGenResult } from '@/lib/ai';
import type { ZodSchema } from 'zod';
import { qualifications } from '@/lib/db/schema/qualifications';
import { sourceRecords } from '@/lib/db/schema/connectors';
import { reviewItems } from '@/lib/db/schema/review';
import { outreachQueue } from '@/lib/db/schema/outreach';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  applyGeoGate,
  inferCountryFromRecord,
  normalizeCountry,
} from '@/lib/services/geo';
import type { ClassificationVerdict } from '@/lib/services/qualification-engine';
import { classifySourceRecord } from '@/lib/services/qualification';
import {
  createConnector,
  createRecipe,
  startRun,
} from '@/lib/services/connector-run';
import { createProductProfile } from '@/lib/services/product-profile';
import { ensureQualifiedLead, updateContact } from '@/lib/services/pipeline';
import { approveOutreachDraft, generateOutreachDraft } from '@/lib/services/outreach';
import { createMailbox } from '@/lib/services/mailbox';
import { drainQueue, enqueueDraft } from '@/lib/services/outreach-queue';
import { MockMailProvider } from '@/lib/mail';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

// ---- pure unit tests ---------------------------------------------------

describe('normalizeCountry', () => {
  it('accepts alpha-2 codes in any case', () => {
    expect(normalizeCountry('PL')).toBe('PL');
    expect(normalizeCountry('pl')).toBe('PL');
    expect(normalizeCountry(' de ')).toBe('DE');
  });

  it('maps common shorthands and names', () => {
    expect(normalizeCountry('UK')).toBe('GB');
    expect(normalizeCountry('uk')).toBe('GB');
    expect(normalizeCountry('USA')).toBe('US');
    expect(normalizeCountry('Poland')).toBe('PL');
    expect(normalizeCountry('poland')).toBe('PL');
    expect(normalizeCountry('Germany')).toBe('DE');
    expect(normalizeCountry('United Kingdom')).toBe('GB');
    expect(normalizeCountry('Czech Republic')).toBe('CZ');
  });

  it('maps native names for target markets', () => {
    expect(normalizeCountry('polska')).toBe('PL');
    expect(normalizeCountry('Deutschland')).toBe('DE');
    expect(normalizeCountry('România')).toBe('RO');
    expect(normalizeCountry('Italia')).toBe('IT');
  });

  it('returns null for unknown values — never guesses', () => {
    expect(normalizeCountry('Atlantis')).toBeNull();
    expect(normalizeCountry('XZ')).toBeNull();
    expect(normalizeCountry('')).toBeNull();
    expect(normalizeCountry(null)).toBeNull();
    expect(normalizeCountry(undefined)).toBeNull();
  });
});

describe('inferCountryFromRecord', () => {
  it('reads the ccTLD', () => {
    expect(
      inferCountryFromRecord({ domain: 'firma.pl', title: null, snippet: null, url: null, body: null })
        .country,
    ).toBe('PL');
    expect(
      inferCountryFromRecord({ domain: 'acme.co.uk', title: null, snippet: null, url: null, body: null })
        .country,
    ).toBe('GB');
  });

  it('ignores generic/vanity ccTLDs and gTLDs', () => {
    for (const domain of ['startup.io', 'brand.ai', 'company.com', 'shop.co']) {
      expect(
        inferCountryFromRecord({ domain, title: null, snippet: null, url: null, body: null }).country,
      ).toBeNull();
    }
  });

  it('reads a unique international phone prefix', () => {
    const r = inferCountryFromRecord({
      domain: 'acme.com',
      title: 'Acme',
      snippet: 'Call us: +48 22 123 45 67',
      url: null,
      body: null,
    });
    expect(r.country).toBe('PL');
  });

  it('refuses to choose between conflicting phone prefixes', () => {
    const r = inferCountryFromRecord({
      domain: 'acme.com',
      title: 'Acme',
      snippet: 'Warsaw office +48 22 123 4567, Berlin office +49 30 123 4567',
      url: null,
      body: null,
    });
    expect(r.country).toBeNull();
  });

  it('reads a unique country-name mention', () => {
    const r = inferCountryFromRecord({
      domain: 'acme.com',
      title: 'Acme Construction',
      snippet: 'A leading contractor based in Poland.',
      url: null,
      body: null,
    });
    expect(r.country).toBe('PL');
  });

  it('refuses multi-country pages', () => {
    const r = inferCountryFromRecord({
      domain: 'acme.com',
      title: 'Acme Group',
      snippet: 'Offices in Poland, Germany and France.',
      url: null,
      body: null,
    });
    expect(r.country).toBeNull();
  });
});

function verdict(overrides: Partial<ClassificationVerdict> = {}): ClassificationVerdict {
  return {
    isRelevant: true,
    relevanceScore: 80,
    confidence: 85,
    matchedKeywords: ['concrete'],
    disqualifyingSignals: [],
    qualificationReason: 'fits',
    rejectionReason: null,
    evidence: { contributions: [], matchedLessonIds: [] },
    method: 'rules',
    ...overrides,
  };
}

const plRecord = {
  title: 'Firma budowlana',
  snippet: 'Generalny wykonawca',
  url: 'https://firma.pl',
  domain: 'firma.pl',
  body: null,
};

describe('applyGeoGate', () => {
  it('no target → no_gate, verdict untouched', () => {
    const v = verdict();
    const r = applyGeoGate(v, plRecord, null);
    expect(r.geoStatus).toBe('no_gate');
    expect(r.verdict).toBe(v);
  });

  it('matching country → match, verdict untouched', () => {
    const r = applyGeoGate(verdict(), plRecord, 'PL');
    expect(r.geoStatus).toBe('match');
    expect(r.inferredCountry).toBe('PL');
    expect(r.verdict.isRelevant).toBe(true);
  });

  it('normalizes the target before comparing (uk vs GB inference)', () => {
    const gbRecord = { ...plRecord, domain: 'acme.co.uk', url: 'https://acme.co.uk' };
    const r = applyGeoGate(verdict(), gbRecord, 'uk');
    expect(r.geoStatus).toBe('match');
    expect(r.targetCountry).toBe('GB');
  });

  it('mismatch → hard disqualify, product fit never overrides', () => {
    const r = applyGeoGate(verdict({ relevanceScore: 98 }), plRecord, 'DE');
    expect(r.geoStatus).toBe('mismatch');
    expect(r.verdict.isRelevant).toBe(false);
    expect(r.verdict.rejectionReason).toContain('outside target country');
    expect(r.verdict.disqualifyingSignals.join(',')).toContain('geo:mismatch');
  });

  it('AI-detected country outranks heuristic inference', () => {
    // Record looks Polish by TLD, but the model saw a German address.
    const r = applyGeoGate(verdict(), plRecord, 'PL', 'DE');
    expect(r.geoStatus).toBe('mismatch');
    expect(r.inferredCountry).toBe('DE');
    expect(r.verdict.isRelevant).toBe(false);
  });

  it('unknown location → unverified, kept but flagged with capped confidence', () => {
    const unknownRecord = { ...plRecord, domain: 'acme.com', url: 'https://acme.com', title: 'Acme', snippet: 'contractor' };
    const r = applyGeoGate(verdict({ confidence: 90 }), unknownRecord, 'PL');
    expect(r.geoStatus).toBe('unverified');
    expect(r.verdict.isRelevant).toBe(true);
    expect(r.verdict.confidence).toBeLessThanOrEqual(60);
    expect(r.verdict.disqualifyingSignals.join(',')).toContain('geo:unverified');
  });
});

// ---- integration: qualification + rules fallback + recipe save --------

interface Setup {
  workspaceA: bigint;
  ownerA: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'geo@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  return { workspaceA, ownerA };
}

function ctx(
  workspaceId: bigint,
  userId: string,
  role: WorkspaceContext['role'] = 'owner',
): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
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

class StubAIProvider implements IAIProvider {
  public readonly id = 'stub';
  public readonly model = 'stub-1';
  constructor(private readonly response: Record<string, unknown>) {}
  async generateText(_input: AIGenInput): Promise<AIGenResult> {
    return { text: JSON.stringify(this.response), model: this.model, usage: { inputTokens: 0, outputTokens: 0 } };
  }
  async generateJson<T>(_input: AIGenInput, schema: ZodSchema<T>): Promise<T> {
    return schema.parse(this.response);
  }
  estimateCost(): number {
    return 0;
  }
  async healthCheck() {
    return { ok: true, detail: 'stub' };
  }
}

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  _setAIProviderForTests(null);
});

afterAll(async () => {
  _setAIProviderForTests(null);
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

/** Seed a mock-connector record with a recipe targeting `country`, then
 *  overwrite its normalizedData so the tests control the location signals. */
async function seedRecordWithCountry(
  s: Setup,
  country: string | undefined,
  normalizedData: Record<string, unknown>,
) {
  const c = await createConnector(ctx(s.workspaceA, s.ownerA), {
    templateType: 'mock',
    name: 'Mock',
    config: {},
  });
  const r = await createRecipe(ctx(s.workspaceA, s.ownerA), {
    connectorId: c.id,
    name: 'r',
    selectors: { seed: 'q', count: 1, ...(country ? { country } : {}) },
  });
  await startRun(ctx(s.workspaceA, s.ownerA), {
    connectorId: c.id,
    recipeId: r.id,
    wait: true,
    waitTimeoutMs: 5000,
  });
  const records = await db
    .select()
    .from(sourceRecords)
    .where(eq(sourceRecords.workspaceId, s.workspaceA))
    .limit(1);
  expect(records.length).toBeGreaterThan(0);
  const record = records[0]!;
  await db
    .update(sourceRecords)
    .set({ normalizedData })
    .where(eq(sourceRecords.id, record.id));
  return record;
}

describe('classifySourceRecord geo gate', () => {
  it('rules fallback enforces the country when the AI provider is down', async () => {
    const s = await setup();
    _setAIProviderForTests(new ThrowingAIProvider());
    await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'Sealer',
      includeKeywords: ['concrete repair'],
      relevanceThreshold: 55,
    });
    const record = await seedRecordWithCountry(s, 'PL', {
      title: 'concrete repair services',
      snippet: 'German contractor',
      url: 'https://acme.de',
      domain: 'acme.de',
    });

    const verdicts = await classifySourceRecord(ctx(s.workspaceA, s.ownerA), record.id);
    expect(verdicts.length).toBe(1);
    const q = verdicts[0]!;
    expect(q.method).toBe('rules_fallback');
    expect(q.geoStatus).toBe('mismatch');
    expect(q.isRelevant).toBe(false);
    expect(q.targetCountry).toBe('PL');
    expect(q.inferredCountry).toBe('DE');
    expect(q.rejectionReason).toContain('outside target country');
  });

  it('unknown location under a country gate → unverified + review escalation', async () => {
    const s = await setup();
    _setAIProviderForTests(new ThrowingAIProvider());
    await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'Sealer',
      includeKeywords: ['concrete repair'],
      relevanceThreshold: 55,
    });
    const record = await seedRecordWithCountry(s, 'PL', {
      title: 'concrete repair services',
      snippet: 'contractor',
      url: 'https://acme.com',
      domain: 'acme.com',
    });

    const verdicts = await classifySourceRecord(ctx(s.workspaceA, s.ownerA), record.id);
    const q = verdicts[0]!;
    expect(q.geoStatus).toBe('unverified');
    expect(q.isRelevant).toBe(true);
    expect(q.confidence).toBeLessThanOrEqual(60);

    // The backing review item must demand human attention.
    const reviews = await db
      .select()
      .from(reviewItems)
      .where(
        and(
          eq(reviewItems.workspaceId, s.workspaceA),
          eq(reviewItems.sourceRecordId, record.id),
        ),
      );
    expect(reviews[0]!.state).toBe('needs_review');
  });

  it('deterministic gate overrides a misbehaving AI that approves out-of-country', async () => {
    const s = await setup();
    // AI says "relevant" but honestly reports the company is in Germany.
    _setAIProviderForTests(
      new StubAIProvider({
        isRelevant: true,
        relevanceScore: 88,
        confidence: 80,
        matchedKeywords: ['concrete repair'],
        disqualifyingSignals: [],
        reason: 'great fit',
        detectedCountry: 'DE',
      }),
    );
    await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'Sealer',
      includeKeywords: ['concrete repair'],
      relevanceThreshold: 55,
    });
    const record = await seedRecordWithCountry(s, 'PL', {
      title: 'concrete repair services',
      snippet: 'contractor',
      url: 'https://acme.com',
      domain: 'acme.com',
    });

    const verdicts = await classifySourceRecord(ctx(s.workspaceA, s.ownerA), record.id);
    const q = verdicts[0]!;
    expect(q.method).toBe('ai');
    expect(q.geoStatus).toBe('mismatch');
    expect(q.isRelevant).toBe(false);
    expect(q.inferredCountry).toBe('DE');
  });

  it('no recipe country → no_gate (behaviour unchanged)', async () => {
    const s = await setup();
    _setAIProviderForTests(new ThrowingAIProvider());
    await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'Sealer',
      includeKeywords: ['concrete repair'],
      relevanceThreshold: 55,
    });
    const record = await seedRecordWithCountry(s, undefined, {
      title: 'concrete repair services',
      snippet: 'contractor',
      url: 'https://acme.de',
      domain: 'acme.de',
    });

    const verdicts = await classifySourceRecord(ctx(s.workspaceA, s.ownerA), record.id);
    const q = verdicts[0]!;
    expect(q.geoStatus).toBe('no_gate');
    expect(q.isRelevant).toBe(true);
  });
});

describe('recipe country validation', () => {
  it('rejects an unrecognisable country at save time', async () => {
    const s = await setup();
    const c = await createConnector(ctx(s.workspaceA, s.ownerA), {
      templateType: 'mock',
      name: 'Mock',
      config: {},
    });
    await expect(
      createRecipe(ctx(s.workspaceA, s.ownerA), {
        connectorId: c.id,
        name: 'bad',
        selectors: { country: 'Atlantis' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('canonicalises names to ISO alpha-2 at save time', async () => {
    const s = await setup();
    const c = await createConnector(ctx(s.workspaceA, s.ownerA), {
      templateType: 'mock',
      name: 'Mock',
      config: {},
    });
    const recipe = await createRecipe(ctx(s.workspaceA, s.ownerA), {
      connectorId: c.id,
      name: 'ok',
      selectors: { country: 'poland' },
    });
    expect((recipe.selectors as Record<string, unknown>).country).toBe('PL');
  });
});

// ---- integration: send-time guard --------------------------------------

async function seedQueuedDraft(s: Setup) {
  const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
    name: 'P',
    shortDescription: 'thing',
  });
  const c = await createConnector(ctx(s.workspaceA, s.ownerA), {
    templateType: 'mock',
    name: 'Mock',
    config: {},
  });
  const r = await createRecipe(ctx(s.workspaceA, s.ownerA), {
    connectorId: c.id,
    name: 'r',
    selectors: { seed: 'q', count: 1 },
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
  const review = reviews[0]!;
  const lead = await ensureQualifiedLead(ctx(s.workspaceA, s.ownerA), review.id, product.id);
  await updateContact(ctx(s.workspaceA, s.ownerA), lead.id, {
    contactName: 'Anna',
    contactEmail: 'anna@target.com',
  });
  const draft = await generateOutreachDraft(ctx(s.workspaceA, s.ownerA), {
    reviewItemId: review.id,
    productProfileId: product.id,
  });
  await approveOutreachDraft(ctx(s.workspaceA, s.ownerA), draft.id);
  const mailbox = await createMailbox(ctx(s.workspaceA, s.ownerA), {
    name: 'sales',
    fromAddress: 'sales@nulife.pl',
    smtpHost: 'smtp.example.com',
    smtpUser: 'sales@nulife.pl',
    smtpPassword: 'pw',
    imap: { host: 'imap.example.com', user: 'sales@nulife.pl', password: 'pw' },
  });
  await enqueueDraft(ctx(s.workspaceA, s.ownerA), {
    draftId: draft.id,
    mailboxId: mailbox.id,
    delayMode: 'immediate',
  });
  return { product, review, draft };
}

async function setGeo(
  s: Setup,
  review: { sourceRecordId: bigint },
  productId: bigint,
  geoStatus: string,
  targetCountry: string | null = 'PL',
  inferredCountry: string | null = null,
) {
  await db
    .update(qualifications)
    .set({ geoStatus, targetCountry, inferredCountry })
    .where(
      and(
        eq(qualifications.workspaceId, s.workspaceA),
        eq(qualifications.sourceRecordId, review.sourceRecordId),
        eq(qualifications.productProfileId, productId),
      ),
    );
}

describe('send-time geo guard', () => {
  it('blocks a geo-mismatched draft at dispatch', async () => {
    const s = await setup();
    const { product, review } = await seedQueuedDraft(s);
    await setGeo(s, review, product.id, 'mismatch', 'PL', 'DE');

    const r = await drainQueue(ctx(s.workspaceA, s.ownerA), {
      providerOverride: new MockMailProvider(),
    });
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe(1);

    const entries = await db
      .select()
      .from(outreachQueue)
      .where(eq(outreachQueue.workspaceId, s.workspaceA));
    expect(entries[0]!.status).toBe('skipped');
    expect(entries[0]!.lastError).toContain('geo blocked');
  });

  it('blocks geo-unverified drafts until the review item is human-approved', async () => {
    const s = await setup();
    const { product, review } = await seedQueuedDraft(s);
    await setGeo(s, review, product.id, 'unverified', 'PL', null);
    // Make sure the review item is NOT approved.
    await db
      .update(reviewItems)
      .set({ state: 'needs_review' })
      .where(eq(reviewItems.id, review.id));

    const blocked = await drainQueue(ctx(s.workspaceA, s.ownerA), {
      providerOverride: new MockMailProvider(),
    });
    expect(blocked.sent).toBe(0);
    expect(blocked.skipped).toBe(1);

    // Human approves → re-queue the entry → dispatch goes through.
    await db
      .update(reviewItems)
      .set({ state: 'approved' })
      .where(eq(reviewItems.id, review.id));
    await db
      .update(outreachQueue)
      .set({ status: 'queued', lastError: null })
      .where(eq(outreachQueue.workspaceId, s.workspaceA));

    const allowed = await drainQueue(ctx(s.workspaceA, s.ownerA), {
      providerOverride: new MockMailProvider(),
    });
    expect(allowed.sent).toBe(1);
  });

  it('match / no_gate sends normally', async () => {
    const s = await setup();
    const { product, review } = await seedQueuedDraft(s);
    await setGeo(s, review, product.id, 'match', 'PL', 'PL');

    const r = await drainQueue(ctx(s.workspaceA, s.ownerA), {
      providerOverride: new MockMailProvider(),
    });
    expect(r.sent).toBe(1);
  });
});
