import { NextResponse } from 'next/server';

// Liveness probe: reports the bare minimum that this Next.js process is
// alive and responding. Deliberately I/O-free — no database, Redis or
// queue check — so load balancers and container health checks never get
// flaky answers. Dependency and background-job checks live in
// /api/ready (PC-07, docs/OPS_MONITORING.md).

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ ok: true });
}
