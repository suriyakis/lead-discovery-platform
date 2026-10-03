'use server';

// Form actions for /autopilot. They used to be inline closures in
// page.tsx; at module scope they can be guarded (MOB-06): the workspace
// defaults, a product's overrides, a product's pause / resume and Run now
// run only in the workspace the page was rendered for — after a switch in
// another tab they are refused before anything changes
// (src/lib/workspace-guard). The workspace pause itself is
// src/lib/automation-pause-actions.ts, guarded the same way.

import { redirect } from 'next/navigation';
import { requireActionContext } from '@/lib/action-context';
import { isNextRedirectError } from '@/lib/server-redirect';
import { describeActionError } from '@/lib/action-errors';
import { ActionGuardError, withRateLimit } from '@/lib/services/action-guards';
import {
  AutopilotError,
  assertCanRunAutopilot,
  clearProductAutopilotSettings,
  pauseProductAutomation,
  resumeProductAutomation,
  runOnce,
  updateAutopilotSettings,
  upsertProductAutopilotSettings,
} from '@/lib/services/autopilot';
import { PlanLimitError } from '@/lib/services/plan-limits';
import { withWorkspaceGuard } from '@/lib/workspace-guard/server';
import { describeRunNow } from './run-now';

function back(flash: { scope?: bigint; message?: string; error?: string }): never {
  const qs = new URLSearchParams();
  if (flash.scope !== undefined) qs.set('scope', flash.scope.toString());
  if (flash.message) qs.set('message', flash.message);
  if (flash.error) qs.set('error', flash.error);
  const s = qs.toString();
  redirect(s ? `/autopilot?${s}` : '/autopilot');
}

function productIdFrom(formData: FormData): bigint {
  const raw = String(formData.get('productProfileId') ?? '');
  if (!/^\d{1,19}$/.test(raw)) back({ error: 'Pick a product first.' });
  return BigInt(raw);
}

async function saveAutopilotDefaultsForm(formData: FormData): Promise<void> {
  const ctx = await requireActionContext();
  const num = (k: string) => {
    const v = String(formData.get(k) ?? '');
    return /^\d+$/.test(v) ? Number(v) : undefined;
  };
  const big = (k: string) => {
    const v = String(formData.get(k) ?? '');
    return /^\d{1,19}$/.test(v) ? BigInt(v) : null;
  };
  try {
    await updateAutopilotSettings(ctx, {
      autopilotEnabled: formData.get('autopilotEnabled') === 'on',
      enableAutoApproveProjects: formData.get('enableAutoApproveProjects') === 'on',
      autoApproveThreshold: num('autoApproveThreshold'),
      enableAutoEnqueueOutreach: formData.get('enableAutoEnqueueOutreach') === 'on',
      enableAutoCrmContactSync: formData.get('enableAutoCrmContactSync') === 'on',
      enableAutoCrmDealOnQualified: formData.get('enableAutoCrmDealOnQualified') === 'on',
      maxApprovalsPerRun: num('maxApprovalsPerRun'),
      maxEnqueuesPerRun: num('maxEnqueuesPerRun'),
      defaultMailboxId: big('defaultMailboxId'),
      defaultCrmConnectionId: big('defaultCrmConnectionId'),
    });
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    // I063: a lapsed plan's refusal says why instead of "failed"; only
    // switching something ON is refused (PC-13).
    const m =
      err instanceof AutopilotError || err instanceof PlanLimitError ? err.message : 'failed';
    back({ error: m });
  }
  back({ message: 'Workspace defaults saved' });
}
export const saveAutopilotDefaultsAction = withWorkspaceGuard(
  'autopilot.save_defaults',
  saveAutopilotDefaultsForm,
);

async function saveProductAutopilotForm(formData: FormData): Promise<void> {
  const ctx = await requireActionContext();
  const pid = productIdFrom(formData);
  // PC-13: two states per switch — "inherit" or "off" (narrow-only).
  const narrow = (k: string): false | null | undefined => {
    const v = String(formData.get(k) ?? '');
    if (v === 'inherit') return null;
    if (v === 'off') return false;
    return undefined;
  };
  const num = (k: string): number | null | undefined => {
    const v = String(formData.get(k) ?? '');
    if (v === '' || v === 'inherit') return null;
    return /^\d+$/.test(v) ? Number(v) : undefined;
  };
  const big = (k: string): bigint | null | undefined => {
    const v = String(formData.get(k) ?? '');
    if (v === '' || v === 'inherit') return null;
    return /^\d{1,19}$/.test(v) ? BigInt(v) : undefined;
  };
  try {
    await upsertProductAutopilotSettings(ctx, {
      productProfileId: pid,
      autopilotEnabled: narrow('autopilotEnabled'),
      enableAutoApproveProjects: narrow('enableAutoApproveProjects'),
      autoApproveThreshold: num('autoApproveThreshold'),
      enableAutoEnqueueOutreach: narrow('enableAutoEnqueueOutreach'),
      enableAutoCrmContactSync: narrow('enableAutoCrmContactSync'),
      enableAutoCrmDealOnQualified: narrow('enableAutoCrmDealOnQualified'),
      defaultMailboxId: big('defaultMailboxId'),
    });
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    back({ scope: pid, error: err instanceof AutopilotError ? err.message : 'failed' });
  }
  back({ scope: pid, message: 'Product overrides saved' });
}
export const saveProductAutopilotAction = withWorkspaceGuard(
  'autopilot.save_product',
  saveProductAutopilotForm,
);

async function clearProductAutopilotForm(formData: FormData): Promise<void> {
  const ctx = await requireActionContext();
  const pid = productIdFrom(formData);
  try {
    await clearProductAutopilotSettings(ctx, pid);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    back({ scope: pid, error: err instanceof AutopilotError ? err.message : 'failed' });
  }
  back({ scope: pid, message: 'Overrides cleared' });
}
export const clearProductAutopilotAction = withWorkspaceGuard(
  'autopilot.clear_product',
  clearProductAutopilotForm,
);

async function pauseProductForm(formData: FormData): Promise<void> {
  const ctx = await requireActionContext();
  const pid = productIdFrom(formData);
  let alreadyPaused: boolean;
  try {
    alreadyPaused = (await pauseProductAutomation(ctx, pid)).alreadyPaused;
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    back({ scope: pid, error: err instanceof AutopilotError ? err.message : 'failed' });
  }
  back({
    scope: pid,
    message: alreadyPaused
      ? 'This product was already paused.'
      : 'Product paused: its automation and outbound mail wait.',
  });
}
export const pauseProductAction = withWorkspaceGuard('autopilot.pause_product', pauseProductForm);

async function resumeProductForm(formData: FormData): Promise<void> {
  const ctx = await requireActionContext();
  const pid = productIdFrom(formData);
  try {
    await resumeProductAutomation(ctx, pid);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    back({ scope: pid, error: err instanceof AutopilotError ? err.message : 'failed' });
  }
  back({ scope: pid, message: 'Product resumed' });
}
export const resumeProductAction = withWorkspaceGuard(
  'autopilot.resume_product',
  resumeProductForm,
);

// PC-38 (I184): rate-limited per workspace (services/action-guards.ts).
// Single-flight it already is: runOnce takes the workspace's
// 'autopilot.run' lease (PC-12), and a second Run now while a run holds it
// is told so (run-now.ts).
async function runAutopilotNowForm(_formData?: FormData): Promise<void> {
  const ctx = await requireActionContext();
  let message: string;
  try {
    const r = await withRateLimit(
      ctx,
      'autopilot.run_now',
      () => runOnce(ctx, { purpose: 'manual' }),
      { precheck: () => assertCanRunAutopilot(ctx) },
    );
    // PC-06 / PC-35 / PC-12: why a run did nothing (held, off, already
    // running) or what it did — run-now.ts.
    message = describeRunNow(r);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    // A read-only role is refused before the limit counts it (and no
    // longer crashes into the error page).
    const failure = describeActionError(err, [ActionGuardError, AutopilotError], {
      permission_denied:
        "Your role in this workspace is read-only, so you can't run autopilot. Ask a workspace admin if you need it.",
    });
    back({ error: failure.message });
  }
  back({ message });
}
export const runAutopilotNowAction = withWorkspaceGuard('autopilot.run_now', runAutopilotNowForm);
