// Plan entitlement enforcement (2026-07 pricing rework).
//
// Before this service existed, `workspaces.plan` was written by the
// Stripe webhook and read by NOTHING — every advertised plan feature
// (mailbox counts, product limits, "unlimited") was unenforced copy.
// This is the single place that turns a workspace's subscription state
// into concrete ceilings, and the assert* helpers are wired into the
// creation/enable paths they protect.
//
// Resolution:
//   billing_exempt            → Pro limits (platform-internal workspaces)
//   status active/trial/past_due + known plan → that plan's limits
//     (past_due keeps FEATURE access during Stripe's retry window;
//      the monthly token grant only happens on a PAID invoice)
//   anything else             → FREE_LIMITS
//
// Limits gate NEW resources only — an existing workspace over a limit
// keeps what it has; it just can't add more.

import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { workspaces } from '@/lib/db/schema/workspaces';
import {
  FREE_LIMITS,
  getPlanById,
  type PlanLimits,
} from '@/lib/billing/plans';
import type { WorkspaceContext } from './context';

export class PlanLimitError extends Error {
  public readonly code = 'plan_limit';
  constructor(message: string) {
    super(message);
    this.name = 'PlanLimitError';
  }
}

export interface EffectivePlan {
  /** 'free' | 'starter' | 'pro' — after exemptions and status checks. */
  id: string;
  limits: PlanLimits;
}

export async function getEffectivePlan(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<EffectivePlan> {
  const [ws] = await db
    .select({
      plan: workspaces.plan,
      subscriptionStatus: workspaces.subscriptionStatus,
      billingExempt: workspaces.billingExempt,
    })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);
  if (!ws) return { id: 'free', limits: FREE_LIMITS };

  if (ws.billingExempt) {
    const pro = getPlanById('pro');
    return { id: 'pro', limits: pro!.limits };
  }

  const entitled =
    ws.subscriptionStatus === 'active' ||
    ws.subscriptionStatus === 'trial' ||
    ws.subscriptionStatus === 'past_due';
  if (entitled) {
    const plan = getPlanById(ws.plan);
    if (plan) return { id: plan.id, limits: plan.limits };
  }
  return { id: 'free', limits: FREE_LIMITS };
}

const upgradeHint =
  'Upgrade your plan in Settings → Billing to raise this limit.';

/** Gate for product-profile creation. `currentCount` = profiles the
 *  workspace already has. */
export async function assertCanCreateProduct(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  currentCount: number,
): Promise<void> {
  const { limits } = await getEffectivePlan(ctx);
  if (limits.maxProducts !== null && currentCount >= limits.maxProducts) {
    throw new PlanLimitError(
      `Your plan allows up to ${limits.maxProducts} product profile${limits.maxProducts === 1 ? '' : 's'}. ${upgradeHint}`,
    );
  }
}

/** Gate for mailbox creation. `currentCount` = mailboxes already connected. */
export async function assertCanAddMailbox(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  currentCount: number,
): Promise<void> {
  const { limits } = await getEffectivePlan(ctx);
  if (limits.maxMailboxes !== null && currentCount >= limits.maxMailboxes) {
    throw new PlanLimitError(
      `Your plan allows up to ${limits.maxMailboxes} mailbox${limits.maxMailboxes === 1 ? '' : 'es'}. ${upgradeHint}`,
    );
  }
}

/** Gate for turning ON any autopilot toggle. Turning things OFF is
 *  always allowed. */
export async function assertAutopilotAllowed(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<void> {
  const { limits } = await getEffectivePlan(ctx);
  if (!limits.autopilot) {
    throw new PlanLimitError(`Autopilot needs a subscription. ${upgradeHint}`);
  }
}

/** Gate for storing workspace vendor API keys (BYOK). Applies only to
 *  workspace-scoped secrets — platform console keys are super-admin
 *  territory and never touch this. */
export async function assertByokAllowed(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<void> {
  const { limits } = await getEffectivePlan(ctx);
  if (!limits.byok) {
    throw new PlanLimitError(
      `Bring-your-own-key needs the Pro plan. ${upgradeHint}`,
    );
  }
}
