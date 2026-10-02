// PC-07: when should a tick have run, and is it stale? Pure functions over
// a job_heartbeats row and a clock, so every rule is testable with a fake
// "now".
//
// THE EXPECTED-SLOT RULE. A repeatable tick fires on slots:
//   - BullMQ (`repeat: { every }`, legacy repeat): slots are aligned to the
//     Unix epoch — k × interval. A weekly tick fires Thursdays 00:00 UTC
//     whatever time the process booted.
//   - memory queue (setInterval): slots count from the registration —
//     registered_at + k × interval, k ≥ 1.
// After a start at t the next start is expected at the first slot after t;
// the tick is STALE once that slot plus a tolerance has passed with no new
// start. Tolerance = 2 × interval, clamped to [1 min, 1 h]: a 30 s tick is
// stale ~90 s after its last start (≈ interval × 3), a weekly one an hour
// after the slot it missed.
//
// PENDING. A tick that has not started since its schedule was registered
// (this boot) is 'pending' until its first slot after registration plus
// the tolerance — a weekly tick right after a deploy is pending for days,
// not stale.
//
// BOOT GRACE. Within 10 minutes of a registration (a new boot_id) or of
// this process's own boot, staleness is reported but never fails
// readiness: a deploy restarts the worker and must not page anyone.

export const BOOT_GRACE_MS = 10 * 60 * 1000;
export const MIN_STALE_TOLERANCE_MS = 60 * 1000;
export const MAX_STALE_TOLERANCE_MS = 60 * 60 * 1000;
/** A start slightly before a slot boundary (clock skew between Redis and
 *  Node) still counts for that slot. */
const MAX_SLOT_SKEW_MS = 60 * 1000;

export type TickAlignment = 'epoch' | 'registration';

export type TickState =
  /** Started within its expected slot (+ tolerance). */
  | 'ok'
  /** Not started since registration; its first slot (+ tolerance) is still ahead. */
  | 'pending'
  /** Missed its expected slot by more than the tolerance. */
  | 'stale'
  /** No schedule registered (no interval or no registered_at): not judged. */
  | 'unscheduled';

export interface TickHeartbeatLike {
  name: string;
  intervalMs: number | null;
  queueProvider: string | null;
  registeredAt: Date | null;
  lastStartedAt: Date | null;
  consecutiveFailures: number;
}

export interface TickEvaluation {
  name: string;
  state: TickState;
  alignment: TickAlignment | null;
  /** The slot the next start is expected at. */
  expectedAt: Date | null;
  /** expectedAt + tolerance: stale after this. */
  dueBy: Date | null;
  /** Within BOOT_GRACE_MS of the registration or of the process boot. */
  inBootGrace: boolean;
  /** True only when stale AND outside the boot grace. */
  failsReadiness: boolean;
  /** The last run threw (consecutive_failures > 0). Not a readiness failure. */
  failing: boolean;
  consecutiveFailures: number;
}

export function alignmentFor(queueProvider: string | null | undefined): TickAlignment {
  return queueProvider === 'bullmq' ? 'epoch' : 'registration';
}

export function staleToleranceMs(intervalMs: number): number {
  return Math.min(MAX_STALE_TOLERANCE_MS, Math.max(MIN_STALE_TOLERANCE_MS, 2 * intervalMs));
}

function slotSkewMs(intervalMs: number): number {
  return Math.min(MAX_SLOT_SKEW_MS, Math.floor(intervalMs / 4));
}

/** First slot strictly after `t` (ms). Registration alignment needs the
 *  registration time as its origin. */
export function nextSlotAfter(
  t: number,
  intervalMs: number,
  alignment: TickAlignment,
  registeredAtMs: number,
): number {
  if (alignment === 'epoch') {
    return Math.floor(t / intervalMs) * intervalMs + intervalMs;
  }
  if (t < registeredAtMs) return registeredAtMs + intervalMs;
  return registeredAtMs + (Math.floor((t - registeredAtMs) / intervalMs) + 1) * intervalMs;
}

/** The first slot after a schedule registration (BullMQ computes
 *  `floor(now / every) * every + every`; setInterval fires at R + I). */
export function firstSlotAfterRegistration(
  registeredAtMs: number,
  intervalMs: number,
  alignment: TickAlignment,
): number {
  return nextSlotAfter(registeredAtMs, intervalMs, alignment, registeredAtMs);
}

/** The slot a run started at `startedAtMs` is expected to be followed by. */
export function expectedSlotAfterStart(
  startedAtMs: number,
  intervalMs: number,
  alignment: TickAlignment,
  registeredAtMs: number,
): number {
  return nextSlotAfter(startedAtMs + slotSkewMs(intervalMs), intervalMs, alignment, registeredAtMs);
}

export function evaluateTick(
  hb: TickHeartbeatLike,
  now: Date,
  options: { processBootedAt?: Date | null; bootGraceMs?: number } = {},
): TickEvaluation {
  const graceMs = options.bootGraceMs ?? BOOT_GRACE_MS;
  const nowMs = now.getTime();
  const processGrace =
    options.processBootedAt != null && nowMs - options.processBootedAt.getTime() < graceMs;
  const base = {
    name: hb.name,
    failing: hb.consecutiveFailures > 0,
    consecutiveFailures: hb.consecutiveFailures,
  };

  if (!hb.intervalMs || hb.intervalMs <= 0 || !hb.registeredAt) {
    return {
      ...base,
      state: 'unscheduled',
      alignment: null,
      expectedAt: null,
      dueBy: null,
      inBootGrace: processGrace,
      failsReadiness: false,
    };
  }

  const interval = hb.intervalMs;
  const alignment = alignmentFor(hb.queueProvider);
  const registeredMs = hb.registeredAt.getTime();
  const tolerance = staleToleranceMs(interval);
  const ranSinceRegistration =
    hb.lastStartedAt != null && hb.lastStartedAt.getTime() >= registeredMs;

  const expectedMs = ranSinceRegistration
    ? expectedSlotAfterStart(hb.lastStartedAt!.getTime(), interval, alignment, registeredMs)
    : firstSlotAfterRegistration(registeredMs, interval, alignment);
  const dueByMs = expectedMs + tolerance;
  const overdue = nowMs > dueByMs;
  const state: TickState = overdue ? 'stale' : ranSinceRegistration ? 'ok' : 'pending';
  const inBootGrace = processGrace || nowMs - registeredMs < graceMs;

  return {
    ...base,
    state,
    alignment,
    expectedAt: new Date(expectedMs),
    dueBy: new Date(dueByMs),
    inBootGrace,
    failsReadiness: state === 'stale' && !inBootGrace,
  };
}
