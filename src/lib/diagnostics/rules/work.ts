// AP-06 rules: work waiting for people — review, drafts, follow-ups.

import { and, count, eq, inArray, lt } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { outreachFollowUps } from '@/lib/db/schema/follow-ups';
import { outreachDrafts } from '@/lib/db/schema/outreach';
import { qualifications } from '@/lib/db/schema/qualifications';
import { reviewItems } from '@/lib/db/schema/review';
import { daysBefore, plural } from '../env';
import { fixHref } from '../hrefs';
import { defineRule } from '../rule';
import { notifyEveryDays } from '../types';

const OPEN_REVIEW_STATES = ['new', 'needs_review'] as const;

export const reviewBacklogRule = defineRule({
  id: 'review.backlog',
  owner: 'diagnostics',
  summary: 'More than 10 open review items untouched for over a week.',
  async evaluate(env) {
    const [row] = await db
      .select({ n: count() })
      .from(reviewItems)
      .where(
        and(
          eq(reviewItems.workspaceId, env.ctx.workspaceId),
          inArray(reviewItems.state, [...OPEN_REVIEW_STATES]),
          lt(reviewItems.updatedAt, daysBefore(env.now, 7)),
        ),
      );
    const n = Number(row?.n ?? 0);
    if (n <= 10) return [];
    return [
      {
        code: 'review.backlog',
        severity: 'info',
        title: `${n} review items are older than a week`,
        detail: 'Reviewing them also teaches the qualifier what you want.',
        facts: { olderThanWeek: n },
        href: fixHref.review(),
      },
    ];
  },
});

/** review.noise fires with at least NOISE_MIN_OPEN open items of which
 *  fewer than NOISE_MAX_RELEVANT_SHARE are relevant for any product. */
export const NOISE_MIN_OPEN = 50;
export const NOISE_MAX_RELEVANT_SHARE = 0.1;

/**
 * X8 / I027: a review queue the qualifier itself rejected — production
 * holds 310 open items of which 1 is relevant for any product. The
 * operator wades through noise, and nothing learns from it. Notifies at
 * most every 30 days.
 */
export const reviewNoiseRule = defineRule({
  id: 'review.noise',
  owner: 'discovery',
  summary: 'At least 50 open review items and under 10% of them relevant for any product.',
  async evaluate(env) {
    const wsId = env.ctx.workspaceId;
    const openItems = and(
      eq(reviewItems.workspaceId, wsId),
      inArray(reviewItems.state, [...OPEN_REVIEW_STATES]),
    );
    // Records relevant for at least one product (the qualifier's verdict).
    const relevantRecords = db
      .select({ id: qualifications.sourceRecordId })
      .from(qualifications)
      .where(and(eq(qualifications.workspaceId, wsId), eq(qualifications.isRelevant, true)));
    const [[openRow], [relevantRow]] = await Promise.all([
      db.select({ n: count() }).from(reviewItems).where(openItems),
      db
        .select({ n: count() })
        .from(reviewItems)
        .where(and(openItems, inArray(reviewItems.sourceRecordId, relevantRecords))),
    ]);
    const open = Number(openRow?.n ?? 0);
    const relevant = Number(relevantRow?.n ?? 0);
    if (open < NOISE_MIN_OPEN || relevant / open >= NOISE_MAX_RELEVANT_SHARE) return [];
    const pct = Math.round((relevant / open) * 1000) / 10;
    return [
      {
        code: 'review.noise',
        severity: 'warning',
        title: 'The review queue is mostly noise',
        detail:
          `Only ${relevant} of ${open} open review items (${pct}%) are relevant for any product; the ` +
          'qualifier rejected the rest. Review the relevant ones first, and narrow the searches ' +
          '(queries, countries) so fewer unsuitable companies are found.',
        facts: { open, relevant, relevantPercent: pct },
        href: fixHref.review(),
        notify: { policy: notifyEveryDays(30), dedupeKey: 'review.noise' },
      },
    ];
  },
});

export const draftsStaleRule = defineRule({
  id: 'drafts.stale',
  owner: 'outreach',
  summary: 'Drafts waiting over a week for approval.',
  async evaluate(env) {
    const [row] = await db
      .select({ n: count() })
      .from(outreachDrafts)
      .where(
        and(
          eq(outreachDrafts.workspaceId, env.ctx.workspaceId),
          inArray(outreachDrafts.status, ['draft', 'needs_edit']),
          lt(outreachDrafts.updatedAt, daysBefore(env.now, 7)),
        ),
      );
    const n = Number(row?.n ?? 0);
    if (n === 0) return [];
    return [
      {
        code: 'drafts.stale',
        severity: 'info',
        title: `${plural(n, 'draft has', 'drafts have')} waited over a week for approval`,
        detail: 'Cold leads go colder.',
        facts: { staleDrafts: n },
        href: fixHref.drafts(),
      },
    ];
  },
});

export const followUpsPendingRule = defineRule({
  id: 'follow_ups.pending',
  owner: 'outreach',
  summary: 'Follow-ups awaiting approval.',
  async evaluate(env) {
    const [row] = await db
      .select({ n: count() })
      .from(outreachFollowUps)
      .where(
        and(
          eq(outreachFollowUps.workspaceId, env.ctx.workspaceId),
          eq(outreachFollowUps.status, 'awaiting_approval'),
        ),
      );
    const n = Number(row?.n ?? 0);
    if (n === 0) return [];
    return [
      {
        code: 'follow_ups.pending',
        severity: 'info',
        title: `${plural(n, 'follow-up is', 'follow-ups are')} awaiting approval`,
        detail: 'They go out only once someone approves them.',
        facts: { awaitingApproval: n },
        href: fixHref.followUps(),
      },
    ];
  },
});
