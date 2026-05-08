// Plan catalogue for the subscription tier.
//
// Plans are configured by environment so the operator can rotate
// Stripe price IDs (test vs live, regional pricing) without a code
// change. Plans whose price ID is unset are hidden from the UI —
// useful when a plan is staged but not yet live.
//
// Plan identifiers ('starter', 'pro') match the values written to
// `workspaces.plan` by the Stripe webhook handler.

export type PlanId = 'starter' | 'pro';

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
        'Solo operators or a small sales team running a single product profile.',
      features: [
        'Up to 1,000 outreach drafts per month',
        '500 grounded research calls per month',
        '1 product profile, unlimited connectors',
        'Email + Google sign-in, 1 mailbox',
      ],
      trialDays,
    },
    {
      id: 'pro',
      name: 'Pro',
      priceId: process.env[PRO_PRICE_ENV] ?? null,
      displayPrice: process.env.STRIPE_PRICE_PRO_DISPLAY ?? '€99 / month',
      pitch:
        'Growing teams running multiple product profiles + autopilot.',
      features: [
        'Unlimited drafts and research calls',
        'Unlimited product profiles + autopilot',
        'Up to 10 mailboxes',
        'Workspace BYOK on every provider',
        'Priority support',
      ],
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
