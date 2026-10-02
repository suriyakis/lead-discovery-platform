'use server';

// ia:F-03: server actions for /settings/outreach that live outside the
// page module (so they never close over page-local helpers).

import { redirect } from 'next/navigation';
import { requireActionContext } from '@/lib/action-context';
import {
  REPLY_AUTO_ACTION_KEYS,
  ReplyAutoActionsError,
  updateReplyAutoActions,
  type UpdateReplyAutoActionsInput,
} from '@/lib/services/reply-auto-actions';
import { isNextRedirectError } from '@/lib/server-redirect';
import { withWorkspaceGuard } from '@/lib/workspace-guard/server';

/**
 * Save the four reply auto-action switches. The form always posts every
 * switch; an unchecked checkbox is absent from the FormData, i.e. off.
 * The service enforces admin-only and writes the audit event. A stale
 * session (signed out, inactive, no workspace) redirects like every other
 * Phase 0 action instead of reaching the error page; resolved outside the
 * try, since requireActionContext() redirects by throwing.
 *
 * MOB-06: behind the expected-workspace guard — the switches decide what
 * happens to inbound mail without a person, so a stale tab must not flip
 * them in the workspace another tab switched to.
 */
async function saveReplyAutoActionsForm(formData: FormData): Promise<void> {
  const ctx = await requireActionContext();
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

export const saveReplyAutoActions = withWorkspaceGuard(
  'settings.reply_auto_actions',
  saveReplyAutoActionsForm,
);
