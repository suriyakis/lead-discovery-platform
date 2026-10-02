// Navigation badge numbers (Sidebar, account menu). One small query per
// number; the registry's count policy (src/lib/nav/registry.ts,
// resolveNavCount) decides which ones show and in which tone. Returned
// values are non-negative integers. Best-effort: an error degrades every
// number to 0 with a console warning, so a partially migrated workspace
// never breaks the layout. MOB-02 later turns this into a projection of
// getAttentionSummary(); keep the keys in step with NavCountKey.

import { and, count, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { outreachDrafts } from '@/lib/db/schema/outreach';
import { outreachFollowUps } from '@/lib/db/schema/follow-ups';
import { reviewItems } from '@/lib/db/schema/review';
import { supportThreads } from '@/lib/db/schema/support';
import type { NavCountKey, NavCountValues, NavSignalKey } from '@/lib/nav/registry';
import type { WorkspaceContext } from './context';

export interface NavCounts extends NavCountValues {
  /** Review items nobody has decided on yet (new + needs_review). */
  reviewPending: number;
  /** needs_review only: the Review badge turns amber only when > 0. */
  reviewNeedsReview: number;
  /** Drafts awaiting a person (status draft / needs_edit). */
  draftsPending: number;
  /** Follow-ups composed and waiting for approval. */
  followUpsAwaiting: number;
  /** The Outreach badge: drafts + follow-ups awaiting approval. */
  outreachPending: number;
  /** Support threads with an unread reply from the platform team. */
  supportUnread: number;
  /** Gated until I084 (registry): not computed, never shown. */
  repliesUnhandled: null;
}

export const ZERO_NAV_COUNTS: NavCounts = {
  reviewPending: 0,
  reviewNeedsReview: 0,
  draftsPending: 0,
  followUpsAwaiting: 0,
  outreachPending: 0,
  supportUnread: 0,
  repliesUnhandled: null,
};

/**
 * Compile-time guard: every tenant count key and gate signal the registry
 * can ask for is produced here (adminSupportUnread is platform-wide;
 * AppShell adds it for super-admins).
 */
export const NAV_COUNT_KEYS_PRODUCED: Record<
  Exclude<NavCountKey, 'adminSupportUnread'> | NavSignalKey,
  true
> = {
  reviewPending: true,
  reviewNeedsReview: true,
  outreachPending: true,
  repliesUnhandled: true,
  supportUnread: true,
};

export async function getNavCounts(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<NavCounts> {
  try {
    const [reviewRows, draftsRow, followUpsRow, supportRow] = await Promise.all([
      db
        .select({ state: reviewItems.state, n: count() })
        .from(reviewItems)
        .where(
          and(
            eq(reviewItems.workspaceId, ctx.workspaceId),
            inArray(reviewItems.state, ['new', 'needs_review']),
          ),
        )
        .groupBy(reviewItems.state),
      db
        .select({ n: count() })
        .from(outreachDrafts)
        .where(
          and(
            eq(outreachDrafts.workspaceId, ctx.workspaceId),
            inArray(outreachDrafts.status, ['draft', 'needs_edit']),
          ),
        ),
      db
        .select({ n: count() })
        .from(outreachFollowUps)
        .where(
          and(
            eq(outreachFollowUps.workspaceId, ctx.workspaceId),
            eq(outreachFollowUps.status, 'awaiting_approval'),
          ),
        ),
      db
        .select({ n: count() })
        .from(supportThreads)
        .where(
          and(
            eq(supportThreads.workspaceId, ctx.workspaceId),
            eq(supportThreads.customerUnread, true),
          ),
        ),
    ]);
    const byState = (state: string) =>
      Number(reviewRows.find((r) => r.state === state)?.n ?? 0);
    const draftsPending = Number(draftsRow[0]?.n ?? 0);
    const followUpsAwaiting = Number(followUpsRow[0]?.n ?? 0);
    return {
      reviewPending: byState('new') + byState('needs_review'),
      reviewNeedsReview: byState('needs_review'),
      draftsPending,
      followUpsAwaiting,
      outreachPending: draftsPending + followUpsAwaiting,
      supportUnread: Number(supportRow[0]?.n ?? 0),
      repliesUnhandled: null,
    };
  } catch (err) {
    console.warn('[nav-counts] degraded to zero:', err);
    return ZERO_NAV_COUNTS;
  }
}
