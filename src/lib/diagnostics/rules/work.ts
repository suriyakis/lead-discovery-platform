// AP-06 rules: work waiting for people — review, drafts, follow-ups.
// MOB-02 adds drafts.blocked (drafts that cannot reach anyone).

import { and, count, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { outreachFollowUps } from '@/lib/db/schema/follow-ups';
import { outreachDrafts, outreachQueue } from '@/lib/db/schema/outreach';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { qualifications } from '@/lib/db/schema/qualifications';
import { reviewItems } from '@/lib/db/schema/review';
import { daysBefore, hoursBefore, plural } from '../env';
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

/** An approved draft gets this long to be queued before it counts as
 *  stuck (approving and queueing are two steps on the draft page). */
export const APPROVED_UNQUEUED_GRACE_HOURS = 1;

/**
 * MOB-02: drafts that cannot reach anyone. The send queue takes the
 * recipient from the draft's lead (qualified_leads.contact_email) and only
 * takes approved drafts, so:
 *   approved, not queued    approved over an hour ago, never queued, sent
 *                           or sending (the operator approved and nothing
 *                           happened)
 *   approved, no email      approved, but its lead has no contact email
 *                           (or there is no lead): queueing is refused
 *   awaiting, no email      draft / needs_edit whose lead has no contact
 *                           email: approving it will not send it either
 * warning when an approved draft is stuck (A or B); info when only
 * awaiting drafts lack an email. Never notifies (Today and /health show it).
 */
export const draftsBlockedRule = defineRule({
  id: 'drafts.blocked',
  owner: 'outreach',
  summary:
    'Drafts that cannot reach a recipient: approved but never queued, or no contact email on their lead.',
  async evaluate(env) {
    const wsId = env.ctx.workspaceId;
    const onTheirWay = db
      .selectDistinct({ draftId: outreachQueue.draftId })
      .from(outreachQueue)
      .where(
        and(
          eq(outreachQueue.workspaceId, wsId),
          inArray(outreachQueue.status, ['queued', 'sending', 'sent']),
          isNotNull(outreachQueue.draftId),
        ),
      )
      .as('on_way');
    const graceBefore = hoursBefore(env.now, APPROVED_UNQUEUED_GRACE_HOURS).toISOString();
    const noEmail = sql`(${qualifiedLeads.id} is null or coalesce(btrim(${qualifiedLeads.contactEmail}), '') = '')`;
    const approvedIdle = sql`${outreachDrafts.status} = 'approved' and ${onTheirWay.draftId} is null`;
    // The three categories are disjoint.
    const notQueued = sql`${approvedIdle} and not ${noEmail} and coalesce(${outreachDrafts.approvedAt}, ${outreachDrafts.updatedAt}) < ${graceBefore}::timestamptz`;
    const approvedNoEmail = sql`${approvedIdle} and ${noEmail}`;
    const awaitingNoEmail = sql`${outreachDrafts.status} in ('draft', 'needs_edit') and ${noEmail}`;
    const [row] = await db
      .select({
        approvedNotQueued: sql<number>`(count(*) filter (where ${notQueued}))::int`,
        approvedNoEmail: sql<number>`(count(*) filter (where ${approvedNoEmail}))::int`,
        awaitingNoEmail: sql<number>`(count(*) filter (where ${awaitingNoEmail}))::int`,
        firstId: sql<
          string | null
        >`(min(${outreachDrafts.id}) filter (where (${notQueued}) or (${approvedNoEmail}) or (${awaitingNoEmail})))::text`,
      })
      .from(outreachDrafts)
      .leftJoin(
        qualifiedLeads,
        and(
          eq(qualifiedLeads.workspaceId, outreachDrafts.workspaceId),
          eq(qualifiedLeads.reviewItemId, outreachDrafts.reviewItemId),
          eq(qualifiedLeads.productProfileId, outreachDrafts.productProfileId),
        ),
      )
      .leftJoin(onTheirWay, eq(onTheirWay.draftId, outreachDrafts.id))
      .where(
        and(
          eq(outreachDrafts.workspaceId, wsId),
          inArray(outreachDrafts.status, ['draft', 'needs_edit', 'approved']),
        ),
      );
    const a = Number(row?.approvedNotQueued ?? 0);
    const b = Number(row?.approvedNoEmail ?? 0);
    const c = Number(row?.awaitingNoEmail ?? 0);
    if (a + b + c === 0) return [];

    const sentences: string[] = [];
    if (a > 0) {
      sentences.push(
        `${plural(a, 'approved draft was', 'approved drafts were')} never queued, so ${a === 1 ? 'it waits' : 'they wait'} for nothing: open ${a === 1 ? 'it' : 'them'} and queue ${a === 1 ? 'it' : 'them'} (or reject).`,
      );
    }
    if (b > 0) {
      sentences.push(
        `${plural(b, 'approved draft cannot', 'approved drafts cannot')} be queued: the lead has no contact email. Add one on the lead's page.`,
      );
    }
    if (c > 0) {
      sentences.push(
        `${plural(c, 'draft awaiting', 'drafts awaiting')} approval ${c === 1 ? 'has' : 'have'} no contact email on the lead, so approving will not send ${c === 1 ? 'it' : 'them'}.`,
      );
    }
    const stuck = a + b;
    // Exactly one draft involved: link to it; otherwise the list.
    const single = a + b + c === 1 && row?.firstId ? row.firstId : null;
    return [
      {
        code: 'drafts.blocked',
        severity: stuck > 0 ? 'warning' : 'info',
        title:
          stuck > 0
            ? `${plural(stuck, 'approved draft is', 'approved drafts are')} stuck`
            : `${plural(c, 'draft has', 'drafts have')} no contact email`,
        detail: sentences.join(' '),
        facts: { approvedNotQueued: a, approvedNoContactEmail: b, awaitingNoContactEmail: c },
        href: single ? fixHref.draft(single) : fixHref.drafts(),
      },
    ];
  },
});
