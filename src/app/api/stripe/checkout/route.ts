// POST /api/stripe/checkout
//
// Body: { planId: 'starter' | 'pro' }
// Response: { url } — caller redirects the operator to Stripe Checkout.
// On Stripe success → operator returns to /onboarding?stripe=success;
// on cancel → /onboarding?stripe=canceled.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import {
  BillingError,
  createCheckoutSession,
} from '@/lib/services/billing';

const InputSchema = z.object({
  planId: z.enum(['starter', 'pro']),
});

export async function POST(req: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let parsed: z.infer<typeof InputSchema>;
  try {
    parsed = InputSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
  }
  const ctx = await getWorkspaceContext();

  // Build success / cancel URLs from the request origin so we don't
  // hardcode discover.nulife.pl — works on localhost / preview deploys.
  const origin = new URL(req.url).origin;
  try {
    const result = await createCheckoutSession(ctx, {
      planId: parsed.planId,
      successUrl: `${origin}/onboarding?stripe=success`,
      cancelUrl: `${origin}/onboarding?stripe=canceled`,
    });
    return NextResponse.json({ url: result.url });
  } catch (err) {
    if (err instanceof BillingError) {
      const status =
        err.code === 'permission_denied' ? 403 :
        err.code === 'not_configured' ? 503 :
        err.code === 'invalid_input' ? 400 :
        500;
      return NextResponse.json({ error: err.code, detail: err.message }, { status });
    }
    return NextResponse.json(
      { error: 'internal', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
