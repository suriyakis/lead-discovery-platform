// POST /api/stripe/portal
//
// Returns { url } — caller redirects the operator to Stripe's hosted
// Customer Portal where they can change plan, cancel, or update card.
// On portal exit → operator returns to /settings/billing.

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import { BillingError, createPortalSession } from '@/lib/services/billing';

export async function POST(req: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const ctx = await getWorkspaceContext();
  const origin = new URL(req.url).origin;
  try {
    const result = await createPortalSession(ctx, `${origin}/settings/billing`);
    return NextResponse.json({ url: result.url });
  } catch (err) {
    if (err instanceof BillingError) {
      const status =
        err.code === 'permission_denied' ? 403 :
        err.code === 'not_configured' ? 503 :
        500;
      return NextResponse.json({ error: err.code, detail: err.message }, { status });
    }
    return NextResponse.json(
      { error: 'internal', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
