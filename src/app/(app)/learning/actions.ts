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
import { guardAction } from '@/lib/services/action-guards';
import {
  assertCanCompactKnowledge,
  compactWorkspaceKnowledge,
} from '@/lib/services/knowledge-compaction';
import {
  assertCanSynthesizeLearning,
  synthesizeWorkspaceLearning,
} from '@/lib/services/learning-synthesis';

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

// ---- Compact now / Synthesize now (PC-38) ----------------------------------
//
// Both are AI passes over the whole workspace. They used to be inline page
// actions with no guard, so a double-click ran the pass twice. Now each is
// single-flight in the workspace and rate-limited (services/action-guards.ts);
// a refusal says why on the page. The service's own refusals (admins only,
// the wallet, a hold) are asked first, so a refused click never uses up the
// workspace's limit.

function learningFlash(flash: { message?: string; error?: string }): string {
  const params = new URLSearchParams();
  if (flash.message) params.set('message', flash.message);
  if (flash.error) params.set('error', flash.error);
  const qs = params.toString();
  return qs ? `/learning?${qs}` : '/learning';
}

export async function compactNowAction(): Promise<void> {
  const c = await getWorkspaceContext();
  try {
    await guardAction(c, 'knowledge.compact', () => compactWorkspaceKnowledge(c), {
      precheck: () => assertCanCompactKnowledge(c),
    });
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    // PC-06: a Background AI hold refuses compaction with a reason.
    const m = err instanceof Error ? err.message : 'compaction failed';
    redirect(learningFlash({ error: m }));
  }
  redirect('/learning');
}

export async function synthesizeNowAction(): Promise<void> {
  const c = await getWorkspaceContext();
  try {
    const s = await guardAction(c, 'learning.synthesize', () => synthesizeWorkspaceLearning(c), {
      precheck: () => assertCanSynthesizeLearning(c),
    });
    const msg = !s.ran
      ? s.skippedReason === 'insufficient_events'
        ? `Not enough recent activity to learn from yet (${s.eventsExamined} events in the last 14 days — need 10+).`
        : s.skippedReason === 'held'
          ? 'Skipped — Background AI is on hold for this workspace.'
          : 'Skipped — no tokens left for the AI pass.'
      : s.lessonsCreated > 0
        ? `Learned ${s.lessonsCreated} new rule${s.lessonsCreated === 1 ? '' : 's'} from ${s.eventsExamined} recent events.`
        : `Examined ${s.eventsExamined} recent events — no reliable new pattern found.`;
    redirect(learningFlash({ message: msg }));
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    const m = err instanceof Error ? err.message : 'synthesis failed';
    redirect(learningFlash({ error: m }));
  }
}
