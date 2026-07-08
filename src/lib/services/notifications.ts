// In-app notification service. Producers call notify() best-effort from
// the events that matter (reply received, follow-up staged, geo review,
// run failed, tokens low, mention/assignment); the bell in the app shell
// reads unreadCount(); /notifications lists and marks read.
//
// notify() must NEVER break its caller: it swallows every error
// (including dedupe conflicts, which are the mechanism working).

import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  notifications,
  type Notification,
} from '@/lib/db/schema/notifications';
import type { WorkspaceContext } from './context';

export interface NotifyInput {
  kind: string;
  title: string;
  body?: string | null;
  href?: string | null;
  /** Targeted recipient; omit for workspace-wide. */
  userId?: string | null;
  /** While an UNREAD notification with this key exists, duplicates drop. */
  dedupeKey?: string | null;
}

/** Fire-and-forget insert. Returns the row when one was created, null on
 *  dedupe or failure. Takes a bare workspaceId — producers include
 *  background jobs with no user session. */
export async function notify(
  workspaceId: bigint,
  input: NotifyInput,
): Promise<Notification | null> {
  try {
    const [row] = await db
      .insert(notifications)
      .values({
        workspaceId,
        userId: input.userId ?? null,
        kind: input.kind,
        title: input.title.slice(0, 300),
        body: input.body?.slice(0, 1000) ?? null,
        href: input.href ?? null,
        dedupeKey: input.dedupeKey ?? null,
      })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  } catch (err) {
    console.error(
      '[notifications] notify failed:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Rows visible to this user: workspace-wide + targeted at them. */
function visibleTo(ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>): SQL {
  return and(
    eq(notifications.workspaceId, ctx.workspaceId),
    or(isNull(notifications.userId), eq(notifications.userId, ctx.userId)),
  )!;
}

export async function listNotifications(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
  options: { unreadOnly?: boolean; limit?: number } = {},
): Promise<Notification[]> {
  const conds: SQL[] = [visibleTo(ctx)];
  if (options.unreadOnly) conds.push(isNull(notifications.readAt));
  return db
    .select()
    .from(notifications)
    .where(and(...conds))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(Math.min(options.limit ?? 50, 200));
}

export async function unreadNotificationCount(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
): Promise<number> {
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(visibleTo(ctx), isNull(notifications.readAt)));
  return Number(row?.c ?? 0);
}

/** Mark specific notifications read (only ones visible to the caller). */
export async function markNotificationsRead(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
  ids: ReadonlyArray<bigint>,
): Promise<number> {
  if (ids.length === 0) return 0;
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        visibleTo(ctx),
        isNull(notifications.readAt),
        inArray(notifications.id, [...ids]),
      ),
    )
    .returning({ id: notifications.id });
  return updated.length;
}

export async function markAllNotificationsRead(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
): Promise<number> {
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(visibleTo(ctx), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return updated.length;
}
