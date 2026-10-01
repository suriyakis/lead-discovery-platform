// Wall-clock <-> instant conversion for datetime-local form inputs.
//
// A datetime-local input submits a bare wall-clock value
// ("2026-03-10T11:00") with no offset. `new Date(value)` on the server
// reads it in the server's own time zone (UTC in the container), so a
// viewer in Warsaw who asks for "since 11:00" silently gets 11:00 UTC.
// Pages that take such inputs also submit the viewer's IANA time zone
// (see ViewerTimeZoneField) and convert here, so the instant handed to
// the service layer is the one the viewer meant. DST is handled through
// Intl, with no offset tables of our own.

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;
const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

interface WallClock {
  year: number;
  month: number; // 1..12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClockAt(instantMs: number, timeZone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: (parts.hour ?? 0) % 24,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

function wallClockAsUtcMs(w: WallClock): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

/** The zone's UTC offset (ms, east positive) at a whole-second instant. */
function offsetAt(instantMs: number, timeZone: string): number {
  return wallClockAsUtcMs(wallClockAt(instantMs, timeZone)) - instantMs;
}

/**
 * The canonical IANA name for a submitted time zone, or null when the
 * value is missing or not a zone this runtime knows ("UTC",
 * "Europe/Warsaw" and "America/New_York" pass; "Mars/Base" does not).
 */
export function resolveTimeZone(raw: unknown): string | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!ZONE_NAME.test(s)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: s }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * A datetime-local value ("2026-03-10T11:00", seconds optional) read as
 * wall-clock time in `timeZone`, returned as the matching instant.
 * Null when the value is malformed or names a date that does not exist
 * (31 June).
 *
 * Clock changes follow the usual convention (Temporal's "compatible"):
 * a time skipped by a spring-forward gap moves forward by the gap
 * (02:30 on the Warsaw spring-forward night is 03:30 CEST), and a time
 * repeated by a fall-back overlap resolves to its first occurrence.
 */
export function parseDateTimeLocal(raw: unknown, timeZone: string): Date | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const m = WALL_CLOCK.exec(s);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m
    .slice(1)
    .map((p) => Number(p ?? 0)) as [number, number, number, number, number, number];
  const wall: WallClock = { year, month, day, hour, minute, second };
  const wallMs = wallClockAsUtcMs(wall);
  // Date.UTC rolls 31 June over to 1 July; reject instead of guessing.
  const check = new Date(wallMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return null;
  }

  // The offsets in force a day either side bracket any single clock
  // change. An offset is right when the instant it gives really shows
  // this wall-clock time in the zone.
  const before = offsetAt(wallMs - DAY_MS, timeZone);
  const after = offsetAt(wallMs + DAY_MS, timeZone);
  const matches = [before, after]
    .map((offset) => wallMs - offset)
    .filter((instant) => wallClockAsUtcMs(wallClockAt(instant, timeZone)) === wallMs);
  if (matches.length > 0) return new Date(Math.min(...matches));
  // In a gap: keep the earlier offset, which lands past the gap.
  return new Date(wallMs - before);
}

/**
 * The value a datetime-local input needs to show `d` as wall-clock time
 * in `timeZone` ("2026-03-10T11:00"). Minute precision, matching the
 * input's default step, so re-submitting the form is not blocked.
 */
export function toDateTimeLocalValue(d: Date, timeZone: string): string {
  const w = wallClockAt(Math.floor(d.getTime() / 1000) * 1000, timeZone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

/** "2026-03-10 11:00:05": `d` as wall-clock time in `timeZone`. */
export function formatDateTimeInZone(d: Date, timeZone: string): string {
  const w = wallClockAt(Math.floor(d.getTime() / 1000) * 1000, timeZone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
