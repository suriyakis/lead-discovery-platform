// Mailbox sending-policy gate (Phase 43).
//
// Decides whether an outbound message is allowed to send right now, and
// when the next allowed slot opens if not. Consulted by the outreach
// queue dispatcher (drainQueue) and used to compute scheduled_send_at
// at enqueue time.
//
// Split into:
//   - Pure functions over a `MailboxSendingLimits` row + a `now` Date.
//     No DB, fully testable.
//   - A DB-backed `canSendNow(ctx, mailboxId, recipientDomain?)` that
//     loads the limits row + counters and folds in the per-domain count
//     query (which inherently needs DB).
//
// Time handling: business-hour window is interpreted in the mailbox's
// configured IANA timezone. We extract local components via
// Intl.DateTimeFormat so DST is automatic.

import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  mailMessages,
  mailboxSendingLimits,
  type MailboxSendingLimits,
} from '@/lib/db/schema/mailing';
import {
  isNonWorkingDay,
  type HolidayCountry,
} from '@/lib/i18n/holidays';

export interface SendDecision {
  allowed: boolean;
  /** Human-readable reason for a denial. */
  reason?: string;
  /** UTC datetime when the next sending slot is expected to open.
   *  Always set when `allowed=false`. */
  retryAfter?: Date;
}

// ─── Time helpers ────────────────────────────────────────────────────

interface LocalParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number; // 0..23
  minute: number; // 0..59
  weekdayIso: number; // 1=Mon..7=Sun
}

function localParts(date: Date, timezone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const weekdayMap: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24, // en-GB returns '24' at midnight in some locales
    minute: Number(parts.minute),
    weekdayIso: weekdayMap[parts.weekday ?? 'Mon'] ?? 1,
  };
}

/** Build a UTC Date that, when rendered in the given timezone, lands
 *  at year/month/day/hour:00:00 local. Walks an offset search via
 *  Intl so DST transitions are handled correctly. */
function utcForLocalWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  timezone: string,
): Date {
  // Start with the naive UTC interpretation and iterate up to twice to
  // converge against the timezone's offset for that wall-clock moment.
  let candidate = new Date(Date.UTC(year, month - 1, day, hour, 0, 0));
  for (let i = 0; i < 3; i++) {
    const lp = localParts(candidate, timezone);
    const drift =
      (lp.year - year) * 525600 +
      (lp.month - month) * 43800 +
      (lp.day - day) * 1440 +
      (lp.hour - hour) * 60 +
      lp.minute;
    if (drift === 0) return candidate;
    candidate = new Date(candidate.getTime() - drift * 60_000);
  }
  return candidate;
}

/** Convert a calendar date in the given timezone to a JS Date with the
 *  local civil components (used for holiday lookup since `isHoliday`
 *  consumes a Date in local civil time). */
function civilDate(parts: Pick<LocalParts, 'year' | 'month' | 'day'>): Date {
  return new Date(parts.year, parts.month - 1, parts.day);
}

// ─── Pure evaluator ──────────────────────────────────────────────────

interface EvaluatableLimits {
  maxPerDay: number;
  maxPerHour: number;
  minDelaySeconds: number;
  maxDelaySeconds: number;
  businessHoursOnly: boolean;
  businessStartHour: number;
  businessEndHour: number;
  businessDays: number[]; // ISO 1..7
  timezone: string;
  respectWeekends: boolean;
  respectHolidays: boolean;
  holidayCountry: string;
  sentToday: number;
  sentThisHour: number;
  lastResetDate: string | null;
  lastResetHour: number | null;
}

/**
 * Decide whether the configured business window allows a send at `now`.
 * Returns `allowed=true` immediately if `businessHoursOnly` is off.
 * Otherwise checks: today is a business day per businessDays, today
 * isn't a holiday/weekend per respectWeekends/respectHolidays, and the
 * current hour is within [start, end). On failure, computes the next
 * UTC instant when the window will reopen.
 */
export function evaluateBusinessWindow(
  limits: EvaluatableLimits,
  now: Date = new Date(),
): SendDecision {
  if (!limits.businessHoursOnly) return { allowed: true };

  const lp = localParts(now, limits.timezone);

  const country = limits.holidayCountry as HolidayCountry;
  const off = isNonWorkingDay(civilDate(lp), {
    country,
    respectWeekends: limits.respectWeekends,
    respectHolidays: limits.respectHolidays,
  });
  if (off.off) {
    return {
      allowed: false,
      reason: `Non-working day: ${off.reason}`,
      retryAfter: nextWindowOpen(limits, now),
    };
  }

  if (!limits.businessDays.includes(lp.weekdayIso)) {
    return {
      allowed: false,
      reason: 'Outside business days',
      retryAfter: nextWindowOpen(limits, now),
    };
  }

  if (lp.hour < limits.businessStartHour || lp.hour >= limits.businessEndHour) {
    const reason =
      lp.hour < limits.businessStartHour
        ? `Before business hours (${limits.businessStartHour}:00–${limits.businessEndHour}:00 ${limits.timezone})`
        : `After business hours (${limits.businessStartHour}:00–${limits.businessEndHour}:00 ${limits.timezone})`;
    return { allowed: false, reason, retryAfter: nextWindowOpen(limits, now) };
  }

  return { allowed: true };
}

/** Walk forward day-by-day in local time until we find a date that's
 *  in businessDays AND not a non-working day. Returns the UTC instant
 *  at startHour on that local day. Bounded at 30 days. */
function nextWindowOpen(limits: EvaluatableLimits, after: Date): Date {
  const country = limits.holidayCountry as HolidayCountry;
  let lp = localParts(after, limits.timezone);

  // If we're earlier than start hour today and today is a business day +
  // not a non-working day, today itself opens at startHour. Otherwise
  // we move forward.
  const todayIsBiz =
    limits.businessDays.includes(lp.weekdayIso) &&
    !isNonWorkingDay(civilDate(lp), {
      country,
      respectWeekends: limits.respectWeekends,
      respectHolidays: limits.respectHolidays,
    }).off;

  if (todayIsBiz && lp.hour < limits.businessStartHour) {
    return utcForLocalWallClock(
      lp.year,
      lp.month,
      lp.day,
      limits.businessStartHour,
      limits.timezone,
    );
  }

  // Walk forward.
  for (let i = 0; i < 30; i++) {
    // Advance by ~24 hours and re-extract local parts.
    const advanced = new Date(after.getTime() + (i + 1) * 24 * 60 * 60 * 1000);
    lp = localParts(advanced, limits.timezone);
    const off = isNonWorkingDay(civilDate(lp), {
      country,
      respectWeekends: limits.respectWeekends,
      respectHolidays: limits.respectHolidays,
    });
    if (off.off) continue;
    if (!limits.businessDays.includes(lp.weekdayIso)) continue;
    return utcForLocalWallClock(
      lp.year,
      lp.month,
      lp.day,
      limits.businessStartHour,
      limits.timezone,
    );
  }
  // Fallback: 24h from now. Should never hit unless 30 consecutive
  // days are non-working, which is implausible.
  return new Date(after.getTime() + 24 * 60 * 60 * 1000);
}

/** Evaluate the daily / hourly counters at `now`. Returns allowed + a
 *  retryAfter pointing at the next hour boundary (hourly cap) or the
 *  next day's business window opening (daily cap). */
export function evaluateCounters(
  limits: EvaluatableLimits,
  now: Date = new Date(),
): SendDecision {
  const lp = localParts(now, limits.timezone);
  const today = `${lp.year}-${String(lp.month).padStart(2, '0')}-${String(lp.day).padStart(2, '0')}`;

  const sentToday = limits.lastResetDate === today ? limits.sentToday : 0;
  const sentThisHour =
    limits.lastResetDate === today && limits.lastResetHour === lp.hour
      ? limits.sentThisHour
      : 0;

  if (sentToday >= limits.maxPerDay) {
    return {
      allowed: false,
      reason: `Daily limit reached (${limits.maxPerDay})`,
      retryAfter: nextWindowOpen(limits, now),
    };
  }
  if (sentThisHour >= limits.maxPerHour) {
    // Retry at the top of the next hour (UTC equivalent).
    const utc = utcForLocalWallClock(
      lp.year,
      lp.month,
      lp.day,
      lp.hour + 1,
      limits.timezone,
    );
    return {
      allowed: false,
      reason: `Hourly limit reached (${limits.maxPerHour})`,
      retryAfter: utc,
    };
  }
  return { allowed: true };
}

/** Pick a delay between minDelaySeconds and maxDelaySeconds (uniform). */
export function pickRandomDelaySeconds(
  limits: Pick<EvaluatableLimits, 'minDelaySeconds' | 'maxDelaySeconds'>,
): number {
  const min = Math.max(0, Math.floor(limits.minDelaySeconds));
  const max = Math.max(min, Math.floor(limits.maxDelaySeconds));
  if (max === min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

// ─── DB-backed orchestrator ──────────────────────────────────────────

export class SendingPolicyError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'SendingPolicyError';
    this.code = code;
  }
}

/** Read the per-mailbox limits row, lazily creating it with defaults
 *  if it doesn't exist yet. */
export async function getOrCreateMailboxSendingLimits(
  workspaceId: bigint,
  mailboxId: bigint,
): Promise<MailboxSendingLimits> {
  const [existing] = await db
    .select()
    .from(mailboxSendingLimits)
    .where(eq(mailboxSendingLimits.mailboxId, mailboxId))
    .limit(1);
  if (existing) {
    if (existing.workspaceId !== workspaceId) {
      throw new SendingPolicyError('mailbox does not belong to workspace', 'forbidden');
    }
    return existing;
  }
  const [created] = await db
    .insert(mailboxSendingLimits)
    .values({ mailboxId, workspaceId })
    .returning();
  if (!created) {
    throw new SendingPolicyError('failed to create sending_limits row', 'internal');
  }
  return created;
}

/** Full check: time window + counters + per-domain count. Pass the
 *  recipient domain (lowercased; from the FIRST recipient is fine —
 *  most outreach is single-recipient). Without it, per-domain check
 *  is skipped. */
export async function canSendNow(args: {
  workspaceId: bigint;
  mailboxId: bigint;
  recipientDomain?: string | null;
  now?: Date;
}): Promise<SendDecision> {
  const limits = await getOrCreateMailboxSendingLimits(
    args.workspaceId,
    args.mailboxId,
  );
  const now = args.now ?? new Date();

  const window = evaluateBusinessWindow(limits, now);
  if (!window.allowed) return window;

  const counters = evaluateCounters(limits, now);
  if (!counters.allowed) return counters;

  if (args.recipientDomain) {
    const domain = args.recipientDomain.toLowerCase();
    // How many sends to this domain (any address in to_addresses) in the
    // trailing 24h have already gone out from this mailbox? Cap is
    // maxPerDomain.
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [row] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.workspaceId, args.workspaceId),
          eq(mailMessages.mailboxId, args.mailboxId),
          eq(mailMessages.direction, 'outbound'),
          gte(mailMessages.createdAt, since),
          sql`EXISTS (
            SELECT 1 FROM unnest(${mailMessages.toAddresses}) AS addr
            WHERE lower(split_part(addr, '@', 2)) = ${domain}
          )`,
        ),
      );
    const sentToDomain = Number(row?.c ?? 0);
    if (sentToDomain >= limits.maxPerDomain) {
      return {
        allowed: false,
        reason: `Per-domain cap reached (${limits.maxPerDomain} in 24h to ${domain})`,
        retryAfter: new Date(now.getTime() + 60 * 60 * 1000), // try again in an hour
      };
    }
  }

  return { allowed: true };
}

/**
 * Atomically increment the sentToday + sentThisHour counters after a
 * successful send. Resets the buckets when the day or hour rolls over.
 * Best-effort — call from the queue dispatcher's success path. Failure
 * to record doesn't roll back the send; caller should swallow + log.
 */
export async function recordSendCounter(args: {
  workspaceId: bigint;
  mailboxId: bigint;
  now?: Date;
}): Promise<void> {
  const limits = await getOrCreateMailboxSendingLimits(
    args.workspaceId,
    args.mailboxId,
  );
  const now = args.now ?? new Date();
  const lp = localParts(now, limits.timezone);
  const today = `${lp.year}-${String(lp.month).padStart(2, '0')}-${String(lp.day).padStart(2, '0')}`;

  let updates: Partial<MailboxSendingLimits>;
  if (limits.lastResetDate !== today) {
    updates = {
      sentToday: 1,
      sentThisHour: 1,
      lastResetDate: today,
      lastResetHour: lp.hour,
    };
  } else if (limits.lastResetHour !== lp.hour) {
    updates = {
      sentToday: limits.sentToday + 1,
      sentThisHour: 1,
      lastResetHour: lp.hour,
    };
  } else {
    updates = {
      sentToday: limits.sentToday + 1,
      sentThisHour: limits.sentThisHour + 1,
    };
  }
  await db
    .update(mailboxSendingLimits)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(mailboxSendingLimits.mailboxId, args.mailboxId));
}
