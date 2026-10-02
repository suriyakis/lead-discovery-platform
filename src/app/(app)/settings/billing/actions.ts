'use server';

// Billing form actions that spend (MOB-06): subscribing to a plan and the
// auto top-up switch (which charges the saved card when tokens run low).
// They used to be inline closures in page.tsx; at module scope they are
// guarded, so a billing tab left open on another workspace can neither
// start a subscription nor change auto top-up for the workspace this
// browser has since switched to (src/lib/workspace-guard). Buying a token
// pack is /api/stripe/buy-tokens, guarded the same way.

import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireActionContext } from '@/lib/action-context';
import { appUrl } from '@/lib/app-origin';
import type { PlanId } from '@/lib/billing/plans';
import { db } from '@/lib/db/client';
import { workspaces } from '@/lib/db/schema/workspaces';
import { isNextRedirectError } from '@/lib/server-redirect';
import { BillingError, createCheckoutSession } from '@/lib/services/billing';
import { canAdminWorkspace } from '@/lib/services/context';
import { withWorkspaceGuard } from '@/lib/workspace-guard/server';

const BILLING = '/settings/billing';

async function saveAutoTopupForm(formData: FormData): Promise<void> {
  const ctx = await requireActionContext();
  if (!canAdminWorkspace(ctx)) {
    redirect(`${BILLING}?err=Only+admins+can+change+auto+top-up`);
  }
  const enabled = formData.get('enabled') === 'on';
  const packId = String(formData.get('packId') ?? 'pack_s');
  await db
    .update(workspaces)
    .set({
      autoTopupEnabled: enabled,
      autoTopupPackId: packId,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, ctx.workspaceId));
  redirect(
    `${BILLING}?msg=${encodeURIComponent(enabled ? 'Auto top-up enabled.' : 'Auto top-up disabled.')}`,
  );
}
export const saveAutoTopupAction = withWorkspaceGuard('billing.auto_topup', saveAutoTopupForm);

async function subscribeToPlanForm(formData: FormData): Promise<void> {
  const ctx = await requireActionContext();
  const planId = String(formData.get('planId') ?? '') as PlanId;
  if (planId !== 'starter' && planId !== 'pro') {
    redirect(`${BILLING}?err=${encodeURIComponent('Unknown plan.')}`);
  }
  // Stripe returns to this deployment, not to production (I155).
  const requestHeaders = await headers();
  let url: string;
  try {
    const result = await createCheckoutSession(ctx, {
      planId,
      successUrl: appUrl(`${BILLING}?stripe=success`, { headers: requestHeaders }),
      cancelUrl: appUrl(`${BILLING}?stripe=canceled`, { headers: requestHeaders }),
    });
    url = result.url;
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    const m =
      err instanceof BillingError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'checkout failed';
    redirect(`${BILLING}?err=${encodeURIComponent(m)}`);
  }
  redirect(url);
}
export const subscribeToPlanAction = withWorkspaceGuard('billing.subscribe', subscribeToPlanForm);
