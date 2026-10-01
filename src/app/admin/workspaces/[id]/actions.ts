'use server';

// "End impersonation" on the admin workspace page (/admin/workspaces/[id]).
//
// It used to be an inline closure that let every AdminServiceError escape,
// so a double submit (or a second tab) crashed into Next's error page on a
// session that was already over (I078). It lives at module scope now — the
// page binds the workspace id — and answers each outcome with a flash:
//
//   ended now                       → ?message=Impersonation ended
//   already ended (conflict)        → ?message=  — the operator's goal is met
//   session gone (not_found)        → ?message=  — same
//   malformed id / not super-admin  → ?error=
//
// Unexpected errors still propagate to app/error.tsx.

import { redirect } from 'next/navigation';
import { requireActionContext } from '@/lib/action-context';
import { describeActionError, withFlash } from '@/lib/action-errors';
import { AdminServiceError, endImpersonation } from '@/lib/services/admin';

const BIGINT_ID = /^\d{1,19}$/;

export async function endImpersonationAction(
  rawWorkspaceId: string,
  formData: FormData,
): Promise<void> {
  if (typeof rawWorkspaceId !== 'string' || !BIGINT_ID.test(rawWorkspaceId)) redirect('/admin');
  const back = `/admin/workspaces/${rawWorkspaceId}`;
  const ctx = await requireActionContext('/admin');

  const sessionIdRaw = String(formData.get('sessionId') ?? '').trim();
  if (!BIGINT_ID.test(sessionIdRaw)) {
    redirect(withFlash(back, { error: 'Unknown impersonation session.' }));
  }

  try {
    await endImpersonation(ctx, BigInt(sessionIdRaw));
  } catch (err) {
    const failure = describeActionError(err, [AdminServiceError], {
      permission_denied: 'Only super-admins can end impersonation sessions.',
      conflict: 'Impersonation already ended.',
      not_found: 'That impersonation session no longer exists — nothing left to end.',
    });
    const settled = failure.code === 'conflict' || failure.code === 'not_found';
    redirect(withFlash(back, settled ? { message: failure.message } : { error: failure.message }));
  }
  redirect(withFlash(back, { message: 'Impersonation ended' }));
}
