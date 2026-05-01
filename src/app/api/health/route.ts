import { NextResponse } from 'next/server';

// Phase 1 health endpoint. Reports the bare minimum that this Next.js process
// is alive and responding. Phase 1 P1-09 extends it with database + queue
// status; do not add those checks here yet — keep this fast and cheap so
// load balancers and uptime checks don't get flaky responses.

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ ok: true });
}
