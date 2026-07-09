// Sidebar count badges. One small query per category. Returned values
// are non-negative integers; missing tables return 0 so a partially-
// migrated workspace doesn't crash the layout. Best-effort: errors
// degrade to 0 with a console warning.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { outreachDrafts } from '@/lib/db/schema/outreach';
import { reviewItems } from '@/lib/db/schema/review';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { supportThreads } from '@/lib/db/schema/support';
import type { WorkspaceContext } from './context';

export interface NavCounts {
  /** Drafts awaiting human review (status in draft / needs_edit). */
  draftsPending: number;
  /** Review items the operator hasn't decided on yet. */
  reviewPending: number;
  /** Pipeline leads not closed. */
  leadsOpen: number;
  /** Support threads with an unread admin reply. */
  supportUnread: number;
}

const ZERO: NavCounts = {
  draftsPending: 0,
  reviewPending: 0,
  leadsOpen: 0,
  supportUnread: 0,
};

export async function getNavCounts(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<NavCounts> {
  try {
    const [draftsRow, reviewRow, leadsRow, supportRow] = await Promise.all([
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(outreachDrafts)
        .where(
          and(
            eq(outreachDrafts.workspaceId, ctx.workspaceId),
            inArray(outreachDrafts.status, ['draft', 'needs_edit']),
          ),
        ),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(reviewItems)
        .where(
          and(
            eq(reviewItems.workspaceId, ctx.workspaceId),
            inArray(reviewItems.state, ['new', 'needs_review']),
          ),
        ),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(qualifiedLeads)
        .where(
          and(
            eq(qualifiedLeads.workspaceId, ctx.workspaceId),
            sql`${qualifiedLeads.state} <> 'closed'`,
          ),
        ),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(supportThreads)
        .where(
          and(
            eq(supportThreads.workspaceId, ctx.workspaceId),
            eq(supportThreads.customerUnread, true),
          ),
        ),
    ]);
    return {
      draftsPending: draftsRow[0]?.n ?? 0,
      reviewPending: reviewRow[0]?.n ?? 0,
      leadsOpen: leadsRow[0]?.n ?? 0,
      supportUnread: supportRow[0]?.n ?? 0,
    };
  } catch (err) {
    console.warn('[nav-counts] degraded to zero:', err);
    return ZERO;
  }
}
