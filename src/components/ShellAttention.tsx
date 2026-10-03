'use client';

// DS-07 (MOB-03, AP-05a): the workspace frame's numbers in the browser.
//
// The (app) layout renders the frame once and keeps it across client
// navigation, so a server-rendered number would freeze at the value of the
// first page. Every number in the frame — the sidebar and area-tab badges,
// the bell, the account menu — therefore reads the attention summary
// through this provider: the layout's server-rendered summary is the seed,
// and useAttention() keeps it current (60 s poll while visible, focus,
// reconnect, refreshAttention() after a mutation, and a newer seed each
// time the layout renders again — refreshChrome() after a decision).
//
// A summary for another workspace than the frame's (this browser switched
// in another tab) is not shown as the frame's numbers: `summary` keeps the
// frame's last ones and `latest` carries the other one, for the drift
// notice (WorkspaceDriftNotice) and nothing else.

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { AttentionSummary } from '@/lib/attention/types';
import { useAttention } from '@/lib/attention/use-attention';

export interface ShellAttentionValue {
  /** The newest summary for the frame's workspace (the seed until then). */
  summary: AttentionSummary | null;
  /** The newest summary the browser holds, whatever its workspace. */
  latest: AttentionSummary | null;
  /** The workspace the frame was rendered for. */
  workspaceId: string | null;
}

const ShellAttentionContext = createContext<ShellAttentionValue | null>(null);

/** Only the summaries of `workspaceId` count; another one keeps `seed`. */
function forWorkspace(
  latest: AttentionSummary | null,
  seed: AttentionSummary | null,
  workspaceId: string | null,
): AttentionSummary | null {
  if (latest && workspaceId && latest.workspaceId !== workspaceId) return seed;
  return latest;
}

export function ShellAttentionProvider({
  seed,
  workspaceId,
  children,
}: Readonly<{
  seed: AttentionSummary | null;
  workspaceId: string | null;
  children: ReactNode;
}>) {
  // No summary (it failed as a whole): no store, no poll — no numbers.
  const latest = useAttention(seed, { enabled: Boolean(seed) });
  const value = useMemo<ShellAttentionValue>(
    () => ({ summary: forWorkspace(latest, seed, workspaceId), latest, workspaceId }),
    [latest, seed, workspaceId],
  );
  return <ShellAttentionContext.Provider value={value}>{children}</ShellAttentionContext.Provider>;
}

/** The frame's attention, or null outside the workspace frame. */
export function useShellAttention(): ShellAttentionValue | null {
  return useContext(ShellAttentionContext);
}

/**
 * The summary a frame component shows: the frame's inside the shell;
 * outside it (tests, the docs gallery) the component's own `seed`, kept
 * live the same way.
 */
export function useFrameAttention(seed?: AttentionSummary | null): AttentionSummary | null {
  const shell = useContext(ShellAttentionContext);
  const own = useAttention(shell ? null : seed, { enabled: !shell && Boolean(seed) });
  if (shell) return shell.summary;
  return forWorkspace(own, seed ?? null, seed?.workspaceId ?? null);
}
