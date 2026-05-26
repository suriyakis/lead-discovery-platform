'use server';

// Bulk actions for the Review queue. Operates on review_item ids posted
// from the page-level form. State filter is round-tripped so the user
// stays on the same tab after the action completes.

import { redirect } from 'next/navigation';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import {
  ReviewServiceError,
  bulkArchiveReviewItems,
  bulkDeleteReviewItems,
} from '@/lib/services/review';
import { isNextRedirectError } from '@/lib/server-redirect';

function parseIds(formData: FormData): bigint[] {
  const ids: bigint[] = [];
  for (const raw of formData.getAll('ids')) {
    const s = String(raw);
    if (!/^\d+$/.test(s)) continue;
    try {
      ids.push(BigInt(s));
    } catch {
      /* skip non-numeric */
    }
  }
  return ids;
}

function returnTo(formData: FormData, flash: { message?: string; error?: string }): string {
  const stateRaw = String(formData.get('state') ?? '').trim();
  const safeState = /^[a-z_]+$/.test(stateRaw) ? stateRaw : '';
  const params = new URLSearchParams();
  if (safeState && safeState !== 'new') params.set('state', safeState);
  if (flash.message) params.set('message', flash.message);
  if (flash.error) params.set('error', flash.error);
  const qs = params.toString();
  return qs ? `/review?${qs}` : '/review';
}

export async function bulkArchiveAction(formData: FormData): Promise<void> {
  const ctx = await getWorkspaceContext();
  const ids = parseIds(formData);
  if (ids.length === 0) {
    redirect(returnTo(formData, { error: 'Select at least one item.' }));
  }
  try {
    const r = await bulkArchiveReviewItems(ctx, ids);
    redirect(
      returnTo(formData, {
        message: `Archived ${r.archived} of ${r.requested} item(s).`,
      }),
    );
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    redirect(
      returnTo(formData, {
        error:
          err instanceof ReviewServiceError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'archive failed',
      }),
    );
  }
}

export async function bulkDeleteAction(formData: FormData): Promise<void> {
  const ctx = await getWorkspaceContext();
  const ids = parseIds(formData);
  if (ids.length === 0) {
    redirect(returnTo(formData, { error: 'Select at least one item.' }));
  }
  try {
    const r = await bulkDeleteReviewItems(ctx, ids);
    redirect(
      returnTo(formData, {
        message: `Deleted ${r.deleted} of ${r.requested} item(s).`,
      }),
    );
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    redirect(
      returnTo(formData, {
        error:
          err instanceof ReviewServiceError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'delete failed',
      }),
    );
  }
}
