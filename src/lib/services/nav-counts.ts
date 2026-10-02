// Navigation badge numbers (Sidebar, area tabs, account menu, console
// nav). MOB-02: a PROJECTION of the attention summary
// (src/lib/attention): the registry's count keys mapped onto the
// summary's keys, nothing queried here, so a badge can never disagree with
// the Today tile or the /api/attention number it stands for. The
// registry's count policy (src/lib/nav/registry.ts, resolveNavCount)
// decides which ones show and in which tone; a key whose source failed to
// load is `null` and listed in `unknown` (its badge prints "—", never 0).

import { getAttentionSummary } from '@/lib/attention/service';
import {
  navCountsFromAttention,
  type NavCounts,
  type ProjectedNavCounts,
} from '@/lib/attention/project';
import type { NavCountKey, NavSignalKey } from '@/lib/nav/registry';
import type { WorkspaceContext } from './context';

export { navCountsFromAttention, type NavCounts, type ProjectedNavCounts };

/** No workspace resolved yet: no numbers at all (not zeros). */
export const NO_NAV_COUNTS: ProjectedNavCounts = { values: {} as NavCounts, unknown: new Set() };

/**
 * Compile-time guard: every tenant count key and gate signal the registry
 * can ask for is produced by the projection (adminSupportUnread comes from
 * the summary's platform section, super-admins only).
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

/** The navigation's numbers for a workspace (a projection of
 *  getAttentionSummary). */
export async function getNavCounts(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
  options: { isSuperAdmin?: boolean } = {},
): Promise<ProjectedNavCounts> {
  return navCountsFromAttention(await getAttentionSummary(ctx, options));
}
