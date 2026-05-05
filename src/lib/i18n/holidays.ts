// Public holiday calendars. Used by the mailbox sending-policy gate
// (Phase 43) so outbound mail respects the recipient's working calendar.
//
// Pure module — no DB, no AI. Year-by-year holiday sets are computed
// deterministically (Easter via the Anonymous Gregorian algorithm,
// nth-weekday rules for US holidays) so we don't need a hardcoded
// table that has to be kept up to date.
//
// Country support today: PL, GB, US, DE. Adding a new country is a
// small file edit — see addCountry() shape below.

export type HolidayCountry = 'PL' | 'GB' | 'US' | 'DE';

export const SUPPORTED_HOLIDAY_COUNTRIES: ReadonlyArray<{
  code: HolidayCountry;
  name: string;
}> = [
  { code: 'PL', name: 'Poland' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'US', name: 'United States' },
  { code: 'DE', name: 'Germany' },
];

export interface Holiday {
  date: string; // 'YYYY-MM-DD' in local civil time of the country
  name: string;
}

// ─── Easter (Anonymous Gregorian algorithm) ──────────────────────────

/** Easter Sunday for a given Gregorian year, returned in local civil time. */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 or 4
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

// ─── Helpers ─────────────────────────────────────────────────────────

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/** Return the date of the Nth occurrence of weekday `wd` (0=Sun..6=Sat)
 *  in month `month` (1..12) of `year`. */
function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(year, month - 1, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  return new Date(year, month - 1, 1 + offset + (n - 1) * 7);
}

/** Last occurrence of weekday `wd` in month/year. */
function lastWeekday(year: number, month: number, weekday: number): Date {
  const last = new Date(year, month, 0); // 0th day of next month = last of this month
  const offset = (last.getDay() - weekday + 7) % 7;
  return new Date(year, month - 1, last.getDate() - offset);
}

// ─── Country holiday builders ────────────────────────────────────────

interface FixedRule {
  month: number;
  day: number;
  name: string;
}

function buildPoland(year: number): Holiday[] {
  const fixed: FixedRule[] = [
    { month: 1, day: 1, name: 'Nowy Rok' },
    { month: 1, day: 6, name: 'Trzech Króli' },
    { month: 5, day: 1, name: 'Święto Pracy' },
    { month: 5, day: 3, name: 'Święto Konstytucji 3 Maja' },
    { month: 8, day: 15, name: 'Wniebowzięcie NMP' },
    { month: 11, day: 1, name: 'Wszystkich Świętych' },
    { month: 11, day: 11, name: 'Święto Niepodległości' },
    { month: 12, day: 24, name: 'Wigilia Bożego Narodzenia' },
    { month: 12, day: 25, name: 'Boże Narodzenie (1 dzień)' },
    { month: 12, day: 26, name: 'Boże Narodzenie (2 dzień)' },
  ];
  const easter = easterSunday(year);
  const movable: Holiday[] = [
    { date: fmt(easter), name: 'Wielkanoc' },
    { date: fmt(addDays(easter, 1)), name: 'Poniedziałek Wielkanocny' },
    { date: fmt(addDays(easter, 49)), name: 'Zesłanie Ducha Świętego' },
    { date: fmt(addDays(easter, 60)), name: 'Boże Ciało' },
  ];
  return [
    ...fixed.map((h) => ({
      date: `${year}-${String(h.month).padStart(2, '0')}-${String(h.day).padStart(2, '0')}`,
      name: h.name,
    })),
    ...movable,
  ];
}

function buildGermany(year: number): Holiday[] {
  // Federal-level only. Some Länder have extras (e.g. Reformationstag in
  // protestant states, Allerheiligen in catholic states); we don't model
  // that yet — a future per-region selector can extend.
  const fixed: FixedRule[] = [
    { month: 1, day: 1, name: 'Neujahr' },
    { month: 5, day: 1, name: 'Tag der Arbeit' },
    { month: 10, day: 3, name: 'Tag der Deutschen Einheit' },
    { month: 12, day: 25, name: '1. Weihnachtstag' },
    { month: 12, day: 26, name: '2. Weihnachtstag' },
  ];
  const easter = easterSunday(year);
  const movable: Holiday[] = [
    { date: fmt(addDays(easter, -2)), name: 'Karfreitag' },
    { date: fmt(easter), name: 'Ostersonntag' },
    { date: fmt(addDays(easter, 1)), name: 'Ostermontag' },
    { date: fmt(addDays(easter, 39)), name: 'Christi Himmelfahrt' },
    { date: fmt(addDays(easter, 49)), name: 'Pfingstsonntag' },
    { date: fmt(addDays(easter, 50)), name: 'Pfingstmontag' },
  ];
  return [
    ...fixed.map((h) => ({
      date: `${year}-${String(h.month).padStart(2, '0')}-${String(h.day).padStart(2, '0')}`,
      name: h.name,
    })),
    ...movable,
  ];
}

/** UK England + Wales bank holidays. NI / Scotland have variations not
 *  modelled. Substitute holidays are handled when a fixed-date holiday
 *  falls on a weekend (1 Jan, 25 Dec, 26 Dec). */
function buildUK(year: number): Holiday[] {
  const out: Holiday[] = [];
  // New Year's Day (with substitute)
  const ny = new Date(year, 0, 1);
  const nyDow = ny.getDay();
  if (nyDow === 0) out.push({ date: fmt(addDays(ny, 1)), name: 'New Year’s Day (substitute)' });
  else if (nyDow === 6) out.push({ date: fmt(addDays(ny, 2)), name: 'New Year’s Day (substitute)' });
  else out.push({ date: fmt(ny), name: 'New Year’s Day' });

  const easter = easterSunday(year);
  out.push({ date: fmt(addDays(easter, -2)), name: 'Good Friday' });
  out.push({ date: fmt(addDays(easter, 1)), name: 'Easter Monday' });

  // Early May bank holiday — first Monday of May
  out.push({ date: fmt(nthWeekday(year, 5, 1, 1)), name: 'Early May bank holiday' });
  // Spring bank holiday — last Monday of May
  out.push({ date: fmt(lastWeekday(year, 5, 1)), name: 'Spring bank holiday' });
  // Summer bank holiday — last Monday of August
  out.push({ date: fmt(lastWeekday(year, 8, 1)), name: 'Summer bank holiday' });

  // Christmas + Boxing Day with substitutes
  const xmas = new Date(year, 11, 25);
  const boxing = new Date(year, 11, 26);
  const xDow = xmas.getDay();
  if (xDow === 6) {
    // Sat 25, Sun 26 → Mon 27 + Tue 28
    out.push({ date: fmt(xmas), name: 'Christmas Day' });
    out.push({ date: fmt(boxing), name: 'Boxing Day' });
    out.push({ date: fmt(addDays(xmas, 2)), name: 'Christmas Day (substitute)' });
    out.push({ date: fmt(addDays(boxing, 2)), name: 'Boxing Day (substitute)' });
  } else if (xDow === 0) {
    // Sun 25, Mon 26 → Mon 26 (Boxing) + Tue 27 (substitute Christmas)
    out.push({ date: fmt(xmas), name: 'Christmas Day' });
    out.push({ date: fmt(boxing), name: 'Boxing Day' });
    out.push({ date: fmt(addDays(xmas, 2)), name: 'Christmas Day (substitute)' });
  } else if (xDow === 5) {
    // Fri 25, Sat 26 → Mon 28 (substitute Boxing)
    out.push({ date: fmt(xmas), name: 'Christmas Day' });
    out.push({ date: fmt(boxing), name: 'Boxing Day' });
    out.push({ date: fmt(addDays(boxing, 2)), name: 'Boxing Day (substitute)' });
  } else {
    out.push({ date: fmt(xmas), name: 'Christmas Day' });
    out.push({ date: fmt(boxing), name: 'Boxing Day' });
  }
  return out;
}

/** US federal holidays. Includes substitutes for Sat→Fri and Sun→Mon. */
function buildUS(year: number): Holiday[] {
  const out: Holiday[] = [];

  function pushWithSub(d: Date, name: string) {
    const dow = d.getDay();
    if (dow === 6) out.push({ date: fmt(addDays(d, -1)), name: `${name} (observed)` });
    else if (dow === 0) out.push({ date: fmt(addDays(d, 1)), name: `${name} (observed)` });
    else out.push({ date: fmt(d), name });
  }

  pushWithSub(new Date(year, 0, 1), "New Year's Day");
  out.push({ date: fmt(nthWeekday(year, 1, 1, 3)), name: 'Martin Luther King Jr. Day' });
  out.push({ date: fmt(nthWeekday(year, 2, 1, 3)), name: "Presidents' Day" });
  out.push({ date: fmt(lastWeekday(year, 5, 1)), name: 'Memorial Day' });
  pushWithSub(new Date(year, 5, 19), 'Juneteenth National Independence Day');
  pushWithSub(new Date(year, 6, 4), 'Independence Day');
  out.push({ date: fmt(nthWeekday(year, 9, 1, 1)), name: 'Labor Day' });
  out.push({ date: fmt(nthWeekday(year, 10, 1, 2)), name: 'Columbus Day' });
  pushWithSub(new Date(year, 10, 11), 'Veterans Day');
  out.push({ date: fmt(nthWeekday(year, 11, 4, 4)), name: 'Thanksgiving Day' });
  pushWithSub(new Date(year, 11, 25), 'Christmas Day');
  return out;
}

const BUILDERS: Record<HolidayCountry, (year: number) => Holiday[]> = {
  PL: buildPoland,
  GB: buildUK,
  US: buildUS,
  DE: buildGermany,
};

// ─── Public API ──────────────────────────────────────────────────────

const cache = new Map<string, Holiday[]>();

export function getHolidaysForYear(country: HolidayCountry, year: number): Holiday[] {
  const key = `${country}:${year}`;
  let cached = cache.get(key);
  if (!cached) {
    const builder = BUILDERS[country];
    cached = builder ? builder(year) : [];
    cached.sort((a, b) => a.date.localeCompare(b.date));
    cache.set(key, cached);
  }
  return cached;
}

/**
 * Returns whether `date` (interpreted in local civil time) is a public
 * holiday in `country`, and if so, the holiday's name.
 */
export function isHoliday(
  country: HolidayCountry,
  date: Date,
): { isHoliday: boolean; name?: string } {
  const dateStr = fmt(date);
  const list = getHolidaysForYear(country, date.getFullYear());
  const match = list.find((h) => h.date === dateStr);
  if (match) return { isHoliday: true, name: match.name };
  return { isHoliday: false };
}

/** Predicate: is `date` a non-working day per the requested rules?
 *  Caller decides whether to respect weekends and holidays separately
 *  (via the boolean knobs) so the same helper can express any policy. */
export function isNonWorkingDay(
  date: Date,
  opts: {
    country: HolidayCountry;
    respectWeekends: boolean;
    respectHolidays: boolean;
  },
): { off: boolean; reason?: string } {
  if (opts.respectWeekends) {
    const dow = date.getDay();
    if (dow === 0) return { off: true, reason: 'Sunday' };
    if (dow === 6) return { off: true, reason: 'Saturday' };
  }
  if (opts.respectHolidays) {
    const h = isHoliday(opts.country, date);
    if (h.isHoliday) return { off: true, reason: h.name };
  }
  return { off: false };
}
