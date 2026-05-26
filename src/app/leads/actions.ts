'use server';

// Bulk actions for the Leads page. Each lead row's checkbox carries the
// qualification id (NOT the review_item id) so leads without a backing
// review_item can still be bulk-deleted. Archive resolves each
// qualification to its review_item and archives that; Delete hard-deletes
// the qualification (and the review_item, when no other qualification
// references the same source_record).

import { redirect } from 'next/navigation';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import {
  QualificationServiceError,
  bulkArchiveLeads,
  bulkDeleteLeads,
} from '@/lib/services/qualification';
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
  const from = String(formData.get('from') ?? '').trim();
  const to = String(formData.get('to') ?? '').trim();
  if (/^\d+$/.test(product)) params.set('product', product);
  if (mode === 'all' || mode === 'relevant') params.set('mode', mode);
  if (sort === 'score' || sort === 'recent') params.set('sort', sort);
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) params.set('from', from);
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) params.set('to', to);
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
    const r = await bulkArchiveLeads(ctx, ids);
    redirect(
      returnTo(formData, {
        message: `Archived ${r.archived} lead(s) (requested ${r.requested}).`,
      }),
    );
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    redirect(
      returnTo(formData, {
        error:
          err instanceof QualificationServiceError
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
    const r = await bulkDeleteLeads(ctx, ids);
    redirect(
      returnTo(formData, {
        message: `Deleted ${r.deleted} lead(s) (requested ${r.requested}).`,
      }),
    );
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    redirect(
      returnTo(formData, {
        error:
          err instanceof QualificationServiceError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'delete failed',
      }),
    );
  }
}
