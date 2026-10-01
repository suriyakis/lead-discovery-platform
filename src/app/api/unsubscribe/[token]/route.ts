// Phase 35 + flow:F-05 (I012): public unsubscribe endpoint.
//   GET  /api/unsubscribe/<token> — a confirmation page with a button.
//                                    Changes NOTHING: link scanners and
//                                    previews fetch every URL in an email.
//   HEAD /api/unsubscribe/<token> — explicit no-op (Next would otherwise
//                                    run GET for it).
//   POST /api/unsubscribe/<token> — the opt-out: the page's button, or a
//                                    mail client's RFC 8058 one-click POST
//                                    (body List-Unsubscribe=One-Click).
//                                    Suppresses the recipients and stops
//                                    queued mail, follow-ups and open leads.
//
// Always 200 — a 404 for unknown tokens would let a prober learn which
// tokens exist. POST is idempotent.

import { NextResponse } from 'next/server';
import {
  confirmUnsubscribe,
  resolveUnsubscribeToken,
} from '@/lib/services/unsubscribe';
import { renderConfirmPage, renderDonePage, renderInvalidPage } from './render';

type Params = { params: Promise<{ token: string }> };

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
} as const;

export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const { token } = await params;
  const target = await resolveUnsubscribeToken(token);
  const html = target ? renderConfirmPage(target) : renderInvalidPage();
  return new NextResponse(html, { status: 200, headers: PAGE_HEADERS });
}

export async function HEAD(): Promise<NextResponse> {
  return new NextResponse(null, { status: 200, headers: PAGE_HEADERS });
}

export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { token } = await params;
  const fromPage = isPageConfirm(await req.text().catch(() => ''));
  const target = fromPage ? await resolveUnsubscribeToken(token) : null;
  const outcome = await confirmUnsubscribe(token);
  // RFC 8058 one-click: an empty 200 is all a mail client needs.
  if (!fromPage) return new NextResponse(null, { status: 200 });
  const html =
    outcome.addresses.length > 0
      ? renderDonePage(outcome.addresses, target?.language ?? null)
      : renderInvalidPage(target?.language ?? null);
  return new NextResponse(html, { status: 200, headers: PAGE_HEADERS });
}

/** The page's form posts `confirm=1`; a one-click client posts
 *  `List-Unsubscribe=One-Click`. */
function isPageConfirm(body: string): boolean {
  return /(?:^|&)confirm=1(?:&|$)/.test(body.trim());
}
