// MOB-02 (absorbs flow getAttentionCounts, the ia counts and AP-05a's
// /api/shell/counts): getAttentionSummary(ctx) — THE count source. The
// sidebar badges (AppShell, then useAttention in the browser), Today's
// tiles and Needs-you tabs, the bell, the assistant's counts and
// GET /api/attention all read this one function, so a badge, its tile and
// its destination list cannot disagree (types.ts holds the definitions).
//
// Cheap by construction: about ten small indexed queries in parallel
// (review_items_ws_state_idx, outreach_drafts_ws_status_idx,
// outreach_follow_ups_ws_status_idx, mail_messages_ws_relevance_idx +
// mail_messages_thread_created_idx, notifications_ws_user_unread_idx,
// outreach_queue_ws_status_idx), the automation pill, and the diagnostics
// findings read stale-while-revalidate from the engine's memo (at most
// DIAGNOSTICS_ATTENTION_MAX_AGE_MS old; /health always evaluates afresh).
// Query builders only: inArray(), gte()/ISO casts, isNull() — no JS Date
// inside a raw sql template.
//
// Isolation: every key and section loads on its own. One that throws
// becomes null (the UI prints "—", never 0), is listed in `failed`, and
// sets `degraded`; the rest still report.

import { cache } from 'react';
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { outreachFollowUps } from '@/lib/db/schema/follow-ups';
import { mailMessages } from '@/lib/db/schema/mailing';
import { outreachDrafts, outreachQueue } from '@/lib/db/schema/outreach';
import { reviewItems } from '@/lib/db/schema/review';
import { supportThreads } from '@/lib/db/schema/support';
import { workspaces } from '@/lib/db/schema/workspaces';
import {
  DIAGNOSTICS_ATTENTION_MAX_AGE_MS,
  getWorkspaceDiagnostics,
} from '@/lib/diagnostics/engine';
import { isProblem } from '@/lib/diagnostics/types';
import { describeError } from '@/lib/ops/mask';
import { getAutomationState } from '@/lib/services/automation-policy';
import type { WorkspaceContext } from '@/lib/services/context';
import { unreadNotificationCount } from '@/lib/services/notifications';
import { adminSupportUnreadCount } from '@/lib/services/support';
import {
  ATTENTION_COUNT_KEYS,
  ATTENTION_MAX_FINDINGS,
  ATTENTION_VERSION,
  type AttentionCountKey,
  type AttentionFinding,
  type AttentionHealth,
  type AttentionOutreach,
  type AttentionSection,
  type AttentionSummary,
  type AttentionWallet,
} from './types';

export interface AttentionOptions {
  /** The viewer is a platform super-admin: adds the console's support count. */
  isSuperAdmin?: boolean;
  /** Test seam: the clock every window is measured from. */
  now?: Date;
  /** Evaluate the findings afresh instead of the engine's memo. */
  freshFindings?: boolean;
}

/** Review items nobody has decided on (review.open). */
export const OPEN_REVIEW_STATES = ['new', 'needs_review'] as const;
/** Drafts waiting for a person (drafts.approve = the /drafts default list). */
export const DRAFT_APPROVAL_STATUSES = ['draft', 'needs_edit'] as const;
/** A prospect reply older than this is overdue (replies.overdue). */
export const REPLY_OVERDUE_MS = 24 * 60 * 60 * 1000;

type Ctx = Pick<WorkspaceContext, 'workspaceId' | 'userId'>;

/** review.open, review.needsReview, review.mine — one grouped query. */
async function reviewCounts(ctx: Ctx) {
  const rows = await db
    .select({
      state: reviewItems.state,
      n: count(),
      mine: sql<number>`(count(*) filter (where ${reviewItems.assignedToUserId} = ${ctx.userId}))::int`,
    })
    .from(reviewItems)
    .where(
      and(
        eq(reviewItems.workspaceId, ctx.workspaceId),
        inArray(reviewItems.state, [...OPEN_REVIEW_STATES]),
      ),
    )
    .groupBy(reviewItems.state);
  const of = (state: string) => rows.find((r) => r.state === state);
  return {
    open: rows.reduce((s, r) => s + Number(r.n), 0),
    needsReview: Number(of('needs_review')?.n ?? 0),
    mine: rows.reduce((s, r) => s + Number(r.mine), 0),
  };
}

async function draftsToApprove(ctx: Ctx): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(outreachDrafts)
    .where(
      and(
        eq(outreachDrafts.workspaceId, ctx.workspaceId),
        inArray(outreachDrafts.status, [...DRAFT_APPROVAL_STATUSES]),
      ),
    );
  return Number(row?.n ?? 0);
}

async function followUpsToApprove(ctx: Ctx): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(outreachFollowUps)
    .where(
      and(
        eq(outreachFollowUps.workspaceId, ctx.workspaceId),
        eq(outreachFollowUps.status, 'awaiting_approval'),
      ),
    );
  return Number(row?.n ?? 0);
}

/** The visible prospect replies of a workspace: inbound, relevance
 *  prospect_reply (flow:F-01), not trashed, not spam, on a thread. */
function visibleProspectReplies(workspaceId: bigint) {
  return and(
    eq(mailMessages.workspaceId, workspaceId),
    eq(mailMessages.direction, 'inbound'),
    eq(mailMessages.outreachRelevance, 'prospect_reply'),
    isNull(mailMessages.trashedAt),
    isNull(mailMessages.spamAt),
    isNotNull(mailMessages.threadId),
  );
}

/**
 * The two derived tables behind replies.awaiting: per thread, the newest
 * visible prospect reply (`last_in`) and our newest sent message
 * (`last_out`, only for threads that have a prospect reply). A thread
 * awaits an answer when last_out is missing or older (`awaitingWhere`).
 */
function awaitingReplyTables(workspaceId: bigint) {
  const lastIn = db
    .select({
      threadId: mailMessages.threadId,
      at: sql<Date>`max(coalesce(${mailMessages.receivedAt}, ${mailMessages.createdAt}))`.as(
        'last_in_at',
      ),
    })
    .from(mailMessages)
    .where(visibleProspectReplies(workspaceId))
    .groupBy(mailMessages.threadId)
    .as('last_in');
  const threadsWithReplies = db
    .select({ threadId: mailMessages.threadId })
    .from(mailMessages)
    .where(visibleProspectReplies(workspaceId));
  const lastOut = db
    .select({
      threadId: mailMessages.threadId,
      at: sql<Date>`max(coalesce(${mailMessages.sentAt}, ${mailMessages.createdAt}))`.as(
        'last_out_at',
      ),
    })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, workspaceId),
        eq(mailMessages.direction, 'outbound'),
        inArray(mailMessages.status, ['sent', 'delivered']),
        inArray(mailMessages.threadId, threadsWithReplies),
      ),
    )
    .groupBy(mailMessages.threadId)
    .as('last_out');
  return {
    lastIn,
    lastOut,
    awaitingWhere: or(isNull(lastOut.at), gt(lastIn.at, lastOut.at)),
  };
}

/** replies.awaiting / replies.overdue (types.ts has the definition). */
async function repliesAwaiting(ctx: Ctx, now: Date) {
  const { lastIn, lastOut, awaitingWhere } = awaitingReplyTables(ctx.workspaceId);
  const overdueBefore = new Date(now.getTime() - REPLY_OVERDUE_MS).toISOString();
  const [row] = await db
    .select({
      awaiting: count(),
      overdue: sql<number>`(count(*) filter (where ${lastIn.at} < ${overdueBefore}::timestamptz))::int`,
    })
    .from(lastIn)
    .leftJoin(lastOut, eq(lastOut.threadId, lastIn.threadId))
    .where(awaitingWhere);
  return { awaiting: Number(row?.awaiting ?? 0), overdue: Number(row?.overdue ?? 0) };
}

export interface AwaitingReply {
  threadId: bigint;
  /** The newest visible prospect reply of the thread. */
  messageId: bigint;
  fromName: string | null;
  fromAddress: string;
  subject: string;
  receivedAt: Date;
  classification: string | null;
}

/**
 * The replies.awaiting threads, newest reply first, each with its newest
 * prospect reply: the list Today's Replies tab shows, so its count is
 * exactly the key's number.
 */
export async function listAwaitingReplies(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  options: { limit?: number } = {},
): Promise<AwaitingReply[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const { lastIn, lastOut, awaitingWhere } = awaitingReplyTables(ctx.workspaceId);
  const rows = await db
    .select({
      threadId: lastIn.threadId,
      messageId: mailMessages.id,
      fromName: mailMessages.fromName,
      fromAddress: mailMessages.fromAddress,
      subject: mailMessages.subject,
      receivedAt: mailMessages.receivedAt,
      createdAt: mailMessages.createdAt,
      classification: mailMessages.replyClassification,
    })
    .from(lastIn)
    .leftJoin(lastOut, eq(lastOut.threadId, lastIn.threadId))
    .innerJoin(
      mailMessages,
      and(
        eq(mailMessages.threadId, lastIn.threadId),
        visibleProspectReplies(ctx.workspaceId),
        eq(sql`coalesce(${mailMessages.receivedAt}, ${mailMessages.createdAt})`, lastIn.at),
      ),
    )
    .where(awaitingWhere)
    .orderBy(desc(lastIn.at), desc(mailMessages.id))
    // Two replies of one thread can share the newest timestamp: read a
    // little more, keep the first per thread.
    .limit(limit * 2);
  const seen = new Set<string>();
  const out: AwaitingReply[] = [];
  for (const r of rows) {
    if (r.threadId === null) continue;
    const key = r.threadId.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      threadId: r.threadId,
      messageId: r.messageId,
      fromName: r.fromName,
      fromAddress: r.fromAddress,
      subject: r.subject,
      receivedAt: r.receivedAt ?? r.createdAt,
      classification: r.classification,
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function supportUnread(ctx: Ctx): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(supportThreads)
    .where(
      and(eq(supportThreads.workspaceId, ctx.workspaceId), eq(supportThreads.customerUnread, true)),
    );
  return Number(row?.n ?? 0);
}

/** The automation pill (Ops' policy) and the send queue's two numbers. */
async function outreachState(ctx: Ctx, now: Date): Promise<AttentionOutreach> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const [state, [queue]] = await Promise.all([
    getAutomationState(ctx, { now }),
    db
      .select({
        queued: sql<number>`(count(*) filter (where ${outreachQueue.status} = 'queued'))::int`,
        failed24h: sql<number>`(count(*) filter (where ${outreachQueue.status} = 'failed' and ${outreachQueue.updatedAt} >= ${since}::timestamptz))::int`,
      })
      .from(outreachQueue)
      .where(
        and(
          eq(outreachQueue.workspaceId, ctx.workspaceId),
          inArray(outreachQueue.status, ['queued', 'failed']),
        ),
      ),
  ]);
  return {
    state: state.kind,
    label: state.label,
    paused: state.kind === 'paused',
    live: state.live,
    partlyPaused: state.partlyPaused,
    degraded: state.degraded,
    queued: Number(queue?.queued ?? 0),
    failed24h: Number(queue?.failed24h ?? 0),
  };
}

async function wallet(ctx: Ctx): Promise<AttentionWallet> {
  const [row] = await db
    .select({ balance: workspaces.tokenBalance, billingExempt: workspaces.billingExempt })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);
  if (!row) throw new Error(`workspace ${ctx.workspaceId} not found`);
  const balance = Number(row.balance);
  return { balance, billingExempt: row.billingExempt, empty: !row.billingExempt && balance <= 0 };
}

async function findingsAndHealth(
  ctx: Ctx,
  fresh: boolean,
): Promise<{ findings: AttentionFinding[]; problems: number; health: AttentionHealth }> {
  const report = await getWorkspaceDiagnostics(
    ctx,
    fresh ? { fresh: true } : { maxAgeMs: DIAGNOSTICS_ATTENTION_MAX_AGE_MS },
  );
  const problems = report.findings.filter(isProblem);
  return {
    problems: problems.length,
    findings: problems.slice(0, ATTENTION_MAX_FINDINGS).map((f) => ({
      code: f.code,
      severity: f.severity,
      title: f.title,
      href: f.href,
      ...(f.entity ? { entity: { ...f.entity } } : {}),
      since: f.since,
    })),
    health: {
      score: report.score,
      critical: problems.filter((f) => f.severity === 'critical').length,
      warning: problems.filter((f) => f.severity === 'warning').length,
      partial: report.partial,
      evaluatedAt: report.evaluatedAt.toISOString(),
    },
  };
}

/**
 * What needs a person in the workspace right now. Read-only; any member.
 * Never throws for a failed part (see the header); throws only when it
 * cannot even start.
 */
export async function getAttentionSummary(
  ctx: Ctx,
  options: AttentionOptions = {},
): Promise<AttentionSummary> {
  const now = options.now ?? new Date();
  const failed: Array<AttentionCountKey | AttentionSection> = [];
  const settle = async <T>(
    parts: ReadonlyArray<AttentionCountKey | AttentionSection>,
    load: () => Promise<T>,
  ): Promise<T | null> => {
    try {
      return await load();
    } catch (err) {
      failed.push(...parts);
      const { name, message } = describeError(err);
      console.warn(
        `[attention] ${parts.join(', ')} unavailable for workspace=${ctx.workspaceId}: ${name}: ${message}`,
      );
      return null;
    }
  };

  const [review, drafts, followUps, replies, unread, support, diag, outreach, purse, platform] =
    await Promise.all([
      settle(['review.open', 'review.needsReview', 'review.mine'], () => reviewCounts(ctx)),
      settle(['drafts.approve'], () => draftsToApprove(ctx)),
      settle(['followUps.approve'], () => followUpsToApprove(ctx)),
      settle(['replies.awaiting', 'replies.overdue'], () => repliesAwaiting(ctx, now)),
      settle(['notifications.unread'], () => unreadNotificationCount(ctx)),
      settle(['support.unread'], () => supportUnread(ctx)),
      settle(['problems', 'health'], () => findingsAndHealth(ctx, options.freshFindings ?? false)),
      settle(['outreach'], () => outreachState(ctx, now)),
      settle(['wallet'], () => wallet(ctx)),
      options.isSuperAdmin
        ? settle(['platform'], async () => ({ supportUnread: await adminSupportUnreadCount() }))
        : Promise.resolve(undefined),
    ]);

  const counts: Record<AttentionCountKey, number | null> = {
    'review.open': review?.open ?? null,
    'review.needsReview': review?.needsReview ?? null,
    'review.mine': review?.mine ?? null,
    'drafts.approve': drafts,
    'followUps.approve': followUps,
    'replies.awaiting': replies?.awaiting ?? null,
    'replies.overdue': replies?.overdue ?? null,
    'notifications.unread': unread,
    'support.unread': support,
    problems: diag?.problems ?? null,
  };
  // Every key is accounted for (a new key without a loader fails here).
  for (const key of ATTENTION_COUNT_KEYS) {
    if (counts[key] === undefined) throw new Error(`attention: no loader for ${key}`);
  }

  return {
    version: ATTENTION_VERSION,
    workspaceId: ctx.workspaceId.toString(),
    generatedAt: now.toISOString(),
    counts,
    failed,
    degraded: failed.length > 0,
    findings: diag?.findings ?? [],
    outreach,
    wallet: purse,
    health: diag?.health ?? null,
    platform:
      platform === undefined ? null : platform === null ? { supportUnread: null } : platform,
  };
}

/**
 * The same summary, computed once per server request: AppShell and the
 * page (Today) both ask for it while rendering one request, and React's
 * request cache hands the second caller the first one's promise. Outside
 * a server-component render (route handlers, jobs, tests) it is the plain
 * function.
 */
const summaryForRequest = cache(
  (workspaceId: string, userId: string, isSuperAdmin: boolean): Promise<AttentionSummary> =>
    getAttentionSummary({ workspaceId: BigInt(workspaceId), userId }, { isSuperAdmin }),
);

export function getRequestAttentionSummary(
  ctx: Ctx,
  options: { isSuperAdmin?: boolean } = {},
): Promise<AttentionSummary> {
  return summaryForRequest(ctx.workspaceId.toString(), ctx.userId, options.isSuperAdmin ?? false);
}
