'use server';

// ia:F-03: server actions for /settings/outreach that live outside the
// page module (so they never close over page-local helpers).

import { redirect } from 'next/navigation';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import {
  REPLY_AUTO_ACTION_KEYS,
  ReplyAutoActionsError,
  updateReplyAutoActions,
  type UpdateReplyAutoActionsInput,
} from '@/lib/services/reply-auto-actions';
import { isNextRedirectError } from '@/lib/server-redirect';

/**
 * Save the four reply auto-action switches. The form always posts every
 * switch; an unchecked checkbox is absent from the FormData, i.e. off.
 * The service enforces admin-only and writes the audit event.
 */
export async function saveReplyAutoActions(formData: FormData): Promise<void> {
  const ctx = await getWorkspaceContext();
  const input: UpdateReplyAutoActionsInput = {};
  for (const key of REPLY_AUTO_ACTION_KEYS) {
    input[key] = formData.get(key) === 'on';
  }
  try {
    await updateReplyAutoActions(ctx, input);
    redirect('/settings/outreach?message=' + encodeURIComponent('Reply auto-actions saved.'));
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    const m =
      err instanceof ReplyAutoActionsError
        ? err.code === 'permission_denied'
          ? 'Only workspace admins can change reply auto-actions.'
          : err.message
        : 'Saving reply auto-actions failed.';
    redirect(`/settings/outreach?error=${encodeURIComponent(m)}`);
  }
}
