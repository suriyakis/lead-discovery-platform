// Phase 57 — Communication workspace.
//
// Aggregates mail_threads + their linked outreach state (qualified_lead,
// product) + queue state + message activity into a single row shape that
// the /communication list page consumes. Filters cover the operator's
// stated needs: status (sent/replied/error/scheduled/all), product,
// free-text search (subject/contact/email/company), date range.
//
// The recipe filter (connector_recipes.id) is intentionally out-of-scope
// for the MVP — wiring it requires another join through review_items →
// source_records → connector_recipes, which we can add when there's an
// explicit operator need.

import { and, desc, eq, gte, ilike, lte, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { mailThreads, mailMessages } from '@/lib/db/schema/mailing';
import { outreachThreadState } from '@/lib/db/schema/outreach';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { productProfiles } from '@/lib/db/schema/products';
import { outreachQueue } from '@/lib/db/schema/outreach';
import type { WorkspaceContext } from './context';

export type CommunicationStatus =
  | 'all'
  | 'sent'
  | 'replied'
  | 'error'
  | 'scheduled';

export interface ListCommunicationFilters {
  status?: CommunicationStatus;
  productId?: bigint;
  /** Free-text — matches subject, contact name, contact email, product
   *  name (case-insensitive). */
  search?: string;
  /** Filter by mail_threads.last_message_at >= dateFrom. */
  dateFrom?: Date;
  /** Filter by mail_threads.last_message_at <= dateTo. */
  dateTo?: Date;
  /** Page size. Defaults to 100, capped at 500. */
  limit?: number;
}

export interface CommunicationRow {
  threadId: bigint;
  mailboxId: bigint;
  subject: string;
  participants: string[];
  messageCount: number;
  lastMessageAt: Date | null;

  /** When the thread links to a qualified lead via outreach_thread_state. */
  leadId: bigint | null;
  leadState: string | null;
  currentStage: string | null;
  contactName: string | null;
  contactEmail: string | null;

  productId: bigint | null;
  productName: string | null;

  /** Derived: latest queued send, if any. */
  scheduledSendAt: Date | null;
  /** Derived: at least one outbound queue entry is in 'failed' state. */
  hasError: boolean;
  /** Derived: at least one inbound message exists on the thread. */
  hasInbound: boolean;
  /** Derived: at least one outbound message exists on the thread. */
  hasOutbound: boolean;

  /** Bucket label for the status filter. One of:
   *    'scheduled' — there's an outreach_queue row with status=queued and
   *                  scheduled_send_at in the future
   *    'error'     — has a failed queue entry
   *    'replied'   — at least one inbound message has arrived after
   *                  outbound (the recipient answered)
   *    'sent'      — at least one outbound message, no inbound yet
   *    'pending'   — has thread state but no messages yet (drafts only)
   */
  derivedStatus: 'scheduled' | 'error' | 'replied' | 'sent' | 'pending';
}

/**
 * Workspace-wide communication list. Returns the union of every
 * mail_thread + its derived state. Ordering: most recent activity first
 * (last_message_at desc, then created_at desc as a tie-breaker).
 */
export async function listCommunication(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filters: ListCommunicationFilters = {},
): Promise<CommunicationRow[]> {
  const limit = Math.min(filters.limit ?? 100, 500);

  // Build a single query that joins everything we need + computes the
  // derived flags via correlated subqueries. Worth a single round-trip
  // even if the SQL is heavier — keeps the page snappy.
  const hasInboundExpr = sql<boolean>`EXISTS (
    SELECT 1 FROM ${mailMessages}
    WHERE ${mailMessages.threadId} = ${mailThreads.id}
      AND ${mailMessages.workspaceId} = ${mailThreads.workspaceId}
      AND ${mailMessages.direction} = 'inbound'
  )`;
  const hasOutboundExpr = sql<boolean>`EXISTS (
    SELECT 1 FROM ${mailMessages}
    WHERE ${mailMessages.threadId} = ${mailThreads.id}
      AND ${mailMessages.workspaceId} = ${mailThreads.workspaceId}
      AND ${mailMessages.direction} = 'outbound'
  )`;
  const hasErrorExpr = sql<boolean>`EXISTS (
    SELECT 1 FROM ${outreachQueue}
    WHERE ${outreachQueue.workspaceId} = ${mailThreads.workspaceId}
      AND ${outreachQueue.status} = 'failed'
      AND (
        ${outreachQueue.inReplyTo} IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM ${mailMessages} m2
          WHERE m2.thread_id = ${mailThreads.id}
            AND m2.message_id = ${outreachQueue.inReplyTo}
        )
      )
  )`;
  const scheduledSendAtExpr = sql<Date | null>`(
    SELECT MIN(${outreachQueue.scheduledSendAt})
    FROM ${outreachQueue}
    WHERE ${outreachQueue.workspaceId} = ${mailThreads.workspaceId}
      AND ${outreachQueue.status} = 'queued'
      AND ${outreachQueue.scheduledSendAt} > NOW()
      AND (
        ${outreachQueue.inReplyTo} IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM ${mailMessages} m3
          WHERE m3.thread_id = ${mailThreads.id}
            AND m3.message_id = ${outreachQueue.inReplyTo}
        )
      )
  )`;

  const conditions: SQL[] = [eq(mailThreads.workspaceId, ctx.workspaceId)];
  if (filters.productId !== undefined) {
    conditions.push(eq(qualifiedLeads.productProfileId, filters.productId));
  }
  if (filters.dateFrom) {
    conditions.push(gte(mailThreads.lastMessageAt, filters.dateFrom));
  }
  if (filters.dateTo) {
    conditions.push(lte(mailThreads.lastMessageAt, filters.dateTo));
  }
  if (filters.search && filters.search.trim()) {
    const needle = `%${filters.search.trim()}%`;
    const searchCondition = or(
      ilike(mailThreads.subject, needle),
      ilike(qualifiedLeads.contactName, needle),
      ilike(qualifiedLeads.contactEmail, needle),
      ilike(productProfiles.name, needle),
    );
    if (searchCondition) conditions.push(searchCondition);
  }

  const rows = await db
    .select({
      threadId: mailThreads.id,
      mailboxId: mailThreads.mailboxId,
      subject: mailThreads.subject,
      participants: mailThreads.participants,
      messageCount: mailThreads.messageCount,
      lastMessageAt: mailThreads.lastMessageAt,
      leadId: qualifiedLeads.id,
      leadState: qualifiedLeads.state,
      currentStage: qualifiedLeads.currentStage,
      contactName: qualifiedLeads.contactName,
      contactEmail: qualifiedLeads.contactEmail,
      productId: productProfiles.id,
      productName: productProfiles.name,
      hasInbound: hasInboundExpr,
      hasOutbound: hasOutboundExpr,
      hasError: hasErrorExpr,
      scheduledSendAt: scheduledSendAtExpr,
    })
    .from(mailThreads)
    .leftJoin(
      outreachThreadState,
      and(
        eq(outreachThreadState.threadId, mailThreads.id),
        eq(outreachThreadState.workspaceId, mailThreads.workspaceId),
      ),
    )
    .leftJoin(
      qualifiedLeads,
      eq(qualifiedLeads.id, outreachThreadState.qualifiedLeadId),
    )
    .leftJoin(
      productProfiles,
      eq(productProfiles.id, qualifiedLeads.productProfileId),
    )
    .where(and(...conditions))
    .orderBy(
      sql`COALESCE(${mailThreads.lastMessageAt}, ${mailThreads.createdAt}) DESC`,
    )
    .limit(limit);

  const enriched: CommunicationRow[] = rows.map((r) => {
    const hasInbound = Boolean(r.hasInbound);
    const hasOutbound = Boolean(r.hasOutbound);
    const hasError = Boolean(r.hasError);
    const scheduledSendAt = r.scheduledSendAt
      ? new Date(r.scheduledSendAt as unknown as string)
      : null;
    let derivedStatus: CommunicationRow['derivedStatus'];
    if (scheduledSendAt) {
      derivedStatus = 'scheduled';
    } else if (hasError) {
      derivedStatus = 'error';
    } else if (hasInbound && hasOutbound) {
      derivedStatus = 'replied';
    } else if (hasOutbound) {
      derivedStatus = 'sent';
    } else {
      derivedStatus = 'pending';
    }
    return {
      threadId: r.threadId,
      mailboxId: r.mailboxId,
      subject: r.subject,
      participants: r.participants,
      messageCount: r.messageCount,
      lastMessageAt: r.lastMessageAt,
      leadId: r.leadId,
      leadState: r.leadState,
      currentStage: r.currentStage,
      contactName: r.contactName,
      contactEmail: r.contactEmail,
      productId: r.productId,
      productName: r.productName,
      scheduledSendAt,
      hasError,
      hasInbound,
      hasOutbound,
      derivedStatus,
    };
  });

  // Status filter is post-aggregation since it's derived from multiple
  // signals. With the index on (workspace, last_message_at) the page
  // size cap of 500 is plenty — for workspaces with more threads we
  // can add a SQL-level CASE in a later iteration.
  if (filters.status && filters.status !== 'all') {
    return enriched.filter((r) => r.derivedStatus === filters.status);
  }
  return enriched;
}

/** Per-status counts for the filter chip badges on the list page.
 *  Runs the same query without the status filter so the badges
 *  reflect the full unfiltered set within the OTHER filters (product /
 *  search / date) that ARE active. */
export async function countCommunicationByStatus(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filters: Omit<ListCommunicationFilters, 'status' | 'limit'> = {},
): Promise<Record<CommunicationStatus, number>> {
  const all = await listCommunication(ctx, { ...filters, limit: 500 });
  const counts: Record<CommunicationStatus, number> = {
    all: all.length,
    sent: 0,
    replied: 0,
    error: 0,
    scheduled: 0,
  };
  for (const r of all) {
    if (r.derivedStatus === 'sent') counts.sent++;
    else if (r.derivedStatus === 'replied') counts.replied++;
    else if (r.derivedStatus === 'error') counts.error++;
    else if (r.derivedStatus === 'scheduled') counts.scheduled++;
  }
  return counts;
}
