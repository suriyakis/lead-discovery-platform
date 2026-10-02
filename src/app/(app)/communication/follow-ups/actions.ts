'use server';

// Form actions for /communication/follow-ups. They used to be inline
// closures in page.tsx; at module scope (the page binds the status tab to
// return to) they can be guarded (MOB-06): Approve sends, Reject skips one
// follow-up and Cancel skips a thread's pending ones, so each runs only in
// the workspace the page was rendered for — after a switch in another tab
// they are refused before anything changes (src/lib/workspace-guard).

import { redirect } from 'next/navigation';
import { requireActionContext } from '@/lib/action-context';
import { isNextRedirectError } from '@/lib/server-redirect';
import {
  FollowUpServiceError,
  approveFollowUp,
  cancelFollowUps,
  rejectFollowUp,
} from '@/lib/services/follow-up';
import { followUpStatus } from '@/lib/db/schema/follow-ups';
import { withWorkspaceGuard } from '@/lib/workspace-guard/server';

const BASE = '/communication/follow-ups';

/** The status tab to come back to ('pending' when unknown). */
function tabOf(raw: unknown): string {
  return raw === 'all' || (followUpStatus as readonly unknown[]).includes(raw)
    ? String(raw)
    : 'pending';
}

function back(tab: string, flash: { message?: string; error?: string }): never {
  const qs = new URLSearchParams({ status: tab });
  if (flash.message) qs.set('message', flash.message);
  if (flash.error) qs.set('error', flash.error);
  redirect(`${BASE}?${qs.toString()}`);
}

function failure(err: unknown, fallback: string): string {
  if (isNextRedirectError(err)) throw err;
  return err instanceof FollowUpServiceError
    ? err.message
    : err instanceof Error
      ? err.message
      : fallback;
}

function parseId(raw: FormDataEntryValue | null): bigint | null {
  const s = String(raw ?? '');
  return /^\d{1,19}$/.test(s) ? BigInt(s) : null;
}

/** "Cancel": skip every pending follow-up on a thread. */
async function cancelThreadFollowUpsForm(statusTab: string, formData: FormData): Promise<void> {
  const tab = tabOf(statusTab);
  const ctx = await requireActionContext();
  const threadId = parseId(formData.get('threadId'));
  if (threadId === null) back(tab, { error: 'invalid_thread_id' });
  let n: number;
  try {
    n = await cancelFollowUps(ctx, threadId, 'manual_cancel');
  } catch (err) {
    back(tab, { error: failure(err, 'cancel failed') });
  }
  back(tab, { message: `Cancelled ${n} pending follow-up${n === 1 ? '' : 's'}.` });
}
export const cancelThreadFollowUpsAction = withWorkspaceGuard(
  'follow_up.skip',
  cancelThreadFollowUpsForm,
);

/** Approve (and send) an awaiting-approval follow-up, with the operator's edits. */
async function approveFollowUpForm(statusTab: string, formData: FormData): Promise<void> {
  const tab = tabOf(statusTab);
  const ctx = await requireActionContext();
  const id = parseId(formData.get('id'));
  if (id === null) back(tab, { error: 'invalid_id' });
  const field = (k: string) => String(formData.get(k) ?? '').trim() || undefined;
  let message: string;
  try {
    const updated = await approveFollowUp(ctx, id, {
      subject: field('subject'),
      body: field('body'),
      translatedSubject: field('translatedSubject'),
      translatedBody: field('translatedBody'),
      targetLanguage: field('targetLanguage'),
      // PC-05: "send anyway" ticked while automation is paused.
      confirmPaused: formData.get('confirmPaused') === 'on',
    });
    message = `Approved step ${updated.stepNumber}/${updated.totalSteps} — sent.`;
  } catch (err) {
    back(tab, { error: failure(err, 'approve failed') });
  }
  back(tab, { message });
}
export const approveFollowUpAction = withWorkspaceGuard('follow_up.approve', approveFollowUpForm);

/** Reject: mark one awaiting-approval follow-up as skipped (never sent). */
async function rejectFollowUpForm(statusTab: string, formData: FormData): Promise<void> {
  const tab = tabOf(statusTab);
  const ctx = await requireActionContext();
  const id = parseId(formData.get('id'));
  if (id === null) back(tab, { error: 'invalid_id' });
  try {
    await rejectFollowUp(ctx, id);
  } catch (err) {
    back(tab, { error: failure(err, 'reject failed') });
  }
  back(tab, { message: 'Follow-up rejected.' });
}
export const rejectFollowUpAction = withWorkspaceGuard('follow_up.reject', rejectFollowUpForm);
