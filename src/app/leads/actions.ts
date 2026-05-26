'use server';

// Bulk actions for the Leads page. Each lead row carries the backing
// review_item id — bulk Archive sets that review_item to 'archived'
// (listLeads filters those out so the lead disappears) and bulk Delete
// hard-deletes the review_item (also filtered out). Query-string
// filters (product/mode/sort) are round-tripped so the user stays on
// the same view after the action.

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
  const params = new URLSearchParams();
  const product = String(formData.get('product') ?? '').trim();
  const mode = String(formData.get('mode') ?? '').trim();
  const sort = String(formData.get('sort') ?? '').trim();
  if (/^\d+$/.test(product)) params.set('product', product);
  if (mode === 'all' || mode === 'relevant') params.set('mode', mode);
  if (sort === 'score' || sort === 'recent') params.set('sort', sort);
  if (flash.message) params.set('message', flash.message);
  if (flash.error) params.set('error', flash.error);
  const qs = params.toString();
  return qs ? `/leads?${qs}` : '/leads';
}

export async function bulkArchiveAction(formData: FormData): Promise<void> {
  const ctx = await getWorkspaceContext();
  const ids = parseIds(formData);
  if (ids.length === 0) {
    redirect(returnTo(formData, { error: 'Select at least one lead.' }));
  }
  try {
    const r = await bulkArchiveReviewItems(ctx, ids);
    redirect(
      returnTo(formData, {
        message: `Archived ${r.archived} of ${r.requested} lead(s).`,
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
    redirect(returnTo(formData, { error: 'Select at least one lead.' }));
  }
  try {
    const r = await bulkDeleteReviewItems(ctx, ids);
    redirect(
      returnTo(formData, {
        message: `Deleted ${r.deleted} of ${r.requested} lead(s).`,
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
