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
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { workspaces, type Workspace } from '@/lib/db/schema/workspaces';
import { recordAuditEvent } from './audit';
import { canAdminWorkspace, type WorkspaceContext } from './context';
import { getPlanById, type PlanId } from '@/lib/billing/plans';
import { tokenPackById } from '@/lib/billing/tokens';
import { creditTokens } from './token-ledger';

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

  // Phase 48 trial: Stripe collects card upfront on Checkout (default)
  // and grants `trial_period_days` of free use before the first charge.
  // The webhook flips us to subscriptionStatus='trial' for that window
  // and to 'active' on conversion.
  const subscriptionData: {
    metadata: Record<string, string>;
    trial_period_days?: number;
  } = {
    metadata: {
      workspace_id: ctx.workspaceId.toString(),
      plan_id: plan.id,
    },
  };
  if (plan.trialDays > 0) {
    subscriptionData.trial_period_days = plan.trialDays;
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: plan.priceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    allow_promotion_codes: true,
    subscription_data: subscriptionData,
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

export interface CreateTokenCheckoutInput {
  packId: string;
  successUrl: string;
  cancelUrl: string;
}

/**
 * One-time payment Checkout for a prepaid token pack. The pack's token
 * amount travels in session metadata; the webhook credits the wallet on
 * `checkout.session.completed` (mode=payment), idempotent by session id.
 */
export async function createTokenCheckoutSession(
  ctx: WorkspaceContext,
  input: CreateTokenCheckoutInput,
): Promise<{ url: string; sessionId: string }> {
  if (!canAdminWorkspace(ctx)) throw denied('billing.buy_tokens');
  const pack = tokenPackById(input.packId);
  if (!pack) throw invalid(`unknown token pack: ${input.packId}`);
  if (!pack.priceId) {
    throw invalid(
      `token pack ${pack.id} is not purchasable yet — its STRIPE_PRICE_TOKENS_* env is unset`,
    );
  }

  const { customerId } = await getOrCreateStripeCustomer(ctx);
  const stripe = getStripeClient();

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer: customerId,
    line_items: [{ price: pack.priceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    allow_promotion_codes: true,
    // Save the card for off-session auto top-up (opt-in feature — the
    // charge itself only happens if the workspace enables it).
    payment_intent_data: { setup_future_usage: 'off_session' },
    metadata: {
      workspace_id: ctx.workspaceId.toString(),
      token_pack_id: pack.id,
      tokens: pack.tokens.toString(),
    },
  });

  if (!session.url) {
    throw new BillingError(
      'stripe checkout session returned no url',
      'invariant_violation',
    );
  }

  await recordAuditEvent(ctx, {
    kind: 'billing.token_checkout_created',
    entityType: 'workspace',
    entityId: ctx.workspaceId,
    payload: { packId: pack.id, tokens: pack.tokens, sessionId: session.id },
  });

  return { url: session.url, sessionId: session.id };
}

/**
 * Attempt an automatic off-session token top-up for a workspace whose
 * wallet crossed the low threshold. Called fire-and-forget from the
 * debit path — every exit is silent-but-notified, never throws upward.
 *
 * Guards, in order: feature enabled + pack chosen, not billing-exempt,
 * rate limit (one ATTEMPT per 6h — success or fail — so a declining
 * card isn't hammered), Stripe configured, customer + saved card exist.
 *
 * Crediting happens on the webhook (payment_intent.succeeded) AND
 * inline on synchronous success — both idempotent by PaymentIntent id.
 */
export async function attemptAutoTopup(workspaceId: bigint): Promise<
  'charged' | 'skipped' | 'failed'
> {
  const [ws] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!ws) return 'skipped';
  if (!ws.autoTopupEnabled || !ws.autoTopupPackId || ws.billingExempt) {
    return 'skipped';
  }
  const pack = tokenPackById(ws.autoTopupPackId);
  if (!pack?.priceId) return 'skipped';

  // ATOMIC claim of the rate-limit window. Concurrent debits all fire
  // this function at once when the balance crosses the threshold; a
  // read-check-then-write stamp would let several of them pass and each
  // charge the card (real double-billing). The conditional UPDATE lets
  // exactly ONE caller win per 6h window — losers see rowCount 0.
  const RATE_LIMIT_MS = 6 * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - RATE_LIMIT_MS);
  const claimed = await db
    .update(workspaces)
    .set({ autoTopupLastAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(workspaces.id, workspaceId),
        or(
          isNull(workspaces.autoTopupLastAt),
          lt(workspaces.autoTopupLastAt, cutoff),
        ),
      ),
    )
    .returning({ id: workspaces.id });
  if (!claimed[0]) return 'skipped';

  const { notify } = await import('./notifications');
  try {
    const stripe = getStripeClient();
    if (!ws.stripeCustomerId) throw new Error('no stripe customer');
    const methods = await stripe.paymentMethods.list({
      customer: ws.stripeCustomerId,
      type: 'card',
      limit: 1,
    });
    const card = methods.data[0];
    if (!card) throw new Error('no saved card');

    const price = await stripe.prices.retrieve(pack.priceId);
    if (!price.unit_amount || !price.currency) {
      throw new Error('pack price has no amount');
    }

    const intent = await stripe.paymentIntents.create({
      amount: price.unit_amount,
      currency: price.currency,
      customer: ws.stripeCustomerId,
      payment_method: card.id,
      off_session: true,
      confirm: true,
      description: `Auto top-up: ${pack.name} (${pack.tokens.toLocaleString()} tokens)`,
      metadata: {
        workspace_id: workspaceId.toString(),
        token_pack_id: pack.id,
        tokens: pack.tokens.toString(),
        auto_topup: '1',
      },
    });

    if (intent.status === 'succeeded') {
      await creditTokens(workspaceId, {
        tokens: pack.tokens,
        kind: 'purchase',
        reason: `${pack.id} (auto top-up)`,
        externalRef: intent.id,
        payload: { paymentIntentId: intent.id, autoTopup: true },
      });
      await notify(workspaceId, {
        kind: 'tokens.auto_topup',
        title: `Auto top-up: +${pack.tokens.toLocaleString()} tokens (${pack.display})`,
        href: '/settings/billing',
      });
      return 'charged';
    }
    // Not settled synchronously ('processing' etc.) — the webhook credits
    // on payment_intent.succeeded if it lands. Don't claim success, and
    // tell the operator something is pending so a silent async failure
    // isn't a mystery pause (the 6h stamp blocks immediate retries).
    await notify(workspaceId, {
      kind: 'tokens.auto_topup_pending',
      title: `Auto top-up is processing (${pack.display}) — tokens arrive when the payment settles`,
      href: '/settings/billing',
      dedupeKey: 'tokens.auto_topup_pending',
    });
    return 'skipped';
  } catch (err) {
    console.error(
      `[billing] auto top-up failed for workspace ${workspaceId}:`,
      err instanceof Error ? err.message : err,
    );
    await notify(workspaceId, {
      kind: 'tokens.auto_topup_failed',
      title: 'Automatic top-up failed — update your card',
      body: err instanceof Error ? err.message.slice(0, 200) : null,
      href: '/settings/billing',
      dedupeKey: 'tokens.auto_topup_failed',
    });
    return 'failed';
  }
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
 *   - invoice.paid                     — monthly token allowance grant
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

      // One-time token purchase: credit the wallet and stop — a payment-
      // mode session must NEVER touch subscription state (the fallthrough
      // below would wrongly flip the workspace to plan+active).
      if (session.mode === 'payment') {
        const tokens = Number(session.metadata?.tokens ?? '0');
        const packId = session.metadata?.token_pack_id ?? 'unknown';
        if (!Number.isFinite(tokens) || tokens <= 0) {
          return {
            workspaceId,
            action: 'ignored',
            detail: 'payment session without token metadata',
          };
        }
        const { alreadyApplied } = await creditTokens(workspaceId, {
          tokens,
          kind: 'purchase',
          reason: packId,
          externalRef: session.id,
          payload: {
            stripeSessionId: session.id,
            amountTotal: session.amount_total,
            currency: session.currency,
          },
        });
        return {
          workspaceId,
          action: 'updated',
          detail: alreadyApplied
            ? 'token purchase (replay, already credited)'
            : `token purchase credited: ${tokens}`,
        };
      }
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

    case 'payment_intent.succeeded': {
      // Auto top-up settlement. Only intents WE created carry token
      // metadata; checkout-session intents don't (their credit happens on
      // checkout.session.completed with the session id as the idempotency
      // ref, so no double-credit is possible).
      const intent = event.data.object as Stripe.PaymentIntent;
      const workspaceId = parseWorkspaceId(intent.metadata);
      const tokens = Number(intent.metadata?.tokens ?? '0');
      if (!workspaceId || !Number.isFinite(tokens) || tokens <= 0) {
        return {
          workspaceId: workspaceId ?? null,
          action: 'ignored',
          detail: 'payment_intent without token metadata',
        };
      }
      const packId = intent.metadata?.token_pack_id ?? 'unknown';
      const isAuto = intent.metadata?.auto_topup === '1';
      const { alreadyApplied } = await creditTokens(workspaceId, {
        tokens,
        kind: 'purchase',
        reason: isAuto ? `${packId} (auto top-up)` : packId,
        externalRef: intent.id,
        payload: {
          paymentIntentId: intent.id,
          amountReceived: intent.amount_received,
          currency: intent.currency,
          autoTopup: isAuto,
        },
      });
      return {
        workspaceId,
        action: 'updated',
        detail: alreadyApplied
          ? 'token purchase (replay, already credited)'
          : `token purchase credited: ${tokens}`,
      };
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const workspaceId = parseWorkspaceId(sub.metadata);
      if (!workspaceId) return { workspaceId: null, action: 'no_workspace' };
      const planId =
        (sub.metadata?.plan_id as PlanId | undefined) ?? undefined;
      // Stripe encodes trial_end as Unix seconds, null when no trial
      // (or already past trial).
      const trialEndsAt =
        typeof sub.trial_end === 'number' && sub.trial_end > 0
          ? new Date(sub.trial_end * 1000)
          : null;
      await db
        .update(workspaces)
        .set({
          stripeSubscriptionId: sub.id,
          subscriptionStatus: mapStripeStatus(sub.status),
          ...(planId ? { plan: planId } : {}),
          trialEndsAt,
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

    case 'invoice.paid': {
      // Monthly token allowance: every PAID subscription invoice
      // credits the plan's monthlyTokens into the wallet. Idempotent
      // per invoice id (Stripe retries + the subscription.updated
      // renewal event can race this — creditTokens' externalRef guard
      // makes the grant exactly-once). €0 invoices (trials, 100%-off
      // coupons) grant nothing: trials run on the welcome tokens.
      const invoice = event.data.object as Stripe.Invoice;
      if (!invoice.id) return { workspaceId: null, action: 'ignored', detail: 'invoice without id' };
      if ((invoice.amount_paid ?? 0) <= 0) {
        return { workspaceId: null, action: 'ignored', detail: 'zero-amount invoice (trial/coupon)' };
      }
      const customerId =
        typeof invoice.customer === 'string'
          ? invoice.customer
          : invoice.customer?.id ?? null;
      if (!customerId) return { workspaceId: null, action: 'no_workspace' };
      const [ws] = await db
        .select({ id: workspaces.id, plan: workspaces.plan })
        .from(workspaces)
        .where(eq(workspaces.stripeCustomerId, customerId))
        .limit(1);
      if (!ws) return { workspaceId: null, action: 'no_workspace' };
      const plan = getPlanById(ws.plan);
      if (!plan || plan.monthlyTokens <= 0) {
        return {
          workspaceId: ws.id,
          action: 'ignored',
          detail: `no allowance for plan '${ws.plan}'`,
        };
      }
      // Only subscription invoices carry the allowance — a future
      // one-off invoice on the same customer must not trigger a grant.
      const isSubscriptionInvoice = Boolean(
        invoice.parent?.subscription_details ??
          (invoice as unknown as { subscription?: unknown }).subscription,
      );
      if (!isSubscriptionInvoice) {
        return { workspaceId: ws.id, action: 'ignored', detail: 'non-subscription invoice' };
      }
      const { alreadyApplied } = await creditTokens(ws.id, {
        tokens: plan.monthlyTokens,
        kind: 'purchase',
        reason: `subscription.allowance:${plan.id}`,
        externalRef: `invoice:${invoice.id}`,
        payload: {
          stripeInvoiceId: invoice.id,
          plan: plan.id,
          amountPaid: invoice.amount_paid,
          currency: invoice.currency,
        },
      });
      // Restore feature access if the workspace had lapsed to past_due.
      await db
        .update(workspaces)
        .set({ subscriptionStatus: 'active', updatedAt: new Date() })
        .where(eq(workspaces.id, ws.id));
      return {
        workspaceId: ws.id,
        action: 'updated',
        detail: alreadyApplied
          ? 'allowance replay (already credited)'
          : `allowance credited: ${plan.monthlyTokens} (${plan.id})`,
      };
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
