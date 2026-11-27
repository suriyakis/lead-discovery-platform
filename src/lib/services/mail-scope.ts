// Which stored mail the app shows: the conversations the platform started
// and the answers to them — never the rest of the mailbox.
//
// IMAP sync stores EVERY message in the synced folder (the relevance gate
// needs them to recognise replies), but newsletters, receipts and
// colleagues' mail are not the platform's business and must not show up in
// Conversations, on a mailbox page, in the follow-up chips or on Today.
//
// A leaf module (db client, schema and relevance constants only — no other
// service) so the mail service, the communication list, the dashboard
// signals, the thread page, the reply assistant and the rest can all share
// one definition without import cycles.

import { and, asc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { mailMessages, mailThreads, type MailMessage } from '@/lib/db/schema/mailing';
import {
  OUTREACH_LINKED_RELEVANCE_VALUES,
  isOutreachLinked,
  type OutreachRelevance,
} from '@/lib/mail/relevance';
import type { WorkspaceContext } from './context';

/**
 * A message belongs to the platform when it is
 *   - outbound: only the platform's send path writes outbound rows (sync
 *     never imports a Sent folder), so each one was sent — or attempted —
 *     from here: outreach, follow-ups, replies and compose;
 *   - inbound and proven to answer that mail: outreach_relevance
 *     prospect_reply / auto_reply / bounce (flow:F-01);
 *   - inbound that references our outbound but was classed unrelated only
 *     because it came from one of our own connected mailboxes (a colleague
 *     replying-all, a self-test between two mailboxes). The gate keeps it
 *     'unrelated' so it never triggers suppression or a reply handler, but
 *     it is part of the conversation (relevance_signals.evidence);
 *   - inbound synced before the relevance gate existed (outreach_relevance
 *     NULL) on a thread that holds our outbound — the same rule follow-ups
 *     use (follow-up.ts outreachLinkedInbound), so a legacy reply that
 *     stops a cascade is also visible.
 * Everything else — newsletters, colleagues, receipts (bulk / unrelated),
 * and legacy rows on threads we never wrote to — stays stored but is never
 * listed or counted.
 *
 * Plain column references, so it also works inside a correlated
 * `EXISTS (SELECT 1 FROM mail_messages …)` subquery; the legacy-row check
 * aliases its own subquery so the references stay unambiguous.
 */
export function platformMailCondition(): SQL {
  return or(
    eq(mailMessages.direction, 'outbound'),
    and(
      eq(mailMessages.direction, 'inbound'),
      or(
        inArray(mailMessages.outreachRelevance, [...OUTREACH_LINKED_RELEVANCE_VALUES]),
        sql`(${mailMessages.relevanceSignals} -> 'evidence' ->> 'references_our_outbound') = 'true'`,
        and(
          isNull(mailMessages.outreachRelevance),
          sql`EXISTS (
            SELECT 1 FROM mail_messages AS scope_ours
            WHERE scope_ours.thread_id = ${mailMessages.threadId}
              AND scope_ours.workspace_id = ${mailMessages.workspaceId}
              AND scope_ours.direction = 'outbound'
          )`,
        ),
      ),
    ),
  ) as SQL;
}

/**
 * platformMailCondition for one inbound row the relevance gate has just
 * assessed, in memory: the sync uses it to count what it added to
 * Conversations. Assessed means outreach_relevance is set, so the legacy
 * clause (relevance NULL, decided by the thread) never applies; that one
 * needs the thread and stays SQL-only.
 */
export function isPlatformInbound(row: {
  outreachRelevance: OutreachRelevance;
  relevanceSignals: unknown;
}): boolean {
  return isOutreachLinked(row.outreachRelevance) || referencesOurOutbound(row.relevanceSignals);
}

/** relevance_signals.evidence.references_our_outbound read the way the SQL
 *  above reads it (`->> … = 'true'`: a JSON true or the string "true"). */
function referencesOurOutbound(signals: unknown): boolean {
  if (signals === null || typeof signals !== 'object') return false;
  const evidence = (signals as { evidence?: unknown }).evidence;
  if (evidence === null || typeof evidence !== 'object') return false;
  const flag = (evidence as { references_our_outbound?: unknown }).references_our_outbound;
  return flag === true || flag === 'true';
}

/**
 * A thread is the platform's when it holds at least one platform message
 * (above). For a query FROM mail_threads: a thread made only of mailbox
 * mail is never listed. Pass `excludeHidden` where the thread is offered
 * for something that reads listPlatformThreadMessages(…, { excludeHidden })
 * — the CRM "Push thread as notes" picker — so a thread whose only
 * platform mail is trashed or spam is not offered to push nothing.
 */
export function threadHasPlatformMail(
  opts: { excludeHidden?: boolean } = {},
): SQL<boolean> {
  const visibleOnly = opts.excludeHidden
    ? sql` AND ${mailMessages.trashedAt} IS NULL AND ${mailMessages.spamAt} IS NULL`
    : sql``;
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${mailMessages}
    WHERE ${mailMessages.threadId} = ${mailThreads.id}
      AND ${mailMessages.workspaceId} = ${mailThreads.workspaceId}
      AND ${platformMailCondition()}${visibleOnly}
  )`;
}

/**
 * For a query FROM mail_threads: how many platform messages the thread
 * holds, and when the newest one arrived — what the thread page shows.
 * mail_threads.message_count / last_message_at are denormalised over EVERY
 * synced message on the thread, so a newsletter filed there by subject
 * would raise the count and move the thread to the top.
 */
export function threadPlatformMessageCount(): SQL<number> {
  return sql<number>`(
    SELECT count(*)::int FROM ${mailMessages}
    WHERE ${mailMessages.threadId} = ${mailThreads.id}
      AND ${mailMessages.workspaceId} = ${mailThreads.workspaceId}
      AND ${platformMailCondition()}
  )`.mapWith(Number);
}

export function threadPlatformLastMessageAt(): SQL<Date | null> {
  return sql<Date | null>`(
    SELECT max(${mailMessages.createdAt}) FROM ${mailMessages}
    WHERE ${mailMessages.threadId} = ${mailThreads.id}
      AND ${mailMessages.workspaceId} = ${mailThreads.workspaceId}
      AND ${platformMailCondition()}
  )`.mapWith(mailMessages.createdAt);
}

/**
 * The counts part of a sync result message. A sync stores every new
 * message in the synced folder, but only the answers to our mail appear
 * in Conversations — saying "new 40" when 38 of them are newsletters left
 * the user looking for mail that is deliberately not shown.
 *   fetched 40: 2 new in Conversations, 38 other mailbox messages not shown
 */
export function describeSyncCounts(r: {
  fetched: number;
  inserted: number;
  replies: number;
}): string {
  if (r.inserted === 0) return `fetched ${r.fetched}, nothing new`;
  const other = r.inserted - r.replies;
  const shown = `${r.replies} new in Conversations`;
  if (other === 0) return `fetched ${r.fetched}: ${shown}`;
  return `fetched ${r.fetched}: ${shown}, ${other} other mailbox message${other === 1 ? '' : 's'} not shown`;
}

/**
 * The conversation of one thread as the app shows it: its platform
 * messages, oldest first, trashed and spammed ones included (the thread
 * page folds those away; pass `excludeHidden` to drop them). Empty when
 * the thread holds no platform mail — or is not in this workspace. The
 * thread page, the reply assistant and the outreach reply drafts
 * (outreach-reply-handler.ts) all read through this, so the AI never
 * answers a message the user cannot see.
 */
export async function listPlatformThreadMessages(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  threadId: bigint,
  opts: { excludeHidden?: boolean } = {},
): Promise<MailMessage[]> {
  return db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        eq(mailMessages.threadId, threadId),
        platformMailCondition(),
        ...(opts.excludeHidden
          ? [isNull(mailMessages.trashedAt), isNull(mailMessages.spamAt)]
          : []),
      ),
    )
    .orderBy(asc(mailMessages.createdAt), asc(mailMessages.id));
}
