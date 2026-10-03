// PC-08 (X10, I021): owner alerting through a webhook sink (ntfy).
//
// Three things reach the owner's phone:
//   1. INCIDENTS. Open ops_events at or above OPS_ALERT_MIN_SEVERITY
//      (default 'error') — every tick / job / worker failure PC-07 records,
//      and the watchdog's 'tick.stale' (src/lib/ops/watchdog.ts). Pulled by
//      dispatchOpsAlerts(), which the watchdog runs every minute.
//   2. A DAILY DIGEST of what is still open (warning and above), grouped by
//      kind and source, at 07:00 UTC. Nothing open, nothing sent.
//   3. CONTROL CHANGES: the platform-wide outbound stop, workspace holds and
//      the workspace automation pause, pushed by alertControlChange() right
//      after the change commits.
//
// Rules for incidents:
//   - DEDUPE + RATE LIMIT PER KEY. The key is the incident fingerprint. A
//     key alerts once; repeats (occurrences) within REALERT_AFTER_MS (6 h)
//     send nothing, and that includes the incident resolving and reopening
//     (a flapping tick). Still open after 6 h → one reminder.
//   - BUDGET. At most ALERT_BUDGET_PER_WINDOW incident / digest messages
//     per rolling hour, platform-wide. Over budget, incidents wait (still
//     due) and go out once the budget frees; only critical ones still go
//     out at once, folded into one message.
//   - DIGEST WHEN MANY FIRE. More than DIGEST_THRESHOLD due at once, or more
//     than the budget has left, are folded into ONE message.
//   - NOISE. Scanner noise ("Failed to find Server Action", X10) never
//     alerts and never appears in a digest.
//   - EXACTLY ONCE. A key is claimed in ops_alert_state before sending (an
//     atomic upsert guarded by the cutoff), so two processes or two
//     overlapping passes cannot send the same alert. A failed send gives
//     the claim back, so the next pass retries it.
//
// Alerts are off (and say so once in the log) while NTFY_TOPIC is unset.
// The topic and the token never leave src/lib/ops/alert-config.ts except
// in the request to the ntfy server (src/lib/ops/ntfy.ts).

import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  notIlike,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { opsAlertDeliveries, opsAlertState, opsEvents } from '@/lib/db/schema/ops';
import { workspaces } from '@/lib/db/schema/workspaces';
import { runDetached } from '@/lib/detached';
import {
  describeAlertConfig,
  logAlertsDisabledOnce,
  readAlertConfig,
  severitiesAtOrAbove,
  severityRank,
  type AlertConfig,
  type AlertConfigSummary,
} from '@/lib/ops/alert-config';
import {
  ALERT_NOISE_PHRASES,
  ControlChangeSchema,
  containsPattern,
  controlChangeKey,
  formatControlAlert,
  formatDigestAlert,
  formatIncidentAlert,
  formatTestAlert,
  isAlertNoise,
  type AlertMessage,
  type AlertableEvent,
} from '@/lib/ops/alert-messages';
import { describeError } from '@/lib/ops/mask';
import { sendNtfy, type FetchLike, type SinkResult } from '@/lib/ops/ntfy';
import { recordPlatformAuditEvent } from './audit';
import { opsEventFingerprint, raiseOpsEvent, resolveOpsEvent } from './ops-events';
import { isPlatformContext, type PlatformContext } from './platform-context';

const HOUR_MS = 60 * 60 * 1000;

/** An alerted key stays quiet this long; still open after it → a reminder. */
export const REALERT_AFTER_MS = 6 * HOUR_MS;
/** Incident + digest messages allowed per rolling window, platform-wide. */
export const ALERT_BUDGET_PER_WINDOW = 10;
export const ALERT_BUDGET_WINDOW_MS = HOUR_MS;
/** More incidents than this due in one pass → one digest message. */
export const DIGEST_THRESHOLD = 3;
/** The daily digest goes out on the first pass at or after this hour (UTC). */
export const DAILY_DIGEST_HOUR_UTC = 7;
export const DAILY_DIGEST_KEY = 'digest:daily';
/** The daily digest lists open incidents from this severity up. */
export const DAILY_DIGEST_MIN_SEVERITY = 'warning';
/** The same control change twice within this window is one alert. */
export const CONTROL_DEDUPE_MS = 60 * 1000;
/** Due incidents read per pass; the rest wait for the next pass. */
export const MAX_DUE_PER_PASS = 200;
/** Recent deliveries shown in the console. */
export const RECENT_DELIVERIES_SHOWN = 8;

/** Raised (warning) when the sink refuses or does not answer; resolved by
 *  the next successful delivery. Never alerted itself: it cannot be. */
export const ALERT_DELIVERY_FAILED_KIND = 'alerts.delivery_failed';
export const ALERT_DELIVERY_SOURCE = 'ops.alerts';
export const ALERT_DELIVERY_FAILED_FINGERPRINT = opsEventFingerprint({
  scope: 'platform',
  kind: ALERT_DELIVERY_FAILED_KIND,
  dedupeKey: 'ntfy',
});
export const NON_ALERTABLE_KINDS: readonly string[] = [ALERT_DELIVERY_FAILED_KIND];

export const ALERT_DELIVERY_KINDS = [
  'incident',
  'digest',
  'daily_digest',
  'control',
  'test',
] as const;
export type AlertDeliveryKind = (typeof ALERT_DELIVERY_KINDS)[number];

/** Kinds that spend the hourly budget. Control changes and the test are
 *  rare human actions; the daily digest is once a day. */
const BUDGETED_KINDS: AlertDeliveryKind[] = ['incident', 'digest'];

export class OpsAlertError extends Error {
  public readonly code: 'permission_denied';
  constructor(message: string) {
    super(message);
    this.name = 'OpsAlertError';
    this.code = 'permission_denied';
  }
}

// ---- dependencies -----------------------------------------------------------

export interface OpsAlertDeps {
  now: () => Date;
  config: () => AlertConfig;
  /** undefined = the global fetch. */
  fetch: FetchLike | undefined;
  log: (message: string) => void;
}

const DEFAULT_DEPS: OpsAlertDeps = {
  now: () => new Date(),
  config: () => readAlertConfig(),
  fetch: undefined,
  log: (message) => console.warn(message),
};

let testOverrides: Partial<OpsAlertDeps> | null = null;

/** Tests: replace dependencies for every call (pass null to restore). */
export function _setOpsAlertDepsForTests(overrides: Partial<OpsAlertDeps> | null): void {
  testOverrides = overrides;
}

function resolveDeps(overrides?: Partial<OpsAlertDeps>): OpsAlertDeps {
  return { ...DEFAULT_DEPS, ...(testOverrides ?? {}), ...(overrides ?? {}) };
}

// ---- claims (ops_alert_state) -------------------------------------------------

interface Claim {
  key: string;
  eventId: bigint | null;
  /** last_alerted_at before this claim (null: the key was new). */
  prevAlertedAt: Date | null;
}

/**
 * Claim keys that are due: new, or last alerted at or before
 * `dueAtOrBefore`. Atomic per key, so a key is claimed by one caller only.
 * Returns the keys this call claimed.
 */
async function claimAlertKeys(
  claims: readonly Claim[],
  at: Date,
  dueAtOrBefore: Date,
): Promise<Set<string>> {
  if (claims.length === 0) return new Set();
  const rows = await db
    .insert(opsAlertState)
    .values(
      claims.map((c) => ({
        alertKey: c.key,
        lastAlertedAt: at,
        lastEventId: c.eventId,
        alertCount: 1,
      })),
    )
    .onConflictDoUpdate({
      target: opsAlertState.alertKey,
      set: {
        lastAlertedAt: at,
        lastEventId: sql`excluded.last_event_id`,
        alertCount: sql`${opsAlertState.alertCount} + 1`,
      },
      setWhere: lte(opsAlertState.lastAlertedAt, dueAtOrBefore),
    })
    .returning({ key: opsAlertState.alertKey });
  return new Set(rows.map((r) => r.key));
}

/** Give claims back after a failed send, so the next pass retries them.
 *  Only touches rows still carrying this claim. */
async function releaseClaims(claims: readonly Claim[], at: Date): Promise<void> {
  for (const c of claims) {
    const mine = and(eq(opsAlertState.alertKey, c.key), eq(opsAlertState.lastAlertedAt, at));
    if (c.prevAlertedAt === null) {
      await db.delete(opsAlertState).where(mine);
    } else {
      await db
        .update(opsAlertState)
        .set({
          lastAlertedAt: c.prevAlertedAt,
          alertCount: sql`greatest(${opsAlertState.alertCount} - 1, 1)`,
        })
        .where(mine);
    }
  }
}

async function loadKeyState(key: string): Promise<{ lastAlertedAt: Date } | null> {
  const [row] = await db
    .select({ lastAlertedAt: opsAlertState.lastAlertedAt })
    .from(opsAlertState)
    .where(eq(opsAlertState.alertKey, key))
    .limit(1);
  return row ?? null;
}

// ---- delivery --------------------------------------------------------------------

async function deliver(
  d: OpsAlertDeps,
  config: AlertConfig,
  kind: AlertDeliveryKind,
  message: AlertMessage,
  meta: { alertKeys: readonly string[]; eventIds: readonly bigint[] },
): Promise<SinkResult> {
  const result: SinkResult = config.ntfy
    ? await sendNtfy(config.ntfy, message, { fetch: d.fetch })
    : { ok: false, httpStatus: null, error: 'alerts are off' };
  try {
    await db.insert(opsAlertDeliveries).values({
      kind,
      sink: config.sink,
      status: result.ok ? 'sent' : 'failed',
      title: message.title,
      priority: message.priority,
      eventCount: meta.eventIds.length,
      // Fingerprints are our own hashes and keys our own labels: stored
      // as they are (maskPayload would redact the hashes as tokens).
      payload: {
        alertKeys: meta.alertKeys.slice(0, 50),
        eventIds: meta.eventIds.slice(0, 50).map(String),
      },
      httpStatus: result.httpStatus,
      error: result.error,
      createdAt: d.now(),
    });
  } catch (err) {
    d.log(`[ops] alert delivery not recorded: ${describeError(err).message}`);
  }
  await noteSinkHealth(d, result);
  return result;
}

/** A failing sink is itself an incident (warning: below every alert
 *  threshold, and never alerted), resolved by the next delivery. */
async function noteSinkHealth(d: OpsAlertDeps, result: SinkResult): Promise<void> {
  try {
    if (result.ok) {
      await resolveOpsEvent(ALERT_DELIVERY_FAILED_FINGERPRINT, { now: d.now() });
    } else {
      d.log(`[ops] owner alert not delivered: ${result.error}`);
      await raiseOpsEvent(
        {
          scope: 'platform',
          kind: ALERT_DELIVERY_FAILED_KIND,
          severity: 'warning',
          source: ALERT_DELIVERY_SOURCE,
          dedupeKey: 'ntfy',
          title: 'Owner alerts could not be delivered',
          message: result.error ?? 'unknown error',
          payload: { httpStatus: result.httpStatus },
        },
        d.now(),
      );
    }
  } catch (err) {
    d.log(`[ops] alert sink health not recorded: ${describeError(err).message}`);
  }
}

async function countBudgetedSince(since: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(opsAlertDeliveries)
    .where(
      and(
        eq(opsAlertDeliveries.status, 'sent'),
        inArray(opsAlertDeliveries.kind, BUDGETED_KINDS),
        gt(opsAlertDeliveries.createdAt, since),
      ),
    );
  return Number(row?.n ?? 0);
}

async function loadWorkspaceNames(ids: readonly (bigint | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is bigint => id !== null).map(String))].map(
    BigInt,
  );
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(inArray(workspaces.id, unique));
  return new Map(rows.map((r) => [r.id.toString(), r.name]));
}

const EVENT_COLUMNS = {
  id: opsEvents.id,
  fingerprint: opsEvents.fingerprint,
  scope: opsEvents.scope,
  workspaceId: opsEvents.workspaceId,
  kind: opsEvents.kind,
  severity: opsEvents.severity,
  source: opsEvents.source,
  title: opsEvents.title,
  message: opsEvents.message,
  occurrences: opsEvents.occurrences,
  firstSeenAt: opsEvents.firstSeenAt,
  lastSeenAt: opsEvents.lastSeenAt,
};

/** SQL twin of isAlertNoise(): neither the title nor the message contains
 *  a noise phrase. Applied before the per-pass LIMIT so a pile of noise
 *  can never crowd real incidents out of a pass (the JS check stays as
 *  the reference). */
function notNoise(): SQL {
  return and(
    ...ALERT_NOISE_PHRASES.flatMap((phrase) => [
      notIlike(opsEvents.title, containsPattern(phrase)),
      or(isNull(opsEvents.message), notIlike(opsEvents.message, containsPattern(phrase))),
    ]),
  )!;
}

/** Most severe first. Raw SQL: a CASE over the four literal severities
 *  (the builder has no ordering by a value list). */
const SEVERITY_ORDER = sql`CASE ${opsEvents.severity} WHEN 'critical' THEN 0 WHEN 'error' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END`;

const bySeverityThenAge = (a: AlertableEvent, b: AlertableEvent) =>
  severityRank(b.severity) - severityRank(a.severity) ||
  a.firstSeenAt.getTime() - b.firstSeenAt.getTime();

// ---- 1. incidents ----------------------------------------------------------------

export interface DispatchResult {
  /** disabled: alerts off · idle: nothing due · held: budget spent ·
   *  sent / failed: what the sink said. */
  status: 'disabled' | 'idle' | 'held' | 'sent' | 'failed';
  /** Incidents due this pass (noise excluded). */
  due: number;
  /** Messages delivered. */
  messages: number;
  /** Incidents covered by the delivered messages. */
  alerted: number;
  mode: 'individual' | 'digest' | null;
}

/** One dispatch pass: alert every due incident (see the rules above). */
export async function dispatchOpsAlerts(
  overrides?: Partial<OpsAlertDeps>,
): Promise<DispatchResult> {
  const d = resolveDeps(overrides);
  const config = d.config();
  const result = (r: Partial<DispatchResult> & Pick<DispatchResult, 'status'>): DispatchResult => ({
    due: 0,
    messages: 0,
    alerted: 0,
    mode: null,
    ...r,
  });
  if (!config.enabled) {
    logAlertsDisabledOnce(config, d.log);
    return result({ status: 'disabled' });
  }

  const now = d.now();
  const cutoff = new Date(now.getTime() - REALERT_AFTER_MS);
  const rows = await db
    .select({
      ...EVENT_COLUMNS,
      lastAlertedAt: opsAlertState.lastAlertedAt,
      lastAlertedEventId: opsAlertState.lastEventId,
    })
    .from(opsEvents)
    .leftJoin(opsAlertState, eq(opsAlertState.alertKey, opsEvents.fingerprint))
    .where(
      and(
        isNull(opsEvents.resolvedAt),
        inArray(opsEvents.severity, severitiesAtOrAbove(config.minSeverity)),
        notInArray(opsEvents.kind, [...NON_ALERTABLE_KINDS]),
        notNoise(),
        or(isNull(opsAlertState.alertKey), lte(opsAlertState.lastAlertedAt, cutoff)),
      ),
    )
    .orderBy(SEVERITY_ORDER, opsEvents.firstSeenAt, opsEvents.id)
    .limit(MAX_DUE_PER_PASS);
  const due = rows.filter((r) => !isAlertNoise(r)).sort(bySeverityThenAge);
  if (due.length === 0) return result({ status: 'idle' });

  const budgetLeft =
    ALERT_BUDGET_PER_WINDOW -
    (await countBudgetedSince(new Date(now.getTime() - ALERT_BUDGET_WINDOW_MS)));
  // Over budget, only critical incidents still go out (in one message);
  // the rest stay due until the window frees.
  const batch = budgetLeft > 0 ? due : due.filter((e) => e.severity === 'critical');
  if (batch.length === 0) return result({ status: 'held', due: due.length });
  const slots = Math.max(budgetLeft, 1);

  const claims = new Map<string, Claim>(
    batch.map((e) => [
      e.fingerprint,
      { key: e.fingerprint, eventId: e.id, prevAlertedAt: e.lastAlertedAt ?? null },
    ]),
  );
  const claimed = await claimAlertKeys([...claims.values()], now, cutoff);
  const mine = batch.filter((e) => claimed.has(e.fingerprint));
  // Another process claimed them between the read and the claim.
  if (mine.length === 0) return result({ status: 'idle', due: due.length });
  const claimsOf = (events: typeof mine) => events.map((e) => claims.get(e.fingerprint)!);

  const workspaceNames = await loadWorkspaceNames(mine.map((e) => e.workspaceId));
  const format = { appUrl: config.appUrl, workspaceNames };

  if (mine.length > DIGEST_THRESHOLD || mine.length > slots) {
    const sent = await deliver(
      d,
      config,
      'digest',
      formatDigestAlert(mine, { ...format, variant: 'burst' }),
      {
        alertKeys: mine.map((e) => e.fingerprint),
        eventIds: mine.map((e) => e.id),
      },
    );
    if (!sent.ok) {
      await releaseClaims(claimsOf(mine), now);
      return result({ status: 'failed', due: due.length, mode: 'digest' });
    }
    return result({
      status: 'sent',
      due: due.length,
      messages: 1,
      alerted: mine.length,
      mode: 'digest',
    });
  }

  let messages = 0;
  for (let i = 0; i < mine.length; i++) {
    const e = mine[i]!;
    // Same row alerted before and still open → a reminder. A NEW row of a
    // key alerted 6+ h ago is a fresh incident.
    const reminder = e.lastAlertedAt !== null && e.lastAlertedEventId === e.id;
    const sent = await deliver(
      d,
      config,
      'incident',
      formatIncidentAlert(e, { ...format, reminder }),
      {
        alertKeys: [e.fingerprint],
        eventIds: [e.id],
      },
    );
    if (!sent.ok) {
      // Stop at the first failure: the sink is down, the rest would fail
      // too. Their claims go back with this one's.
      await releaseClaims(claimsOf(mine.slice(i)), now);
      return result({
        status: 'failed',
        due: due.length,
        messages,
        alerted: messages,
        mode: 'individual',
      });
    }
    messages++;
  }
  return result({
    status: 'sent',
    due: due.length,
    messages,
    alerted: messages,
    mode: 'individual',
  });
}

// ---- 2. the daily digest -------------------------------------------------------

/** Today's digest slot (UTC). */
export function dailyDigestSlot(now: Date, hourUtc: number = DAILY_DIGEST_HOUR_UTC): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0),
  );
}

export interface DailyDigestResult {
  /** not_due: before today's slot, or today's digest is done ·
   *  nothing_open: done for today, nothing to report. */
  status: 'disabled' | 'not_due' | 'nothing_open' | 'sent' | 'failed';
  incidents: number;
  groups: number;
}

/** Send today's digest of open incidents, once, on the first pass at or
 *  after the slot. */
export async function sendDailyDigestIfDue(
  overrides?: Partial<OpsAlertDeps>,
): Promise<DailyDigestResult> {
  const d = resolveDeps(overrides);
  const config = d.config();
  if (!config.enabled) {
    logAlertsDisabledOnce(config, d.log);
    return { status: 'disabled', incidents: 0, groups: 0 };
  }
  const now = d.now();
  const slot = dailyDigestSlot(now);
  if (now < slot) return { status: 'not_due', incidents: 0, groups: 0 };
  const prev = await loadKeyState(DAILY_DIGEST_KEY);
  if (prev && prev.lastAlertedAt >= slot) return { status: 'not_due', incidents: 0, groups: 0 };

  const claim: Claim = {
    key: DAILY_DIGEST_KEY,
    eventId: null,
    prevAlertedAt: prev?.lastAlertedAt ?? null,
  };
  const claimed = await claimAlertKeys([claim], now, new Date(slot.getTime() - 1));
  if (!claimed.has(DAILY_DIGEST_KEY)) return { status: 'not_due', incidents: 0, groups: 0 };

  const open = (
    await db
      .select(EVENT_COLUMNS)
      .from(opsEvents)
      .where(
        and(
          isNull(opsEvents.resolvedAt),
          inArray(opsEvents.severity, severitiesAtOrAbove(DAILY_DIGEST_MIN_SEVERITY)),
          notInArray(opsEvents.kind, [...NON_ALERTABLE_KINDS]),
          notNoise(),
        ),
      )
      .orderBy(SEVERITY_ORDER, opsEvents.firstSeenAt)
      .limit(1000)
  ).filter((e) => !isAlertNoise(e));
  if (open.length === 0) return { status: 'nothing_open', incidents: 0, groups: 0 };

  const message = formatDigestAlert(open, {
    appUrl: config.appUrl,
    workspaceNames: await loadWorkspaceNames(open.map((e) => e.workspaceId)),
    variant: 'daily',
  });
  const sent = await deliver(d, config, 'daily_digest', message, {
    alertKeys: [DAILY_DIGEST_KEY],
    eventIds: open.map((e) => e.id),
  });
  const groups = new Set(open.map((e) => `${e.kind}\u001f${e.source}`)).size;
  if (!sent.ok) {
    await releaseClaims([claim], now);
    return { status: 'failed', incidents: open.length, groups };
  }
  return { status: 'sent', incidents: open.length, groups };
}

// ---- 3. control changes ------------------------------------------------------------

export type ControlAlertStatus = 'sent' | 'failed' | 'disabled' | 'duplicate' | 'invalid' | 'error';

/**
 * Tell the owner that the platform-wide outbound stop, a workspace hold or
 * a workspace's automation pause changed. Call it AFTER the change has
 * committed. Never throws. The same change twice within CONTROL_DEDUPE_MS
 * (a double submit) alerts once. Not counted against the hourly budget.
 * A failed delivery is recorded but not retried.
 */
export async function alertControlChange(
  change: unknown,
  overrides?: Partial<OpsAlertDeps>,
): Promise<{ status: ControlAlertStatus }> {
  const d = resolveDeps(overrides);
  const parsed = ControlChangeSchema.safeParse(change);
  if (!parsed.success) {
    d.log(
      `[ops] control-change alert refused: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
    return { status: 'invalid' };
  }
  const config = d.config();
  if (!config.enabled) {
    logAlertsDisabledOnce(config, d.log);
    return { status: 'disabled' };
  }
  const c = parsed.data;
  try {
    const now = d.now();
    const key = controlChangeKey(c);
    const prev = await loadKeyState(key);
    const claim: Claim = { key, eventId: null, prevAlertedAt: prev?.lastAlertedAt ?? null };
    const claimed = await claimAlertKeys([claim], now, new Date(now.getTime() - CONTROL_DEDUPE_MS));
    if (!claimed.has(key)) return { status: 'duplicate' };
    const workspaceNames = await loadWorkspaceNames(['workspaceId' in c ? c.workspaceId : null]);
    const sent = await deliver(
      d,
      config,
      'control',
      formatControlAlert(c, { appUrl: config.appUrl, workspaceNames }),
      { alertKeys: [key], eventIds: [] },
    );
    if (!sent.ok) {
      await releaseClaims([claim], now);
      return { status: 'failed' };
    }
    return { status: 'sent' };
  } catch (err) {
    d.log(`[ops] control-change alert failed: ${describeError(err).message}`);
    return { status: 'error' };
  }
}

/** Fire-and-forget form for the controls' service functions: the change
 *  is committed and must not wait for (or fail on) the alert. */
export function notifyControlChange(change: unknown): void {
  runDetached('ops.alert.control', () => alertControlChange(change));
}

// ---- console: test + status -----------------------------------------------------

/** "Send test alert" in the platform console. */
export async function sendTestAlert(
  pctx: PlatformContext,
  overrides?: Partial<OpsAlertDeps>,
): Promise<{ ok: boolean; message: string }> {
  if (!isPlatformContext(pctx)) throw new OpsAlertError('Permission denied: ops.alert.test');
  const d = resolveDeps(overrides);
  const config = d.config();
  if (!config.enabled) {
    return {
      ok: false,
      message: `Owner alerts are off: ${config.disabledReason}. Set NTFY_TOPIC (and NTFY_URL for a self-hosted server) in the server environment and restart.`,
    };
  }
  const now = d.now();
  const sent = await deliver(
    d,
    config,
    'test',
    formatTestAlert({ now, appUrl: config.appUrl, minSeverity: config.minSeverity }),
    { alertKeys: [], eventIds: [] },
  );
  await recordPlatformAuditEvent(pctx.actorUserId, {
    kind: 'ops.alert.test',
    entityType: 'ops_alert_deliveries',
    entityId: null,
    payload: {
      status: sent.ok ? 'sent' : 'failed',
      httpStatus: sent.httpStatus,
      server: config.serverDisplay,
    },
  });
  return sent.ok
    ? {
        ok: true,
        message: `Test alert sent to the ntfy topic on ${config.serverDisplay}. Check the ntfy app subscribed to it.`,
      }
    : { ok: false, message: `Test alert failed: ${sent.error}` };
}

export interface RecentAlertDelivery {
  id: string;
  kind: string;
  status: string;
  title: string;
  priority: number;
  eventCount: number;
  httpStatus: number | null;
  error: string | null;
  createdAt: Date;
}

export interface OwnerAlertStatus {
  config: AlertConfigSummary;
  rules: {
    reAlertHours: number;
    digestThreshold: number;
    budgetPerHour: number;
    dailyDigestHourUtc: number;
  };
  /** null when the delivery log could not be read. */
  history: { sentLastHour: number; recent: RecentAlertDelivery[] } | null;
}

/** What the console shows. Contains neither the topic nor the token. */
export async function getOwnerAlertStatus(
  pctx: PlatformContext,
  overrides?: Partial<OpsAlertDeps>,
): Promise<OwnerAlertStatus> {
  if (!isPlatformContext(pctx)) throw new OpsAlertError('Permission denied: ops.alert.status');
  const d = resolveDeps(overrides);
  const config = d.config();
  let history: OwnerAlertStatus['history'] = null;
  try {
    const now = d.now();
    const [sentLastHour, recent] = await Promise.all([
      countBudgetedSince(new Date(now.getTime() - ALERT_BUDGET_WINDOW_MS)),
      db
        .select({
          id: opsAlertDeliveries.id,
          kind: opsAlertDeliveries.kind,
          status: opsAlertDeliveries.status,
          title: opsAlertDeliveries.title,
          priority: opsAlertDeliveries.priority,
          eventCount: opsAlertDeliveries.eventCount,
          httpStatus: opsAlertDeliveries.httpStatus,
          error: opsAlertDeliveries.error,
          createdAt: opsAlertDeliveries.createdAt,
        })
        .from(opsAlertDeliveries)
        .orderBy(desc(opsAlertDeliveries.createdAt), desc(opsAlertDeliveries.id))
        .limit(RECENT_DELIVERIES_SHOWN),
    ]);
    history = { sentLastHour, recent: recent.map((r) => ({ ...r, id: r.id.toString() })) };
  } catch (err) {
    d.log(`[ops] alert history not readable: ${describeError(err).message}`);
  }
  return {
    config: describeAlertConfig(config),
    rules: {
      reAlertHours: REALERT_AFTER_MS / HOUR_MS,
      digestThreshold: DIGEST_THRESHOLD,
      budgetPerHour: ALERT_BUDGET_PER_WINDOW,
      dailyDigestHourUtc: DAILY_DIGEST_HOUR_UTC,
    },
    history,
  };
}
