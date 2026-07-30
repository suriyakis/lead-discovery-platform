// Plan entitlement enforcement (2026-07 pricing rework). Before
// plan-limits.ts existed, `workspaces.plan` gated nothing — these tests
// pin that each advertised ceiling is actually enforced, and that the
// exemption paths (billing_exempt, active subscription) work.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { workspaces } from '@/lib/db/schema/workspaces';
import {
  PlanLimitError,
  assertAutopilotAllowed,
  assertByokAllowed,
  assertCanAddMailbox,
  assertCanCreateProduct,
  getEffectivePlan,
} from '@/lib/services/plan-limits';
import { makeWorkspaceContext } from '@/lib/services/context';
import { setSecret } from '@/lib/services/secrets';
import { createProductProfile } from '@/lib/services/product-profile';
import { updateAutopilotSettings } from '@/lib/services/autopilot';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  wsFree: bigint;
  wsStarter: bigint;
  wsPro: bigint;
  wsExempt: bigint;
  owner: string;
}

async function setup(): Promise<Setup> {
  const owner = await seedUser({ email: 'plan-owner@test.local' });
  const wsFree = await seedWorkspace({ name: 'Free', ownerUserId: owner, plan: 'free' });
  const wsStarter = await seedWorkspace({ name: 'Starter', ownerUserId: owner, plan: 'starter' });
  const wsPro = await seedWorkspace({ name: 'Pro', ownerUserId: owner, plan: 'pro' });
  const wsExempt = await seedWorkspace({ name: 'Exempt', ownerUserId: owner, plan: 'free' });
  await db
    .update(workspaces)
    .set({ billingExempt: true })
    .where(eq(workspaces.id, wsExempt));
  return { wsFree, wsStarter, wsPro, wsExempt, owner };
}

const ctx = (workspaceId: bigint, userId: string) =>
  makeWorkspaceContext({ workspaceId, userId, role: 'owner' });

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('getEffectivePlan', () => {
  it('unsubscribed workspace resolves to free limits', async () => {
    const s = await setup();
    const plan = await getEffectivePlan({ workspaceId: s.wsFree });
    expect(plan.id).toBe('free');
    expect(plan.limits.maxProducts).toBe(1);
    expect(plan.limits.autopilot).toBe(false);
    expect(plan.limits.byok).toBe(false);
  });

  it('active starter/pro subscriptions resolve to their tiers', async () => {
    const s = await setup();
    expect((await getEffectivePlan({ workspaceId: s.wsStarter })).id).toBe('starter');
    expect((await getEffectivePlan({ workspaceId: s.wsPro })).id).toBe('pro');
  });

  it('billing_exempt workspaces get pro limits regardless of plan', async () => {
    const s = await setup();
    const plan = await getEffectivePlan({ workspaceId: s.wsExempt });
    expect(plan.id).toBe('pro');
    expect(plan.limits.byok).toBe(true);
  });

  it('a canceled subscription falls back to free limits', async () => {
    const s = await setup();
    await db
      .update(workspaces)
      .set({ subscriptionStatus: 'canceled' })
      .where(eq(workspaces.id, s.wsPro));
    const plan = await getEffectivePlan({ workspaceId: s.wsPro });
    expect(plan.id).toBe('free');
  });

  it('past_due keeps feature access (Stripe retry grace)', async () => {
    const s = await setup();
    await db
      .update(workspaces)
      .set({ subscriptionStatus: 'past_due' })
      .where(eq(workspaces.id, s.wsPro));
    const plan = await getEffectivePlan({ workspaceId: s.wsPro });
    expect(plan.id).toBe('pro');
  });
});

describe('limit assertions', () => {
  it('free tier: second product blocked, second mailbox blocked', async () => {
    const s = await setup();
    await expect(
      assertCanCreateProduct({ workspaceId: s.wsFree }, 0),
    ).resolves.toBeUndefined();
    await expect(
      assertCanCreateProduct({ workspaceId: s.wsFree }, 1),
    ).rejects.toBeInstanceOf(PlanLimitError);
    await expect(
      assertCanAddMailbox({ workspaceId: s.wsFree }, 1),
    ).rejects.toBeInstanceOf(PlanLimitError);
  });

  it('starter tier: 3 products / 2 mailboxes ceilings', async () => {
    const s = await setup();
    await expect(
      assertCanCreateProduct({ workspaceId: s.wsStarter }, 2),
    ).resolves.toBeUndefined();
    await expect(
      assertCanCreateProduct({ workspaceId: s.wsStarter }, 3),
    ).rejects.toBeInstanceOf(PlanLimitError);
    await expect(
      assertCanAddMailbox({ workspaceId: s.wsStarter }, 2),
    ).rejects.toBeInstanceOf(PlanLimitError);
  });

  it('pro tier: products unlimited, 10 mailbox ceiling, byok allowed', async () => {
    const s = await setup();
    await expect(
      assertCanCreateProduct({ workspaceId: s.wsPro }, 250),
    ).resolves.toBeUndefined();
    await expect(
      assertCanAddMailbox({ workspaceId: s.wsPro }, 10),
    ).rejects.toBeInstanceOf(PlanLimitError);
    await expect(
      assertByokAllowed({ workspaceId: s.wsPro }),
    ).resolves.toBeUndefined();
  });

  it('autopilot + byok blocked on free and starter-byok', async () => {
    const s = await setup();
    await expect(
      assertAutopilotAllowed({ workspaceId: s.wsFree }),
    ).rejects.toBeInstanceOf(PlanLimitError);
    await expect(
      assertAutopilotAllowed({ workspaceId: s.wsStarter }),
    ).resolves.toBeUndefined();
    await expect(
      assertByokAllowed({ workspaceId: s.wsStarter }),
    ).rejects.toBeInstanceOf(PlanLimitError);
  });
});

describe('gates wired into services', () => {
  it('createProductProfile enforces the free-tier ceiling', async () => {
    const s = await setup();
    const c = ctx(s.wsFree, s.owner);
    await createProductProfile(c, { name: 'First product' });
    await expect(
      createProductProfile(c, { name: 'Second product' }),
    ).rejects.toBeInstanceOf(PlanLimitError);
  });

  it('setSecret blocks vendor BYOK keys on non-pro plans but allows non-vendor scopes', async () => {
    const s = await setup();
    const c = ctx(s.wsStarter, s.owner);
    await expect(
      setSecret(c, 'openai.apiKey', 'sk-nope'),
    ).rejects.toBeInstanceOf(PlanLimitError);
    // Mailbox-style secrets are not BYOK — must pass.
    await expect(
      setSecret(c, 'mailbox_abc123.smtpPassword', 'hunter2'),
    ).resolves.toBeDefined();
    // Pro workspace can store vendor keys.
    await expect(
      setSecret(ctx(s.wsPro, s.owner), 'openai.apiKey', 'sk-yes'),
    ).resolves.toBeDefined();
  });

  it('updateAutopilotSettings blocks enabling on free, allows disabling', async () => {
    const s = await setup();
    const c = ctx(s.wsFree, s.owner);
    await expect(
      updateAutopilotSettings(c, { autopilotEnabled: true }),
    ).rejects.toBeInstanceOf(PlanLimitError);
    // Turning OFF (and emergency pause) always works.
    await expect(
      updateAutopilotSettings(c, { autopilotEnabled: false, emergencyPause: true }),
    ).resolves.toBeDefined();
  });
});
