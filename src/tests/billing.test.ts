import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { workspaces } from '@/lib/db/schema/workspaces';
import {
  applyStripeEvent,
  _setStripeClientForTests,
} from '@/lib/services/billing';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'billing-owner@test.local' });
  const workspaceA = await seedWorkspace({ name: 'B', ownerUserId: ownerA });
  return { workspaceA };
}

beforeEach(async () => {
  _setStripeClientForTests(null);
  await truncateAll();
});

afterEach(() => {
  _setStripeClientForTests(null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ─── applyStripeEvent — webhook reconciliation ────────────────────────

describe('applyStripeEvent', () => {
  function checkoutCompleted(workspaceId: bigint, planId: string): Stripe.Event {
    return {
      id: 'evt_test_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_1',
          mode: 'subscription',
          subscription: 'sub_test_1',
          customer: 'cus_test_1',
          metadata: {
            workspace_id: workspaceId.toString(),
            plan_id: planId,
          },
        } as unknown as Stripe.Checkout.Session,
      },
    } as unknown as Stripe.Event;
  }

  it('checkout.session.completed sets subscription_status=active + plan + ids', async () => {
    const s = await setup();
    const result = await applyStripeEvent(checkoutCompleted(s.workspaceA, 'pro'));
    expect(result.action).toBe('updated');
    expect(result.workspaceId).toBe(s.workspaceA);

    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, s.workspaceA));
    expect(ws!.subscriptionStatus).toBe('active');
    expect(ws!.plan).toBe('pro');
    expect(ws!.stripeCustomerId).toBe('cus_test_1');
    expect(ws!.stripeSubscriptionId).toBe('sub_test_1');
    expect(ws!.onboardingStatus).toBe('completed');
  });

  it('subscription.updated → past_due flips status', async () => {
    const s = await setup();
    await applyStripeEvent(checkoutCompleted(s.workspaceA, 'starter'));

    const event = {
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_test_1',
          status: 'past_due',
          metadata: { workspace_id: s.workspaceA.toString() },
        } as unknown as Stripe.Subscription,
      },
    } as unknown as Stripe.Event;
    await applyStripeEvent(event);

    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, s.workspaceA));
    expect(ws!.subscriptionStatus).toBe('past_due');
  });

  it('subscription.deleted flips to canceled', async () => {
    const s = await setup();
    await applyStripeEvent(checkoutCompleted(s.workspaceA, 'pro'));

    const event = {
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_test_1',
          status: 'canceled',
          metadata: { workspace_id: s.workspaceA.toString() },
        } as unknown as Stripe.Subscription,
      },
    } as unknown as Stripe.Event;
    await applyStripeEvent(event);

    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, s.workspaceA));
    expect(ws!.subscriptionStatus).toBe('canceled');
  });

  it('invoice.payment_failed flips to past_due via stripeCustomerId lookup', async () => {
    const s = await setup();
    await applyStripeEvent(checkoutCompleted(s.workspaceA, 'pro'));

    const event = {
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_test_1',
          customer: 'cus_test_1',
        } as unknown as Stripe.Invoice,
      },
    } as unknown as Stripe.Event;
    await applyStripeEvent(event);

    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, s.workspaceA));
    expect(ws!.subscriptionStatus).toBe('past_due');
  });

  it('returns no_workspace when metadata is missing', async () => {
    const event = {
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_test_orphan',
          status: 'active',
          metadata: {},
        } as unknown as Stripe.Subscription,
      },
    } as unknown as Stripe.Event;
    const result = await applyStripeEvent(event);
    expect(result.action).toBe('no_workspace');
  });

  it('subscription.updated writes trialEndsAt when trial_end is present', async () => {
    const s = await setup();
    await applyStripeEvent(checkoutCompleted(s.workspaceA, 'pro'));
    const trialEndUnix = Math.floor(Date.now() / 1000) + 5 * 86400;
    await applyStripeEvent({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_test_1',
          status: 'trialing',
          trial_end: trialEndUnix,
          metadata: { workspace_id: s.workspaceA.toString() },
        } as unknown as Stripe.Subscription,
      },
    } as unknown as Stripe.Event);
    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, s.workspaceA));
    expect(ws!.subscriptionStatus).toBe('trial');
    expect(ws!.trialEndsAt).toBeInstanceOf(Date);
    expect(Math.floor(ws!.trialEndsAt!.getTime() / 1000)).toBe(trialEndUnix);
  });

  it('subscription.updated clears trialEndsAt when trial_end is null', async () => {
    const s = await setup();
    await applyStripeEvent(checkoutCompleted(s.workspaceA, 'pro'));
    // First put it in trialing with a date.
    await applyStripeEvent({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_test_1',
          status: 'trialing',
          trial_end: Math.floor(Date.now() / 1000) + 86400,
          metadata: { workspace_id: s.workspaceA.toString() },
        } as unknown as Stripe.Subscription,
      },
    } as unknown as Stripe.Event);
    // Then convert to active with no trial_end.
    await applyStripeEvent({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_test_1',
          status: 'active',
          trial_end: null,
          metadata: { workspace_id: s.workspaceA.toString() },
        } as unknown as Stripe.Subscription,
      },
    } as unknown as Stripe.Event);
    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, s.workspaceA));
    expect(ws!.subscriptionStatus).toBe('active');
    expect(ws!.trialEndsAt).toBeNull();
  });

  it('ignores unhandled event types (returns 200 to stop retries)', async () => {
    const event = {
      type: 'product.created',
      data: { object: {} },
    } as unknown as Stripe.Event;
    const result = await applyStripeEvent(event);
    expect(result.action).toBe('ignored');
  });

  it('subscription status mapping: trialing → trial, incomplete → past_due', async () => {
    const s = await setup();
    await applyStripeEvent(checkoutCompleted(s.workspaceA, 'pro'));

    // trialing
    await applyStripeEvent({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_test_1',
          status: 'trialing',
          metadata: { workspace_id: s.workspaceA.toString() },
        } as unknown as Stripe.Subscription,
      },
    } as unknown as Stripe.Event);
    let [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, s.workspaceA));
    expect(ws!.subscriptionStatus).toBe('trial');

    // incomplete
    await applyStripeEvent({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_test_1',
          status: 'incomplete',
          metadata: { workspace_id: s.workspaceA.toString() },
        } as unknown as Stripe.Subscription,
      },
    } as unknown as Stripe.Event);
    [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, s.workspaceA));
    expect(ws!.subscriptionStatus).toBe('past_due');
  });
});
