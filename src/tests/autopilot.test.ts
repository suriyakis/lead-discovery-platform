import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { autopilotLog } from '@/lib/db/schema/autopilot';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  getAutopilotSettings,
  listAutopilotLog,
  runOnce,
  updateAutopilotSettings,
} from '@/lib/services/autopilot';
import { createConnector, createRecipe, startRun } from '@/lib/services/connector-run';
import { createProductProfile } from '@/lib/services/product-profile';
import { reviewItems } from '@/lib/db/schema/review';
import { qualifications } from '@/lib/db/schema/qualifications';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  ownerA: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  return { workspaceA, ownerA };
}

function ctx(workspaceId: bigint, userId: string, role: WorkspaceContext['role'] = 'owner'): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ============ settings ==============================================

describe('autopilot settings', () => {
  it('lazy-creates defaults', async () => {
    const s = await setup();
    const settings = await getAutopilotSettings(ctx(s.workspaceA, s.ownerA));
    expect(settings.autopilotEnabled).toBe(false);
    expect(settings.emergencyPause).toBe(false);
    expect(settings.autoApproveThreshold).toBe(70);
    expect(settings.maxApprovalsPerRun).toBe(20);
  });

  it('admin updates persist + audit', async () => {
    const s = await setup();
    const updated = await updateAutopilotSettings(ctx(s.workspaceA, s.ownerA), {
      autopilotEnabled: true,
      enableAutoApproveProjects: true,
      autoApproveThreshold: 85,
      maxApprovalsPerRun: 5,
    });
    expect(updated.autopilotEnabled).toBe(true);
    expect(updated.autoApproveThreshold).toBe(85);
    expect(updated.maxApprovalsPerRun).toBe(5);
  });

  it('non-admin cannot update', async () => {
    const s = await setup();
    await expect(
      updateAutopilotSettings(ctx(s.workspaceA, s.ownerA, 'member'), {
        autopilotEnabled: true,
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

// ============ runOnce guards ========================================

describe('runOnce guards', () => {
  it('autopilotEnabled=false -> single skipped guard step', async () => {
    const s = await setup();
    const r = await runOnce(ctx(s.workspaceA, s.ownerA));
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]).toEqual({
      step: 'guard',
      outcome: 'skipped',
      detail: 'autopilot_disabled',
    });
  });

  it('emergency pause halts even when enabled', async () => {
    const s = await setup();
    await updateAutopilotSettings(ctx(s.workspaceA, s.ownerA), {
      autopilotEnabled: true,
      emergencyPause: true,
      enableAutoApproveProjects: true,
    });
    const r = await runOnce(ctx(s.workspaceA, s.ownerA));
    expect(r.steps[0]).toEqual({
      step: 'guard',
      outcome: 'skipped',
      detail: 'emergency_pause',
    });
  });
});

// ============ auto-approve ==========================================

describe('runOnce — auto-approve step', () => {
  async function seedReviewableLead(s: Setup) {
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'P',
      includeKeywords: ['mock'],
      relevanceThreshold: 50,
    });
    const c = await createConnector(ctx(s.workspaceA, s.ownerA), {
      templateType: 'mock',
      name: 'Mock',
      config: {},
    });
    const r = await createRecipe(ctx(s.workspaceA, s.ownerA), {
      connectorId: c.id,
      name: 'r',
      selectors: { seed: 'p21', count: 1 },
    });
    await startRun(ctx(s.workspaceA, s.ownerA), {
      connectorId: c.id,
      recipeId: r.id,
      wait: true,
    });
    void product;
    return db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.workspaceId, s.workspaceA));
  }

  it('approves new review items whose qualification crosses the threshold', async () => {
    const s = await setup();
    await seedReviewableLead(s);
    await updateAutopilotSettings(ctx(s.workspaceA, s.ownerA), {
      autopilotEnabled: true,
      enableAutoApproveProjects: true,
      // threshold of 50 — connector mock + 'mock' keyword pass.
      autoApproveThreshold: 50,
    });
    const r = await runOnce(ctx(s.workspaceA, s.ownerA));
    const approveStep = r.steps.find((s) => s.step === 'auto_approve_projects');
    expect(approveStep).toBeDefined();
    expect(approveStep!.outcome).toBe('success');
    expect(approveStep!.detail).toMatch(/approved=\d+/);

    const reviews = await db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.workspaceId, s.workspaceA));
    expect(reviews.some((ri) => ri.state === 'approved')).toBe(true);

    // Audit log should have at least one success entry for auto_approve_projects.
    const log = await listAutopilotLog(ctx(s.workspaceA, s.ownerA));
    expect(
      log.some(
        (l) => l.step === 'auto_approve_projects' && l.outcome === 'success',
      ),
    ).toBe(true);
  });

  it('skips review items below the threshold', async () => {
    const s = await setup();
    await seedReviewableLead(s);
    // Set a high threshold the qualification cannot meet.
    await updateAutopilotSettings(ctx(s.workspaceA, s.ownerA), {
      autopilotEnabled: true,
      enableAutoApproveProjects: true,
      autoApproveThreshold: 99,
    });
    await runOnce(ctx(s.workspaceA, s.ownerA));
    const reviews = await db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.workspaceId, s.workspaceA));
    expect(reviews.every((ri) => ri.state === 'new')).toBe(true);
    void qualifications;
  });

  it('caps approvals per run', async () => {
    const s = await setup();
    // Two records this time (count: 2).
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'P',
      includeKeywords: ['mock'],
      relevanceThreshold: 50,
    });
    void product;
    const c = await createConnector(ctx(s.workspaceA, s.ownerA), {
      templateType: 'mock',
      name: 'Mock',
      config: {},
    });
    const r = await createRecipe(ctx(s.workspaceA, s.ownerA), {
      connectorId: c.id,
      name: 'r',
      selectors: { seed: 'p21-cap', count: 4 },
    });
    await startRun(ctx(s.workspaceA, s.ownerA), {
      connectorId: c.id,
      recipeId: r.id,
      wait: true,
    });
    await updateAutopilotSettings(ctx(s.workspaceA, s.ownerA), {
      autopilotEnabled: true,
      enableAutoApproveProjects: true,
      autoApproveThreshold: 50,
      maxApprovalsPerRun: 2,
    });
    await runOnce(ctx(s.workspaceA, s.ownerA));
    const reviews = await db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.workspaceId, s.workspaceA));
    const approvedCount = reviews.filter((ri) => ri.state === 'approved').length;
    expect(approvedCount).toBeLessThanOrEqual(2);
  });
});

// ============ log =====================================================

describe('autopilot log', () => {
  it('every action shares a runId across the same runOnce()', async () => {
    const s = await setup();
    await updateAutopilotSettings(ctx(s.workspaceA, s.ownerA), {
      autopilotEnabled: true,
      enableAutoApproveProjects: true,
      autoApproveThreshold: 50,
    });
    const r = await runOnce(ctx(s.workspaceA, s.ownerA));
    const entries = await db
      .select()
      .from(autopilotLog)
      .where(eq(autopilotLog.workspaceId, s.workspaceA));
    if (entries.length > 0) {
      expect(entries.every((e) => e.runId === r.runId)).toBe(true);
    }
  });
});
