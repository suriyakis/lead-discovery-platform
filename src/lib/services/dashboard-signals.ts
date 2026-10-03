// Dashboard cockpit signals. One server call returns everything the
// dashboard widgets need so the landing page doesn't fire 5 separate
// queries with their own loading states. Best-effort: a failing query
// does not fail the page — the result comes back `degraded` and the page
// shows "—" with a warning, never a zero that looks like a real count
// (PC-33, I070).
//
// I070: the send-queue tile shows the daily cap exactly as the drain
// applies it (getSendCapUsage: emails delivered in the trailing 24 hours,
// whatever path sent them, against outreach_send_settings.daily_email_limit).
//
// MOB-02: the decision counts (pending review, drafts awaiting approval)
// are NOT here: Today's tiles read them from the attention summary
// (src/lib/attention), the same object the sidebar badges project, so a
// tile and its badge cannot disagree. This module keeps what only the
// Overview shows: the drafts' stage mix, inbound volume, the send queue,
// the funnel and the latest replies.

import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { outreachDrafts, outreachQueue } from '@/lib/db/schema/outreach';
import { mailMessages } from '@/lib/db/schema/mailing';
import { workspaces } from '@/lib/db/schema/workspaces';
import { qualifiedLeads, type PipelineState } from '@/lib/db/schema/pipeline';
import type { WorkspaceContext } from './context';
import { getSendCapUsage } from './outreach-queue';

export interface DashboardSignals {
  /** A query failed: every number below is a placeholder, not a count —
   *  render "—" and say so (I070). */
  degraded: boolean;
  /** Drafts awaiting approval by stage (the total is the attention
   *  summary's drafts.approve). */
  drafts: {
    discovery: number;
    engagement: number;
    pitch: number;
    closing: number;
  };
  replies7d: number;
  /** Last 5 inbound messages, newest first. */
  recentInbound: Array<{
    id: string;
    fromName: string | null;
    fromAddress: string;
    subject: string;
    receivedAt: Date;
    intent: string | null;
  }>;
  sendQueue: {
    queued: number;
    /** Emails delivered in the trailing 24 hours (the drain's cap window). */
    sent24h: number;
    dailyCap: number;
    nextSendAt: Date | null;
    /** PC-05: the workspace pause (it holds the send queue with every
     *  other kind of automatic work). */
    paused: boolean;
  };
  funnel: Record<PipelineState, number>;
}

const ZERO_FUNNEL: Record<PipelineState, number> = {
  raw_discovered: 0,
  relevant: 0,
  contacted: 0,
  replied: 0,
  contact_identified: 0,
  qualified: 0,
  handed_over: 0,
  synced_to_crm: 0,
  closed: 0,
};

const ZERO_DRAFTS = {
  discovery: 0,
  engagement: 0,
  pitch: 0,
  closing: 0,
};

/** What a failed load returns: placeholders, flagged degraded. */
const DEGRADED: DashboardSignals = {
  degraded: true,
  drafts: ZERO_DRAFTS,
  replies7d: 0,
  recentInbound: [],
  sendQueue: { queued: 0, sent24h: 0, dailyCap: 0, nextSendAt: null, paused: false },
  funnel: ZERO_FUNNEL,
};

export async function getDashboardSignals(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<DashboardSignals> {
  const ws = ctx.workspaceId;
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

  try {
    const [
      draftRows,
      replies7dRow,
      recentInbound,
      queueQueuedRow,
      capUsage,
      nextSendRow,
      leadRows,
      pauseRow,
    ] = await Promise.all([
      db
        .select({
          stage: outreachDrafts.stage,
          n: sql<number>`count(*)::int`,
        })
        .from(outreachDrafts)
        .where(
          and(
            eq(outreachDrafts.workspaceId, ws),
            inArray(outreachDrafts.status, ['draft', 'needs_edit']),
          ),
        )
        .groupBy(outreachDrafts.stage),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(mailMessages)
        .where(
          and(
            eq(mailMessages.workspaceId, ws),
            eq(mailMessages.direction, 'inbound'),
            gte(mailMessages.createdAt, sevenDaysAgo),
          ),
        ),
      db
        .select({
          id: mailMessages.id,
          fromName: mailMessages.fromName,
          fromAddress: mailMessages.fromAddress,
          subject: mailMessages.subject,
          receivedAt: mailMessages.receivedAt,
          createdAt: mailMessages.createdAt,
          intent: mailMessages.replyClassification,
        })
        .from(mailMessages)
        .where(
          and(
            eq(mailMessages.workspaceId, ws),
            eq(mailMessages.direction, 'inbound'),
          ),
        )
        .orderBy(desc(mailMessages.id))
        .limit(5),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(outreachQueue)
        .where(
          and(
            eq(outreachQueue.workspaceId, ws),
            inArray(outreachQueue.status, ['queued', 'sending']),
          ),
        ),
      getSendCapUsage(ctx, now),
      db
        .select({ at: outreachQueue.scheduledSendAt })
        .from(outreachQueue)
        .where(
          and(
            eq(outreachQueue.workspaceId, ws),
            eq(outreachQueue.status, 'queued'),
          ),
        )
        .orderBy(asc(outreachQueue.scheduledSendAt))
        .limit(1),
      db
        .select({ state: qualifiedLeads.state })
        .from(qualifiedLeads)
        .where(eq(qualifiedLeads.workspaceId, ws)),
      db
        .select({ pausedAt: workspaces.automationPausedAt })
        .from(workspaces)
        .where(eq(workspaces.id, ws))
        .limit(1),
    ]);

    const drafts = { ...ZERO_DRAFTS };
    for (const row of draftRows) {
      const stage = row.stage as keyof typeof drafts;
      if (stage in drafts) (drafts as Record<string, number>)[stage] = row.n;
    }

    const funnel = { ...ZERO_FUNNEL };
    for (const r of leadRows) funnel[r.state] += 1;

    return {
      degraded: false,
      drafts,
      replies7d: replies7dRow[0]?.n ?? 0,
      recentInbound: recentInbound.map((m) => ({
        id: m.id.toString(),
        fromName: m.fromName,
        fromAddress: m.fromAddress,
        subject: m.subject,
        receivedAt: m.receivedAt ?? m.createdAt,
        intent: m.intent,
      })),
      sendQueue: {
        queued: queueQueuedRow[0]?.n ?? 0,
        sent24h: capUsage.used,
        dailyCap: capUsage.cap,
        nextSendAt: nextSendRow[0]?.at ?? null,
        paused: Boolean(pauseRow[0]?.pausedAt),
      },
      funnel,
    };
  } catch (err) {
    console.warn('[dashboard-signals] degraded:', err);
    return DEGRADED;
  }
}
