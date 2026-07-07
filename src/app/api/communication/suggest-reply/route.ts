// POST /api/communication/suggest-reply
//
// Wires the Phase 12 reply assistant into the communication detail page:
// given a threadId, retrieve workspace knowledge chunks + lessons for the
// most recent inbound message and draft a grounded reply the operator can
// edit before sending. The suggestion NEVER auto-sends — it only fills the
// composer.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { ReplyAssistantError, suggestReply } from '@/lib/services/reply-assistant';
import { TokenError, assertTokens } from '@/lib/services/token-ledger';

const InputSchema = z.object({
  threadId: z.coerce.bigint(),
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

  try {
    await assertTokens(ctx);
    const suggestion = await suggestReply(ctx, { threadId: parsed.threadId });
    return NextResponse.json({
      ok: true,
      text: suggestion.text,
      model: suggestion.model,
      sources: {
        chunkCount: suggestion.sources.chunkIds.length,
        lessonCount: suggestion.sources.lessonIds.length,
      },
    });
  } catch (err) {
    if (err instanceof TokenError) {
      return NextResponse.json(
        { error: err.code, detail: err.message },
        { status: 402 },
      );
    }
    if (err instanceof ReplyAssistantError) {
      const status =
        err.code === 'not_found' ? 404 : err.code === 'permission_denied' ? 403 : 400;
      return NextResponse.json({ error: err.code, detail: err.message }, { status });
    }
    console.error('[suggest-reply] failed:', err);
    return NextResponse.json(
      { error: 'suggest_failed', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 500 },
    );
  }
}
