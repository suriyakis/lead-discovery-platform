// POST /api/signatures/redesign
//
// Phase 54 — generate a fresh HTML signature from the structured fields
// the operator has filled out so far, plus an optional style prompt.
// Returns the candidate HTML without persisting; the SignatureForm /
// edit panel injects it into the bodyHtml textarea so the operator
// previews then saves through the normal create / update path.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import {
  SignatureServiceError,
  redesignSignatureHtml,
} from '@/lib/services/signatures';

const PhoneSchema = z.object({
  label: z.string().max(40),
  number: z.string().max(60),
});

const InputSchema = z.object({
  extraPrompt: z.string().max(2000).nullable().optional(),
  fullName: z.string().max(120).nullable().optional(),
  title: z.string().max(120).nullable().optional(),
  company: z.string().max(120).nullable().optional(),
  tagline: z.string().max(200).nullable().optional(),
  website: z.string().max(2048).nullable().optional(),
  email: z.string().max(255).nullable().optional(),
  phones: z.array(PhoneSchema).max(6).optional(),
  logoUrl: z.string().max(2048).nullable().optional(),
  bodyText: z.string().max(4000).nullable().optional(),
  currentBodyHtml: z.string().max(20000).nullable().optional(),
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
    return NextResponse.json(
      { error: 'invalid_input', detail },
      { status: 400 },
    );
  }

  try {
    const result = await redesignSignatureHtml(ctx, {
      extraPrompt: parsed.extraPrompt ?? null,
      fullName: parsed.fullName ?? null,
      title: parsed.title ?? null,
      company: parsed.company ?? null,
      tagline: parsed.tagline ?? null,
      website: parsed.website ?? null,
      email: parsed.email ?? null,
      phones: parsed.phones,
      logoUrl: parsed.logoUrl ?? null,
      bodyText: parsed.bodyText ?? null,
      currentBodyHtml: parsed.currentBodyHtml ?? null,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SignatureServiceError) {
      const status =
        err.code === 'permission_denied'
          ? 403
          : err.code === 'invalid_input'
            ? 400
            : 500;
      return NextResponse.json(
        { error: err.code, detail: err.message },
        { status },
      );
    }
    const detail = err instanceof Error ? err.message : 'unknown';
    return NextResponse.json(
      { error: 'redesign_failed', detail },
      { status: 500 },
    );
  }
}
