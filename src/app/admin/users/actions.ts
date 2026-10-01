'use server';

// "Revoke" on a pre-authorised e-mail (/admin/users).
//
// It used to be an inline closure with no error handling, so a double
// submit or a stale page crashed into Next's error page (I078). Now every
// expected outcome is a flash on /admin/users:
//
//   revoked now                         → ?message=Revoked
//   already gone (not_found)            → ?message=Already revoked.
//   used — they signed up (conflict)    → ?message=  — nothing left to revoke
//   malformed id / not super-admin      → ?error=
//
// Unexpected errors still propagate to app/error.tsx.

import { redirect } from 'next/navigation';
import { requireActionContext } from '@/lib/action-context';
import { describeActionError, withFlash } from '@/lib/action-errors';
import { UserServiceError, revokePreauthorize } from '@/lib/services/users';

const USERS_PATH = '/admin/users';
/** Pre-authorisation ids are UUIDs; anything longer is not one of ours. */
const MAX_ID_LENGTH = 64;

export async function revokePreauthorizationAction(formData: FormData): Promise<void> {
  // The page sends a signed-in user without a workspace to "/", so do the same.
  const ctx = await requireActionContext('/');

  const id = String(formData.get('id') ?? '').trim();
  if (!id || id.length > MAX_ID_LENGTH) {
    redirect(withFlash(USERS_PATH, { error: 'Unknown pre-authorisation.' }));
  }

  try {
    await revokePreauthorize(ctx, id);
  } catch (err) {
    // Double submit / stale page. not_found: the row is already gone.
    // conflict: it was consumed — the person signed up — so there is
    // nothing left to revoke. Neither is a failure worth a red banner.
    const failure = describeActionError(err, [UserServiceError], {
      permission_denied: 'Only super-admins can revoke pre-authorisations.',
      not_found: 'Already revoked.',
      conflict:
        'That pre-authorisation was already used — the person has signed up, so there is nothing left to revoke.',
    });
    const settled = failure.code === 'not_found' || failure.code === 'conflict';
    redirect(
      withFlash(USERS_PATH, settled ? { message: failure.message } : { error: failure.message }),
    );
  }
  redirect(withFlash(USERS_PATH, { message: 'Revoked' }));
}
