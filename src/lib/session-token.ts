// MOB-06: which Auth.js session row this request belongs to.
//
// Sessions are database sessions (src/lib/auth.ts): the cookie carries the
// sessions.sessionToken primary key, and the workspace a session works in
// is stored on that row (sessions.activeWorkspaceId). The token never
// leaves the server — the session callback strips it from the session
// object — so the resolver reads it from the request cookie here.
//
// Auth.js names the cookie with a __Secure- prefix on https deployments
// (session-helpers.ts mints the same names for the password login), so
// both names are tried. A token that does not belong to the signed-in user
// is harmless: the resolver only reads a session row WHERE the token AND
// the user id match.
//
// Outside a request (scripts, ticks, most tests) there are no cookies; the
// readers return null and the resolver falls back to the user's last-used
// workspace without pinning anything.

import { cookies, headers } from 'next/headers';

export const SESSION_COOKIE_NAMES = [
  '__Secure-authjs.session-token',
  'authjs.session-token',
] as const;

/** Longest User-Agent stored on a session row. */
export const USER_AGENT_MAX = 300;

export interface RequestSession {
  /** sessions.sessionToken of this request, or null (no cookie / no request). */
  token: string | null;
  /** The request's User-Agent (clipped), or null. */
  userAgent: string | null;
}

/** Pure: the session token among a request's cookies. */
export function pickSessionToken(read: (name: string) => string | undefined): string | null {
  for (const name of SESSION_COOKIE_NAMES) {
    const value = read(name);
    if (value && /^[A-Za-z0-9._-]{16,512}$/.test(value)) return value;
  }
  return null;
}

/** The current request's session token and User-Agent; nulls outside a request. */
export async function readRequestSession(): Promise<RequestSession> {
  let token: string | null = null;
  let userAgent: string | null = null;
  try {
    const jar = await cookies();
    token = pickSessionToken((name) => jar.get(name)?.value);
  } catch {
    token = null; // not in a request scope
  }
  try {
    const h = await headers();
    const ua = h.get('user-agent')?.trim();
    userAgent = ua ? ua.slice(0, USER_AGENT_MAX) : null;
  } catch {
    userAgent = null;
  }
  return { token, userAgent };
}
