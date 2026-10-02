// MOB-06 — the expected-workspace guard on every action that sends, spends
// or decides.
//
// Tabs of one browser share one session, and a session works in one
// workspace at a time. A tab rendered for workspace A keeps showing A after
// another tab switched the session to B; without a check, its Approve,
// Pause or Send would run in B. So every guarded form posts the workspace
// its page was rendered for (EXPECTED_WORKSPACE_FIELD, rendered by
// <ExpectedWorkspaceField/>), and every guarded fetch sends it as the
// EXPECTED_WORKSPACE_HEADER header (useExpectedWorkspaceHeaders()). The
// wrappers below resolve the session's workspace, compare, and on a
// mismatch — or a missing claim — refuse with `workspace_changed` BEFORE
// the action runs: no review, queue, audit or mail row changes.
//
// When the claim matches, the action runs with that context pinned
// (runWithPinnedWorkspace), so its own getWorkspaceContext() calls return
// exactly the workspace that was checked.
//
// Signed-out, inactive and workspace-less requests are not the guard's
// business: the action runs and answers them as it always has
// (requireActionContext's redirects, the routes' 401/403/400).

import { and, eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db/client';
import { workspaceMembers, workspaces } from '@/lib/db/schema/workspaces';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import type { WorkspaceContext } from '@/lib/services/context';
import { runWithPinnedWorkspace } from '@/lib/services/pinned-workspace';
import { isNextRedirectError } from '@/lib/server-redirect';
import { refreshChrome } from '@/lib/shell/refresh';
import { GUARDED_ACTION_CHROME, type GuardedActionId } from './registry';
import {
  EXPECTED_WORKSPACE_FIELD,
  EXPECTED_WORKSPACE_HEADER,
  WORKSPACE_CHANGED,
  parseWorkspaceIdParam,
  workspaceChangedHref,
} from './shared';

const GUARD_MARK = Symbol.for('leadsonar.workspaceGuard');

export interface WorkspaceMismatch {
  code: typeof WORKSPACE_CHANGED;
  /** The workspace the page was rendered for; null when the request carried none. */
  expectedWorkspaceId: bigint | null;
  /** The workspace the session is in now. */
  activeWorkspaceId: bigint;
  /** One sentence for the person, naming both workspaces where allowed. */
  message: string;
}

/** The registry id a function was wrapped under, or null when it is not guarded. */
export function guardedActionId(fn: unknown): GuardedActionId | null {
  if (typeof fn !== 'function') return null;
  const id = (fn as unknown as Record<symbol, unknown>)[GUARD_MARK];
  return typeof id === 'string' ? (id as GuardedActionId) : null;
}

function mark<F extends object>(fn: F, id: GuardedActionId): F {
  Object.defineProperty(fn, GUARD_MARK, { value: id, enumerable: false });
  return fn;
}

/** The claim a server action's arguments carry: a FormData field, or an
 *  object argument's `expectedWorkspaceId` (client components that call
 *  an action directly). The last argument that carries one wins. */
export function expectedWorkspaceFromArgs(args: ReadonlyArray<unknown>): bigint | null {
  for (let i = args.length - 1; i >= 0; i--) {
    const arg = args[i];
    if (arg instanceof FormData) {
      if (arg.has(EXPECTED_WORKSPACE_FIELD)) {
        return parseWorkspaceIdParam(arg.get(EXPECTED_WORKSPACE_FIELD));
      }
    } else if (arg && typeof arg === 'object' && EXPECTED_WORKSPACE_FIELD in arg) {
      return parseWorkspaceIdParam((arg as Record<string, unknown>)[EXPECTED_WORKSPACE_FIELD]);
    }
  }
  return null;
}

function isAccessError(err: unknown): boolean {
  return (
    err instanceof AuthRequiredError ||
    err instanceof AccountInactiveError ||
    err instanceof NoWorkspaceError
  );
}

const quote = (name: string) => `“${name.length > 60 ? `${name.slice(0, 59)}…` : name}”`;

/** The workspace's name when this user may see it (member, or super-admin). */
async function visibleWorkspaceName(
  ctx: WorkspaceContext,
  workspaceId: bigint,
): Promise<string | null> {
  const rows =
    ctx.role === 'super_admin'
      ? await db
          .select({ name: workspaces.name })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .limit(1)
      : await db
          .select({ name: workspaces.name })
          .from(workspaces)
          .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
          .where(and(eq(workspaces.id, workspaceId), eq(workspaceMembers.userId, ctx.userId)))
          .limit(1);
  return rows[0]?.name ?? null;
}

/** Describe a refused claim. Names only workspaces the user belongs to. */
export async function describeWorkspaceMismatch(
  ctx: WorkspaceContext,
  expectedWorkspaceId: bigint | null,
): Promise<WorkspaceMismatch> {
  const base = {
    code: WORKSPACE_CHANGED,
    expectedWorkspaceId,
    activeWorkspaceId: ctx.workspaceId,
  } as const;
  if (expectedWorkspaceId === null) {
    return {
      ...base,
      message:
        'Nothing was changed: this page did not say which workspace it was opened in. Reload it and try again.',
    };
  }
  const [activeName, expectedName] = await Promise.all([
    visibleWorkspaceName(ctx, ctx.workspaceId),
    visibleWorkspaceName(ctx, expectedWorkspaceId),
  ]);
  const active = activeName ? quote(activeName) : 'another workspace';
  if (!expectedName) {
    return {
      ...base,
      message: `Nothing was changed: this page belongs to another workspace, and this browser is now in ${active}. Reload the page and try again.`,
    };
  }
  const expected = quote(expectedName);
  return {
    ...base,
    message: `Nothing was changed: this page was opened in ${expected}, but this browser has since switched to ${active} (in another tab). Reload to work in ${active}, or switch back to ${expected}.`,
  };
}

function logRefusal(id: GuardedActionId, ctx: WorkspaceContext, expected: bigint | null): void {
  console.warn(
    `[workspace-guard] ${id} refused for user ${ctx.userId}: page workspace ${
      expected === null ? 'none' : expected.toString()
    }, session workspace ${ctx.workspaceId.toString()}`,
  );
}

/** The in-app path the refused form was posted from (Referer), if any. */
async function refererPath(): Promise<string | null> {
  try {
    const referer = (await headers()).get('referer');
    if (!referer) return null;
    const url = new URL(referer);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

export interface WorkspaceGuardOptions<R> {
  /**
   * What the action answers on a refused claim. Default: redirect to
   * /workspace-changed, which explains and offers to switch back — right
   * for form actions. Actions a client component calls for a value return
   * their own failure shape instead (e.g. { ok: false, error }).
   */
  onMismatch?: (mismatch: WorkspaceMismatch) => R | Promise<R>;
}

/**
 * Wrap a server action that sends, spends or decides. `id` registers it
 * (registry.ts). The wrapped function is the export itself:
 *
 *   async function approveDraftForm(rawId: string, _formData?: FormData) { … }
 *   export const approveDraftAction = withWorkspaceGuard('draft.approve', approveDraftForm);
 *
 * and render <ExpectedWorkspaceField/> inside every form that posts to it.
 */
export function withWorkspaceGuard<A extends unknown[], R>(
  id: GuardedActionId,
  action: (...args: A) => Promise<R>,
  options: WorkspaceGuardOptions<R> = {},
): (...args: A) => Promise<R> {
  const guarded = async (...args: A): Promise<R> => {
    const expected = expectedWorkspaceFromArgs(args);
    let ctx: WorkspaceContext;
    try {
      ctx = await getWorkspaceContext();
    } catch (err) {
      if (isAccessError(err)) return action(...args);
      throw err;
    }
    if (expected === null || expected !== ctx.workspaceId) {
      logRefusal(id, ctx, expected);
      const mismatch = await describeWorkspaceMismatch(ctx, expected);
      if (options.onMismatch) return options.onMismatch(mismatch);
      redirect(workspaceChangedHref(expected, await refererPath()));
    }
    // DS-07: a decision re-renders the workspace frame in the same
    // response (badges, bell, banners), whether it returns or redirects.
    const refreshes = GUARDED_ACTION_CHROME[id] === 'refresh';
    try {
      const result = await runWithPinnedWorkspace(ctx, () => action(...args));
      if (refreshes) refreshChrome();
      return result;
    } catch (err) {
      if (refreshes && isNextRedirectError(err)) refreshChrome();
      throw err;
    }
  };
  return mark(guarded, id);
}

/** The 409 a guarded API route answers on a refused claim. */
export function workspaceChangedResponse(mismatch: WorkspaceMismatch): NextResponse {
  return NextResponse.json(
    {
      error: WORKSPACE_CHANGED,
      detail: mismatch.message,
      expectedWorkspaceId: mismatch.expectedWorkspaceId?.toString() ?? null,
      activeWorkspaceId: mismatch.activeWorkspaceId.toString(),
    },
    { status: 409 },
  );
}

/**
 * Wrap an API route handler that sends, spends or decides. The claim is
 * the EXPECTED_WORKSPACE_HEADER header (useExpectedWorkspaceHeaders() on
 * the client). A refused claim answers 409 { error: 'workspace_changed',
 * detail } before the handler runs.
 */
export function withWorkspaceGuardRoute<
  H extends (req: Request, ...rest: never[]) => Promise<Response>,
>(id: GuardedActionId, handler: H): H {
  const guarded = async (req: Request, ...rest: never[]): Promise<Response> => {
    const expected = parseWorkspaceIdParam(req.headers.get(EXPECTED_WORKSPACE_HEADER));
    let ctx: WorkspaceContext;
    try {
      ctx = await getWorkspaceContext();
    } catch (err) {
      if (isAccessError(err)) return handler(req, ...rest);
      throw err;
    }
    if (expected === null || expected !== ctx.workspaceId) {
      logRefusal(id, ctx, expected);
      return workspaceChangedResponse(await describeWorkspaceMismatch(ctx, expected));
    }
    return runWithPinnedWorkspace(ctx, () => handler(req, ...rest));
  };
  return mark(guarded as H, id);
}
