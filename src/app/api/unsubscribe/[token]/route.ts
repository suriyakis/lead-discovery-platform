// Phase 35: public unsubscribe endpoint. Two methods:
//   GET  /api/unsubscribe/<token>  — browser click. Adds to suppression
//                                     list and renders a confirmation page.
//   POST /api/unsubscribe/<token>  — RFC 8058 one-click. Mail clients
//                                     POST here automatically when the
//                                     user clicks the unsubscribe button
//                                     in Gmail / Outlook / Yahoo.
//
// Always responds 200 — leaking token validity (404 vs 200) helps
// adversaries probe which messages were sent. Both methods are safe to
// retry; the underlying upsert is idempotent.

import { NextResponse } from 'next/server';
import { recordUnsubscribeByToken } from '@/lib/services/suppression';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await params;
  await recordUnsubscribeByToken(token);
  // RFC 8058 expects an empty 200 response.
  return new NextResponse(null, { status: 200 });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await params;
  const result = await recordUnsubscribeByToken(token);
  const addresses = result.addresses;
  const html = renderConfirmationPage(addresses);
  return new NextResponse(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function renderConfirmationPage(addresses: string[]): string {
  // Self-contained HTML — no app shell. Public, unauthenticated.
  const escaped = addresses.map(escapeHtml);
  const list =
    escaped.length > 0
      ? `<ul>${escaped.map((a) => `<li><code>${a}</code></li>`).join('')}</ul>`
      : '<p>This unsubscribe link has already been used or is no longer valid. You will not receive further messages.</p>';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Unsubscribed</title>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      body { font-family: -apple-system, system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; color: #1f2937; }
      h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
      .muted { color: #6b7280; font-size: 0.95rem; }
      ul { background: #f3f4f6; padding: 1rem 1.5rem; border-radius: 6px; }
      code { font-family: ui-monospace, Menlo, Consolas, monospace; }
    </style>
  </head>
  <body>
    <h1>You have been unsubscribed</h1>
    <p class="muted">${addresses.length > 0 ? 'These addresses will no longer receive outreach from this sender:' : ''}</p>
    ${list}
    <p class="muted">If this was a mistake, reply to the original message and the sender can re-add you manually.</p>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
