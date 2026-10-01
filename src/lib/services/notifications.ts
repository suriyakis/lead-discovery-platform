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
import { workspaceMembers } from '@/lib/db/schema/workspaces';
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

const ADMIN_KEY_SEPARATOR = ':user:';

/** Dedupe key of one admin's copy of a notifyWorkspaceAdmins() alert:
 *  the unread-dedupe index is per (workspace, key), so each recipient
 *  needs a key of their own. */
export function adminDedupeKey(dedupeKey: string, userId: string): string {
  return `${dedupeKey}${ADMIN_KEY_SEPARATOR}${userId}`;
}

/**
 * flow:F-04: an alert for the people who can act on it — one targeted row
 * per workspace owner / admin (members, managers and viewers do not see
 * it). With a dedupeKey each admin's copy dedupes on its own
 * (adminDedupeKey), so one admin reading theirs never silences another's,
 * and the next occurrence re-notifies exactly the admins who have read
 * theirs. Falls back to a workspace-wide row when the workspace has no
 * owner / admin member, so the alert is never dropped. Best-effort like
 * notify(): returns the rows created ([] on dedupe or failure).
 */
export async function notifyWorkspaceAdmins(
  workspaceId: bigint,
  input: Omit<NotifyInput, 'userId'>,
): Promise<Notification[]> {
  try {
    const admins = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          inArray(workspaceMembers.role, ['owner', 'admin']),
        ),
      )
      .orderBy(workspaceMembers.userId);
    if (admins.length === 0) {
      const row = await notify(workspaceId, input);
      return row ? [row] : [];
    }
    return await db
      .insert(notifications)
      .values(
        admins.map((a) => ({
          workspaceId,
          userId: a.userId,
          kind: input.kind,
          title: input.title.slice(0, 300),
          body: input.body?.slice(0, 1000) ?? null,
          href: input.href ?? null,
          dedupeKey: input.dedupeKey ? adminDedupeKey(input.dedupeKey, a.userId) : null,
        })),
      )
      .onConflictDoNothing()
      .returning();
  } catch (err) {
    console.error(
      '[notifications] notifyWorkspaceAdmins failed:',
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/**
 * flow:F-04: the condition a dedupeKey'd notification announced is over
 * (e.g. a failing mailbox recovered). Marks its unread rows read — the
 * workspace-wide one and every admin's copy (adminDedupeKey) — so the
 * bell stops showing a stale alarm, and so the NEXT occurrence notifies
 * again instead of being swallowed by the dedupe index. Best-effort like
 * notify(): returns the number of rows resolved, 0 on failure.
 */
export async function resolveNotifications(
  workspaceId: bigint,
  dedupeKey: string,
): Promise<number> {
  const adminPrefix = `${dedupeKey}${ADMIN_KEY_SEPARATOR}`;
  try {
    const rows = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.workspaceId, workspaceId),
          or(
            eq(notifications.dedupeKey, dedupeKey),
            sql`left(${notifications.dedupeKey}, ${adminPrefix.length}) = ${adminPrefix}`,
          ),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });
    return rows.length;
  } catch (err) {
    console.error(
      '[notifications] resolve failed:',
      err instanceof Error ? err.message : err,
    );
    return 0;
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
