// PC-10 (I013): settle the outreach queue when an email has gone out.
//
// A queued send is 'sent' in the SAME transaction as its mail_messages row
// (sendMessage's onPersisted hook), so a failure after the insert can no
// longer leave a delivered email marked 'failed'. These writers take the
// transaction (or the pool) as their first argument. They live in their
// own module because both the queue (outreach-queue.ts → sendMessage) and
// the Errors-folder retry (mail.ts → retrySend) use them; neither service
// imports the other's module.

import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { db } from '@/lib/db/client';
import { mailMessages } from '@/lib/db/schema/mailing';
import { outreachQueue, type OutreachQueueStatus } from '@/lib/db/schema/outreach';

/** The shared pool or an open transaction. */
export type QueueWriter = Pick<typeof db, 'update'>;

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

/**
 * One queue row's email was delivered and recorded as `messageId`. Sets
 * the row 'sent' whatever its status: the email went out, so even a row
 * the reaper or an operator moved meanwhile is 'sent' now (and a requeued
 * copy cannot go out twice).
 */
export async function markQueueEntrySent(
  writer: QueueWriter,
  input: { workspaceId: bigint; entryId: bigint; messageId: bigint; now?: Date },
): Promise<void> {
  await writer
    .update(outreachQueue)
    .set(sentFields(input.messageId, input.now ?? new Date()))
    .where(
      and(eq(outreachQueue.workspaceId, input.workspaceId), eq(outreachQueue.id, input.entryId)),
    );
}

/** Queue statuses a delivered retry of the same draft settles: a failed
 *  row, and a waiting one that would otherwise send the email again. */
export const QUEUE_STATUSES_SETTLED_BY_RETRY: readonly OutreachQueueStatus[] = ['failed', 'queued'];

/**
 * The Errors-folder Retry (mail.retrySend) delivered `draftId`'s email:
 * settle the queue rows for that draft that are failed or still waiting.
 * Returns their ids for the audit row.
 */
export async function markDraftQueueEntriesSent(
  writer: QueueWriter,
  input: { workspaceId: bigint; draftId: bigint; messageId: bigint; now?: Date },
): Promise<bigint[]> {
  const rows = await writer
    .update(outreachQueue)
    .set(sentFields(input.messageId, input.now ?? new Date()))
    .where(
      and(
        eq(outreachQueue.workspaceId, input.workspaceId),
        eq(outreachQueue.draftId, input.draftId),
        inArray(outreachQueue.status, [...QUEUE_STATUSES_SETTLED_BY_RETRY]),
      ),
    )
    .returning({ id: outreachQueue.id });
  return rows.map((r) => r.id);
}

/**
 * The queue delivered `draftId`'s email after earlier attempts failed.
 * Their failed copies leave the Errors folder (trashed, as a successful
 * Errors-folder Retry does), so nobody re-sends an email that has already
 * gone out. Returns how many were trashed.
 */
export async function trashEarlierFailedCopies(
  writer: QueueWriter,
  input: { workspaceId: bigint; draftId: bigint; deliveredMessageId: bigint; now?: Date },
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
        ne(mailMessages.id, input.deliveredMessageId),
      ),
    )
    .returning({ id: mailMessages.id });
  return rows.length;
}
