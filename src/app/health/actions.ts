'use server';

// "Run check now" on /health. PC-38 (I184): the check reads recent
// conversations with the AI; it is single-flight in the workspace and
// rate-limited (services/action-guards.ts), so a double-click runs it once;
// a member's or viewer's click is refused before it counts.

import { redirect } from 'next/navigation';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import { guardAction } from '@/lib/services/action-guards';
import {
  HealthCheckError,
  assertCanRunHealthCheckNow,
  runHealthCheckNow,
} from '@/lib/services/health-check';
import { isNextRedirectError } from '@/lib/server-redirect';

export async function runHealthCheckNowAction(): Promise<void> {
  const c = await getWorkspaceContext();
  try {
    await guardAction(c, 'health.check_now', () => runHealthCheckNow(c), {
      precheck: () => assertCanRunHealthCheckNow(c),
    });
    redirect('/health?msg=Health+check+completed');
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    const m =
      err instanceof HealthCheckError ? err.message : err instanceof Error ? err.message : 'failed';
    redirect(`/health?err=${encodeURIComponent(m)}`);
  }
}
