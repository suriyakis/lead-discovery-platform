// PC-10 (I013): settle the outreach queue when an email has gone out, and
// make sure one draft's email goes out once.
//
// A queued send is 'sent' in the SAME transaction as its mail_messages row
// (sendMessage's onPersisted hook), so a failure after the insert can no
// longer leave a delivered email marked 'failed'. These writers take the
// transaction (or the pool) as their first argument. They live in their
// own module because both the queue (outreach-queue.ts → sendMessage) and
// the Errors-folder retry (mail.ts → retrySend) use them; neither service
// imports the other's module.
//
// One draft = one email. Automatic retries leave a failed mail_messages
// copy per failed attempt, several queue rows can carry the same draft
// over time, and an operator can retry from the queue page or from the
// Errors folder. findDeliveredCopyOfDraft() is the one answer to "has this
// draft's email already gone out?" that every re-send path asks first.

import { and, asc, eq, inArray, isNull, ne, type SQL } from 'drizzle-orm';
import type { db } from '@/lib/db/client';
import { mailMessages } from '@/lib/db/schema/mailing';
import { outreachQueue, type OutreachQueueStatus } from '@/lib/db/schema/outreach';

/** The shared pool or an open transaction. */
export type QueueWriter = Pick<typeof db, 'update' | 'select'>;

/** Outbound mail_messages statuses that mean the email went out. */
export const DELIVERED_MESSAGE_STATUSES = ['sent', 'delivered'] as const;

/** Columns that describe a failed / pending attempt; cleared once sent. */
function sentFields(messageId: bigint, now: Date) {
  return {
    status: 'sent' as const,
    sentMessageId: messageId,
    lastError: null,
    lastFailureKind: null,
    nextAttemptAt: null,
    updatedAt: now,
  };
}

/** Of `where`'s queue rows, the ones the stuck-work reaper failed as
 *  interrupted (they carry an open send.interrupted incident). Read before
 *  the rows are settled, which clears last_failure_kind. */
async function interruptedAmong(writer: QueueWriter, where: SQL): Promise<bigint[]> {
  const rows = await writer
    .select({ id: outreachQueue.id })
    .from(outreachQueue)
    .where(
      and(where, eq(outreachQueue.status, 'failed'), eq(outreachQueue.lastFailureKind, 'interrupted')),
    );
  return rows.map((r) => r.id);
}

/**
 * One queue row's email was delivered and recorded as `messageId`. Sets
 * the row 'sent' whatever its status: the email went out, so even a row
 * the reaper or an operator moved meanwhile is 'sent' now (and a requeued
 * copy cannot go out twice). `wasInterrupted`: the reaper had failed it
 * as interrupted; the caller resolves that incident once committed.
 */
export async function markQueueEntrySent(
  writer: QueueWriter,
  input: { workspaceId: bigint; entryId: bigint; messageId: bigint; now?: Date },
): Promise<{ wasInterrupted: boolean }> {
  const row = and(
    eq(outreachQueue.workspaceId, input.workspaceId),
    eq(outreachQueue.id, input.entryId),
  ) as SQL;
  const interrupted = await interruptedAmong(writer, row);
  await writer
    .update(outreachQueue)
    .set(sentFields(input.messageId, input.now ?? new Date()))
    .where(row);
  return { wasInterrupted: interrupted.length > 0 };
}

/** Queue statuses a delivered retry of the same draft settles: a failed
 *  row, and a waiting one that would otherwise send the email again. */
export const QUEUE_STATUSES_SETTLED_BY_RETRY: readonly OutreachQueueStatus[] = ['failed', 'queued'];

/**
 * The Errors-folder Retry (mail.retrySend) delivered `draftId`'s email:
 * settle the queue rows for that draft that are failed or still waiting.
 * Returns their ids for the audit row, and the ones that were interrupted
 * (their incidents are resolved by the caller once committed).
 */
export async function markDraftQueueEntriesSent(
  writer: QueueWriter,
  input: { workspaceId: bigint; draftId: bigint; messageId: bigint; now?: Date },
): Promise<{ settled: bigint[]; interrupted: bigint[] }> {
  const draftRows = and(
    eq(outreachQueue.workspaceId, input.workspaceId),
    eq(outreachQueue.draftId, input.draftId),
  ) as SQL;
  const interrupted = await interruptedAmong(writer, draftRows);
  const rows = await writer
    .update(outreachQueue)
    .set(sentFields(input.messageId, input.now ?? new Date()))
    .where(and(draftRows, inArray(outreachQueue.status, [...QUEUE_STATUSES_SETTLED_BY_RETRY])))
    .returning({ id: outreachQueue.id });
  return { settled: rows.map((r) => r.id), interrupted };
}

/**
 * `draftId`'s email has gone out (or an operator said so): its failed
 * copies leave the Errors folder (trashed, as a successful Errors-folder
 * Retry does), so nobody re-sends an email that has already gone out.
 * `deliveredMessageId` (the copy that went out) is never touched. Returns
 * how many were trashed.
 */
export async function trashEarlierFailedCopies(
  writer: QueueWriter,
  input: {
    workspaceId: bigint;
    draftId: bigint;
    deliveredMessageId?: bigint | null;
    now?: Date;
  },
): Promise<number> {
  const now = input.now ?? new Date();
  const rows = await writer
    .update(mailMessages)
    .set({ trashedAt: now, updatedAt: now })
    .where(
      and(
        eq(mailMessages.workspaceId, input.workspaceId),
        eq(mailMessages.sourceDraftId, input.draftId),
        eq(mailMessages.direction, 'outbound'),
        eq(mailMessages.status, 'failed'),
        isNull(mailMessages.trashedAt),
        input.deliveredMessageId != null
          ? ne(mailMessages.id, input.deliveredMessageId)
          : undefined,
      ),
    )
    .returning({ id: mailMessages.id });
  return rows.length;
}

/** Evidence that a draft's email has already gone out. */
export interface DeliveredDraftCopy {
  /** A sent / delivered outbound mail_messages row of the draft. */
  messageId: bigint | null;
  /** A queue row of the draft that is 'sent' (set even when the email
   *  went out but its mail row could not be recorded). */
  queueEntryId: bigint | null;
}

/**
 * Has `draftId`'s email already gone out? Yes when an outbound copy of it
 * is sent / delivered (in Trash or not: trashing does not unsend it), or
 * when a queue row of the draft is 'sent' — `excludeQueueEntryId` (the
 * row asking) left out. Null when neither exists. Every re-send path asks
 * this first: the drain before it sends, Retry now / Requeue before they
 * put a row back, the Errors-folder Retry before each copy.
 */
export async function findDeliveredCopyOfDraft(
  reader: Pick<typeof db, 'select'>,
  input: { workspaceId: bigint; draftId: bigint; excludeQueueEntryId?: bigint },
): Promise<DeliveredDraftCopy | null> {
  const [message] = await reader
    .select({ id: mailMessages.id })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, input.workspaceId),
        eq(mailMessages.sourceDraftId, input.draftId),
        eq(mailMessages.direction, 'outbound'),
        inArray(mailMessages.status, [...DELIVERED_MESSAGE_STATUSES]),
      ),
    )
    .orderBy(asc(mailMessages.id))
    .limit(1);
  const [entry] = await reader
    .select({ id: outreachQueue.id })
    .from(outreachQueue)
    .where(
      and(
        eq(outreachQueue.workspaceId, input.workspaceId),
        eq(outreachQueue.draftId, input.draftId),
        eq(outreachQueue.status, 'sent'),
        input.excludeQueueEntryId !== undefined
          ? ne(outreachQueue.id, input.excludeQueueEntryId)
          : undefined,
      ),
    )
    .orderBy(asc(outreachQueue.id))
    .limit(1);
  if (!message && !entry) return null;
  return { messageId: message?.id ?? null, queueEntryId: entry?.id ?? null };
}

/** True while a queue row of `draftId` is being sent (claimed, in flight). */
export async function draftIsBeingSent(
  reader: Pick<typeof db, 'select'>,
  input: { workspaceId: bigint; draftId: bigint },
): Promise<boolean> {
  const [row] = await reader
    .select({ id: outreachQueue.id })
    .from(outreachQueue)
    .where(
      and(
        eq(outreachQueue.workspaceId, input.workspaceId),
        eq(outreachQueue.draftId, input.draftId),
        eq(outreachQueue.status, 'sending'),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Operator wording for a refused re-send of a delivered draft. */
export function alreadyDeliveredMessage(copy: DeliveredDraftCopy): string {
  return copy.messageId !== null
    ? `This draft's email has already been sent (message ${copy.messageId}, see Sent). It is not sent twice.`
    : `This draft's email has already been sent (queue entry ${copy.queueEntryId}). It is not sent twice.`;
}
