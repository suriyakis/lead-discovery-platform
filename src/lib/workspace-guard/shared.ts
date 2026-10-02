// MOB-06 — tenant-safe links and actions: the pieces both the browser and
// the server need (no server imports here).
//
//   - The expected-workspace claim. A guarded form posts the id of the
//     workspace its page was rendered for as a hidden `expectedWorkspaceId`
//     field; a guarded fetch sends it as the `x-expected-workspace` header.
//     withWorkspaceGuard (./server.ts) refuses with `workspace_changed`
//     when the session has since moved to another workspace (a switch in
//     another tab of the same browser) — before anything is written.
//   - Workspace-carrying links: `/go?ws=<id>&to=<path>` switches this
//     session to <id> (members only) and lands on <path> with a
//     "Switched to …" notice. Notifications and the assistant's record
//     links are built with goHref(), so a link opened while the session is
//     elsewhere still lands on the right tenant.

/** Hidden form field carrying the page's workspace id. */
export const EXPECTED_WORKSPACE_FIELD = 'expectedWorkspaceId';
/** Request header carrying the page's workspace id on guarded fetches. */
export const EXPECTED_WORKSPACE_HEADER = 'x-expected-workspace';
/** The refusal code a guarded action answers with on a mismatch. */
export const WORKSPACE_CHANGED = 'workspace_changed';

/** The workspace-switching link route. */
export const GO_PATH = '/go';
/** Query flag /go appends to the landing page after a real switch. */
export const SWITCHED_PARAM = 'switched';
/** The page a refused form action lands on. */
export const WORKSPACE_CHANGED_PATH = '/workspace-changed';

/** Longest in-app path a /go link or a refusal carries. */
export const MAX_TARGET_LENGTH = 2000;

/** A workspace id as it travels in forms, headers and URLs, or null. */
export function parseWorkspaceIdParam(raw: unknown): bigint | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^[1-9]\d{0,18}$/.test(s)) return null;
  const id = BigInt(s);
  return id <= 9_223_372_036_854_775_807n ? id : null;
}

/**
 * An in-app path that is safe to redirect to, or null.
 *
 * Accepts only a relative path that starts with a single '/': no scheme,
 * no host, no protocol-relative '//' (or '/\', which browsers read as
 * '//'), no control characters, and nothing that resolves to another
 * origin. /go itself is refused so a link cannot loop. Query and #hash
 * are kept.
 */
export function safeInAppPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > MAX_TARGET_LENGTH) return null;
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\')) return null;
  // Backslashes and control characters (incl. tab / newline, which URL
  // parsers strip) can turn a path into a host.
  if (/[\\\u0000-\u001f\u007f]/.test(s)) return null;
  const base = 'http://in-app.invalid';
  let url: URL;
  try {
    url = new URL(s, base);
  } catch {
    return null;
  }
  if (url.origin !== base) return null;
  if (url.pathname === GO_PATH || url.pathname.startsWith(`${GO_PATH}/`)) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * A workspace-carrying link to `path` in workspace `workspaceId`. Already
 * a /go link → returned unchanged (idempotent); not a safe in-app path →
 * null (the caller shows no link rather than a dangerous one).
 */
export function goHref(
  workspaceId: bigint | string,
  path: string | null | undefined,
): string | null {
  if (!path) return null;
  if (isGoHref(path)) return path;
  const target = safeInAppPath(path);
  if (!target) return null;
  const ws = typeof workspaceId === 'bigint' ? workspaceId.toString() : workspaceId;
  if (parseWorkspaceIdParam(ws) === null) return null;
  const qs = new URLSearchParams({ ws, to: target });
  return `${GO_PATH}?${qs.toString()}`;
}

/** Whether `href` is already a /go link. */
export function isGoHref(href: string): boolean {
  return href === GO_PATH || href.startsWith(`${GO_PATH}?`);
}

/** The landing path /go redirects to, flagged with SWITCHED_PARAM when the session moved. */
export function goLandingPath(target: string, workspaceId: bigint, switched: boolean): string {
  if (!switched) return target;
  const url = new URL(target, 'http://in-app.invalid');
  url.searchParams.set(SWITCHED_PARAM, workspaceId.toString());
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Where a refused form action sends the browser. */
export function workspaceChangedHref(
  expectedWorkspaceId: bigint | null,
  returnTo: string | null,
): string {
  const qs = new URLSearchParams();
  if (expectedWorkspaceId !== null) qs.set('ws', expectedWorkspaceId.toString());
  const to = safeInAppPath(returnTo);
  if (to && !to.startsWith(WORKSPACE_CHANGED_PATH)) qs.set('to', to);
  const s = qs.toString();
  return s ? `${WORKSPACE_CHANGED_PATH}?${s}` : WORKSPACE_CHANGED_PATH;
}

/**
 * The "Switched to …" notice for a page that /go landed on: the message
 * when the URL's SWITCHED_PARAM names the page's own workspace, and the
 * URL without the flag (so a reload does not repeat it). null when there
 * is nothing to say.
 */
export function switchNotice(
  href: string,
  page: { id: string; name: string } | null,
): { message: string; cleanHref: string } | null {
  let url: URL;
  try {
    url = new URL(href, 'http://in-app.invalid');
  } catch {
    return null;
  }
  const flagged = url.searchParams.get(SWITCHED_PARAM);
  if (flagged === null) return null;
  url.searchParams.delete(SWITCHED_PARAM);
  const cleanHref = `${url.pathname}${url.search}${url.hash}`;
  if (!page || flagged !== page.id) return { message: '', cleanHref };
  return { message: `Switched to ${page.name}`, cleanHref };
}

/**
 * How the assistant panel links a [/path] reference in an answer computed
 * for workspace `answerWorkspaceId`, seen on a page of `pageWorkspaceId`:
 * the same workspace → a plain client-side link (the panel and its
 * transcript stay); another one → the /go link, a full page load that
 * switches this session back to the answer's workspace first.
 */
export function assistantLink(
  path: string,
  answerWorkspaceId: string | null,
  pageWorkspaceId: string | null,
): { href: string; viaGo: boolean } | null {
  const target = safeInAppPath(path);
  if (!target) return null;
  if (!answerWorkspaceId || answerWorkspaceId === pageWorkspaceId) {
    return { href: target, viaGo: false };
  }
  const href = goHref(answerWorkspaceId, target);
  return href ? { href, viaGo: true } : { href: target, viaGo: false };
}
