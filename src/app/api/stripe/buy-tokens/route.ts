// POST /api/stripe/buy-tokens
//
// Body: { packId: 'pack_s' | 'pack_m' | 'pack_l' }
// Response: { url } — caller redirects the operator to a one-time-payment
// Stripe Checkout for the chosen prepaid token pack. The webhook credits
// the workspace wallet on completion (idempotent by session id).
//
// MOB-06: guarded — BuyTokensButtons sends the page's workspace as the
// x-expected-workspace header; after a switch in another tab no checkout
// is opened for the other workspace (409 workspace_changed).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import { authErrorToResponse } from '@/lib/services/http';
import {
  BillingError,
  createTokenCheckoutSession,
} from '@/lib/services/billing';
import { withWorkspaceGuardRoute } from '@/lib/workspace-guard/server';

const InputSchema = z.object({
  packId: z.string().min(1).max(40),
});

async function handlePost(req: Request): Promise<NextResponse> {
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
  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    const res = authErrorToResponse(err);
    if (res) return res;
    throw err;
  }

  const origin = new URL(req.url).origin;
  try {
    const result = await createTokenCheckoutSession(ctx, {
      packId: parsed.packId,
      successUrl: `${origin}/settings/billing?msg=${encodeURIComponent('Payment received — tokens will appear in a moment.')}`,
      cancelUrl: `${origin}/settings/billing?err=${encodeURIComponent('Token purchase canceled.')}`,
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

export const POST = withWorkspaceGuardRoute('billing.buy_tokens', handlePost);
