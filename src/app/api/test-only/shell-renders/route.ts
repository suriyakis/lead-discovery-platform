// GET /api/test-only/shell-renders?probe=<id> — how many times the
// workspace frame was rendered on the server for requests carrying that
// probe cookie (src/lib/shell/render-probe.ts). e2e/app-shell.spec.ts uses
// it to prove client navigation does not re-render the frame (DS-07,
// MOB-03). A 404 unless ENABLE_TEST_ROUTES=1, as every test-only route.

import { NextResponse } from 'next/server';
import { shellProbeEnabled, shellRenderCount } from '@/lib/shell/render-probe';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  if (!shellProbeEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const probe = new URL(req.url).searchParams.get('probe') ?? '';
  return NextResponse.json(
    { probe, renders: shellRenderCount(probe) },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
