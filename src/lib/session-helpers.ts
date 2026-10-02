// Helpers shared between the /api/auth/team-login route and the
// teamLoginAction server action. Mints rows in the same `sessions` table
// Auth.js's DB adapter uses, then names the cookie the same way Auth.js
// does so auth() resolves it identically.

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from './db/client';
import { sessions, users } from './db/schema/auth';
import { USER_AGENT_MAX } from './session-token';

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface MintedSession {
  sessionToken: string;
  expires: Date;
  cookieName: string;
  cookieSecure: boolean;
}

export function sessionCookieName(): string {
  const url = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? '';
  return url.startsWith('https://')
    ? '__Secure-authjs.session-token'
    : 'authjs.session-token';
}

export function sessionCookieIsSecure(): boolean {
  const url = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? '';
  return url.startsWith('https://');
}

/**
 * Insert a fresh sessions row for `userId` and return the token + cookie
 * settings the caller should attach. Also bumps `users.lastSignedInAt`.
 *
 * MOB-06: the row starts with no workspace of its own; its first request
 * pins the user's last-used workspace (workspace-resolution.ts). The
 * browser's User-Agent, when the caller has it, is recorded so the user
 * can tell sessions apart.
 */
export async function createSessionForUser(
  userId: string,
  options: { userAgent?: string | null } = {},
): Promise<MintedSession> {
  const sessionToken = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_LIFETIME_MS);
  const userAgent = options.userAgent?.trim().slice(0, USER_AGENT_MAX) || null;
  await db.insert(sessions).values({ sessionToken, userId, expires, userAgent });
  await db
    .update(users)
    .set({ lastSignedInAt: new Date() })
    .where(eq(users.id, userId));
  return {
    sessionToken,
    expires,
    cookieName: sessionCookieName(),
    cookieSecure: sessionCookieIsSecure(),
  };
}
