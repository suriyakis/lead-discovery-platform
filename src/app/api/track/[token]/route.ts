// Phase 22: tracking-pixel endpoint.
// GET /api/track/<token>.gif — records an open event keyed by the
// opaque trackingToken stored on the mail_messages row at send time.
// Always returns a 1x1 transparent GIF so the user's mail client renders
// nothing visible regardless of whether the token resolves.

import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { emailOpens, mailMessages } from '@/lib/db/schema/mailing';

// 1x1 transparent GIF (43 bytes, base64 — universal email-pixel literal).
const GIF_BASE64 =
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const GIF_BUFFER = Buffer.from(GIF_BASE64, 'base64');

function gifResponse(): NextResponse {
  return new NextResponse(GIF_BUFFER, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
    },
  });
}

function ipHash(req: Request): string | null {
  const fwd = req.headers.get('x-forwarded-for') ?? '';
  const ip = fwd.split(',')[0]?.trim() || null;
  if (!ip) return null;
  return createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token: raw } = await params;
  // Strip a trailing .gif if present (the URL ends in .gif by convention).
  const token = raw.replace(/\.gif$/i, '');
  if (!/^[a-f0-9]{16,64}$/i.test(token)) {
    return gifResponse();
  }

  try {
    const msgRows = await db
      .select({
        id: mailMessages.id,
        workspaceId: mailMessages.workspaceId,
        firstOpenedAt: mailMessages.firstOpenedAt,
      })
      .from(mailMessages)
      .where(eq(mailMessages.trackingToken, token))
      .limit(1);
    const msg = msgRows[0];
    if (msg) {
      const ua = req.headers.get('user-agent')?.slice(0, 500) ?? null;
      const ip = ipHash(req);
      // Best-effort: record the open + bump the counter.
      await db.insert(emailOpens).values({
        workspaceId: msg.workspaceId,
        messageId: msg.id,
        token,
        userAgent: ua,
        ipHash: ip,
      });
      await db
        .update(mailMessages)
        .set({
          openCount: sql`${mailMessages.openCount} + 1`,
          firstOpenedAt: msg.firstOpenedAt ?? new Date(),
          updatedAt: new Date(),
        })
        .where(eq(mailMessages.id, msg.id));
    }
  } catch (err) {
    // Never let tracking errors leak as failures — always return the GIF.
    console.error('[track] open event failed:', err);
  }

  return gifResponse();
}
