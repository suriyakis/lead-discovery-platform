import { NextResponse } from 'next/server';
import {
  checkReadiness,
  isReadinessDetailAuthorized,
  publicReadiness,
} from '@/lib/services/readiness';

// PC-07 (I022): readiness for the external uptime monitor. 200 when the
// database, Redis (bullmq only), migrations and every tick heartbeat are
// fine; 503 otherwise. Anonymous callers get { ok, checkedAt }; the full
// report needs `Authorization: Bearer <OPS_READY_TOKEN>`.
// /api/health stays the cheap liveness probe. See docs/OPS_MONITORING.md.

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const report = await checkReadiness();
  const body = isReadinessDetailAuthorized(request.headers.get('authorization'))
    ? report
    : publicReadiness(report);
  return NextResponse.json(body, {
    status: report.ok ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
