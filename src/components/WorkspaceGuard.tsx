'use client';

// MOB-06 — the browser half of the expected-workspace guard.
//
// The app shell (AppShell today; (app)/layout.tsx once MOB-03 lands)
// mounts <WorkspaceGuardProvider> with the workspace the page was rendered
// for. Inside it:
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

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Alert } from './Alert';
import styles from './WorkspaceGuard.module.css';
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
