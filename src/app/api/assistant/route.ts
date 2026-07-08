// POST /api/assistant — the in-app AI guide ("Ask the platform").
// Body: { question: string, history?: [{role, content}] }
// Metered AI usage; blocked (402) on an empty wallet like every other
// AI feature.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { AssistantError, askAssistant } from '@/lib/services/assistant';
import { TokenError, assertTokens } from '@/lib/services/token-ledger';
import { rateLimitAllow } from '@/lib/rate-limit';

const InputSchema = z.object({
  question: z.string().min(1).max(2000),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(4000),
      }),
    )
    .max(16)
    .optional(),
});

export async function POST(req: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    if (err instanceof NoWorkspaceError) {
      return NextResponse.json({ error: 'no_workspace' }, { status: 400 });
    }
    throw err;
  }

  let parsed: z.infer<typeof InputSchema>;
  try {
    parsed = InputSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
  }

  // Cost-DoS guard: metering is post-hoc, so the wallet check alone can be
  // raced by concurrent floods (and billing-exempt tenants have no wallet
  // gate at all). Cap per workspace AND per user.
  if (
    !rateLimitAllow(`assistant:ws:${ctx.workspaceId}`, 20, 60_000) ||
    !rateLimitAllow(`assistant:user:${ctx.userId}`, 10, 60_000)
  ) {
    return NextResponse.json(
      { error: 'rate_limited', detail: 'Too many questions — try again in a minute.' },
      { status: 429 },
    );
  }

  try {
    await assertTokens(ctx);
    const result = await askAssistant(ctx, parsed.question, parsed.history ?? []);
    return NextResponse.json({ ok: true, answer: result.answer });
  } catch (err) {
    if (err instanceof TokenError) {
      return NextResponse.json({ error: err.code, detail: err.message }, { status: 402 });
    }
    if (err instanceof AssistantError) {
      return NextResponse.json({ error: err.code, detail: err.message }, { status: 400 });
    }
    console.error('[assistant] failed:', err);
    return NextResponse.json(
      { error: 'assistant_failed', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 500 },
    );
  }
}
