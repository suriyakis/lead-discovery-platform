// POST /api/translate
//
// Generic on-demand translation for compose/reply UIs: translate a subject +
// body into a target language (hinting the workspace native language as the
// source). No-op when the target equals the native language. Workspace-scoped.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { getWorkspaceNativeLanguage } from '@/lib/services/workspace';
import { translateText } from '@/lib/services/translation';

const InputSchema = z.object({
  subject: z.string().max(998).optional().default(''),
  body: z.string().min(1).max(50_000),
  targetLanguage: z.string().min(2).max(10),
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
  } catch (err) {
    const detail = err instanceof z.ZodError ? err.message : 'invalid_input';
    return NextResponse.json({ error: 'invalid_input', detail }, { status: 400 });
  }

  const native = await getWorkspaceNativeLanguage(ctx);
  const target = parsed.targetLanguage.toLowerCase().split('-')[0] ?? '';
  if (!target || target === native) {
    return NextResponse.json({ ok: true, subject: parsed.subject, body: parsed.body });
  }

  try {
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
    const detail = err instanceof Error ? err.message : 'unknown';
    return NextResponse.json({ error: 'translate_failed', detail }, { status: 500 });
  }
}
