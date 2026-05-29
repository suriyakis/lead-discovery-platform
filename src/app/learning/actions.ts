'use server';

import { redirect } from 'next/navigation';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import {
  LESSON_CATEGORIES,
  LearningServiceError,
  bulkSetLessonsEnabled,
} from '@/lib/services/learning';
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

const CATEGORY_SET = new Set<string>(LESSON_CATEGORIES);

function returnTo(formData: FormData, flash: { message?: string; error?: string }): string {
  const categoryRaw = String(formData.get('category') ?? '').trim();
  const enabledRaw = String(formData.get('enabled') ?? '').trim();
  const params = new URLSearchParams();
  if (categoryRaw && categoryRaw !== 'all' && CATEGORY_SET.has(categoryRaw)) {
    params.set('category', categoryRaw);
  }
  if (enabledRaw === 'all') params.set('enabled', 'all');
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
    redirect(
      returnTo(formData, {
        message: `${verb} ${r.updated} of ${r.requested} lesson(s).`,
      }),
    );
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    redirect(
      returnTo(formData, {
        error:
          err instanceof LearningServiceError
            ? err.message
            : err instanceof Error
              ? err.message
              : `${verb.toLowerCase()} failed`,
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
