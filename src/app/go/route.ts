// GET /go?ws=<workspace id>&to=<in-app path> — workspace-carrying links
// (MOB-06).
//
// Notifications, alerts and the assistant link to records through /go, so
// a link opened while this browser works in another workspace still lands
// on the right tenant:
//
//   - `to` must be a relative in-app path starting with a single '/'
//     (no //host, no scheme, no backslash tricks): anything else is 400;
//   - the signed-in user must be a member of `ws` (super-admins included:
//     god mode is never entered through a link) — otherwise 403 and
//     nothing moves;
//   - only THIS session switches (not the last-used value, not the user's
//     other browsers);
//   - 303 to `to`, flagged ?switched=<ws> when the session really moved,
//     which the shell turns into a "Switched to …" notice.
//
// Signed out → the sign-in page; account not active → /pending.
//
// A GET that switches is deliberate (links must work from mail and push),
// so it is never prefetched: link to /go with a plain <a>, never next/link.

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { HOME_PATH } from '@/lib/nav/registry';
import { readRequestSession } from '@/lib/session-token';
import { resolveSessionWorkspaceContext } from '@/lib/services/auth-context';
import { NoWorkspaceError } from '@/lib/services/workspace-resolution';
import { WorkspaceServiceError, switchSessionWorkspace } from '@/lib/services/workspace';
import { goLandingPath, parseWorkspaceIdParam, safeInAppPath } from '@/lib/workspace-guard/shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = 'no-store, max-age=0';

/** A relative 303 (RFC 9110 allows a relative Location): no origin guessing behind the proxy. */
function seeOther(location: string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { Location: location, 'Cache-Control': NO_STORE },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

/** A small plain page for a link that cannot be followed. */
function refusal(status: 400 | 403, title: string, text: string): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(
    title,
  )}</title></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(
    text,
  )}</p><p><a href="${HOME_PATH}">Go to Today</a></p></main></body></html>`;
  return new NextResponse(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': NO_STORE },
  });
}

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const target = safeInAppPath(url.searchParams.get('to'));
  const workspaceId = parseWorkspaceIdParam(url.searchParams.get('ws'));
  if (!target || workspaceId === null) {
    return refusal(
      400,
      'This link is not valid',
      'It does not point to a page of this app. Nothing was changed.',
    );
  }

  const session = await auth();
  if (!session?.user?.id) return seeOther('/');
  if (session.user.accountStatus !== 'active' && session.user.role !== 'super_admin') {
    return seeOther('/pending');
  }

  const { token } = await readRequestSession();
  if (!token) return seeOther('/');

  // Resolve (and so pin) this session's current workspace first, so
  // "switched" means the session really moved.
  try {
    await resolveSessionWorkspaceContext(session.user);
  } catch (err) {
    if (!(err instanceof NoWorkspaceError)) throw err;
  }

  try {
    const result = await switchSessionWorkspace(session.user.id, workspaceId, token);
    return seeOther(goLandingPath(target, workspaceId, result.switched));
  } catch (err) {
    if (err instanceof WorkspaceServiceError) {
      return refusal(
        403,
        'You are not in that workspace',
        err.code === 'workspace_archived'
          ? 'That workspace is archived. Nothing was changed.'
          : 'This link belongs to a workspace you are not a member of. Nothing was changed.',
      );
    }
    throw err;
  }
}
