'use server';

// "Run now" on /autopilot. PC-38 (I184): rate-limited per workspace
// (services/action-guards.ts). Single-flight it already is: runOnce takes
// the workspace's 'autopilot.run' lease (PC-12), and a second Run now while
// a run holds it is told so (run-now.ts).

import { redirect } from 'next/navigation';
import { requireActionContext } from '@/lib/action-context';
import { describeActionError, withFlash } from '@/lib/action-errors';
import { ActionGuardError, withRateLimit } from '@/lib/services/action-guards';
import { AutopilotError, assertCanRunAutopilot, runOnce } from '@/lib/services/autopilot';
import { describeRunNow } from './run-now';

export async function runAutopilotNowAction(): Promise<void> {
  const c = await requireActionContext();
  let message: string;
  try {
    const r = await withRateLimit(c, 'autopilot.run_now', () => runOnce(c, { purpose: 'manual' }), {
      precheck: () => assertCanRunAutopilot(c),
    });
    // PC-06 / PC-35 / PC-12: why a run did nothing (held, off, already
    // running) or what it did — run-now.ts.
    message = describeRunNow(r);
  } catch (err) {
    // A read-only role is refused before the limit counts it (and no
    // longer crashes into the error page).
    const failure = describeActionError(err, [ActionGuardError, AutopilotError], {
      permission_denied:
        "Your role in this workspace is read-only, so you can't run autopilot. Ask a workspace admin if you need it.",
    });
    redirect(withFlash('/autopilot', { error: failure.message }));
  }
  redirect(withFlash('/autopilot', { message }));
}
