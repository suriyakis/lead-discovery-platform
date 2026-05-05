import { describe, expect, it } from 'vitest';
import {
  easterSunday,
  getHolidaysForYear,
  isHoliday,
  isNonWorkingDay,
  type HolidayCountry,
} from '@/lib/i18n/holidays';
import {
  evaluateBusinessWindow,
  evaluateCounters,
  pickRandomDelaySeconds,
} from '@/lib/services/sending-policy';

// ─── holidays.ts ───────────────────────────────────────────────────────

describe('easterSunday', () => {
  it('matches known Easter dates', () => {
    expect(easterSunday(2024).toDateString()).toBe('Sun Mar 31 2024');
    expect(easterSunday(2025).toDateString()).toBe('Sun Apr 20 2025');
    expect(easterSunday(2026).toDateString()).toBe('Sun Apr 05 2026');
    expect(easterSunday(2027).toDateString()).toBe('Sun Mar 28 2027');
  });
});

describe('Polish holidays', () => {
  it('includes Wielkanoc, Boże Ciało, Wszystkich Świętych', () => {
    const list = getHolidaysForYear('PL', 2026);
    const dates = list.map((h) => h.date);
    // Easter 2026 = Apr 5; Boże Ciało = Easter + 60 = June 4
    expect(dates).toContain('2026-04-05');
    expect(dates).toContain('2026-04-06'); // Easter Monday
    expect(dates).toContain('2026-06-04'); // Boże Ciało
    expect(dates).toContain('2026-11-01'); // Wszystkich Świętych
    expect(dates).toContain('2026-11-11'); // Independence Day
  });

  it('isHoliday detects 1 January', () => {
    const r = isHoliday('PL', new Date(2026, 0, 1));
    expect(r.isHoliday).toBe(true);
    expect(r.name).toMatch(/Nowy Rok/);
  });
});

describe('UK holidays', () => {
  it('includes substitute days when Christmas falls on weekend', () => {
    // 2027: Christmas Day is Saturday → substitute Tuesday Dec 28.
    const list = getHolidaysForYear('GB', 2027);
    const dates = list.map((h) => h.date);
    expect(dates).toContain('2027-12-25');
    expect(dates).toContain('2027-12-27');
    expect(dates).toContain('2027-12-28');
  });

  it('includes Easter Monday and Spring bank holiday', () => {
    const list = getHolidaysForYear('GB', 2026);
    const names = list.map((h) => h.name);
    expect(names).toContain('Easter Monday');
    expect(names).toContain('Spring bank holiday');
  });
});

describe('US holidays', () => {
  it('uses observed-day rule for July 4 on a Saturday', () => {
    // 2026: July 4 is Saturday → observed Friday July 3.
    const list = getHolidaysForYear('US', 2026);
    const dates = list.map((h) => h.date);
    expect(dates).toContain('2026-07-03');
  });

  it('Thanksgiving is the 4th Thursday in November', () => {
    const list = getHolidaysForYear('US', 2026);
    const thx = list.find((h) => h.name === 'Thanksgiving Day');
    expect(thx?.date).toBe('2026-11-26');
  });
});

describe('German holidays', () => {
  it('includes Karfreitag, Ostermontag, and Tag der Deutschen Einheit', () => {
    const list = getHolidaysForYear('DE', 2026);
    const names = list.map((h) => h.name);
    expect(names).toContain('Karfreitag');
    expect(names).toContain('Ostermontag');
    expect(names).toContain('Tag der Deutschen Einheit');
  });
});

describe('isNonWorkingDay', () => {
  const country: HolidayCountry = 'PL';

  it('flags a Sunday', () => {
    const r = isNonWorkingDay(new Date(2026, 4, 17), {
      country,
      respectWeekends: true,
      respectHolidays: false,
    });
    expect(r.off).toBe(true);
    expect(r.reason).toMatch(/Sunday/);
  });

  it('flags a Polish holiday on a weekday', () => {
    const r = isNonWorkingDay(new Date(2026, 0, 1), {
      country,
      respectWeekends: false,
      respectHolidays: true,
    });
    expect(r.off).toBe(true);
    expect(r.reason).toMatch(/Nowy Rok/);
  });

  it('does not flag a regular Tuesday when respect flags are off', () => {
    const r = isNonWorkingDay(new Date(2026, 4, 19), {
      country,
      respectWeekends: false,
      respectHolidays: false,
    });
    expect(r.off).toBe(false);
  });
});

// ─── sending-policy evaluator ─────────────────────────────────────────

const baseLimits = {
  maxPerDay: 50,
  maxPerHour: 10,
  minDelaySeconds: 60,
  maxDelaySeconds: 300,
  businessHoursOnly: true,
  businessStartHour: 8,
  businessEndHour: 17,
  businessDays: [1, 2, 3, 4, 5],
  timezone: 'Europe/Warsaw',
  respectWeekends: true,
  respectHolidays: true,
  holidayCountry: 'PL',
  sentToday: 0,
  sentThisHour: 0,
  lastResetDate: null,
  lastResetHour: null,
};

describe('evaluateBusinessWindow', () => {
  it('always allows when businessHoursOnly is off', () => {
    const out = evaluateBusinessWindow(
      { ...baseLimits, businessHoursOnly: false },
      new Date('2026-05-04T03:00:00Z'),
    );
    expect(out.allowed).toBe(true);
  });

  it('allows a Tuesday at 10:00 Europe/Warsaw', () => {
    // 2026-05-05 is a Tuesday. 10:00 Warsaw = 08:00 UTC (CEST).
    const out = evaluateBusinessWindow(
      baseLimits,
      new Date('2026-05-05T08:00:00Z'),
    );
    expect(out.allowed).toBe(true);
  });

  it('blocks before business hours and pushes retryAfter to startHour today', () => {
    // Tuesday 06:00 Warsaw = 04:00 UTC. Today's window opens at 08:00
    // Warsaw = 06:00 UTC.
    const out = evaluateBusinessWindow(
      baseLimits,
      new Date('2026-05-05T04:00:00Z'),
    );
    expect(out.allowed).toBe(false);
    expect(out.reason).toMatch(/Before business hours/);
    expect(out.retryAfter).toBeDefined();
    expect(out.retryAfter!.toISOString()).toBe('2026-05-05T06:00:00.000Z');
  });

  it('blocks after business hours and pushes retryAfter to next business day', () => {
    // Tuesday 21:00 Warsaw = 19:00 UTC → window opens Wed 08:00 Warsaw.
    const out = evaluateBusinessWindow(
      baseLimits,
      new Date('2026-05-05T19:00:00Z'),
    );
    expect(out.allowed).toBe(false);
    expect(out.reason).toMatch(/After business hours/);
    expect(out.retryAfter!.toISOString()).toBe('2026-05-06T06:00:00.000Z');
  });

  it('blocks weekends and pushes to Monday', () => {
    // Saturday 2026-05-09 12:00 UTC (any time Sat) → Monday 08:00 Warsaw.
    const out = evaluateBusinessWindow(
      baseLimits,
      new Date('2026-05-09T12:00:00Z'),
    );
    expect(out.allowed).toBe(false);
    expect(out.reason).toMatch(/Saturday/);
    expect(out.retryAfter!.toISOString()).toBe('2026-05-11T06:00:00.000Z');
  });

  it('blocks Polish holidays', () => {
    // 2026-05-01 is a Friday and Święto Pracy in PL. 12:00 UTC lands
    // inside the working window but the day itself is off.
    const out = evaluateBusinessWindow(
      baseLimits,
      new Date('2026-05-01T12:00:00Z'),
    );
    expect(out.allowed).toBe(false);
    expect(out.reason).toMatch(/Święto Pracy/);
  });

  it('respectHolidays=false ignores holidays', () => {
    const out = evaluateBusinessWindow(
      { ...baseLimits, respectHolidays: false },
      new Date('2026-05-01T12:00:00Z'),
    );
    expect(out.allowed).toBe(true);
  });
});

describe('evaluateCounters', () => {
  it('allows when counters are zero', () => {
    const out = evaluateCounters(baseLimits, new Date('2026-05-05T10:00:00Z'));
    expect(out.allowed).toBe(true);
  });

  it('blocks at maxPerDay and reschedules to next business window', () => {
    const out = evaluateCounters(
      {
        ...baseLimits,
        sentToday: 50,
        lastResetDate: '2026-05-05',
        lastResetHour: 10,
      },
      new Date('2026-05-05T10:00:00Z'),
    );
    expect(out.allowed).toBe(false);
    expect(out.reason).toMatch(/Daily limit reached/);
  });

  it('blocks at maxPerHour and reschedules to top of next hour', () => {
    // 12:00 Warsaw = 10:00 UTC; next hour starts at 13:00 Warsaw = 11:00 UTC.
    const out = evaluateCounters(
      {
        ...baseLimits,
        sentToday: 5,
        sentThisHour: 10,
        lastResetDate: '2026-05-05',
        lastResetHour: 12,
      },
      new Date('2026-05-05T10:00:00Z'),
    );
    expect(out.allowed).toBe(false);
    expect(out.reason).toMatch(/Hourly limit reached/);
    expect(out.retryAfter!.toISOString()).toBe('2026-05-05T11:00:00.000Z');
  });

  it('treats yesterday counters as stale', () => {
    const out = evaluateCounters(
      {
        ...baseLimits,
        sentToday: 999,
        lastResetDate: '2026-05-04', // yesterday
        lastResetHour: 12,
      },
      new Date('2026-05-05T10:00:00Z'),
    );
    expect(out.allowed).toBe(true);
  });
});

describe('pickRandomDelaySeconds', () => {
  it('returns a value within [min, max]', () => {
    for (let i = 0; i < 100; i++) {
      const n = pickRandomDelaySeconds({ minDelaySeconds: 60, maxDelaySeconds: 300 });
      expect(n).toBeGreaterThanOrEqual(60);
      expect(n).toBeLessThanOrEqual(300);
    }
  });

  it('returns the floor when min === max', () => {
    expect(pickRandomDelaySeconds({ minDelaySeconds: 90, maxDelaySeconds: 90 })).toBe(90);
  });

  it('clamps inverted ranges', () => {
    const n = pickRandomDelaySeconds({ minDelaySeconds: 300, maxDelaySeconds: 60 });
    expect(n).toBe(300);
  });
});
