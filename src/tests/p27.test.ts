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
  getEffectiveAutopilotSettings,
  getProductAutopilotSettings,
  updateAutopilotSettings,
  upsertProductAutopilotSettings,
} from '@/lib/services/autopilot';
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

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ============ getEffectiveAutopilotSettings ==========================

describe('getEffectiveAutopilotSettings', () => {
  it('falls through to workspace defaults when no overlay exists', async () => {
    const s = await setup();
    await updateAutopilotSettings(ctx(s.workspaceA, s.ownerA), {
      autopilotEnabled: true,
      enableAutoApproveProjects: true,
      autoApproveThreshold: 75,
    });
    const eff = await getEffectiveAutopilotSettings(
      ctx(s.workspaceA, s.ownerA),
      s.productX,
    );
    expect(eff.autopilotEnabled).toBe(true);
    expect(eff.enableAutoApproveProjects).toBe(true);
    expect(eff.autoApproveThreshold).toBe(75);
  });

  it('overlay column wins when set', async () => {
    const s = await setup();
    await updateAutopilotSettings(ctx(s.workspaceA, s.ownerA), {
      autopilotEnabled: true,
      enableAutoApproveProjects: true,
      autoApproveThreshold: 75,
    });
    await upsertProductAutopilotSettings(ctx(s.workspaceA, s.ownerA), {
      productProfileId: s.productX,
      enableAutoApproveProjects: false,
      autoApproveThreshold: 90,
    });
    const eff = await getEffectiveAutopilotSettings(
      ctx(s.workspaceA, s.ownerA),
      s.productX,
    );
    // Workspace says auto-approve true, threshold 75. Product says off, 90.
    expect(eff.enableAutoApproveProjects).toBe(false);
    expect(eff.autoApproveThreshold).toBe(90);
    // Untouched fields fall through.
    expect(eff.autopilotEnabled).toBe(true);
  });

  it('null overlay column means inherit', async () => {
    const s = await setup();
    await updateAutopilotSettings(ctx(s.workspaceA, s.ownerA), {
      enableAutoEnqueueOutreach: true,
    });
    // Insert overlay row that explicitly clears one column but leaves others null.
    await upsertProductAutopilotSettings(ctx(s.workspaceA, s.ownerA), {
      productProfileId: s.productX,
      // Don't touch enableAutoEnqueueOutreach — only set CRM contact sync.
      enableAutoCrmContactSync: true,
    });
    const eff = await getEffectiveAutopilotSettings(
      ctx(s.workspaceA, s.ownerA),
      s.productX,
    );
    // Inherited from workspace.
    expect(eff.enableAutoEnqueueOutreach).toBe(true);
    // Set explicitly on overlay.
    expect(eff.enableAutoCrmContactSync).toBe(true);
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
        enableAutoApproveProjects: true,
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
    expect(second.enableAutoApproveProjects).toBe(true);
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
        enableAutoApproveProjects: true,
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

describe('clearProductAutopilotSettings', () => {
  it('removes the overlay row', async () => {
    const s = await setup();
    await upsertProductAutopilotSettings(ctx(s.workspaceA, s.ownerA), {
      productProfileId: s.productX,
      enableAutoApproveProjects: true,
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
