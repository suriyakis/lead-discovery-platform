// The flash after "Run now" on /autopilot. A plain module (no 'use
// server'), so the page's inline action and the tests can import it.

import type { AutopilotRunResult } from '@/lib/services/autopilot';
import { describeLeaseHolder } from '@/lib/services/work-leases';

export function describeRunNow(r: AutopilotRunResult): string {
  // PC-12 (I064): another run holds the workspace's autopilot lease (the
  // 5-minute tick, the hook after a crawl, someone else's Run now).
  if (r.leaseHeld) {
    return `Autopilot is already running in this workspace ${describeLeaseHolder(r.leaseHeld)}. This run was not started; the running one picks up the same work.`;
  }
  // PC-06: a held run stops at the guard step — say why. PC-35: the guard
  // is logged only when its state changes, so a run it stopped may add
  // no activity row; the message says why instead.
  const first = r.steps[0];
  const guard = first?.step === 'guard' && first.outcome === 'skipped' ? first : null;
  return guard?.detail?.startsWith('held: ')
    ? `Nothing ran. ${guard.detail.slice('held: '.length)}`
    : guard
      ? `Autopilot did not run: ${guard.detail ?? 'guard'}`
      : `runOnce — ${r.steps.length} steps`;
}
