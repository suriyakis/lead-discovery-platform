// What a download route answers when the download fails.
//
// The Download links (/documents/[id], "Download CSV" on /settings/crm)
// are plain same-tab links to /api/... routes. On success the response
// is an attachment, so the browser saves it and stays on the page. On a
// failure (archived, file gone, workspace switched in another tab) the
// browser would instead navigate to the route's raw JSON error body.
// So a browser navigation gets a 303 back to a page with a readable
// ?error= flash; fetch() and scripts keep the JSON from errorResponse().

import { AccountInactiveError, AuthRequiredError, NoWorkspaceError } from '@/lib/services/auth-context';
import { errorResponse } from '@/lib/services/http';
import { HOME_PATH } from '@/lib/nav/registry';

/** The page a failed browser download goes back to, and what it says there. */
export interface DownloadFailurePage {
  /** Same-origin path, e.g. '/documents/12'. */
  path: string;
  error: string;
}

/** The failed response, as the route's JSON would have described it. */
export interface DownloadFailure {
  status: number;
  /** The `code` field of the JSON error body, when it has one. */
  code: string | null;
}

/**
 * True when a browser is following a link or submitting a form (a page
 * navigation), as opposed to fetch() or a script. Sec-Fetch-Mode is
 * authoritative where sent; older browsers fall back to the Accept header.
 */
export function isBrowserNavigation(req: Request): boolean {
  const mode = req.headers.get('sec-fetch-mode');
  if (mode) return mode === 'navigate';
  return (req.headers.get('accept') ?? '').includes('text/html');
}

/**
 * The response for a download route whose body threw `err`. Non-browser
 * callers get errorResponse(err) unchanged. A browser navigation gets a
 * 303 instead: signed out to sign-in, an inactive account to /pending, no
 * workspace to Today (as server actions do), and anything else to
 * the page `pageFor` picks, with its message as ?error=.
 */
export async function downloadErrorResponse(
  req: Request,
  err: unknown,
  pageFor: (failure: DownloadFailure) => DownloadFailurePage,
): Promise<Response> {
  const failure = errorResponse(err);
  if (!isBrowserNavigation(req)) return failure;
  // The same targets as requireActionContext (src/lib/action-context.ts).
  if (err instanceof AuthRequiredError) return seeOther('/');
  if (err instanceof AccountInactiveError) return seeOther('/pending');
  if (err instanceof NoWorkspaceError) return seeOther(HOME_PATH);
  const page = pageFor({ status: failure.status, code: await errorCode(failure) });
  const sep = page.path.includes('?') ? '&' : '?';
  return seeOther(`${page.path}${sep}error=${encodeURIComponent(page.error)}`);
}

/** A 303 to a same-origin path. Relative Location, so the proxy's public
 *  host is kept whatever Host header reached the app. */
function seeOther(path: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: path, 'Cache-Control': 'private, no-store' },
  });
}

async function errorCode(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.clone().json();
    const code = (body as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}
