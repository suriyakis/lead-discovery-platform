// PC-08: the ops watchdog. A timer in the app process, started by the
// Next.js startup hook (instrumentation-node.ts), that once a minute:
//
//   1. checks tick heartbeats with the expected-slot rule (PC-07). A tick
//      that fails readiness (stale, outside the boot grace) on
//      STALE_CHECKS_BEFORE_ALERT (2) CONSECUTIVE checks raises a platform
//      'tick.stale' incident; one stale observation is not enough (a slow
//      run at a slot boundary). The incident resolves when a check sees the
//      tick running again;
//   2. dispatches owner alerts for due incidents (services/ops-alerts.ts);
//   3. sends the daily digest when it is due.
//
// It is NOT a queued job on purpose: it keeps watching when Redis or the
// BullMQ worker is what broke. It is not independent of the app process,
// though: if the process dies or hangs, the watchdog goes with it. Until the
// dedicated worker (PC-36) the external uptime monitor on /api/ready is the
// independent check (docs/OPS_MONITORING.md).

import type { JobHeartbeat } from '@/lib/db/schema/ops';
import { getBootInfo } from '@/lib/jobs/boot';
import { BOOT_GRACE_MS } from '@/lib/jobs/tick-schedule';
import { formatUtc } from '@/lib/format-utc';
import {
  buildTickStatuses,
  listJobHeartbeats,
  type TickStatus,
} from '@/lib/services/job-heartbeats';
import { dispatchOpsAlerts, sendDailyDigestIfDue } from '@/lib/services/ops-alerts';
import {
  listOpenOpsEventFingerprintsByKind,
  opsEventFingerprint,
  raiseOpsEvent,
  resolveOpsEvent,
} from '@/lib/services/ops-events';
import { logAlertsDisabledOnce, readAlertConfig } from './alert-config';
import { describeError } from './mask';

export const WATCHDOG_INTERVAL_MS = 60 * 1000;
/** First check after boot: let the schedule registration finish first. */
export const WATCHDOG_FIRST_CHECK_DELAY_MS = 30 * 1000;
/** Consecutive stale observations before a tick.stale incident opens. */
export const STALE_CHECKS_BEFORE_ALERT = 2;
export const TICK_STALE_KIND = 'tick.stale';

export function tickStaleFingerprint(tickName: string): string {
  return opsEventFingerprint({ scope: 'platform', kind: TICK_STALE_KIND, dedupeKey: tickName });
}

/**
 * The "two consecutive checks" rule. Process-local: after a restart the
 * count starts again, and the boot grace (10 min) covers that window.
 */
export class StaleTickStreaks {
  private readonly streaks = new Map<string, number>();

  constructor(private readonly required: number = STALE_CHECKS_BEFORE_ALERT) {}

  /**
   * One watchdog check. `confirmed`: stale on `required` or more checks in
   * a row (raise / keep the incident). `healthy`: not stale at all (resolve
   * any incident). A stale tick inside the boot grace is neither: it does
   * not count towards the streak and does not resolve anything.
   */
  observe(statuses: readonly TickStatus[]): {
    confirmed: Array<{ status: TickStatus; checks: number }>;
    healthy: TickStatus[];
  } {
    const confirmed: Array<{ status: TickStatus; checks: number }> = [];
    const healthy: TickStatus[] = [];
    for (const s of statuses) {
      if (s.failsReadiness) {
        const checks = (this.streaks.get(s.name) ?? 0) + 1;
        this.streaks.set(s.name, checks);
        if (checks >= this.required) confirmed.push({ status: s, checks });
        continue;
      }
      this.streaks.delete(s.name);
      if (s.state !== 'stale') healthy.push(s);
    }
    return { confirmed, healthy };
  }

  streak(name: string): number {
    return this.streaks.get(name) ?? 0;
  }
}

function every(ms: number): string {
  if (ms % (24 * 3600_000) === 0) return `${ms / (24 * 3600_000)} d`;
  if (ms % 3600_000 === 0) return `${ms / 3600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${Math.round(ms / 1000)} s`;
}

export interface WatchdogDeps {
  now: () => Date;
  processBootedAt: () => Date;
  loadHeartbeats: () => Promise<JobHeartbeat[]>;
  listOpenStale: () => Promise<Set<string>>;
  raise: typeof raiseOpsEvent;
  resolve: typeof resolveOpsEvent;
  dispatch: () => Promise<unknown>;
  dailyDigest: () => Promise<unknown>;
  log: (message: string) => void;
}

const DEFAULT_DEPS: WatchdogDeps = {
  now: () => new Date(),
  processBootedAt: () => getBootInfo().startedAt,
  loadHeartbeats: listJobHeartbeats,
  listOpenStale: () => listOpenOpsEventFingerprintsByKind(TICK_STALE_KIND),
  raise: raiseOpsEvent,
  resolve: resolveOpsEvent,
  dispatch: () => dispatchOpsAlerts(),
  dailyDigest: () => sendDailyDigestIfDue(),
  log: (message) => console.error(message),
};

export interface WatchdogPassResult {
  /** Ticks with an open (raised or re-raised) tick.stale incident. */
  stale: string[];
  /** Ticks whose tick.stale incident this pass resolved. */
  recovered: string[];
  dispatch: unknown;
  dailyDigest: unknown;
  /** Steps that threw (masked); the other steps still ran. */
  errors: string[];
}

/** One watchdog check. Each step is isolated: one failing never skips the next. */
export async function runWatchdogPass(
  streaks: StaleTickStreaks,
  overrides: Partial<WatchdogDeps> = {},
): Promise<WatchdogPassResult> {
  const d: WatchdogDeps = { ...DEFAULT_DEPS, ...overrides };
  const out: WatchdogPassResult = {
    stale: [],
    recovered: [],
    dispatch: null,
    dailyDigest: null,
    errors: [],
  };
  const fail = (step: string, err: unknown) => {
    const message = `${step}: ${describeError(err).message}`;
    out.errors.push(message);
    d.log(`[ops] watchdog ${message}`);
  };

  // 1. stale ticks
  try {
    const now = d.now();
    const statuses = buildTickStatuses(await d.loadHeartbeats(), now, {
      processBootedAt: d.processBootedAt(),
      bootGraceMs: BOOT_GRACE_MS,
    });
    const { confirmed, healthy } = streaks.observe(statuses);
    for (const { status: s, checks } of confirmed) {
      await d.raise(
        {
          scope: 'platform',
          kind: TICK_STALE_KIND,
          severity: 'error',
          source: s.name,
          dedupeKey: s.name,
          title: `${s.label} stopped running`,
          message:
            `No run since ${s.lastStartedAt ? formatUtc(s.lastStartedAt) : 'its schedule was registered'}; ` +
            `one was due by ${s.dueBy ? formatUtc(s.dueBy) : 'now'} (every ${s.intervalMs ? every(s.intervalMs) : '?'}). ` +
            `Stale on ${checks} consecutive watchdog checks.`,
          payload: {
            tick: s.name,
            intervalMs: s.intervalMs,
            lastStartedAt: s.lastStartedAt,
            expectedAt: s.expectedAt,
            dueBy: s.dueBy,
            consecutiveChecks: checks,
          },
        },
        now,
      );
      out.stale.push(s.name);
    }
    if (healthy.length > 0) {
      const open = await d.listOpenStale();
      for (const s of healthy) {
        if (!open.has(tickStaleFingerprint(s.name))) continue;
        if (await d.resolve(tickStaleFingerprint(s.name), { resolution: 'auto', now })) {
          out.recovered.push(s.name);
        }
      }
    }
  } catch (err) {
    fail('stale-tick check', err);
  }

  // 2. owner alerts for due incidents (the stale ones just raised included)
  try {
    out.dispatch = await d.dispatch();
  } catch (err) {
    fail('alert dispatch', err);
  }

  // 3. daily digest
  try {
    out.dailyDigest = await d.dailyDigest();
  } catch (err) {
    fail('daily digest', err);
  }

  return out;
}

// ---- the timer -------------------------------------------------------------

export interface WatchdogHandle {
  stop(): void;
}

const holder = globalThis as unknown as { __leadPlatformOpsWatchdog?: WatchdogHandle };

/**
 * Start the watchdog in this process (idempotent: Next.js may evaluate the
 * startup hook's modules more than once). Passes never overlap: the next
 * one is scheduled when the previous one finished. Timers are unref'd, so
 * they never keep a process alive.
 */
export function startOpsWatchdog(
  options: {
    intervalMs?: number;
    firstDelayMs?: number;
    /** Test seam: what one pass does. */
    runPass?: () => Promise<unknown>;
    log?: (message: string) => void;
  } = {},
): WatchdogHandle {
  if (holder.__leadPlatformOpsWatchdog) return holder.__leadPlatformOpsWatchdog;
  const log = options.log ?? ((m: string) => console.error(m));
  const intervalMs = options.intervalMs ?? WATCHDOG_INTERVAL_MS;
  const streaks = new StaleTickStreaks();
  const runPass = options.runPass ?? (() => runWatchdogPass(streaks));

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(() => void loop(), ms);
    (timer as { unref?: () => void }).unref?.();
  };
  const loop = async () => {
    try {
      await runPass();
    } catch (err) {
      log(`[ops] watchdog pass failed: ${describeError(err).message}`);
    }
    schedule(intervalMs);
  };

  const handle: WatchdogHandle = {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (holder.__leadPlatformOpsWatchdog === handle) delete holder.__leadPlatformOpsWatchdog;
    },
  };
  holder.__leadPlatformOpsWatchdog = handle;
  logAlertsDisabledOnce(readAlertConfig(), (m) => console.info(m));
  schedule(options.firstDelayMs ?? WATCHDOG_FIRST_CHECK_DELAY_MS);
  return handle;
}
