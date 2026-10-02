// MOB-06: the workspace a guarded action was checked against, pinned for
// the rest of that action.
//
// withWorkspaceGuard (src/lib/workspace-guard/server.ts) resolves the
// session's workspace, compares it with the one the page showed, and then
// runs the action inside runWithPinnedWorkspace(ctx). Every
// getWorkspaceContext() inside the action — the action's own, and any a
// helper makes — returns that same context instead of resolving again, so
// a switch in another tab between the check and the write can never move
// the write to another tenant.
//
// Its own module (no next-auth, no DB) so tests that mock auth-context
// still get the real pin.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkspaceContext } from './context';

const pinned = new AsyncLocalStorage<WorkspaceContext>();

/** Run `fn` with `ctx` as the request's workspace context. */
export function runWithPinnedWorkspace<T>(ctx: WorkspaceContext, fn: () => Promise<T>): Promise<T> {
  return pinned.run(ctx, fn);
}

/** The context a guard pinned for this call, if any. */
export function pinnedWorkspaceContext(): WorkspaceContext | null {
  return pinned.getStore() ?? null;
}
