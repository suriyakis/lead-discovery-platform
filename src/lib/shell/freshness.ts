// DS-07 / ia:F-09: keeping the persistent workspace frame true, without
// React — so every trigger is testable in node with fake events
// (src/tests/app-shell-ds07.test.ts). <ShellRefresher/> wires it to the
// browser and to router.refresh().
//
// The (app) layout renders the frame on the server once per full load and
// keeps it across client navigation. Numbers stay current through the
// attention store (useAttention); the rest of the frame — the automation
// banners, the god-mode bar, the workspace chip — is server-rendered and
// changes only when the layout renders again. Three things make it render
// again from the browser:
//   1. coming back to the tab after SHELL_IDLE_REFRESH_MS away (blurred
//      or hidden): one router.refresh() — after asking for the newest
//      summary, and only if it is still the frame's workspace
//      (idleRefreshAllowed());
//   2. the polled summary's automation state differing from the one the
//      frame was rendered with (someone paused, a hold landed, the
//      platform stopped outbound): one router.refresh() per new state, so
//      the banner shows within a poll (60 s) or at once on focus;
//   3. server actions (refreshChrome(), src/lib/shell/refresh.ts).
// A summary for ANOTHER workspace (this browser switched in another tab)
// never refreshes the frame silently: the page's actions would then run
// in a workspace the person did not pick. <WorkspaceDriftNotice/> says so
// and offers a reload; MOB-06's guard refuses the stale page's actions
// meanwhile.

import type { AttentionSummary } from '@/lib/attention/types';

/** A tab away this long refreshes its frame when it comes back. */
export const SHELL_IDLE_REFRESH_MS = 5 * 60_000;

/**
 * The part of a summary the server-rendered frame depends on (beyond the
 * numbers, which the client renders itself): the automation pill state.
 * null when there is nothing to compare.
 */
export function chromeSignature(summary: AttentionSummary | null | undefined): string | null {
  if (!summary?.outreach) return null;
  const o = summary.outreach;
  return [summary.workspaceId, o.state, o.paused, o.live, o.partlyPaused].join('|');
}

/**
 * Whether the polled summary shows a frame state the page was not
 * rendered with, and a refresh for it has not been asked for yet.
 */
export function needsChromeRefresh(input: {
  /** chromeSignature() of the summary the layout rendered with. */
  rendered: string | null;
  /** The newest summary for the frame's workspace. */
  latest: AttentionSummary | null;
  /** The signature a refresh was last requested for. */
  requested: string | null;
}): boolean {
  const latest = chromeSignature(input.latest);
  if (!latest || !input.rendered) return false;
  return latest !== input.rendered && latest !== input.requested;
}

/** The newest summary is for another workspace than the frame's. */
export function workspaceDrifted(
  frameWorkspaceId: string | null,
  latest: AttentionSummary | null,
): boolean {
  return Boolean(frameWorkspaceId && latest && latest.workspaceId !== frameWorkspaceId);
}

/**
 * Whether an idle-return refresh may re-render the frame. The tab was away
 * (polls pause while hidden), so the summary it holds can predate a switch
 * made in another tab meanwhile: ask for the newest one FIRST, and refresh
 * only when it is still the frame's workspace. Otherwise the refresh would
 * re-render the frame for the session's new workspace — a silent tenant
 * swap under the pointer, and the drift notice gone with it. A failed
 * fetch is not drift (the frame refreshes as before).
 */
export async function idleRefreshAllowed(input: {
  frameWorkspaceId: string | null;
  fetchLatest: () => Promise<AttentionSummary | null>;
}): Promise<boolean> {
  if (!input.frameWorkspaceId) return true;
  let latest: AttentionSummary | null = null;
  try {
    latest = await input.fetchLatest();
  } catch {
    latest = null;
  }
  return !workspaceDrifted(input.frameWorkspaceId, latest);
}

export type ShellRefreshReason = 'idle-return' | 'chrome-state';

/** What the idle tracker needs from the browser (tests pass fakes). */
export interface ShellFreshnessEnv {
  now(): number;
  isVisible(): boolean;
  /** Fires 'focus' and 'blur'. */
  window: EventTarget | null;
  /** Fires 'visibilitychange'. */
  document: EventTarget | null;
  refresh(reason: ShellRefreshReason): void;
  /**
   * Asked right before a refresh; false (or a promise of false) skips it.
   * ShellRefresher answers with idleRefreshAllowed(): no refresh while
   * this browser is in another workspace than the frame's.
   */
  shouldRefresh?(reason: ShellRefreshReason): boolean | Promise<boolean>;
  /** Default SHELL_IDLE_REFRESH_MS. */
  idleMs?: number;
}

export interface ShellFreshness {
  start(): void;
  stop(): void;
  /** Refreshes asked for so far (tests). */
  readonly refreshes: ReadonlyArray<ShellRefreshReason>;
  /** Refreshes shouldRefresh() turned down (tests). */
  readonly skipped: ReadonlyArray<ShellRefreshReason>;
  /** Resolves once every pending shouldRefresh() answer is acted on (tests). */
  settled(): Promise<void>;
}

/**
 * Trigger 1: a tab that comes back (focus, or visible again) after being
 * away for at least `idleMs` refreshes the frame once — unless
 * shouldRefresh() says no. Focus and visibilitychange usually fire
 * together; the second finds the tab no longer away and does nothing.
 */
export function createShellFreshness(env: ShellFreshnessEnv): ShellFreshness {
  const idleMs = env.idleMs ?? SHELL_IDLE_REFRESH_MS;
  const refreshes: ShellRefreshReason[] = [];
  const skipped: ShellRefreshReason[] = [];
  const pending = new Set<Promise<void>>();
  let running = false;
  let awaySince: number | null = env.isVisible() ? null : env.now();

  const act = (reason: ShellRefreshReason, ok: boolean) => {
    // Stopped (unmounted) while the answer was on its way: nothing to do.
    if (!running) return;
    if (!ok) {
      skipped.push(reason);
      return;
    }
    refreshes.push(reason);
    env.refresh(reason);
  };
  const ask = (reason: ShellRefreshReason) => {
    const verdict = env.shouldRefresh ? env.shouldRefresh(reason) : true;
    if (typeof verdict === 'boolean') {
      act(reason, verdict);
      return;
    }
    const p = verdict.then(
      (ok) => act(reason, ok),
      () => act(reason, true),
    );
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };

  const leave = () => {
    awaySince ??= env.now();
  };
  const back = () => {
    if (awaySince === null) return;
    const away = env.now() - awaySince;
    awaySince = null;
    if (away >= idleMs) ask('idle-return');
  };
  const onVisibility = () => (env.isVisible() ? back() : leave());

  return {
    start() {
      running = true;
      env.window?.addEventListener('blur', leave);
      env.window?.addEventListener('focus', back);
      env.document?.addEventListener('visibilitychange', onVisibility);
    },
    stop() {
      running = false;
      env.window?.removeEventListener('blur', leave);
      env.window?.removeEventListener('focus', back);
      env.document?.removeEventListener('visibilitychange', onVisibility);
    },
    get refreshes() {
      return refreshes;
    },
    get skipped() {
      return skipped;
    },
    async settled() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
