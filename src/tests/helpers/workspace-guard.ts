// MOB-06 test helpers: what a page rendered for a workspace posts back to a
// guarded action (src/lib/workspace-guard). A test calling a guarded server
// action or route directly plays the browser, so it must carry the claim a
// real form or fetch would — otherwise the guard refuses with
// workspace_changed (a missing claim fails closed).

import { EXPECTED_WORKSPACE_FIELD, EXPECTED_WORKSPACE_HEADER } from '@/lib/workspace-guard/shared';

/** Add the page's workspace to a guarded form's FormData (returns it). */
export function withClaim(fd: FormData, workspaceId: bigint | string): FormData {
  fd.set(EXPECTED_WORKSPACE_FIELD, String(workspaceId));
  return fd;
}

/** A FormData with `fields` and the page's workspace claim. */
export function claimedForm(
  workspaceId: bigint | string,
  fields: Record<string, string> = {},
): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return withClaim(fd, workspaceId);
}

/** The header a guarded fetch sends. */
export function claimHeaders(workspaceId: bigint | string): Record<string, string> {
  return { [EXPECTED_WORKSPACE_HEADER]: String(workspaceId) };
}

/**
 * Wrap a guarded server action as "posted from a page rendered just now":
 * at call time the signed-in user's current workspace is resolved (as the
 * page render would) and added as the claim to every FormData argument
 * that has none. For suites about something else than the guard — the
 * guard itself is exercised in workspace-guard-mob06.test.ts.
 */
export function postedFromCurrentPage<A extends unknown[], R>(
  action: (...args: A) => Promise<R>,
  currentUser: () => { id: string; role?: string } | null | undefined,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const user = currentUser();
    if (user) {
      try {
        const { resolveWorkspaceContextForUser } =
          await import('@/lib/services/workspace-resolution');
        const page = await resolveWorkspaceContextForUser(user.id, user.role === 'super_admin');
        for (const arg of args) {
          if (arg instanceof FormData && !arg.has(EXPECTED_WORKSPACE_FIELD)) {
            arg.set(EXPECTED_WORKSPACE_FIELD, page.workspaceId.toString());
          }
        }
      } catch {
        // No workspace: the action answers that itself.
      }
    }
    return action(...args);
  };
}
