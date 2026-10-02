// Session-free workspace-context resolution. Split out of auth-context.ts
// so tests (and any non-request code path) can exercise the selection
// logic without importing next-auth. The request's session token comes in
// as a plain option (auth-context reads it from the cookie).

import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { sessions, users } from '@/lib/db/schema/auth';
import { workspaceMembers, workspaces } from '@/lib/db/schema/workspaces';
import { makeWorkspaceContext, type WorkspaceContext } from './context';

export class NoWorkspaceError extends Error {
  constructor() {
    super('No workspace membership');
    this.name = 'NoWorkspaceError';
  }
}

/** How often a session's lastSeenAt is rewritten (at most). */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60_000;

export interface WorkspaceResolutionOptions {
  /**
   * sessions.sessionToken of the request (MOB-06). Without one (scripts,
   * ticks, tests) there is no session pointer: the last-used workspace
   * decides and nothing is pinned.
   */
  sessionToken?: string | null;
  /** The request's User-Agent, recorded on the session row. */
  userAgent?: string | null;
  /** Clock override for tests. */
  now?: Date;
}

/** Which rule picked the workspace (tests and diagnostics). */
export type WorkspaceSelectionSource = 'session' | 'last_used' | 'first_membership';

export interface WorkspaceSelection {
  ctx: WorkspaceContext;
  source: WorkspaceSelectionSource;
}

/**
 * Resolve which workspace a user's requests operate in.
 *
 * Selection order (MOB-06):
 *   1. The SESSION's pointer, `sessions.activeWorkspaceId` — a workspace
 *      the user is a member of, or, for a super-admin, any existing
 *      workspace (god mode, which setActiveWorkspace(allowAnyAsSuperAdmin)
 *      audit-logged). Each browser keeps its own, so switching in one
 *      never moves another.
 *   2. `users.activeWorkspaceId`, the LAST-USED workspace, under the same
 *      rule: what a new session starts in. A super-admin's stale pointer
 *      to a deleted workspace is cleared and falls through.
 *   3. The user's oldest membership (workspace_members.created_at, then
 *      id; the I042 ordering). Deterministic, so every page, the
 *      dashboard and the header switcher agree.
 *
 * With a session token, the result is pinned on the session row when it
 * differs from the stored pointer (a new session, or one whose workspace
 * the user has since left), so a later switch in ANOTHER session — which
 * moves the last-used value — no longer moves this one. The pin only
 * lands if the pointer is still what this request read (see touchSession),
 * so a slow request never undoes a switch made meanwhile. The row's
 * lastSeenAt (at most every 5 minutes) and User-Agent are kept current in
 * the same write.
 *
 * Normal users never get god mode — a non-member pointer is ignored,
 * preserving the tenant-isolation invariant — and archived workspaces are
 * invisible to them.
 */
export async function resolveWorkspaceContextForUser(
  userId: string,
  isSuperAdminUser: boolean,
  options: WorkspaceResolutionOptions = {},
): Promise<WorkspaceContext> {
  return (await resolveWorkspaceSelection(userId, isSuperAdminUser, options)).ctx;
}

/** resolveWorkspaceContextForUser, also saying which rule decided. */
export async function resolveWorkspaceSelection(
  userId: string,
  isSuperAdminUser: boolean,
  options: WorkspaceResolutionOptions = {},
): Promise<WorkspaceSelection> {
  // Phase 23: filter out archived workspaces — they're "off" until a
  // super-admin restores them. super_admin sees archived ones too so the
  // restore action is reachable.
  //
  // Oldest membership first (id breaks ties between rows written in one
  // transaction) so the step-3 fallback is deterministic. With no ORDER
  // BY, Postgres returned rows in heap order, and the fallback workspace
  // could differ from one request to the next (audit I042, ia:F-05).
  const memberships = isSuperAdminUser
    ? await db
        .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId))
        .orderBy(asc(workspaceMembers.createdAt), asc(workspaceMembers.id))
    : await db
        .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .where(
          and(
            eq(workspaceMembers.userId, userId),
            eq(workspaces.status, 'active'),
          ),
        )
        .orderBy(asc(workspaceMembers.createdAt), asc(workspaceMembers.id));

  const userRows = await db
    .select({ activeWorkspaceId: users.activeWorkspaceId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const lastUsedId = userRows[0]?.activeWorkspaceId ?? null;

  const token = options.sessionToken ?? null;
  const sessionRow = token
    ? ((
        await db
          .select({
            activeWorkspaceId: sessions.activeWorkspaceId,
            lastSeenAt: sessions.lastSeenAt,
            userAgent: sessions.userAgent,
          })
          .from(sessions)
          .where(and(eq(sessions.sessionToken, token), eq(sessions.userId, userId)))
          .limit(1)
      )[0] ?? null)
    : null;

  /** The context for a pointer, or null when it does not apply. */
  const fromPointer = async (
    workspaceId: bigint | null,
  ): Promise<{ ctx: WorkspaceContext | null; missing: boolean }> => {
    if (workspaceId === null) return { ctx: null, missing: false };
    const member = memberships.find((m) => m.workspaceId === workspaceId);
    if (member) {
      return {
        ctx: makeWorkspaceContext({
          workspaceId: member.workspaceId,
          userId,
          role: isSuperAdminUser ? 'super_admin' : member.role,
        }),
        missing: false,
      };
    }
    if (!isSuperAdminUser) return { ctx: null, missing: false };
    // God mode: a super-admin pointer at a workspace they're NOT a member
    // of. Honoured while the workspace exists (any status — god mode must
    // be able to inspect archived tenants too).
    const target = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!target[0]) return { ctx: null, missing: true };
    return {
      ctx: makeWorkspaceContext({ workspaceId: target[0].id, userId, role: 'super_admin' }),
      missing: false,
    };
  };

  let selection: WorkspaceSelection | null = null;

  // 1. This session's own pointer.
  const bySession = await fromPointer(sessionRow?.activeWorkspaceId ?? null);
  if (bySession.ctx) selection = { ctx: bySession.ctx, source: 'session' };

  // 2. The last-used workspace.
  if (!selection) {
    const byLastUsed = await fromPointer(lastUsedId);
    if (byLastUsed.ctx) {
      selection = { ctx: byLastUsed.ctx, source: 'last_used' };
    } else if (byLastUsed.missing) {
      // Stale pointer (workspace hard-deleted) — clear it so the switcher
      // and this resolver agree, then fall through to memberships.
      await db.update(users).set({ activeWorkspaceId: null }).where(eq(users.id, userId));
    }
  }

  // 3. Oldest membership (see the ORDER BY above).
  if (!selection && memberships[0]) {
    const first = memberships[0];
    selection = {
      ctx: makeWorkspaceContext({
        workspaceId: first.workspaceId,
        userId,
        role: isSuperAdminUser ? 'super_admin' : first.role,
      }),
      source: 'first_membership',
    };
  }

  if (token && sessionRow) {
    await touchSession(token, sessionRow, {
      workspaceId: selection?.ctx.workspaceId ?? null,
      userAgent: options.userAgent ?? null,
      now: options.now ?? new Date(),
    });
  }

  if (!selection) throw new NoWorkspaceError();
  return selection;
}

/**
 * Pin the resolved workspace on the session row (when it changed) and
 * record lastSeenAt / User-Agent, only when something is due. Best-effort:
 * a failed write must not fail the page — the next request pins again.
 *
 * The pin is a compare-and-set against the pointer this request READ. A
 * new session fires several requests at once (page, RSC prefetches,
 * /api/attention); one still in flight that picked the last-used
 * workspace must not overwrite a switch the user made in this session a
 * moment later (setActiveWorkspace, /go). When the pointer has moved, the
 * pin is skipped and only lastSeenAt / User-Agent are written.
 *
 * Exported for the race test; callers go through resolveWorkspaceSelection.
 */
export async function touchSession(
  token: string,
  row: { activeWorkspaceId: bigint | null; lastSeenAt: Date | null; userAgent: string | null },
  next: { workspaceId: bigint | null; userAgent: string | null; now: Date },
): Promise<void> {
  const pin =
    next.workspaceId !== null && row.activeWorkspaceId !== next.workspaceId
      ? next.workspaceId
      : null;
  const touch: Partial<typeof sessions.$inferInsert> = {};
  if (
    row.lastSeenAt === null ||
    next.now.getTime() - row.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS
  ) {
    touch.lastSeenAt = next.now;
  }
  if (next.userAgent && next.userAgent !== row.userAgent) touch.userAgent = next.userAgent;
  const touchDue = Object.keys(touch).length > 0;
  if (pin === null && !touchDue) return;
  try {
    if (pin !== null) {
      const pinned = await db
        .update(sessions)
        .set({ ...touch, activeWorkspaceId: pin })
        .where(
          and(
            eq(sessions.sessionToken, token),
            row.activeWorkspaceId === null
              ? isNull(sessions.activeWorkspaceId)
              : eq(sessions.activeWorkspaceId, row.activeWorkspaceId),
          ),
        )
        .returning({ token: sessions.sessionToken });
      // Pinned (with the touch), or the pointer moved under us: the
      // user's newer choice stands; only the touch is still owed.
      if (pinned.length > 0 || !touchDue) return;
    }
    await db.update(sessions).set(touch).where(eq(sessions.sessionToken, token));
  } catch (err) {
    console.error(
      '[workspace-resolution] session touch failed:',
      err instanceof Error ? err.message : err,
    );
  }
}
