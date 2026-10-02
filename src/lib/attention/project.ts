// MOB-02: the navigation's numbers are a PROJECTION of the attention
// summary — the registry's count keys (src/lib/nav/registry.ts, NavCountKey)
// mapped onto the summary's keys, nothing computed on the side. Pure, so
// the client Sidebar projects the summary it polls the same way AppShell
// projects the one it rendered with.

import type { NavCountKey, NavCountValues, NavSignalKey } from '@/lib/nav/registry';
import type { AttentionCountKey, AttentionSummary } from './types';

/** The navigation's numbers (the registry's keys). null = unknown. */
export interface NavCounts extends NavCountValues {
  /** review.open: review items nobody has decided on (new + needs_review). */
  reviewPending: number | null;
  /** review.needsReview: the Review badge turns amber only when > 0. */
  reviewNeedsReview: number | null;
  /** drafts.approve. */
  draftsPending: number | null;
  /** followUps.approve. */
  followUpsAwaiting: number | null;
  /** The Outreach badge: drafts.approve + followUps.approve. */
  outreachPending: number | null;
  /** support.unread. */
  supportUnread: number | null;
  /** replies.awaiting; the registry gates its badge until I084. */
  repliesUnhandled: number | null;
  /** Super-admins: the console's unread support threads. */
  adminSupportUnread?: number | null;
}

export interface ProjectedNavCounts {
  values: NavCounts;
  /** Registry keys whose source failed to load: badges render "—". */
  unknown: ReadonlySet<NavCountKey | NavSignalKey>;
}

/** Which summary keys each registry key is made of. */
export const NAV_KEY_SOURCES: Readonly<
  Record<Exclude<NavCountKey, 'adminSupportUnread'> | NavSignalKey, readonly AttentionCountKey[]>
> = {
  reviewPending: ['review.open'],
  reviewNeedsReview: ['review.needsReview'],
  outreachPending: ['drafts.approve', 'followUps.approve'],
  repliesUnhandled: ['replies.awaiting'],
  supportUnread: ['support.unread'],
};

function sum(values: ReadonlyArray<number | null>): number | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

/** The registry's numbers from one summary. */
export function navCountsFromAttention(summary: AttentionSummary): ProjectedNavCounts {
  const c = summary.counts;
  const unknown = new Set<NavCountKey | NavSignalKey>();
  for (const [navKey, sources] of Object.entries(NAV_KEY_SOURCES) as Array<
    [NavCountKey | NavSignalKey, readonly AttentionCountKey[]]
  >) {
    if (sources.some((k) => c[k] === null)) unknown.add(navKey);
  }
  const values: NavCounts = {
    reviewPending: c['review.open'],
    reviewNeedsReview: c['review.needsReview'],
    draftsPending: c['drafts.approve'],
    followUpsAwaiting: c['followUps.approve'],
    outreachPending: sum([c['drafts.approve'], c['followUps.approve']]),
    supportUnread: c['support.unread'],
    repliesUnhandled: c['replies.awaiting'],
  };
  if (summary.platform) {
    values.adminSupportUnread = summary.platform.supportUnread;
    if (summary.platform.supportUnread === null) unknown.add('adminSupportUnread');
  }
  return { values, unknown };
}
