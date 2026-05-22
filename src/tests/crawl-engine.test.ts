// Phase 62 — Crawl Engine tests.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { connectorRecipes, crawlPlans } from '@/lib/db/schema/connectors';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  createConnector,
  createRecipe,
  updateRecipe,
} from '@/lib/services/connector-run';
import { createProductProfile } from '@/lib/services/product-profile';
import {
  CrawlEngineError,
  createCrawlPlan,
  currentLocalHour,
  deleteCrawlPlan,
  getCrawlPlan,
  isInQuietHours,
  listCrawlPlans,
  processDueCrawlPlans,
  runCrawlPlanNow,
  updateCrawlPlan,
} from '@/lib/services/crawl-engine';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  ownerB: string;
}
async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'crawla@test.local' });
  const ownerB = await seedUser({ email: 'crawlb@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  return { workspaceA, workspaceB, ownerA, ownerB };
}
function ctx(
  workspaceId: bigint,
  userId: string,
  role: 'owner' | 'admin' | 'member' | 'viewer' = 'owner',
): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

async function makeMockRecipe(s: Setup, ws: bigint, owner: string, name: string) {
  const c = ctx(ws, owner);
  const conn = await createConnector(c, {
    templateType: 'mock',
    name: `conn-${name}`,
  });
  const recipe = await createRecipe(c, {
    connectorId: conn.id,
    name,
    active: true,
  });
  return { connector: conn, recipe };
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('quiet-hour math', () => {
  it('null both sides = always allowed', () => {
    expect(isInQuietHours(3, null, null)).toBe(false);
    expect(isInQuietHours(22, null, null)).toBe(false);
  });

  it('simple range (10..14) is exclusive of end', () => {
    expect(isInQuietHours(9, 10, 14)).toBe(false);
    expect(isInQuietHours(10, 10, 14)).toBe(true);
    expect(isInQuietHours(13, 10, 14)).toBe(true);
    expect(isInQuietHours(14, 10, 14)).toBe(false);
  });

  it('wrapping range (22..6) covers late evening and early morning', () => {
    expect(isInQuietHours(22, 22, 6)).toBe(true);
    expect(isInQuietHours(23, 22, 6)).toBe(true);
    expect(isInQuietHours(0, 22, 6)).toBe(true);
    expect(isInQuietHours(5, 22, 6)).toBe(true);
    expect(isInQuietHours(6, 22, 6)).toBe(false);
    expect(isInQuietHours(12, 22, 6)).toBe(false);
  });

  it('zero-width window (5..5) is treated as off', () => {
    expect(isInQuietHours(5, 5, 5)).toBe(false);
    expect(isInQuietHours(12, 5, 5)).toBe(false);
  });

  it('currentLocalHour returns 0–23', () => {
    const h = currentLocalHour(new Date(), 'Europe/Warsaw');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(23);
  });

  it('currentLocalHour tolerates a bogus timezone', () => {
    const h = currentLocalHour(new Date(), 'Mars/Olympus');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(23);
  });
});

describe('createCrawlPlan', () => {
  it('persists with sensible defaults', async () => {
    const s = await setup();
    const { recipe } = await makeMockRecipe(s, s.workspaceA, s.ownerA, 'r1');
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'Widget',
      description: 'Widgets for the EU market',
    });
    const plan = await createCrawlPlan(ctx(s.workspaceA, s.ownerA), {
      name: 'Hourly widgets',
      intervalMinutes: 60,
      recipeIds: [recipe.id],
      productProfileIds: [product.id],
    });
    expect(plan.name).toBe('Hourly widgets');
    expect(plan.enabled).toBe(true);
    expect(plan.intervalMinutes).toBe(60);
    expect(plan.timezone).toBe('Europe/Warsaw');
    expect(plan.recipeIds.map(String)).toEqual([recipe.id.toString()]);
    expect(plan.productProfileIds.map(String)).toEqual([product.id.toString()]);
    expect(plan.nextRunAt).not.toBeNull();
  });

  it('rejects sub-5-minute intervals', async () => {
    const s = await setup();
    await expect(
      createCrawlPlan(ctx(s.workspaceA, s.ownerA), {
        name: 'too fast',
        intervalMinutes: 1,
        recipeIds: [],
        productProfileIds: [],
      }),
    ).rejects.toThrow(/intervalMinutes must be/);
  });

  it('rejects mismatched quiet hours (only start set)', async () => {
    const s = await setup();
    await expect(
      createCrawlPlan(ctx(s.workspaceA, s.ownerA), {
        name: 'half quiet',
        intervalMinutes: 60,
        quietStartHour: 22,
        quietEndHour: null,
        recipeIds: [],
        productProfileIds: [],
      }),
    ).rejects.toThrow(/both be set or both null/);
  });

  it('rejects cross-workspace recipe id', async () => {
    const s = await setup();
    const { recipe } = await makeMockRecipe(s, s.workspaceB, s.ownerB, 'r-b');
    await expect(
      createCrawlPlan(ctx(s.workspaceA, s.ownerA), {
        name: 'leaky',
        intervalMinutes: 60,
        recipeIds: [recipe.id],
        productProfileIds: [],
      }),
    ).rejects.toThrow(/recipe id\(s\) do not belong/);
  });

  it('viewers cannot create', async () => {
    const s = await setup();
    await expect(
      createCrawlPlan(ctx(s.workspaceA, s.ownerA, 'viewer'), {
        name: 'denied',
        intervalMinutes: 60,
        recipeIds: [],
        productProfileIds: [],
      }),
    ).rejects.toBeInstanceOf(CrawlEngineError);
  });
});

describe('updateCrawlPlan + delete', () => {
  it('patches selected fields only', async () => {
    const s = await setup();
    const { recipe } = await makeMockRecipe(s, s.workspaceA, s.ownerA, 'r1');
    const plan = await createCrawlPlan(ctx(s.workspaceA, s.ownerA), {
      name: 'p1',
      intervalMinutes: 60,
      recipeIds: [recipe.id],
      productProfileIds: [],
    });
    const updated = await updateCrawlPlan(ctx(s.workspaceA, s.ownerA), plan.id, {
      enabled: false,
      intervalMinutes: 120,
    });
    expect(updated.enabled).toBe(false);
    expect(updated.intervalMinutes).toBe(120);
    expect(updated.recipeIds.map(String)).toEqual([recipe.id.toString()]); // unchanged
  });

  it('delete is admin-only', async () => {
    const s = await setup();
    const plan = await createCrawlPlan(ctx(s.workspaceA, s.ownerA), {
      name: 'p',
      intervalMinutes: 60,
      recipeIds: [],
      productProfileIds: [],
    });
    await expect(
      deleteCrawlPlan(ctx(s.workspaceA, s.ownerA, 'member'), plan.id),
    ).rejects.toThrow(/Permission denied/);
    await deleteCrawlPlan(ctx(s.workspaceA, s.ownerA), plan.id);
    const remaining = await listCrawlPlans(ctx(s.workspaceA, s.ownerA));
    expect(remaining).toHaveLength(0);
  });

  it('workspace isolation — A cannot see B plans', async () => {
    const s = await setup();
    await createCrawlPlan(ctx(s.workspaceB, s.ownerB), {
      name: 'b-plan',
      intervalMinutes: 60,
      recipeIds: [],
      productProfileIds: [],
    });
    expect(await listCrawlPlans(ctx(s.workspaceA, s.ownerA))).toHaveLength(0);
  });
});

describe('runCrawlPlanNow + processDueCrawlPlans', () => {
  it('runCrawlPlanNow fires a connector_run per active recipe', async () => {
    const s = await setup();
    const { recipe } = await makeMockRecipe(s, s.workspaceA, s.ownerA, 'r1');
    const plan = await createCrawlPlan(ctx(s.workspaceA, s.ownerA), {
      name: 'p',
      intervalMinutes: 60,
      recipeIds: [recipe.id],
      productProfileIds: [],
    });
    const r = await runCrawlPlanNow(ctx(s.workspaceA, s.ownerA), plan.id);
    expect(r.startedRuns).toHaveLength(1);
    expect(r.failedRecipes).toEqual([]);
    const after = await getCrawlPlan(ctx(s.workspaceA, s.ownerA), plan.id);
    expect(after.lastRunAt).not.toBeNull();
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(
      after.lastRunAt!.getTime(),
    );
  });

  it('skips archived recipes silently', async () => {
    const s = await setup();
    const { recipe } = await makeMockRecipe(s, s.workspaceA, s.ownerA, 'r1');
    await updateRecipe(ctx(s.workspaceA, s.ownerA), recipe.id, {
      active: false,
    });
    const plan = await createCrawlPlan(ctx(s.workspaceA, s.ownerA), {
      name: 'p',
      intervalMinutes: 60,
      recipeIds: [recipe.id],
      productProfileIds: [],
    });
    const r = await runCrawlPlanNow(ctx(s.workspaceA, s.ownerA), plan.id);
    expect(r.startedRuns).toHaveLength(0);
    expect(r.skippedRecipes.map(String)).toEqual([recipe.id.toString()]);
  });

  it('processDueCrawlPlans skips plans not yet due', async () => {
    const s = await setup();
    const { recipe } = await makeMockRecipe(s, s.workspaceA, s.ownerA, 'r1');
    const plan = await createCrawlPlan(ctx(s.workspaceA, s.ownerA), {
      name: 'p',
      intervalMinutes: 60,
      recipeIds: [recipe.id],
      productProfileIds: [],
    });
    // Push nextRunAt 30 minutes into the future.
    await db
      .update(crawlPlans)
      .set({ nextRunAt: new Date(Date.now() + 30 * 60_000) })
      .where(eq(crawlPlans.id, plan.id));
    const summary = await processDueCrawlPlans(ctx(s.workspaceA, s.ownerA));
    expect(summary.processed).toBe(0);
    expect(summary.notDue).toBe(1);
    expect(summary.totalStartedRuns).toBe(0);
  });

  it('processDueCrawlPlans skips plans in quiet hours', async () => {
    const s = await setup();
    const { recipe } = await makeMockRecipe(s, s.workspaceA, s.ownerA, 'r1');
    const plan = await createCrawlPlan(ctx(s.workspaceA, s.ownerA), {
      name: 'p',
      intervalMinutes: 60,
      // 0..24 = always quiet (every hour falls inside [0, 24))
      quietStartHour: 0,
      quietEndHour: 23,
      timezone: 'UTC',
      recipeIds: [recipe.id],
      productProfileIds: [],
    });
    // Force the plan due NOW.
    await db
      .update(crawlPlans)
      .set({ nextRunAt: new Date(Date.now() - 60_000) })
      .where(eq(crawlPlans.id, plan.id));
    // Pin "now" to 12:00 UTC so the quiet check covers it.
    const noonUtc = new Date('2026-05-22T12:00:00Z');
    const summary = await processDueCrawlPlans(
      ctx(s.workspaceA, s.ownerA),
      noonUtc,
    );
    expect(summary.processed).toBe(0);
    expect(summary.inQuietHours).toBe(1);
  });

  it('processDueCrawlPlans skips disabled plans entirely', async () => {
    const s = await setup();
    const { recipe } = await makeMockRecipe(s, s.workspaceA, s.ownerA, 'r1');
    const plan = await createCrawlPlan(ctx(s.workspaceA, s.ownerA), {
      name: 'p',
      enabled: false,
      intervalMinutes: 60,
      recipeIds: [recipe.id],
      productProfileIds: [],
    });
    // Past due — but disabled, so should still be skipped.
    await db
      .update(crawlPlans)
      .set({ nextRunAt: new Date(Date.now() - 60_000) })
      .where(eq(crawlPlans.id, plan.id));
    const summary = await processDueCrawlPlans(ctx(s.workspaceA, s.ownerA));
    expect(summary.processed).toBe(0);
    expect(summary.notDue).toBe(0);
    expect(summary.inQuietHours).toBe(0);
  });

  it('workspace isolation — A tick never fires B plans', async () => {
    const s = await setup();
    const { recipe } = await makeMockRecipe(s, s.workspaceB, s.ownerB, 'r-b');
    await createCrawlPlan(ctx(s.workspaceB, s.ownerB), {
      name: 'b',
      intervalMinutes: 60,
      recipeIds: [recipe.id],
      productProfileIds: [],
    });
    const summary = await processDueCrawlPlans(ctx(s.workspaceA, s.ownerA));
    expect(summary.processed).toBe(0);
  });
});
