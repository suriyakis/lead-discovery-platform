// Stripe billing service (Phase 48).
//
// Three primary entry points:
//   - createCheckoutSession(ctx, planId)  → Stripe Checkout URL
//   - createPortalSession(ctx)            → Stripe Customer Portal URL
//   - applyStripeWebhook(rawBody, sig)    → reconciles workspace state
//
// The webhook handler is the source of truth — it's the only place
// that mutates workspace.subscription_status, plan, or the stripe_*
// columns. Checkout / Portal flows just create Stripe-side state and
// redirect; the webhook arrives later and writes to our DB.
//
// The Stripe SDK is constructed lazily so a workspace without a
// platform Stripe key never imports the dependency at request time.

import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { workspaces, type Workspace } from '@/lib/db/schema/workspaces';
import { recordAuditEvent } from './audit';
import { canAdminWorkspace, type WorkspaceContext } from './context';
import { getPlanById, type PlanId } from '@/lib/billing/plans';

export class BillingError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
  }
}

const denied = (op: string) =>
  new BillingError(`Permission denied: ${op}`, 'permission_denied');
const notConfigured = () =>
  new BillingError(
    'Stripe is not configured on this server (STRIPE_SECRET_KEY missing).',
    'not_configured',
  );
const invalid = (msg: string) => new BillingError(msg, 'invalid_input');
const notFound = (kind: string) =>
  new BillingError(`${kind} not found`, 'not_found');

let cachedClient: Stripe | null = null;

/** Lazy Stripe client. Throws when STRIPE_SECRET_KEY is missing so
 *  the integrations page can surface 'not configured' clearly. */
export function getStripeClient(): Stripe {
  if (cachedClient) return cachedClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !key.trim()) throw notConfigured();
  cachedClient = new Stripe(key.trim(), {
    apiVersion: '2026-04-22.dahlia',
  });
  return cachedClient;
}

/** For tests — inject a stub Stripe client and reset between cases. */
export function _setStripeClientForTests(client: Stripe | null): void {
  cachedClient = client;
}

/**
 * Find or create the Stripe Customer for a workspace. Idempotent:
 * after the first call, the customer id is persisted on the
 * workspace row, so subsequent calls return without hitting Stripe.
 */
export async function getOrCreateStripeCustomer(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
): Promise<{ customerId: string; workspace: Workspace }> {
  const [ws] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);
  if (!ws) throw notFound('workspace');
  if (ws.stripeCustomerId) {
    return { customerId: ws.stripeCustomerId, workspace: ws };
  }

  const stripe = getStripeClient();
  const customer = await stripe.customers.create({
    name: ws.name,
    metadata: {
      workspace_id: ws.id.toString(),
      workspace_slug: ws.slug,
    },
  });

  const [updated] = await db
    .update(workspaces)
    .set({
      stripeCustomerId: customer.id,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, ctx.workspaceId))
    .returning();
  return { customerId: customer.id, workspace: updated ?? ws };
}

export interface CreateCheckoutSessionInput {
  planId: PlanId;
  /** Where to redirect on success — typically `/onboarding?stripe=success`. */
  successUrl: string;
  /** Where to redirect on cancel — typically `/onboarding?stripe=canceled`. */
  cancelUrl: string;
}

/**
 * Create a Stripe Checkout Session for the requested plan and return
 * the URL the operator should be redirected to.
 */
export async function createCheckoutSession(
  ctx: WorkspaceContext,
  input: CreateCheckoutSessionInput,
): Promise<{ url: string; sessionId: string }> {
  if (!canAdminWorkspace(ctx)) throw denied('billing.checkout');
  const plan = getPlanById(input.planId);
  if (!plan) throw invalid(`unknown plan: ${input.planId}`);
  if (!plan.priceId) {
    throw invalid(
      `plan ${plan.id} is not purchasable yet — STRIPE_PRICE_${plan.id.toUpperCase()} is unset`,
    );
  }

  const { customerId } = await getOrCreateStripeCustomer(ctx);
  const stripe = getStripeClient();

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: plan.priceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    allow_promotion_codes: true,
    subscription_data: {
      metadata: {
        workspace_id: ctx.workspaceId.toString(),
        plan_id: plan.id,
      },
    },
    metadata: {
      workspace_id: ctx.workspaceId.toString(),
      plan_id: plan.id,
    },
  });

  if (!session.url) {
    throw new BillingError(
      'stripe checkout session returned no url',
      'invariant_violation',
    );
  }

  await recordAuditEvent(ctx, {
    kind: 'billing.checkout_session_created',
    entityType: 'workspace',
    entityId: ctx.workspaceId,
    payload: { planId: plan.id, sessionId: session.id },
  });

  return { url: session.url, sessionId: session.id };
}

/**
 * Create a Stripe Customer Portal session so the operator can manage
 * their subscription (cancel, switch plans, update card) on Stripe's
 * hosted UI.
 */
export async function createPortalSession(
  ctx: WorkspaceContext,
  returnUrl: string,
): Promise<{ url: string }> {
  if (!canAdminWorkspace(ctx)) throw denied('billing.portal');
  const { customerId } = await getOrCreateStripeCustomer(ctx);
  const stripe = getStripeClient();
  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  if (!portal.url) {
    throw new BillingError(
      'stripe portal session returned no url',
      'invariant_violation',
    );
  }
  await recordAuditEvent(ctx, {
    kind: 'billing.portal_session_created',
    entityType: 'workspace',
    entityId: ctx.workspaceId,
    payload: {},
  });
  return { url: portal.url };
}

// ─── Webhook handler ─────────────────────────────────────────────────

/**
 * Verify the Stripe signature and parse the raw body into an event.
 * Throws BillingError when the signature doesn't match — caller
 * should return 400.
 */
export function verifyStripeEvent(rawBody: string, signature: string): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !secret.trim()) throw notConfigured();
  const stripe = getStripeClient();
  try {
    return stripe.webhooks.constructEvent(rawBody, signature, secret.trim());
  } catch (err) {
    throw new BillingError(
      `stripe webhook signature verification failed: ${err instanceof Error ? err.message : String(err)}`,
      'webhook_invalid',
    );
  }
}

/** Map Stripe Subscription.status to our subscription_status enum. */
function mapStripeStatus(
  status: Stripe.Subscription.Status,
): 'trial' | 'active' | 'past_due' | 'canceled' {
  switch (status) {
    case 'trialing':
      return 'trial';
    case 'active':
      return 'active';
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
    case 'paused':
      return 'canceled';
    default:
      return 'canceled';
  }
}

interface ApplyResult {
  workspaceId: bigint | null;
  action: 'updated' | 'no_workspace' | 'ignored';
  detail?: string;
}

/**
 * Reconcile a Stripe event into the workspace row. Idempotent: every
 * supported event is a write that can be replayed without breaking.
 *
 * Supported events:
 *   - checkout.session.completed       — first-time subscription
 *   - customer.subscription.created    — alias / belt-and-braces
 *   - customer.subscription.updated    — plan change, renewal, etc.
 *   - customer.subscription.deleted    — canceled
 *   - invoice.payment_failed           — past_due
 *
 * Other event types are quietly ignored (Stripe sends a lot we don't
 * care about; returning 200 is the right move so retries don't pile
 * up).
 */
export async function applyStripeEvent(event: Stripe.Event): Promise<ApplyResult> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const workspaceId = parseWorkspaceId(session.metadata);
      const planId =
        (session.metadata?.plan_id as PlanId | undefined) ?? null;
      if (!workspaceId) return { workspaceId: null, action: 'no_workspace' };
      const subscriptionId =
        typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id ?? null;
      const customerId =
        typeof session.customer === 'string'
          ? session.customer
          : session.customer?.id ?? null;
      await db
        .update(workspaces)
        .set({
          stripeSubscriptionId: subscriptionId,
          stripeCustomerId: customerId,
          plan: planId ?? 'starter',
          subscriptionStatus: 'active',
          onboardingStatus:
            // Auto-complete onboarding when the operator pays —
            // they've finished the wizard's most important step.
            session.mode === 'subscription' ? 'completed' : undefined,
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, workspaceId));
      return { workspaceId, action: 'updated', detail: 'checkout.completed' };
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const workspaceId = parseWorkspaceId(sub.metadata);
      if (!workspaceId) return { workspaceId: null, action: 'no_workspace' };
      const planId =
        (sub.metadata?.plan_id as PlanId | undefined) ?? undefined;
      await db
        .update(workspaces)
        .set({
          stripeSubscriptionId: sub.id,
          subscriptionStatus: mapStripeStatus(sub.status),
          ...(planId ? { plan: planId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, workspaceId));
      return {
        workspaceId,
        action: 'updated',
        detail: `subscription.${event.type.split('.').pop()}`,
      };
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const workspaceId = parseWorkspaceId(sub.metadata);
      if (!workspaceId) return { workspaceId: null, action: 'no_workspace' };
      await db
        .update(workspaces)
        .set({
          subscriptionStatus: 'canceled',
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, workspaceId));
      return { workspaceId, action: 'updated', detail: 'subscription.deleted' };
    }

    case 'invoice.payment_failed': {
      // Invoice doesn't carry workspace_id in metadata directly — look
      // up the workspace by stripe_customer_id instead. This is more
      // robust than relying on subscription metadata threading.
      const invoice = event.data.object as Stripe.Invoice;
      const customerId =
        typeof invoice.customer === 'string'
          ? invoice.customer
          : invoice.customer?.id ?? null;
      if (!customerId) return { workspaceId: null, action: 'no_workspace' };
      const [ws] = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.stripeCustomerId, customerId))
        .limit(1);
      if (!ws) return { workspaceId: null, action: 'no_workspace' };
      await db
        .update(workspaces)
        .set({
          subscriptionStatus: 'past_due',
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, ws.id));
      return { workspaceId: ws.id, action: 'updated', detail: 'payment.failed' };
    }

    default:
      return {
        workspaceId: null,
        action: 'ignored',
        detail: `unhandled type: ${event.type}`,
      };
  }
}

function parseWorkspaceId(
  metadata: Stripe.Metadata | null | undefined,
): bigint | null {
  const raw = metadata?.workspace_id;
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  return BigInt(raw);
}
