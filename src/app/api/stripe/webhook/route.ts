// POST /api/stripe/webhook
//
// Stripe POSTs subscription lifecycle events here. We verify the
// signature with STRIPE_WEBHOOK_SECRET, then route the event into the
// service layer which reconciles workspace state.
//
// IMPORTANT: Stripe needs the RAW request body to verify the
// signature, so we read it as text and pass through. Returning 400 on
// signature failure tells Stripe to retry; returning 200 on
// successfully-applied events stops the retry loop.

import { NextResponse } from 'next/server';
import {
  BillingError,
  applyStripeEvent,
  verifyStripeEvent,
} from '@/lib/services/billing';

export async function POST(req: Request): Promise<NextResponse> {
  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json(
      { error: 'missing stripe-signature header' },
      { status: 400 },
    );
  }
  const rawBody = await req.text();

  let event;
  try {
    event = verifyStripeEvent(rawBody, signature);
  } catch (err) {
    if (err instanceof BillingError) {
      // 400 prompts Stripe to retry — it might be a transient
      // misconfiguration on our side. 503 for not-configured stops
      // the retry loop until the operator fixes it.
      const status = err.code === 'not_configured' ? 503 : 400;
      return NextResponse.json({ error: err.code, detail: err.message }, { status });
    }
    return NextResponse.json(
      { error: 'verification_failed', detail: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  try {
    const result = await applyStripeEvent(event);
    return NextResponse.json({
      received: true,
      type: event.type,
      action: result.action,
      detail: result.detail,
    });
  } catch (err) {
    // We've already verified the signature so this is an internal
    // bug, not a Stripe problem. 500 means Stripe retries —
    // typically what we want for transient DB errors.
    return NextResponse.json(
      {
        error: 'internal',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
