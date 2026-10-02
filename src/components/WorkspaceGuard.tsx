'use client';

// MOB-06 — the browser half of the expected-workspace guard.
//
// The workspace frame (AppShell, rendered once by src/app/(app)/layout.tsx,
// DS-07) mounts <WorkspaceGuardProvider> with the workspace it was rendered
// for, which every page inside it shares. Inside it:
//   - <ExpectedWorkspaceField/> goes into every form whose action is
//     guarded (src/lib/workspace-guard/registry.ts): a hidden input with
//     that workspace id, posted with the form;
//   - useExpectedWorkspaceHeaders() gives the header a guarded fetch sends;
//   - useExpectedWorkspace() gives the id itself (client components that
//     call a guarded action directly pass it as `expectedWorkspaceId`).
// The server refuses with `workspace_changed` when the session has moved
// to another workspace since this page rendered (a switch in another tab).
//
// <WorkspaceSwitchNotice/> shows "Switched to …" after a /go link moved
// the session, and removes the flag from the address bar.
//
// <WorkspaceDriftNotice/> (DS-07) says so when the polled attention summary
// shows this browser working in another workspace than the frame's (a
// switch in another tab). The frame persists across client navigation, so
// a page opened after such a switch would show the other workspace's data
// in this frame; its guarded actions are refused (they post the frame's
// workspace) until the person reloads. Nothing reloads by itself: a frame
// that swapped tenants under the pointer could take a click meant for the
// workspace the person was looking at.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Alert } from './Alert';
import { useShellAttention } from './ShellAttention';
import styles from './WorkspaceGuard.module.css';
import { workspaceDrifted } from '@/lib/shell/freshness';
import {
  EXPECTED_WORKSPACE_FIELD,
  EXPECTED_WORKSPACE_HEADER,
  switchNotice,
} from '@/lib/workspace-guard/shared';

export interface PageWorkspace {
  /** Workspace id as a decimal string. */
  id: string;
  name: string;
}

const PageWorkspaceContext = createContext<PageWorkspace | null>(null);

export function WorkspaceGuardProvider({
  workspace,
  children,
}: Readonly<{ workspace: PageWorkspace | null; children: ReactNode }>) {
  return (
    <PageWorkspaceContext.Provider value={workspace}>{children}</PageWorkspaceContext.Provider>
  );
}

/** The workspace this page was rendered for, or null outside the app shell. */
export function useExpectedWorkspace(): PageWorkspace | null {
  return useContext(PageWorkspaceContext);
}

/** Headers for a guarded fetch: {} outside the app shell (the server then refuses). */
export function useExpectedWorkspaceHeaders(): Record<string, string> {
  const workspace = useExpectedWorkspace();
  return useMemo(() => {
    const headers: Record<string, string> = {};
    if (workspace) headers[EXPECTED_WORKSPACE_HEADER] = workspace.id;
    return headers;
  }, [workspace]);
}

/** The hidden field every guarded form carries. */
export function ExpectedWorkspaceField() {
  const workspace = useExpectedWorkspace();
  if (!workspace) return null;
  return <input type="hidden" name={EXPECTED_WORKSPACE_FIELD} value={workspace.id} />;
}

const NOTICE_MS = 8000;

/** "Switched to …" after /go moved this session (see switchNotice()). */
export function WorkspaceSwitchNotice() {
  const workspace = useExpectedWorkspace();
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const notice = switchNotice(window.location.href, workspace);
    if (!notice) return;
    // Drop the flag so a reload or a shared URL does not repeat it.
    window.history.replaceState(window.history.state, '', notice.cleanHref);
    if (!notice.message) return;
    setMessage(notice.message);
    const timer = window.setTimeout(() => setMessage(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [workspace]);

  if (!message) return null;
  return (
    <div className={styles.notice} data-workspace-switch-notice="">
      <Alert
        tone="success"
        title={message}
        action={
          <button
            type="button"
            className="ghost-btn"
            aria-label="Dismiss"
            onClick={() => setMessage(null)}
          >
            <X className="lucide" aria-hidden="true" />
          </button>
        }
      >
        <p className={styles.noticeText}>
          This browser now works in this workspace. Your other devices stay where they are.
        </p>
      </Alert>
    </div>
  );
}

/**
 * DS-07: "this browser switched to another workspace in another tab" —
 * shown while the newest attention summary belongs to another workspace
 * than the frame's. Reload opens the page in the workspace the browser is
 * in now; the frame never swaps tenants on its own.
 */
export function WorkspaceDriftNotice() {
  const workspace = useExpectedWorkspace();
  const latest = useShellAttention()?.latest ?? null;
  if (!workspace || !workspaceDrifted(workspace.id, latest)) return null;
  return (
    <div className={styles.notice} data-workspace-drift-notice="">
      <Alert
        tone="warning"
        title="This browser switched to another workspace"
        action={
          <button type="button" className="ghost-btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        }
      >
        <p className={styles.noticeText}>
          It happened in another tab. This page still shows “{workspace.name}”, and its actions are
          refused until you reload it in the workspace you are in now.
        </p>
      </Alert>
    </div>
  );
}
