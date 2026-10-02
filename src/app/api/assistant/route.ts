// POST /api/assistant — the in-app AI guide ("Ask the platform").
// Body: { question: string, history?: [{role, content}] }
//
// Metered AI usage (kind ai.assistant). It does NOT 402 on an empty
// wallet: askAssistant then skips the model and returns a free,
// deterministic answer built from the rule findings, with a
// [/settings/billing] link (source: 'deterministic'). A super-admin's
// question is metered as platform support and never debited.
//
// Errors — `detail` is always our own copy, never provider text:
//   401 unauthorized · 400 no_workspace · 403 account_inactive
//   400 invalid_input · 429 rate_limited
//   502 empty_answer (retryable) — the model returned no visible text
//   500 assistant_failed (retryable) — anything else; logged server-side
//   409 workspace_changed — MOB-06: the x-expected-workspace header (the
//       page's workspace) no longer matches this browser's session
//
// The answer carries `workspaceId`, the workspace it was computed for, so
// the panel can link its [/path] references there (through /go).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import { AssistantError, askAssistant } from '@/lib/services/assistant';
import { authErrorToResponse } from '@/lib/services/http';
import { rateLimitAllow } from '@/lib/rate-limit';
import { HISTORY_TURN_MAX_CHARS } from '@/lib/assistant/panel-state';
import { withWorkspaceGuardRoute } from '@/lib/workspace-guard/server';

const InputSchema = z.object({
  question: z.string().min(1).max(2000),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        // Clipped, never rejected: a long earlier answer must not turn
        // every later question into a 400 (askAssistant reads only the
        // first 500 characters of each turn).
        content: z.string().transform((s) => s.slice(0, HISTORY_TURN_MAX_CHARS)),
      }),
    )
    .max(16)
    .optional(),
});

async function handlePost(req: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    const res = authErrorToResponse(err);
    if (res) return res;
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
      { error: 'rate_limited', detail: 'Too many questions — try again in a minute.', retryable: true },
      { status: 429 },
    );
  }

  try {
    const result = await askAssistant(ctx, parsed.question, parsed.history ?? []);
    return NextResponse.json({
      ok: true,
      answer: result.answer,
      source: result.source,
      workspaceId: ctx.workspaceId.toString(),
      ...(result.findings ? { findings: result.findings } : {}),
    });
  } catch (err) {
    if (err instanceof AssistantError) {
      const status = err.code === 'empty_answer' ? 502 : 400;
      return NextResponse.json(
        { error: err.code, detail: err.message, retryable: err.retryable },
        { status },
      );
    }
    // Provider failures (429/529/timeouts) and anything unexpected. The
    // raw message can carry vendor response text — log it, don't show it.
    console.error('[assistant] failed:', err);
    return NextResponse.json(
      {
        error: 'assistant_failed',
        detail: 'The AI guide is unavailable right now. Your question is kept — try again in a moment.',
        retryable: true,
      },
      { status: 500 },
    );
  }
}

export const POST = withWorkspaceGuardRoute('assistant.ask', handlePost);
