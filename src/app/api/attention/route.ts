// GET /api/attention (MOB-02): the attention summary of the signed-in
// user's active workspace — the numbers behind the sidebar badges, Today's
// tiles and (later) the phone tab bar, polled by useAttention().
//
// The workspace is resolved exactly as pages resolve it
// (getWorkspaceContext → resolveWorkspaceContextForUser: the active
// pointer, god mode for super-admins, a foreign pointer ignored), so the
// badges can never show another tenant than the page. Never cached
// (no-store): the numbers change with every decision.
//
//   200  the summary (src/lib/attention/types.ts), degraded parts as null
//   401  signed out           403  account not active
//   400  no workspace yet

import { NextResponse } from 'next/server';
import { getRequestAttentionSummary } from '@/lib/attention/service';
import { auth } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import { authErrorToResponse } from '@/lib/services/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;

function noStore(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(NO_STORE)) res.headers.set(k, v);
  return res;
}

export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return noStore(NextResponse.json({ error: 'unauthorized' }, { status: 401 }));
  }
  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    const res = authErrorToResponse(err);
    if (res) return noStore(res);
    throw err;
  }
  try {
    const summary = await getRequestAttentionSummary(ctx, {
      isSuperAdmin: session.user.role === 'super_admin',
    });
    return NextResponse.json(summary, { headers: NO_STORE });
  } catch (err) {
    console.error('[api/attention] failed:', err);
    return noStore(NextResponse.json({ error: 'attention_unavailable' }, { status: 500 }));
  }
}
