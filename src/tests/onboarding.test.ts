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
import { createConnector, createRecipe, startRun } from '@/lib/services/connector-run';
import { reviewItems } from '@/lib/db/schema/review';
import { approveReviewItem } from '@/lib/services/review';
import {
  OnboardingError,
  getOnboardingState,
  markOnboardingComplete,
  markOnboardingStarted,
  setSetupMode,
  type OnboardingState,
  type OnboardingStepKey,
} from '@/lib/services/onboarding';
import { getProviderSettings } from '@/lib/services/provider-settings';
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

/** Key-based step lookup — the wizard's step ORDER is presentation, not
 *  contract; tests assert by key so inserting a step doesn't break them. */
function step(state: OnboardingState, key: OnboardingStepKey) {
  const found = state.steps.find((s) => s.key === key);
  if (!found) throw new Error(`step ${key} missing`);
  return found;
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
  it('returns 9 steps with sensible defaults on a fresh workspace', async () => {
    const s = await setup();
    const state = await getOnboardingState(ctx(s.workspaceA, s.ownerA));
    expect(state.steps).toHaveLength(9);
    expect(state.steps.map((x) => x.key)).toEqual([
      'setup',
      'plan',
      'ai',
      'search',
      'mailbox',
      'product',
      'connector',
      'run',
      'review',
    ]);
    // Setup mode hasn't been chosen yet — it's the first thing to do.
    expect(step(state, 'setup').done).toBe(false);
    expect(state.nextStepIdx).toBe(0);
    // Plan is auto-done because new workspaces are 'trial'.
    expect(step(state, 'plan').done).toBe(true);
    // The others are not done yet (test env: mock AI, mock search, no key).
    expect(step(state, 'ai').done).toBe(false);
    expect(step(state, 'search').done).toBe(false);
    expect(step(state, 'search').why).toMatch(/mock data/);
    expect(step(state, 'mailbox').done).toBe(false);
    expect(step(state, 'product').done).toBe(false);
    expect(step(state, 'connector').done).toBe(false);
    expect(step(state, 'run').done).toBe(false);
    expect(step(state, 'review').done).toBe(false);
    expect(state.effectivelyComplete).toBe(false);
  });

  it('search step is done when the workspace picks a grounding provider', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await updateProviderSettings(c, { researchProvider: 'gemini' });
    const state = await getOnboardingState(c);
    expect(step(state, 'search').done).toBe(true);
  });

  it('search step is done via the grounded fallback when a Gemini key is reachable', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await setSecret(c, 'gemini.apiKey', 'g-test');
    const state = await getOnboardingState(c);
    expect(step(state, 'search').done).toBe(true);
  });

  it('marks AI step done when a real provider is selected and a key is reachable', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await updateProviderSettings(c, { aiProvider: 'openai' });
    await setSecret(c, 'openai.apiKey', 'sk-test');
    const state = await getOnboardingState(c);
    expect(step(state, 'ai').done).toBe(true);
  });

  it("AI step stays not-done when provider is real but no key is set", async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await updateProviderSettings(c, { aiProvider: 'openai' });
    delete process.env.OPENAI_API_KEY;
    const state = await getOnboardingState(c);
    expect(step(state, 'ai').done).toBe(false);
    expect(step(state, 'ai').why).toMatch(/no key/);
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
    expect(step(state, 'mailbox').done).toBe(true);
  });

  it('marks product step done when at least one active product exists', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await createProductProfile(c, { name: 'Vetrofluid' });
    const state = await getOnboardingState(c);
    expect(step(state, 'product').done).toBe(true);
  });

  it('marks connector step done when one is created', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await createConnector(c, { templateType: 'mock', name: 'M', config: {} });
    const state = await getOnboardingState(c);
    expect(step(state, 'connector').done).toBe(true);
  });

  it('effectivelyComplete flips when every step is done', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await setSetupMode(c, 'advanced');
    await updateProviderSettings(c, { aiProvider: 'openai', researchProvider: 'gemini' });
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
    const connector = await createConnector(c, { templateType: 'mock', name: 'M', config: {} });
    // First-value steps: run discovery, then decide one review item.
    const recipe = await createRecipe(c, {
      connectorId: connector.id,
      name: 'r',
      selectors: { seed: 'onboarding', count: 1, delayMs: 0 },
    });
    await startRun(c, { connectorId: connector.id, recipeId: recipe.id, wait: true });
    const reviews = await db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.workspaceId, s.workspaceA));
    await approveReviewItem(c, reviews[0]!.id);

    const state = await getOnboardingState(c);
    expect(state.steps.every((x) => x.done)).toBe(true);
    expect(state.effectivelyComplete).toBe(true);
    expect(state.nextStepIdx).toBe(-1);
  });

  it('run and review steps flip as the workspace produces value', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    const connector = await createConnector(c, { templateType: 'mock', name: 'M', config: {} });
    const recipe = await createRecipe(c, {
      connectorId: connector.id,
      name: 'r',
      selectors: { seed: 'onboarding2', count: 1, delayMs: 0 },
    });
    await startRun(c, { connectorId: connector.id, recipeId: recipe.id, wait: true });

    let state = await getOnboardingState(c);
    expect(step(state, 'run').done).toBe(true);
    expect(step(state, 'review').done).toBe(false);

    const reviews = await db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.workspaceId, s.workspaceA));
    await approveReviewItem(c, reviews[0]!.id);
    state = await getOnboardingState(c);
    expect(step(state, 'review').done).toBe(true);
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

describe('setSetupMode', () => {
  it('marks the setup step done and persists the mode', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await setSetupMode(c, 'simple');
    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, s.workspaceA));
    expect(ws!.setupMode).toBe('simple');
    const state = await getOnboardingState(c);
    expect(step(state, 'setup').done).toBe(true);
  });

  it('switching to simple resets provider-selection overrides to system defaults', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await updateProviderSettings(c, {
      aiProvider: 'anthropic',
      researchProvider: 'gemini',
    });
    await setSetupMode(c, 'simple');
    const settings = await getProviderSettings(c);
    expect(settings.aiProvider).toBeNull();
    expect(settings.researchProvider).toBeNull();
  });

  it('switching to advanced keeps provider overrides untouched', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await updateProviderSettings(c, { aiProvider: 'anthropic' });
    await setSetupMode(c, 'advanced');
    const settings = await getProviderSettings(c);
    expect(settings.aiProvider).toBe('anthropic');
  });

  it('simple mode rewrites the ai/search steps as system-default steps', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await setSetupMode(c, 'simple');
    const state = await getOnboardingState(c);
    expect(step(state, 'ai').title).toMatch(/system default/);
    expect(step(state, 'search').title).toMatch(/system default/);
    // Test env has no platform keys, so the steps read as a platform
    // problem, not a "go configure it" instruction.
    expect(step(state, 'ai').why).toMatch(/contact support/);
    expect(step(state, 'search').why).toMatch(/contact support/);
  });

  it('viewer role cannot set the mode', async () => {
    const s = await setup();
    await expect(
      setSetupMode(ctx(s.workspaceA, s.ownerA, 'viewer'), 'simple'),
    ).rejects.toThrow(OnboardingError);
  });

  it('rejects unknown modes', async () => {
    const s = await setup();
    await expect(
      setSetupMode(
        ctx(s.workspaceA, s.ownerA),
        'banana' as unknown as Parameters<typeof setSetupMode>[1],
      ),
    ).rejects.toThrow(/unknown setup mode/);
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
