'use server';

// P62-03: server actions for the Crawl Engine UI. PC-13 (I062): none of
// them writes autopilot settings — the autopilot switches live on
// /autopilot only (the "Pipeline after crawl" panel is read-only).

import { redirect } from 'next/navigation';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import {
  CrawlEngineError,
  createCrawlPlan,
  deleteCrawlPlan,
  runCrawlPlanNow,
  updateCrawlPlan,
} from '@/lib/services/crawl-engine';
import { isNextRedirectError } from '@/lib/server-redirect';
import { withWorkspaceGuard } from '@/lib/workspace-guard/server';

function bigintArrayFromFormData(formData: FormData, name: string): bigint[] {
  const out: bigint[] = [];
  for (const raw of formData.getAll(name)) {
    const s = String(raw);
    if (!/^\d+$/.test(s)) continue;
    try { out.push(BigInt(s)); } catch {}
  }
  return out;
}

function intOrNull(raw: FormDataEntryValue | null): number | null {
  const s = String(raw ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function intervalMinutesFromForm(formData: FormData): number {
  // The UI submits intervalHours (fractional allowed). Convert to whole
  // minutes for the storage/service layer, which speaks minutes.
  const raw = String(formData.get('intervalHours') ?? '').trim();
  if (raw === '') return 60;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return 60;
  return Math.round(hours * 60);
}

function buildInput(formData: FormData) {
  return {
    name: String(formData.get('name') ?? '').trim(),
    enabled: formData.get('enabled') === 'on',
    intervalMinutes: intervalMinutesFromForm(formData),
    quietStartHour: intOrNull(formData.get('quietStartHour')),
    quietEndHour: intOrNull(formData.get('quietEndHour')),
    timezone:
      String(formData.get('timezone') ?? '').trim() || 'Europe/Warsaw',
    recipeIds: bigintArrayFromFormData(formData, 'recipeIds'),
    productProfileIds: bigintArrayFromFormData(
      formData,
      'productProfileIds',
    ),
  };
}

export async function createPlan(formData: FormData): Promise<void> {
  const c = await getWorkspaceContext();
  try {
    const plan = await createCrawlPlan(c, buildInput(formData));
    redirect(
      `/connectors/engine?message=${encodeURIComponent(`Plan "${plan.name}" created`)}`,
    );
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    redirect(
      `/connectors/engine?error=${encodeURIComponent(
        err instanceof CrawlEngineError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'create failed',
      )}`,
    );
  }
}

export async function savePlan(formData: FormData): Promise<void> {
  const c = await getWorkspaceContext();
  const idStr = String(formData.get('id') ?? '');
  if (!/^\d+$/.test(idStr)) {
    redirect('/connectors/engine?error=invalid+id');
  }
  const id = BigInt(idStr);
  try {
    await updateCrawlPlan(c, id, buildInput(formData));
    redirect(
      `/connectors/engine?message=${encodeURIComponent('Plan saved')}`,
    );
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    redirect(
      `/connectors/engine?error=${encodeURIComponent(
        err instanceof CrawlEngineError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'save failed',
      )}`,
    );
  }
}

export async function runPlanAction(formData: FormData): Promise<void> {
  const c = await getWorkspaceContext();
  const idStr = String(formData.get('id') ?? '');
  if (!/^\d+$/.test(idStr)) {
    redirect('/connectors/engine?error=invalid+id');
  }
  const id = BigInt(idStr);
  try {
    const r = await runCrawlPlanNow(c, id);
    const parts: string[] = [];
    if (r.startedRuns.length > 0)
      parts.push(`${r.startedRuns.length} run(s) started`);
    if (r.skippedRecipes.length > 0)
      parts.push(`${r.skippedRecipes.length} recipe(s) skipped (archived/missing)`);
    if (r.failedRecipes.length > 0)
      parts.push(`${r.failedRecipes.length} recipe(s) failed`);
    redirect(
      `/connectors/engine?message=${encodeURIComponent(
        parts.length > 0 ? parts.join(', ') + '.' : 'Plan ran with no eligible recipes.',
      )}`,
    );
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    redirect(
      `/connectors/engine?error=${encodeURIComponent(
        err instanceof CrawlEngineError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'run failed',
      )}`,
    );
  }
}

// MOB-06: re-classifying every record spends AI tokens, so a stale tab
// (the browser switched workspace in another tab) is refused.
async function reclassifyAllForm(formData: FormData): Promise<void> {
  const c = await getWorkspaceContext();
  try {
    const { reclassifyWorkspace } = await import('@/lib/services/qualification');
    const r = await reclassifyWorkspace(c);
    redirect(
      `/connectors/engine?message=${encodeURIComponent(
        `Re-classified ${r.recordCount} record(s) — ${r.qualificationCount} qualifications written.`,
      )}`,
    );
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    redirect(
      `/connectors/engine?error=${encodeURIComponent(
        err instanceof Error ? err.message : 'reclassify failed',
      )}`,
    );
  }
  void formData;
}

export const reclassifyAll = withWorkspaceGuard('discovery.reclassify_all', reclassifyAllForm);

export async function deletePlanAction(formData: FormData): Promise<void> {
  const c = await getWorkspaceContext();
  const idStr = String(formData.get('id') ?? '');
  if (!/^\d+$/.test(idStr)) {
    redirect('/connectors/engine?error=invalid+id');
  }
  const id = BigInt(idStr);
  try {
    await deleteCrawlPlan(c, id);
    redirect(
      `/connectors/engine?message=${encodeURIComponent('Plan deleted')}`,
    );
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    redirect(
      `/connectors/engine?error=${encodeURIComponent(
        err instanceof CrawlEngineError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'delete failed',
      )}`,
    );
  }
}
