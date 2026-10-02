'use server';

import { redirect } from 'next/navigation';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import {
  LearningServiceError,
  bulkSetLessonsEnabled,
  learningErrorMessage,
} from '@/lib/services/learning';
import { isLessonCategory } from '@/lib/services/learning-categories';
import { isNextRedirectError } from '@/lib/server-redirect';

function parseIds(formData: FormData): bigint[] {
  const ids: bigint[] = [];
  for (const raw of formData.getAll('ids')) {
    const s = String(raw);
    if (!/^\d+$/.test(s)) continue;
    try {
      ids.push(BigInt(s));
    } catch {
      /* skip */
    }
  }
  return ids;
}

function returnTo(formData: FormData, flash: { message?: string; error?: string }): string {
  const categoryRaw = String(formData.get('category') ?? '').trim();
  const enabledRaw = String(formData.get('enabled') ?? '').trim();
  const scopeRaw = String(formData.get('scope') ?? '').trim();
  const pageRaw = String(formData.get('page') ?? '').trim();
  const params = new URLSearchParams();
  if (categoryRaw && categoryRaw !== 'all' && isLessonCategory(categoryRaw)) {
    params.set('category', categoryRaw);
  }
  if (enabledRaw === 'all') params.set('enabled', 'all');
  if (scopeRaw === 'needs_scope') params.set('scope', 'needs_scope');
  if (/^\d+$/.test(pageRaw) && pageRaw !== '1') params.set('page', pageRaw);
  if (flash.message) params.set('message', flash.message);
  if (flash.error) params.set('error', flash.error);
  const qs = params.toString();
  return qs ? `/learning?${qs}` : '/learning';
}

async function bulkSet(formData: FormData, enabled: boolean, verb: string) {
  const ctx = await getWorkspaceContext();
  const ids = parseIds(formData);
  if (ids.length === 0) {
    redirect(returnTo(formData, { error: 'Select at least one lesson.' }));
  }
  try {
    const r = await bulkSetLessonsEnabled(ctx, ids, enabled);
    const skipped = r.requested - r.updated;
    const note =
      enabled && skipped > 0
        ? ' Retired rules, rules with no product left and rules already on are skipped.'
        : '';
    redirect(
      returnTo(formData, {
        message: `${verb} ${r.updated} of ${r.requested} lesson(s).${note}`,
      }),
    );
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (!(err instanceof LearningServiceError)) {
      console.error(`[learning.bulk${verb}]`, err);
    }
    redirect(
      returnTo(formData, {
        error:
          err instanceof LearningServiceError
            ? (learningErrorMessage(err.code) ?? `${verb.toLowerCase()} failed`)
            : `${verb} failed. Try again in a moment.`,
      }),
    );
  }
}

export async function bulkDisableAction(formData: FormData): Promise<void> {
  await bulkSet(formData, false, 'Disabled');
}

export async function bulkEnableAction(formData: FormData): Promise<void> {
  await bulkSet(formData, true, 'Enabled');
}
