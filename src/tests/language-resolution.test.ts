import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db/client';
import {
  connectorRecipes,
  connectorRuns,
  connectors,
  sourceRecords,
} from '@/lib/db/schema/connectors';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { reviewItems } from '@/lib/db/schema/review';
import { makeWorkspaceContext, type WorkspaceContext } from '@/lib/services/context';
import { createProductProfile } from '@/lib/services/product-profile';
import { resolveOutboundLanguage } from '@/lib/services/language-resolution';
import { updateWorkspaceNativeLanguage } from '@/lib/services/workspace';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceId: bigint;
  ownerId: string;
}

let seq = 0;

async function setup(): Promise<Setup> {
  const ownerId = await seedUser({ email: 'owner-langres@test.local' });
  const workspaceId = await seedWorkspace({ name: 'LangRes', ownerUserId: ownerId });
  return { workspaceId, ownerId };
}

function ctx(s: Setup): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId: s.workspaceId, userId: s.ownerId, role: 'owner' });
}

/** Seed connector → recipe → run → source_record → review_item → product →
 *  qualified_lead, with knobs for each language tier. Returns the lead's
 *  (reviewItemId, productProfileId) pair. */
async function seedChain(
  s: Setup,
  opts: {
    recipeLanguage?: string | null;
    snapshotLanguage?: string | null;
    productLanguage?: string;
    productFullDescription?: string | null;
    leadOverride?: string | null;
  } = {},
): Promise<{ reviewItemId: bigint; productProfileId: bigint }> {
  seq += 1;
  const [connector] = await db
    .insert(connectors)
    .values({ workspaceId: s.workspaceId, templateType: 'mock', name: `c-${seq}` })
    .returning();
  const [recipe] = await db
    .insert(connectorRecipes)
    .values({
      workspaceId: s.workspaceId,
      connectorId: connector!.id,
      name: `r-${seq}`,
      templateType: 'mock',
      selectors: opts.recipeLanguage ? { language: opts.recipeLanguage } : {},
    })
    .returning();
  const [run] = await db
    .insert(connectorRuns)
    .values({
      workspaceId: s.workspaceId,
      connectorId: connector!.id,
      recipeId: recipe!.id,
      status: 'succeeded',
      recipeSnapshot: opts.snapshotLanguage ? { language: opts.snapshotLanguage } : null,
    })
    .returning();
  const [sr] = await db
    .insert(sourceRecords)
    .values({
      workspaceId: s.workspaceId,
      sourceSystem: 'mock',
      sourceId: `s-${seq}`,
      recipeId: recipe!.id,
      runId: run!.id,
      rawData: {},
      normalizedData: {},
    })
    .returning();
  const [ri] = await db
    .insert(reviewItems)
    .values({ workspaceId: s.workspaceId, sourceRecordId: sr!.id, state: 'approved' })
    .returning();
  const product = await createProductProfile(ctx(s), {
    name: `p-${seq}`,
    language: opts.productLanguage ?? 'en',
    fullDescription: opts.productFullDescription ?? null,
  });
  await db.insert(qualifiedLeads).values({
    workspaceId: s.workspaceId,
    reviewItemId: ri!.id,
    productProfileId: product.id,
    outreachLanguage: opts.leadOverride ?? null,
  });
  return { reviewItemId: ri!.id, productProfileId: product.id };
}

beforeEach(async () => {
  seq = 0;
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('resolveOutboundLanguage', () => {
  it('1. per-lead override wins over everything', async () => {
    const s = await setup();
    const pair = await seedChain(s, {
      leadOverride: 'he',
      recipeLanguage: 'ja',
      productLanguage: 'de',
    });
    const r = await resolveOutboundLanguage(ctx(s), pair);
    expect(r).toEqual({ language: 'he', source: 'lead' });
  });

  it('2. recipe language wins over the product profile', async () => {
    const s = await setup();
    const pair = await seedChain(s, { recipeLanguage: 'ja', productLanguage: 'de' });
    const r = await resolveOutboundLanguage(ctx(s), pair);
    expect(r).toEqual({ language: 'ja', source: 'recipe' });
  });

  it('3. explicit recipe language beats product free-text detection (R3)', async () => {
    const s = await setup();
    // Product description is Polish and language left at 'en' — without the
    // cascade ordering this would resolve to 'pl' and hijack the campaign.
    const pair = await seedChain(s, {
      recipeLanguage: 'it',
      productLanguage: 'en',
      productFullDescription:
        'Specjalizujemy się w technologii uszczelniania betonu i zapewniamy rozwiązania dla największych projektów budowlanych w kraju.',
    });
    const r = await resolveOutboundLanguage(ctx(s), pair);
    expect(r).toEqual({ language: 'it', source: 'recipe' });
  });

  it('4. falls back to the frozen run snapshot when the recipe has no language', async () => {
    const s = await setup();
    const pair = await seedChain(s, {
      recipeLanguage: null,
      snapshotLanguage: 'de',
      productLanguage: 'en',
    });
    const r = await resolveOutboundLanguage(ctx(s), pair);
    expect(r).toEqual({ language: 'de', source: 'recipe' });
  });

  it('5. uses the product language when no lead/recipe language is set', async () => {
    const s = await setup();
    const pair = await seedChain(s, { recipeLanguage: null, productLanguage: 'de' });
    const r = await resolveOutboundLanguage(ctx(s), pair);
    expect(r).toEqual({ language: 'de', source: 'product' });
  });

  it('6. product free-text detection applies when nothing higher is set', async () => {
    const s = await setup();
    const pair = await seedChain(s, {
      recipeLanguage: null,
      productLanguage: 'en',
      productFullDescription:
        'Specjalizujemy się w technologii uszczelniania betonu i zapewniamy rozwiązania dla największych projektów budowlanych w kraju.',
    });
    const r = await resolveOutboundLanguage(ctx(s), pair);
    expect(r).toEqual({ language: 'pl', source: 'product' });
  });

  it('falls back to the workspace native language when the pair resolves nothing', async () => {
    const s = await setup();
    await updateWorkspaceNativeLanguage(ctx(s), 'pl');
    // Non-existent pair: no lead, no recipe, no product → workspace native.
    const r = await resolveOutboundLanguage(ctx(s), {
      reviewItemId: 999_999n,
      productProfileId: 999_999n,
    });
    expect(r).toEqual({ language: 'pl', source: 'workspace' });
  });
});
