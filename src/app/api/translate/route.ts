// POST /api/translate
//
// Generic on-demand translation for compose/reply UIs: translate a subject +
// body into a target language (hinting the workspace native language as the
// source). No-op when the target equals the native language. Workspace-scoped.
//
// MOB-06: guarded (it spends tokens) — the caller sends the page's
// workspace as the x-expected-workspace header; after a switch in another
// tab it answers 409 workspace_changed before anything is spent.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import { authErrorToResponse } from '@/lib/services/http';
import { getWorkspaceNativeLanguage } from '@/lib/services/workspace';
import { translateText } from '@/lib/services/translation';
import { TokenError, assertTokens } from '@/lib/services/token-ledger';
import { rateLimitAllow } from '@/lib/rate-limit';
import { withWorkspaceGuardRoute } from '@/lib/workspace-guard/server';

const InputSchema = z.object({
  subject: z.string().max(998).optional().default(''),
  body: z.string().min(1).max(50_000),
  targetLanguage: z.string().min(2).max(10),
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
  } catch (err) {
    const detail = err instanceof z.ZodError ? err.message : 'invalid_input';
    return NextResponse.json({ error: 'invalid_input', detail }, { status: 400 });
  }

  const native = await getWorkspaceNativeLanguage(ctx);
  const target = parsed.targetLanguage.toLowerCase().split('-')[0] ?? '';
  if (!target || target === native) {
    return NextResponse.json({ ok: true, subject: parsed.subject, body: parsed.body });
  }

  if (!rateLimitAllow(`translate:ws:${ctx.workspaceId}`, 30, 60_000)) {
    return NextResponse.json(
      { error: 'rate_limited', detail: 'Too many translations — try again in a minute.' },
      { status: 429 },
    );
  }

  try {
    await assertTokens(ctx);
    const bodyT = await translateText(ctx, {
      text: parsed.body,
      targetLanguage: target,
      sourceLanguageHint: native,
    });
    const subjT = parsed.subject
      ? await translateText(ctx, {
          text: parsed.subject,
          targetLanguage: target,
          sourceLanguageHint: native,
        })
      : null;
    return NextResponse.json({
      ok: true,
      subject: subjT?.translatedText ?? parsed.subject,
      body: bodyT.translatedText,
    });
  } catch (err) {
    if (err instanceof TokenError) {
      return NextResponse.json(
        { error: err.code, detail: err.message },
        { status: 402 },
      );
    }
    const detail = err instanceof Error ? err.message : 'unknown';
    return NextResponse.json({ error: 'translate_failed', detail }, { status: 500 });
  }
}

export const POST = withWorkspaceGuardRoute('communication.translate', handlePost);
