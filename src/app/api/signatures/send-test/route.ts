// POST /api/signatures/send-test
//
// Phase 56 — per-signature deliverability test. Picks an active mailbox
// (the default one, or the signature's mailbox-scoped one if set),
// sends a real email through SMTP with the selected signature appended,
// returns the SMTP response. Wraps the existing sendTestEmail() service.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { db } from '@/lib/db/client';
import { mailboxes, signatures } from '@/lib/db/schema/mailing';
import { and, desc, eq } from 'drizzle-orm';
import { sendTestEmail, MailServiceError } from '@/lib/services/mail';

const InputSchema = z.object({
  signatureId: z.coerce.bigint(),
  to: z.string().email(),
  mailboxId: z.coerce.bigint().optional(),
});

const DEFAULT_BODY = `This is a signature test from your Lead Discovery Platform.

If you can read this, SMTP delivery + signature rendering are working.
The signature below should match the live preview from the editor.`;

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

  // Resolve the signature → confirm workspace ownership.
  const [sig] = await db
    .select()
    .from(signatures)
    .where(
      and(
        eq(signatures.workspaceId, ctx.workspaceId),
        eq(signatures.id, parsed.signatureId),
      ),
    )
    .limit(1);
  if (!sig) {
    return NextResponse.json({ error: 'signature_not_found' }, { status: 404 });
  }

  // Resolve the mailbox to send from. Caller's explicit pick wins; else
  // use the signature's mailbox; else the workspace default; else the
  // most-recently-created active mailbox.
  let mailboxId: bigint | null = parsed.mailboxId ?? sig.mailboxId ?? null;
  if (!mailboxId) {
    const [def] = await db
      .select()
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.workspaceId, ctx.workspaceId),
          eq(mailboxes.isDefault, true),
          eq(mailboxes.status, 'active'),
        ),
      )
      .limit(1);
    if (def) {
      mailboxId = def.id;
    } else {
      const [any] = await db
        .select()
        .from(mailboxes)
        .where(
          and(
            eq(mailboxes.workspaceId, ctx.workspaceId),
            eq(mailboxes.status, 'active'),
          ),
        )
        .orderBy(desc(mailboxes.createdAt))
        .limit(1);
      mailboxId = any?.id ?? null;
    }
  }
  if (!mailboxId) {
    return NextResponse.json(
      {
        error: 'no_active_mailbox',
        detail: 'No active mailbox in this workspace — configure one under /mailbox first.',
      },
      { status: 400 },
    );
  }

  try {
    const result = await sendTestEmail(ctx, {
      mailboxId,
      to: parsed.to,
      subject: `Signature test: ${sig.name}`,
      body: DEFAULT_BODY,
      signatureId: parsed.signatureId,
    });
    return NextResponse.json({
      ok: true,
      messageId: result.messageId,
      smtpResponse: result.smtpResponse,
      signatureName: result.signatureName,
    });
  } catch (err) {
    if (err instanceof MailServiceError) {
      const status = err.code === 'permission_denied' ? 403 : 400;
      return NextResponse.json({ error: err.code, detail: err.message }, { status });
    }
    const detail = err instanceof Error ? err.message : 'unknown';
    return NextResponse.json({ error: 'send_failed', detail }, { status: 500 });
  }
}
