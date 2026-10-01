'use server';

// Server action for the follow-up card on /settings/outreach (deliverable
// ia:F-08, audit I114). It lives outside page.tsx so the form parsing is a
// plain, testable function (./follow-up-form.ts) and the action never
// closes over page-local helpers.

import { redirect } from 'next/navigation';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import {
  FollowUpServiceError,
  updateFollowUpConfig,
} from '@/lib/services/follow-up';
import { isNextRedirectError } from '@/lib/server-redirect';
import { parseFollowUpForm } from './follow-up-form';

export async function saveFollowUp(formData: FormData): Promise<void> {
  const ctx = await getWorkspaceContext();
  const parsed = parseFollowUpForm(formData);
  if (!parsed.ok) {
    redirect(`/settings/outreach?error=${encodeURIComponent(parsed.error)}`);
  }
  const count = parsed.value.steps.length;
  try {
    await updateFollowUpConfig(ctx, parsed.value);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    const m =
      err instanceof FollowUpServiceError
        ? err.code === 'permission_denied'
          ? 'Only workspace admins can change follow-up settings.'
          : err.message
        : 'Saving follow-up settings failed.';
    redirect(`/settings/outreach?error=${encodeURIComponent(m)}`);
  }
  redirect(
    '/settings/outreach?message=' +
      encodeURIComponent(
        `Follow-up settings saved: ${count} step${count === 1 ? '' : 's'}.`,
      ),
  );
}
