// Phase 27 per-product overlay, with PC-13's semantics: overrides only
// narrow (inherit or off, a higher threshold) and are resolved by
// resolveAutomationPolicy / productPolicy — the only reader.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { autopilotProductSettings } from '@/lib/db/schema/autopilot';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  clearProductAutopilotSettings,
  getProductAutopilotSettings,
  pauseProductAutomation,
  updateAutopilotSettings,
  upsertProductAutopilotSettings,
} from '@/lib/services/autopilot';
import { productPolicy, resolveAutomationPolicy } from '@/lib/services/automation-policy';
import { createProductProfile } from '@/lib/services/product-profile';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  ownerA: string;
  productX: bigint;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  const product = await createProductProfile(
    ctx(workspaceA, ownerA),
    { name: 'Widget' },
  );
  return { workspaceA, ownerA, productX: product.id };
}

function ctx(
  workspaceId: bigint,
  userId: string,
  role: WorkspaceContext['role'] = 'owner',
): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

async function resolved(s: Setup) {
  return productPolicy(await resolveAutomationPolicy(ctx(s.workspaceA, s.ownerA)), s.productX);
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ============ productPolicy (the resolver) ============================

describe('productPolicy', () => {
  it('falls through to workspace defaults when no overlay exists', async () => {
    const s = await setup();
    await updateAutopilotSettings(ctx(s.workspaceA, s.ownerA), {
      autopilotEnabled: true,
      enableAutoApproveProjects: true,
      autoApproveThreshold: 75,
    });
    const eff = await resolved(s);
    expect(eff.autopilotEnabled).toBe(true);
    expect(eff.steps.auto_approve_projects).toBe('on');
    expect(eff.autoApproveThreshold).toBe(75);
    expect(eff.hasOverrides).toBe(false);
  });

  it('an override narrows: off, and only a higher threshold applies', async () => {
    const s = await setup();
    await updateAutopilotSettings(ctx(s.workspaceA, s.ownerA), {
      autopilotEnabled: true,
      enableAutoApproveProjects: true,
      enableAutoEnqueueOutreach: true,
      autoApproveThreshold: 75,
    });
    await upsertProductAutopilotSettings(ctx(s.workspaceA, s.ownerA), {
      productProfileId: s.productX,
      enableAutoApproveProjects: false,
      autoApproveThreshold: 90,
    });
    const eff = await resolved(s);
    expect(eff.steps.auto_approve_projects).toBe('product_off');
    expect(eff.autoApproveThreshold).toBe(90);
    // Untouched fields fall through.
    expect(eff.autopilotEnabled).toBe(true);
    expect(eff.steps.auto_enqueue_outreach).toBe('on');

    // The workspace later raises its threshold above the product's: the
    // higher one still wins (never a lower bar for a product).
    await updateAutopilotSettings(ctx(s.workspaceA, s.ownerA), { autoApproveThreshold: 95 });
    expect((await resolved(s)).autoApproveThreshold).toBe(95);
  });

  it('null overlay column means inherit', async () => {
    const s = await setup();
    await updateAutopilotSettings(ctx(s.workspaceA, s.ownerA), {
      autopilotEnabled: true,
      enableAutoEnqueueOutreach: true,
      enableAutoCrmContactSync: true,
    });
    await upsertProductAutopilotSettings(ctx(s.workspaceA, s.ownerA), {
      productProfileId: s.productX,
      // Don't touch enableAutoEnqueueOutreach — only switch CRM contact sync off.
      enableAutoCrmContactSync: false,
    });
    const eff = await resolved(s);
    expect(eff.steps.auto_enqueue_outreach).toBe('on');
    expect(eff.steps.auto_crm_contact_sync).toBe('product_off');
  });

  it('the product master off and a product pause stop every step for the product', async () => {
    const s = await setup();
    await updateAutopilotSettings(ctx(s.workspaceA, s.ownerA), {
      autopilotEnabled: true,
      enableAutoApproveProjects: true,
      enableAutoEnqueueOutreach: true,
    });
    await upsertProductAutopilotSettings(ctx(s.workspaceA, s.ownerA), {
      productProfileId: s.productX,
      autopilotEnabled: false,
    });
    let eff = await resolved(s);
    expect(eff.autopilotEnabled).toBe(false);
    expect(eff.steps.auto_approve_projects).toBe('product_autopilot_off');
    expect(eff.steps.auto_enqueue_outreach).toBe('product_autopilot_off');

    await pauseProductAutomation(ctx(s.workspaceA, s.ownerA), s.productX);
    eff = await resolved(s);
    expect(eff.pause).not.toBeNull();
    expect(Object.values(eff.steps).every((v) => v === 'product_paused')).toBe(true);
  });
});

// ============ upsert + clear ========================================

describe('upsertProductAutopilotSettings', () => {
  it('creates a new overlay then updates the same row', async () => {
    const s = await setup();
    const first = await upsertProductAutopilotSettings(
      ctx(s.workspaceA, s.ownerA),
      {
        productProfileId: s.productX,
        enableAutoApproveProjects: false,
      },
    );
    const second = await upsertProductAutopilotSettings(
      ctx(s.workspaceA, s.ownerA),
      {
        productProfileId: s.productX,
        autoApproveThreshold: 80,
      },
    );
    // Same row — id is preserved.
    expect(first.id).toBe(second.id);
    // Both writes survived (merge keeps the prior column).
    expect(second.enableAutoApproveProjects).toBe(false);
    expect(second.autoApproveThreshold).toBe(80);
  });

  it('clamps autoApproveThreshold to 0..100', async () => {
    const s = await setup();
    const r = await upsertProductAutopilotSettings(
      ctx(s.workspaceA, s.ownerA),
      {
        productProfileId: s.productX,
        autoApproveThreshold: 999,
      },
    );
    expect(r.autoApproveThreshold).toBe(100);
  });

  it('rejects non-admin', async () => {
    const s = await setup();
    await expect(
      upsertProductAutopilotSettings(ctx(s.workspaceA, s.ownerA, 'member'), {
        productProfileId: s.productX,
        enableAutoApproveProjects: false,
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it("rejects another workspace's product", async () => {
    const s = await setup();
    const otherOwner = await seedUser({ email: 'ownerB@test.local' });
    const otherWs = await seedWorkspace({ name: 'B', ownerUserId: otherOwner });
    await expect(
      upsertProductAutopilotSettings(ctx(otherWs, otherOwner), {
        productProfileId: s.productX,
        enableAutoApproveProjects: false,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('clearProductAutopilotSettings', () => {
  it('removes the overlay row', async () => {
    const s = await setup();
    await upsertProductAutopilotSettings(ctx(s.workspaceA, s.ownerA), {
      productProfileId: s.productX,
      enableAutoApproveProjects: false,
    });
    expect(
      await getProductAutopilotSettings(ctx(s.workspaceA, s.ownerA), s.productX),
    ).not.toBeNull();
    await clearProductAutopilotSettings(
      ctx(s.workspaceA, s.ownerA),
      s.productX,
    );
    expect(
      await getProductAutopilotSettings(ctx(s.workspaceA, s.ownerA), s.productX),
    ).toBeNull();
    const left = await db
      .select()
      .from(autopilotProductSettings)
      .where(eq(autopilotProductSettings.workspaceId, s.workspaceA));
    expect(left).toHaveLength(0);
  });

  it('keeps a pause: clearing overrides is not resuming', async () => {
    const s = await setup();
    await upsertProductAutopilotSettings(ctx(s.workspaceA, s.ownerA), {
      productProfileId: s.productX,
      enableAutoApproveProjects: false,
    });
    await pauseProductAutomation(ctx(s.workspaceA, s.ownerA), s.productX);
    await clearProductAutopilotSettings(ctx(s.workspaceA, s.ownerA), s.productX);
    const row = await getProductAutopilotSettings(ctx(s.workspaceA, s.ownerA), s.productX);
    expect(row).toMatchObject({ enableAutoApproveProjects: null });
    expect(row!.pausedAt).not.toBeNull();
  });

  it('rejects non-admin', async () => {
    const s = await setup();
    await expect(
      clearProductAutopilotSettings(
        ctx(s.workspaceA, s.ownerA, 'member'),
        s.productX,
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});
