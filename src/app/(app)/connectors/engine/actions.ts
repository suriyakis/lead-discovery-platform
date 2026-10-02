'use server';

// P62-03: server actions for the Crawl Engine UI. PC-13 (I062): none of
// them writes autopilot settings — the autopilot switches live on
// /autopilot only (the "Pipeline after crawl" panel is read-only).
// PC-38: a plan's Run now is single-flight per plan and rate-limited per
// workspace; Re-classify all is a background run.

import { redirect } from 'next/navigation';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import {
  CrawlEngineError,
  assertCanRunCrawlPlanNow,
  createCrawlPlan,
  deleteCrawlPlan,
  describeRecipeSkips,
  runCrawlPlanNow,
  updateCrawlPlan,
} from '@/lib/services/crawl-engine';
import { isNextRedirectError } from '@/lib/server-redirect';
import { requireActionContext } from '@/lib/action-context';
import { describeActionError, withFlash } from '@/lib/action-errors';
import { ActionGuardError, guardAction } from '@/lib/services/action-guards';
import { AutomationGateError } from '@/lib/services/automation-gate';
import {
  QualificationRunError,
  describeRunProgress,
  requestReclassification,
} from '@/lib/services/qualification-runs';
import { TokenError } from '@/lib/services/token-ledger';
import { withWorkspaceGuard } from '@/lib/workspace-guard/server';

const ENGINE_PATH = '/connectors/engine';

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
    // PC-38: one Run now per plan at a time, within the workspace's limit
    // (a viewer's click or one under a Discovery hold counts nothing).
    const r = await guardAction(c, 'crawl_plan.run_now', () => runCrawlPlanNow(c, id), {
      resource: id,
      precheck: () => assertCanRunCrawlPlanNow(c),
    });
    const parts: string[] = [];
    if (r.startedRuns.length > 0)
      parts.push(`${r.startedRuns.length} run(s) started`);
    // PC-12: why each was skipped (a run still in progress, switched off, deleted).
    if (r.recipeSkips.length > 0) parts.push(describeRecipeSkips(r.recipeSkips));
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
        err instanceof CrawlEngineError || err instanceof ActionGuardError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'run failed',
      )}`,
    );
  }
}

/**
 * PC-38 (I028): "Re-classify all" starts a background run and returns at
 * once (services/qualification-runs.ts). Admins only; an empty wallet, a
 * Background AI hold, a run already in progress and the action's rate
 * limit are refused with a readable flash before anything runs.
 *
 * MOB-06: re-classifying every record spends AI tokens, so a stale tab
 * (the browser switched workspace in another tab) is refused.
 */
async function reclassifyAllForm(formData: FormData): Promise<void> {
  void formData;
  const c = await requireActionContext('/connectors');
  let message: string;
  try {
    const run = await requestReclassification(c);
    message =
      run.processedRecords > 0
        ? `Re-classification resumed at ${describeRunProgress(run)}: its worker stopped before it finished, so the records already done are not classified again. It runs in the background; progress shows below.`
        : `Re-classification started: ${run.totalRecords.toLocaleString('en-US')} record(s) against ${run.productCount} active product(s). It runs in the background; progress shows below.`;
  } catch (err) {
    const failure = describeActionError(
      err,
      [QualificationRunError, TokenError, AutomationGateError, ActionGuardError],
      {
        permission_denied:
          'Only workspace admins can re-classify every record. Ask an admin if it needs doing.',
        queue_unavailable:
          'The background queue is unavailable right now, so nothing was started. Try again in a few minutes.',
      },
    );
    redirect(withFlash(ENGINE_PATH, { error: failure.message }));
  }
  redirect(withFlash(ENGINE_PATH, { message }));
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
