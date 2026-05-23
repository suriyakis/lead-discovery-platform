'use server';

// P62-03: server actions for the Crawl Engine UI.

import { redirect } from 'next/navigation';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import {
  CrawlEngineError,
  createCrawlPlan,
  deleteCrawlPlan,
  runCrawlPlanNow,
  updateCrawlPlan,
} from '@/lib/services/crawl-engine';
import { updateAutopilotSettings } from '@/lib/services/autopilot';
import { isNextRedirectError } from '@/lib/server-redirect';

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

function buildInput(formData: FormData) {
  return {
    name: String(formData.get('name') ?? '').trim(),
    enabled: formData.get('enabled') === 'on',
    intervalMinutes:
      intOrNull(formData.get('intervalMinutes')) ?? 60,
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

export async function saveAutopilot(formData: FormData): Promise<void> {
  const c = await getWorkspaceContext();
  // Read each toggle. Form posts the key only when ticked; we always
  // include a paired hidden input so flipping off works too.
  const autopilotEnabled = formData.get('autopilotEnabled') === 'on';
  const enableAutoApproveProjects =
    formData.get('enableAutoApproveProjects') === 'on';
  const enableAutoEnqueueOutreach =
    formData.get('enableAutoEnqueueOutreach') === 'on';
  const rawThreshold = Number(formData.get('autoApproveThreshold') ?? 75);
  const autoApproveThreshold = Number.isFinite(rawThreshold)
    ? Math.max(0, Math.min(100, Math.floor(rawThreshold)))
    : 75;
  try {
    await updateAutopilotSettings(c, {
      autopilotEnabled,
      enableAutoApproveProjects,
      enableAutoEnqueueOutreach,
      autoApproveThreshold,
    });
    redirect(
      `/connectors/engine?message=${encodeURIComponent('Autopilot updated.')}`,
    );
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    redirect(
      `/connectors/engine?error=${encodeURIComponent(
        err instanceof Error ? err.message : 'autopilot save failed',
      )}`,
    );
  }
}

export async function reclassifyAll(formData: FormData): Promise<void> {
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
