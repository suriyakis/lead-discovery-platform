// Plan catalogue for the subscription tier.
//
// Plans are configured by environment so the operator can rotate
// Stripe price IDs (test vs live, regional pricing) without a code
// change. Plans whose price ID is unset are hidden from the UI —
// useful when a plan is staged but not yet live.
//
// Plan identifiers ('starter', 'pro') match the values written to
// `workspaces.plan` by the Stripe webhook handler.
//
// PRICING MODEL (2026-07 rework): a subscription is a MONTHLY TOKEN
// ALLOWANCE plus a feature tier. Every metered action spends tokens
// from the single workspace wallet; the subscription refills that
// wallet each paid billing cycle (invoice.paid webhook, idempotent per
// invoice). Unused tokens roll over — the margin per token is fixed at
// the metering layer (see billing/tokens.ts), so rollover is
// economically safe. There is deliberately NO "unlimited" anywhere:
// usage is cost-based and unlimited promises on a metered product are
// how you lose money one whale at a time.

export type PlanId = 'starter' | 'pro';

/** Feature ceilings enforced in code (see services/plan-limits.ts).
 *  `null` means no ceiling on that axis for the tier. */
export interface PlanLimits {
  /** Max product profiles the workspace can create. */
  maxProducts: number | null;
  /** Max mailboxes the workspace can connect. */
  maxMailboxes: number | null;
  /** Whether autopilot toggles may be enabled. */
  autopilot: boolean;
  /** Whether the workspace may store its own vendor API keys (BYOK). */
  byok: boolean;
}

/** The no-subscription baseline: enough to evaluate the product with
 *  the welcome tokens + purchased packs, but the recurring tiers carry
 *  the real capacity. */
export const FREE_LIMITS: PlanLimits = {
  maxProducts: 1,
  maxMailboxes: 1,
  autopilot: false,
  byok: false,
};

export interface PlanDefinition {
  id: PlanId;
  name: string;
  /** Stripe Price ID (e.g. price_1Pxxxxx). Pulled from env at boot. */
  priceId: string | null;
  /** Display price for the UI (we don't trust env to format currency). */
  displayPrice: string;
  /** One-line positioning. */
  pitch: string;
  /** What you get; rendered as a checked list. */
  features: string[];
  /** Tokens credited to the workspace wallet each PAID billing cycle.
   *  Granted by the invoice.paid webhook, idempotent per invoice id.
   *  €0 trial invoices grant nothing — trials run on welcome tokens. */
  monthlyTokens: number;
  /** Enforced feature ceilings for this tier. */
  limits: PlanLimits;
  /** Days of free trial Stripe should grant on Checkout. Card is still
   *  collected upfront — Stripe auto-converts to paid on day N+1. Zero
   *  disables the trial entirely. */
  trialDays: number;
}

const STARTER_PRICE_ENV = 'STRIPE_PRICE_STARTER';
const PRO_PRICE_ENV = 'STRIPE_PRICE_PRO';

/** Trial length in days for both plans. Default 5; override via
 *  STRIPE_TRIAL_DAYS env var. Set to '0' to disable trials entirely. */
function readTrialDays(): number {
  const raw = process.env.STRIPE_TRIAL_DAYS;
  if (raw === undefined) return 5;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 5;
  return Math.floor(n);
}

/** Resolve plans against the live env. Cheap — does no I/O. */
export function getPlans(): PlanDefinition[] {
  const trialDays = readTrialDays();
  return [
    {
      id: 'starter',
      name: 'Starter',
      priceId: process.env[STARTER_PRICE_ENV] ?? null,
      displayPrice: process.env.STRIPE_PRICE_STARTER_DISPLAY ?? '€29 / month',
      pitch:
        'Solo operators or a small sales team running a focused pipeline.',
      features: [
        '3,500 tokens included every month (≈ €35 of usage)',
        'Unused tokens roll over while subscribed',
        'Up to 3 product profiles',
        'Up to 2 mailboxes',
        'Autopilot (auto-qualify, auto-drafts, auto-follow-ups)',
      ],
      monthlyTokens: 3_500,
      limits: {
        maxProducts: 3,
        maxMailboxes: 2,
        autopilot: true,
        byok: false,
      },
      trialDays,
    },
    {
      id: 'pro',
      name: 'Pro',
      priceId: process.env[PRO_PRICE_ENV] ?? null,
      displayPrice: process.env.STRIPE_PRICE_PRO_DISPLAY ?? '€99 / month',
      pitch:
        'Growing teams running multiple products, mailboxes and autopilot.',
      features: [
        '13,000 tokens included every month (≈ €130 of usage)',
        'Unused tokens roll over while subscribed',
        'Unlimited product profiles',
        'Up to 10 mailboxes',
        'Bring your own API keys (BYOK usage is token-free)',
        'Priority support',
      ],
      monthlyTokens: 13_000,
      limits: {
        maxProducts: null,
        maxMailboxes: 10,
        autopilot: true,
        byok: true,
      },
      trialDays,
    },
  ];
}

/** Return only plans that are actually purchasable today. */
export function getAvailablePlans(): PlanDefinition[] {
  return getPlans().filter((p) => p.priceId !== null);
}

/** Look up a plan by its id. */
export function getPlanById(id: string): PlanDefinition | null {
  return getPlans().find((p) => p.id === id) ?? null;
}
