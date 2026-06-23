// POST /api/communication/reply
//
// Phase 57 — operator-driven reply on the communication detail page.
// Wraps mail.sendMessage with the inline signature override + thread
// header threading (in-reply-to + references) so the reply lands on the
// same mail_thread the operator is looking at.
//
// Phase 63: the reply composer translates on demand and shows the result
// for review before sending. When the operator generated a translation we
// send that exact (possibly edited) text and keep the native reply as the
// thread reference; otherwise the reply is sent as written. No silent
// auto-translation.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { getWorkspaceNativeLanguage } from '@/lib/services/workspace';
import { MailServiceError, sendMessage } from '@/lib/services/mail';

const InputSchema = z.object({
  threadId: z.coerce.bigint(),
  mailboxId: z.coerce.bigint(),
  to: z.string().email(),
  subject: z.string().min(1).max(998),
  body: z.string().min(1).max(50_000),
  inReplyTo: z.string().nullable().optional(),
  references: z.array(z.string()).max(50).optional(),
  /** '__default__' = mailbox default, '__none__' = no signature, else
   *  the signature id (numeric string). */
  signatureId: z.string().optional(),
  /** Operator-reviewed translation (sent verbatim when present). */
  targetLanguage: z.string().min(2).max(10).optional(),
  translatedSubject: z.string().max(998).optional(),
  translatedBody: z.string().max(50_000).optional(),
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

  // Resolve signature pick.
  let signatureId: bigint | null | undefined;
  if (!parsed.signatureId || parsed.signatureId === '__default__') {
    signatureId = undefined; // use mailbox default
  } else if (parsed.signatureId === '__none__') {
    signatureId = null;
  } else if (/^\d+$/.test(parsed.signatureId)) {
    signatureId = BigInt(parsed.signatureId);
  } else {
    return NextResponse.json(
      { error: 'invalid_input', detail: 'signatureId must be numeric, __default__, or __none__' },
      { status: 400 },
    );
  }

  const useTranslation = Boolean(
    parsed.targetLanguage && parsed.translatedBody && parsed.translatedBody.trim(),
  );
  const nativeLanguage = useTranslation ? await getWorkspaceNativeLanguage(ctx) : undefined;

  try {
    const sent = await sendMessage(ctx, {
      mailboxId: parsed.mailboxId,
      to: [{ address: parsed.to }],
      subject: useTranslation
        ? parsed.translatedSubject?.trim() || parsed.subject
        : parsed.subject,
      text: useTranslation ? parsed.translatedBody! : parsed.body,
      // Keep the native reply as the thread reference.
      bodyTextNative: useTranslation ? parsed.body : undefined,
      nativeLanguage: useTranslation ? nativeLanguage : undefined,
      targetLanguage: useTranslation ? parsed.targetLanguage : undefined,
      inReplyTo: parsed.inReplyTo ?? undefined,
      references: parsed.references,
      signatureId,
    });
    return NextResponse.json({
      ok: true,
      messageId: sent.messageId,
      threadId: sent.threadId?.toString() ?? null,
    });
  } catch (err) {
    if (err instanceof MailServiceError) {
      const status = err.code === 'permission_denied' ? 403 : 400;
      return NextResponse.json(
        { error: err.code, detail: err.message },
        { status },
      );
    }
    const detail = err instanceof Error ? err.message : 'unknown';
    return NextResponse.json({ error: 'send_failed', detail }, { status: 500 });
  }
}
