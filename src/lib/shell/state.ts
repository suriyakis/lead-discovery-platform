// DS-07 (absorbs ia:F-09, MOB-03, AP-05a): everything the workspace frame
// shows, resolved ONCE per server render of src/app/(app)/layout.tsx.
//
// The (app) layout mounts the frame once and keeps it across client-side
// navigation, so this runs on a full page load, after a server action
// (its response re-renders the layout: refreshChrome() / a redirect) and
// on router.refresh() — never on a plain link click. Between those, the
// numbers stay current in the browser through the attention store
// (useAttention: 60 s poll while visible, focus, reconnect, mutations).
//
// The frame has four states, decided here and nowhere else:
//   signed_out    → the layout sends the visitor to the sign-in page;
//   inactive      → an account waiting for approval goes to /pending;
//   no_workspace  → a bare frame (brand header, sign out); every page
//                   answers with <NoWorkspaceState/> (ia:F-07);
//   workspace     → the full frame: sidebar, header, banners, Cmd-K and
//                   the assistant, for the workspace of THIS session
//                   (MOB-06), with the attention summary as its seed.
// Pages keep their own guards (auth, role, workspace): a page and its
// server actions are reachable on their own.

import { cache } from 'react';
import { auth } from '@/lib/auth';
import { getRequestAttentionSummary } from '@/lib/attention/service';
import type { AttentionSummary } from '@/lib/attention/types';
import { NoWorkspaceError, resolveSessionWorkspaceContext } from '@/lib/services/auth-context';
import {
  getWorkspaceAutomationNotice,
  type WorkspaceAutomationNotice,
} from '@/lib/services/automation-gate';
import type { WorkspaceContext, WorkspaceRole } from '@/lib/services/context';
import { listMyWorkspaces } from '@/lib/services/workspace';
import { noteShellRender } from './render-probe';

export interface ShellUser {
  id: string;
  email: string | null;
  name: string | null;
  isSuperAdmin: boolean;
}

/** One row of the header's workspace switcher. */
export interface ShellWorkspaceRow {
  id: string;
  name: string;
  slug: string;
  role: string;
  isActive: boolean;
  isArchived: boolean;
  isDefault: boolean;
  isGodMode: boolean;
}

export interface WorkspaceShellState {
  kind: 'workspace';
  user: ShellUser;
  ctx: WorkspaceContext;
  role: WorkspaceRole;
  /** The workspace every page below is rendered for (MOB-06's expected
   *  workspace; the assistant and Cmd-K are keyed by its id). */
  workspace: { id: string; name: string };
  /** null when the summary failed as a whole (badges print nothing). */
  attention: AttentionSummary | null;
  /** Holds, the platform stop, the pause, go-live (PC-06/PC-05). */
  automationNotice: WorkspaceAutomationNotice | null;
  workspaces: ShellWorkspaceRow[];
  /** Set while a super-admin is inside a workspace they are not a member of. */
  godMode: { workspaceName: string } | null;
  /** The super-admin's own workspace, for "Return to my workspace". */
  homeWorkspaceId: string | null;
}

export type ShellState =
  | { kind: 'signed_out' }
  | { kind: 'inactive'; user: ShellUser }
  | { kind: 'no_workspace'; user: ShellUser }
  /** The workspace could not be resolved for another reason (the database
   *  is unreachable): a bare frame, and the page reports its own error. */
  | { kind: 'unavailable'; user: ShellUser }
  | WorkspaceShellState;

async function loadShellState(): Promise<ShellState> {
  const session = await auth();
  const sessionUser = session?.user;
  if (!sessionUser?.id) return { kind: 'signed_out' };
  const isSuperAdmin = sessionUser.role === 'super_admin';
  const user: ShellUser = {
    id: sessionUser.id,
    email: sessionUser.email ?? null,
    name: sessionUser.name ?? null,
    isSuperAdmin,
  };
  // Phase 15: every account but a super-admin passes the approval gate
  // before the frame shows anything of a workspace.
  if (sessionUser.accountStatus !== 'active' && !isSuperAdmin) return { kind: 'inactive', user };

  // The workspace of THIS session, resolved the way pages resolve it (the
  // session pointer, god mode, a foreign pointer ignored), so the frame
  // never shows another tenant than the page.
  let ctx: WorkspaceContext;
  try {
    ctx = await resolveSessionWorkspaceContext({ id: user.id, role: sessionUser.role });
  } catch (err) {
    if (err instanceof NoWorkspaceError) return { kind: 'no_workspace', user };
    console.error('[shell] workspace resolution failed:', err);
    return { kind: 'unavailable', user };
  }
  await noteShellRender();

  const [summary, notice, rows] = await Promise.allSettled([
    getRequestAttentionSummary(ctx, { isSuperAdmin }),
    getWorkspaceAutomationNotice(ctx),
    listMyWorkspaces(user.id, {
      includeAllForSuperAdmin: isSuperAdmin,
      activeWorkspaceId: ctx.workspaceId,
    }),
  ]);
  if (summary.status === 'rejected')
    console.error('[shell] attention summary failed:', summary.reason);
  if (notice.status === 'rejected')
    console.error('[shell] automation notice failed:', notice.reason);
  if (rows.status === 'rejected') console.error('[shell] workspace list failed:', rows.reason);

  const myWorkspaces = rows.status === 'fulfilled' ? rows.value : [];
  const active = myWorkspaces.find((m) => m.workspace.id === ctx.workspaceId);
  const godModeRow = myWorkspaces.find((m) => m.isGodMode && m.isActive);
  const home = myWorkspaces.find((m) => !m.isGodMode);
  return {
    kind: 'workspace',
    user,
    ctx,
    role: ctx.role,
    workspace: {
      id: ctx.workspaceId.toString(),
      name: active?.workspace.name ?? `Workspace ${ctx.workspaceId.toString()}`,
    },
    attention: summary.status === 'fulfilled' ? summary.value : null,
    automationNotice: notice.status === 'fulfilled' ? notice.value : null,
    workspaces: myWorkspaces.map((m) => ({
      id: m.workspace.id.toString(),
      name: m.workspace.name,
      slug: m.workspace.slug,
      role: m.role,
      isActive: m.isActive,
      isArchived: m.workspace.status === 'archived',
      isDefault: m.workspace.isDefault,
      isGodMode: m.isGodMode,
    })),
    godMode: godModeRow ? { workspaceName: godModeRow.workspace.name } : null,
    homeWorkspaceId: home ? home.workspace.id.toString() : null,
  };
}

/**
 * The frame's state for this request (deduplicated per server render, so
 * the layout and anything else that asks share one resolution).
 */
export const getShellState: () => Promise<ShellState> = cache(loadShellState);
