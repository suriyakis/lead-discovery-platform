'use server';

// AP-06 (I069): the /health server actions, outside the page module so
// they never close over page-local helpers. The services enforce
// admin-only and write the audit row; a stale session redirects like every
// other action (requireActionContext, outside the try: it redirects by
// throwing). Both are behind the expected-workspace guard (MOB-06): a run
// spends AI tokens and the settings switch the scheduled spend on, so a
// stale tab must not do either in the workspace another tab switched to.

import { redirect } from 'next/navigation';
import { requireActionContext } from '@/lib/action-context';
import {
  HealthCheckError,
  runHealthCheckNow,
  updateHealthCheckSettings,
} from '@/lib/services/health-check';
import { isNextRedirectError } from '@/lib/server-redirect';
import { withWorkspaceGuard } from '@/lib/workspace-guard/server';

const HEALTH_PATH = '/health';

function healthErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof HealthCheckError) {
    return err.code === 'permission_denied'
      ? 'Only workspace owners and admins can change the health check.'
      : err.message;
  }
  return fallback;
}

async function runHealthCheckNowForm(_formData?: FormData): Promise<void> {
  const ctx = await requireActionContext();
  try {
    await runHealthCheckNow(ctx);
    redirect(`${HEALTH_PATH}?msg=${encodeURIComponent('Health check completed.')}`);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    redirect(
      `${HEALTH_PATH}?err=${encodeURIComponent(healthErrorMessage(err, 'The health check failed.'))}`,
    );
  }
}

export const runHealthCheckNowAction = withWorkspaceGuard('health.run_check', runHealthCheckNowForm);

/** The form posts `enabled` (a Switch: "on" or absent) and `intervalDays`. */
async function saveHealthCheckSettingsForm(formData: FormData): Promise<void> {
  const ctx = await requireActionContext();
  const enabled = formData.get('enabled') === 'on';
  const intervalDays = Number(formData.get('intervalDays'));
  try {
    await updateHealthCheckSettings(ctx, { enabled, intervalDays });
    redirect(
      `${HEALTH_PATH}?msg=${encodeURIComponent(
        enabled
          ? `Scheduled check on: every ${intervalDays} day${intervalDays === 1 ? '' : 's'}.`
          : 'Scheduled check off: no AI review runs (and no tokens are spent) until you switch it on.',
      )}`,
    );
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    redirect(
      `${HEALTH_PATH}?err=${encodeURIComponent(healthErrorMessage(err, 'Saving the health check failed.'))}`,
    );
  }
}

export const saveHealthCheckSettingsAction = withWorkspaceGuard(
  'health.save_settings',
  saveHealthCheckSettingsForm,
);
