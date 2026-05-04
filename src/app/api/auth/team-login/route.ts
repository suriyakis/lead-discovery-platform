// Phase 30: programmatic email + password login. Mints an Auth.js-shaped
// session row + cookie. Mirrors the form-action path in /lib/auth-actions
// so any caller (CLI, mobile client, etc.) gets the same result as
// submitting the login form.

import { NextResponse } from 'next/server';
import { createSessionForUser } from '@/lib/session-helpers';
import { verifyUserPassword } from '@/lib/services/users';

export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const email =
    typeof (body as { email?: unknown }).email === 'string'
      ? ((body as { email: string }).email as string).trim()
      : '';
  const password =
    typeof (body as { password?: unknown }).password === 'string'
      ? (body as { password: string }).password
      : '';
  if (!email || !password) {
    return NextResponse.json({ error: 'missing_credentials' }, { status: 400 });
  }

  const user = await verifyUserPassword(email, password);
  if (!user) {
    return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  const minted = await createSessionForUser(user.id);
  const res = NextResponse.json({ ok: true, redirectTo: '/dashboard' });
  res.cookies.set({
    name: minted.cookieName,
    value: minted.sessionToken,
    expires: minted.expires,
    httpOnly: true,
    sameSite: 'lax',
    secure: minted.cookieSecure,
    path: '/',
  });
  return res;
}
