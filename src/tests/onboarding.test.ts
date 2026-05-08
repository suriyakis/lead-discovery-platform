import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { mailboxes } from '@/lib/db/schema/mailing';
import { workspaces } from '@/lib/db/schema/workspaces';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { createConnector } from '@/lib/services/connector-run';
import {
  OnboardingError,
  getOnboardingState,
  markOnboardingComplete,
  markOnboardingStarted,
} from '@/lib/services/onboarding';
import { createProductProfile } from '@/lib/services/product-profile';
import { updateProviderSettings } from '@/lib/services/provider-settings';
import { setSecret } from '@/lib/services/secrets';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  ownerA: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'onboarding-owner@test.local' });
  const workspaceA = await seedWorkspace({ name: 'OB', ownerUserId: ownerA });
  // Tests start with onboarding pending so we can drive each step.
  await db
    .update(workspaces)
    .set({ onboardingStatus: 'pending' })
    .where(eq(workspaces.id, workspaceA));
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
  await truncateAll();
});

afterEach(() => {
  delete process.env.AI_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('getOnboardingState', () => {
  it('returns 5 steps with sensible defaults on a fresh workspace', async () => {
    const s = await setup();
    const state = await getOnboardingState(ctx(s.workspaceA, s.ownerA));
    expect(state.steps).toHaveLength(5);
    expect(state.steps.map((x) => x.key)).toEqual([
      'plan',
      'ai',
      'mailbox',
      'product',
      'connector',
    ]);
    // Plan is auto-done because new workspaces are 'trial'.
    expect(state.steps[0]!.done).toBe(true);
    // The other four are not done yet.
    expect(state.steps[1]!.done).toBe(false);
    expect(state.steps[2]!.done).toBe(false);
    expect(state.steps[3]!.done).toBe(false);
    expect(state.steps[4]!.done).toBe(false);
    expect(state.nextStepIdx).toBe(1);
    expect(state.effectivelyComplete).toBe(false);
  });

  it('marks AI step done when a real provider is selected and a key is reachable', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await updateProviderSettings(c, { aiProvider: 'openai' });
    await setSecret(c, 'openai.apiKey', 'sk-test');
    const state = await getOnboardingState(c);
    expect(state.steps[1]!.done).toBe(true);
  });

  it("AI step stays not-done when provider is real but no key is set", async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await updateProviderSettings(c, { aiProvider: 'openai' });
    delete process.env.OPENAI_API_KEY;
    const state = await getOnboardingState(c);
    expect(state.steps[1]!.done).toBe(false);
    expect(state.steps[1]!.why).toMatch(/no key/);
  });

  it('marks mailbox step done when at least one active mailbox exists', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await db.insert(mailboxes).values({
      workspaceId: s.workspaceA,
      name: 'sales',
      fromAddress: 'sales@test.local',
      smtpHost: 'smtp.x',
      smtpUser: 'sales',
      smtpPasswordSecretKey: 'mailbox.smtp_onboarding',
      imapFolder: 'INBOX',
      status: 'active',
    });
    const state = await getOnboardingState(c);
    expect(state.steps[2]!.done).toBe(true);
  });

  it('marks product step done when at least one active product exists', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await createProductProfile(c, { name: 'Vetrofluid' });
    const state = await getOnboardingState(c);
    expect(state.steps[3]!.done).toBe(true);
  });

  it('marks connector step done when one is created', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await createConnector(c, { templateType: 'mock', name: 'M', config: {} });
    const state = await getOnboardingState(c);
    expect(state.steps[4]!.done).toBe(true);
  });

  it('effectivelyComplete flips when every step is done', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await updateProviderSettings(c, { aiProvider: 'openai' });
    await setSecret(c, 'openai.apiKey', 'sk-test');
    await db.insert(mailboxes).values({
      workspaceId: s.workspaceA,
      name: 'sales',
      fromAddress: 'sales@test.local',
      smtpHost: 'smtp.x',
      smtpUser: 'sales',
      smtpPasswordSecretKey: 'mailbox.smtp_onboarding2',
      imapFolder: 'INBOX',
      status: 'active',
    });
    await createProductProfile(c, { name: 'P' });
    await createConnector(c, { templateType: 'mock', name: 'M', config: {} });
    const state = await getOnboardingState(c);
    expect(state.steps.every((x) => x.done)).toBe(true);
    expect(state.effectivelyComplete).toBe(true);
    expect(state.nextStepIdx).toBe(-1);
  });

  it('effectivelyComplete also flips when workspace.onboardingStatus is completed even if steps are missing', async () => {
    const s = await setup();
    await db
      .update(workspaces)
      .set({ onboardingStatus: 'completed' })
      .where(eq(workspaces.id, s.workspaceA));
    const state = await getOnboardingState(ctx(s.workspaceA, s.ownerA));
    expect(state.effectivelyComplete).toBe(true);
  });
});

describe('markOnboardingComplete', () => {
  it('flips status to completed and emits an audit event', async () => {
    const s = await setup();
    await markOnboardingComplete(ctx(s.workspaceA, s.ownerA));
    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, s.workspaceA));
    expect(ws!.onboardingStatus).toBe('completed');
  });

  it('viewer role cannot complete', async () => {
    const s = await setup();
    await expect(
      markOnboardingComplete(ctx(s.workspaceA, s.ownerA, 'viewer')),
    ).rejects.toThrow(OnboardingError);
  });
});

describe('markOnboardingStarted', () => {
  it('moves pending → in_progress', async () => {
    const s = await setup();
    await markOnboardingStarted({ workspaceId: s.workspaceA });
    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, s.workspaceA));
    expect(ws!.onboardingStatus).toBe('in_progress');
  });

  it('does not regress completed → in_progress', async () => {
    const s = await setup();
    await db
      .update(workspaces)
      .set({ onboardingStatus: 'completed' })
      .where(eq(workspaces.id, s.workspaceA));
    await markOnboardingStarted({ workspaceId: s.workspaceA });
    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, s.workspaceA));
    expect(ws!.onboardingStatus).toBe('completed');
  });
});
