// GET /api/learning/receipts/[decisionId] — what the platform learned from
// one decision (KL-03). Workspace-scoped: a decision of another workspace
// answers 404 exactly like one that does not exist.

import { NextResponse, type NextRequest } from 'next/server';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import { errorResponse } from '@/lib/services/http';
import { getDecisionReceipt } from '@/lib/services/learning-receipts';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ decisionId: string }> },
) {
  try {
    const ctx = await getWorkspaceContext();
    const { decisionId } = await params;
    const receipt = await getDecisionReceipt(ctx, decisionId);
    if (!receipt) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ receipt });
  } catch (err) {
    return errorResponse(err);
  }
}
