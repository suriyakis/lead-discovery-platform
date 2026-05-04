'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { signOut } from './auth';
import { createSessionForUser } from './session-helpers';
import { verifyUserPassword } from './services/users';

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: '/' });
}

/**
 * Server action behind the email + password login form on the home
 * page. On success: mints a session row, sets the Auth.js-shaped cookie,
 * redirects to /dashboard. On failure: redirects back to / with an
 * error querystring.
 */
export async function teamLoginAction(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!email || !password) {
    redirect('/?error=missing_credentials');
  }
  const user = await verifyUserPassword(email, password);
  if (!user) {
    redirect('/?error=invalid_credentials');
  }
  const minted = await createSessionForUser(user.id);
  const jar = await cookies();
  jar.set({
    name: minted.cookieName,
    value: minted.sessionToken,
    expires: minted.expires,
    httpOnly: true,
    sameSite: 'lax',
    secure: minted.cookieSecure,
    path: '/',
  });
  redirect('/dashboard');
}
