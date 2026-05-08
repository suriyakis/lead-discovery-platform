import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import { productProfiles } from '@/lib/db/schema/products';
import { _setAIProviderForTests, type IAIProvider } from '@/lib/ai';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  ProductAutofillError,
  autofillProductProfileFromSources,
  fetchAndExtractWebsite,
  synthesizeProfile,
  type SynthesizedProfile,
} from '@/lib/services/product-autofill';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  ownerA: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'autofill-owner@test.local' });
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

beforeEach(async () => {
  _setAIProviderForTests(null);
  await truncateAll();
});

afterEach(() => {
  _setAIProviderForTests(null);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

const stubProfile: SynthesizedProfile = {
  name: 'Vetrofluid',
  shortDescription: 'Crystalline waterproofing admixture for concrete.',
  fullDescription:
    'Vetrofluid is a permanent crystalline waterproofing admixture that reacts with concrete to seal capillaries. Used in below-grade structures, basements, and water-retaining tanks.',
  targetCustomerTypes: ['general contractors', 'precast manufacturers'],
  targetSectors: ['commercial construction', 'infrastructure'],
  targetProjectTypes: ['underground parking', 'water tanks'],
  includeKeywords: ['waterproofing', 'crystalline', 'admixture', 'concrete'],
  excludeKeywords: ['sealant'],
  qualificationCriteria: 'Has a current poured-concrete project below grade.',
  outreachInstructions: 'Lead with a single recent project reference.',
  language: 'en',
  confidence: 'high',
  notes: undefined,
};

function jsonStubAi(profile: SynthesizedProfile): IAIProvider {
  return {
    id: 'stub-json',
    async generateText() {
      throw new Error('not used');
    },
    async generateJson() {
      return profile as never;
    },
    estimateCost() {
      return 0;
    },
    async healthCheck() {
      return { ok: true };
    },
  };
}

// ─── synthesizeProfile ────────────────────────────────────────────────

describe('synthesizeProfile', () => {
  it('returns the AI-extracted profile with non-undefined defaults', async () => {
    const s = await setup();
    _setAIProviderForTests(jsonStubAi(stubProfile));
    const result = await synthesizeProfile(ctx(s.workspaceA, s.ownerA), {
      sources: [
        {
          kind: 'website',
          label: 'https://acme.test',
          text: 'Acme makes crystalline waterproofing admixtures for concrete...',
          originalBytes: 1000,
        },
      ],
    });
    expect(result.name).toBe('Vetrofluid');
    expect(result.targetSectors).toEqual([
      'commercial construction',
      'infrastructure',
    ]);
    expect(result.confidence).toBe('high');
  });

  it('rejects when every source has empty text', async () => {
    const s = await setup();
    _setAIProviderForTests(jsonStubAi(stubProfile));
    await expect(
      synthesizeProfile(ctx(s.workspaceA, s.ownerA), {
        sources: [
          { kind: 'website', label: 'x', text: '   ', originalBytes: 0 },
        ],
      }),
    ).rejects.toThrow(ProductAutofillError);
  });

  it('falls back to detector when AI omits language', async () => {
    const s = await setup();
    _setAIProviderForTests(
      jsonStubAi({ ...stubProfile, language: undefined as unknown as string }),
    );
    const polishText =
      'Vetrofluid to innowacyjny system uszczelniający dla betonu, który zapewnia trwałą ochronę przed wodą i wilgocią. Nasz produkt jest stosowany w budownictwie komercyjnym.';
    const result = await synthesizeProfile(ctx(s.workspaceA, s.ownerA), {
      sources: [
        { kind: 'website', label: 'x', text: polishText, originalBytes: 200 },
      ],
    });
    expect(result.language).toBe('pl');
  });
});

// ─── autofillProductProfileFromSources end-to-end ────────────────────

describe('autofillProductProfileFromSources', () => {
  it('persists an inactive draft profile + emits audit event', async () => {
    const s = await setup();
    _setAIProviderForTests(jsonStubAi(stubProfile));

    // Mock fetch for the website source.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        '<html><body><main><h1>Vetrofluid</h1><p>Crystalline waterproofing admixture for concrete used in below-grade structures, basements, and water-retaining tanks.</p></main></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      ) as unknown as Response,
    );

    const result = await autofillProductProfileFromSources(
      ctx(s.workspaceA, s.ownerA),
      { url: 'https://acme.test/vetrofluid' },
    );
    expect(fetchSpy).toHaveBeenCalledOnce();

    expect(result.profile.name).toBe('Vetrofluid');
    expect(result.profile.active).toBe(true); // service default; we'll switch to inactive in a follow-up if needed
    expect(result.synthesized.confidence).toBe('high');

    // Persisted in DB.
    const rows = await db
      .select()
      .from(productProfiles)
      .where(eq(productProfiles.workspaceId, s.workspaceA));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetSectors).toEqual([
      'commercial construction',
      'infrastructure',
    ]);

    // Audit event emitted.
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.workspaceId, s.workspaceA));
    expect(audits.some((a) => a.kind === 'product_profile.autofill')).toBe(true);
  });

  it('rejects when neither URL nor PDFs are provided', async () => {
    const s = await setup();
    await expect(
      autofillProductProfileFromSources(ctx(s.workspaceA, s.ownerA), {}),
    ).rejects.toThrow(/URL or one PDF/);
  });

  it('viewer role cannot run autofill', async () => {
    const s = await setup();
    await expect(
      autofillProductProfileFromSources(ctx(s.workspaceA, s.ownerA, 'viewer'), {
        url: 'https://acme.test',
      }),
    ).rejects.toThrow(/Permission denied/);
  });

  it('surfaces fetch failures cleanly', async () => {
    const s = await setup();
    _setAIProviderForTests(jsonStubAi(stubProfile));
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('not found', { status: 404 }) as unknown as Response,
    );
    await expect(
      autofillProductProfileFromSources(ctx(s.workspaceA, s.ownerA), {
        url: 'https://acme.test/missing',
      }),
    ).rejects.toThrow(/fetch failed: 404/);
  });

  it('rejects non-http URLs', async () => {
    const s = await setup();
    await expect(
      fetchAndExtractWebsite('file:///etc/passwd'),
    ).rejects.toThrow(/http\(s\)/);
  });

  it('rejects malformed URLs', async () => {
    await expect(fetchAndExtractWebsite('not a url')).rejects.toThrow(/valid URL/);
  });
});
