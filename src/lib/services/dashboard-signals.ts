// Dashboard cockpit signals. One server call returns everything the
// dashboard widgets need so the landing page doesn't fire 5 separate
// queries with their own loading states. Best-effort — any single
// query failing degrades to zero rather than failing the page.

import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { outreachDrafts, outreachQueue, outreachSendSettings } from '@/lib/db/schema/outreach';
import { mailMessages } from '@/lib/db/schema/mailing';
import { reviewItems } from '@/lib/db/schema/review';
import { qualifiedLeads, type PipelineState } from '@/lib/db/schema/pipeline';
import type { WorkspaceContext } from './context';

export interface DashboardSignals {
  reviewPending: number;
  drafts: {
    total: number;
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
    sentToday: number;
    dailyCap: number;
    nextSendAt: Date | null;
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
  total: 0,
  discovery: 0,
  engagement: 0,
  pitch: 0,
  closing: 0,
};

const ZERO: DashboardSignals = {
  reviewPending: 0,
  drafts: ZERO_DRAFTS,
  replies7d: 0,
  recentInbound: [],
  sendQueue: { queued: 0, sentToday: 0, dailyCap: 50, nextSendAt: null, paused: false },
  funnel: ZERO_FUNNEL,
};

export async function getDashboardSignals(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<DashboardSignals> {
  const ws = ctx.workspaceId;
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  try {
    const [
      reviewPendingRow,
      draftRows,
      replies7dRow,
      recentInbound,
      queueQueuedRow,
      sentTodayRow,
      nextSendRow,
      sendSettings,
      leadRows,
    ] = await Promise.all([
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(reviewItems)
        .where(
          and(
            eq(reviewItems.workspaceId, ws),
            inArray(reviewItems.state, ['new', 'needs_review']),
          ),
        ),
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
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(outreachQueue)
        .where(
          and(
            eq(outreachQueue.workspaceId, ws),
            eq(outreachQueue.status, 'sent'),
            gte(outreachQueue.updatedAt, startOfToday),
          ),
        ),
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
        .select()
        .from(outreachSendSettings)
        .where(eq(outreachSendSettings.workspaceId, ws))
        .limit(1),
      db
        .select({ state: qualifiedLeads.state })
        .from(qualifiedLeads)
        .where(eq(qualifiedLeads.workspaceId, ws)),
    ]);

    const drafts = { ...ZERO_DRAFTS };
    for (const row of draftRows) {
      const stage = row.stage as keyof typeof drafts;
      if (stage in drafts) (drafts as Record<string, number>)[stage] = row.n;
      drafts.total += row.n;
    }

    const funnel = { ...ZERO_FUNNEL };
    for (const r of leadRows) funnel[r.state] += 1;

    const settings = sendSettings[0];
    return {
      reviewPending: reviewPendingRow[0]?.n ?? 0,
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
        sentToday: sentTodayRow[0]?.n ?? 0,
        dailyCap: settings?.dailyEmailLimit ?? 50,
        nextSendAt: nextSendRow[0]?.at ?? null,
        paused: settings?.emergencyPause ?? false,
      },
      funnel,
    };
  } catch (err) {
    console.warn('[dashboard-signals] degraded to zero:', err);
    return ZERO;
  }
}
