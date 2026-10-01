// datetime-local values read in the viewer's time zone (src/lib/time-zone.ts).
// Pure functions, no database.

import { describe, expect, it } from 'vitest';
import {
  formatDateTimeInZone,
  parseDateTimeLocal,
  resolveTimeZone,
  toDateTimeLocalValue,
  untilExclusiveEnd,
} from '@/lib/time-zone';

describe('resolveTimeZone', () => {
  it('accepts IANA zones the runtime knows', () => {
    expect(resolveTimeZone('Europe/Warsaw')).toBe('Europe/Warsaw');
    expect(resolveTimeZone(' America/New_York ')).toBe('America/New_York');
    expect(resolveTimeZone('UTC')).toBe('UTC');
  });

  it('rejects missing, unknown and malformed values', () => {
    expect(resolveTimeZone(undefined)).toBeNull();
    expect(resolveTimeZone('')).toBeNull();
    expect(resolveTimeZone(42)).toBeNull();
    expect(resolveTimeZone('Mars/Olympus_Mons')).toBeNull();
    expect(resolveTimeZone('Europe/Warsaw; drop table')).toBeNull();
    expect(resolveTimeZone(`Europe/${'x'.repeat(80)}`)).toBeNull();
  });
});

describe('parseDateTimeLocal', () => {
  const iso = (raw: string, zone: string) => parseDateTimeLocal(raw, zone)?.toISOString() ?? null;

  it('reads the wall-clock value in the given zone', () => {
    expect(iso('2026-03-10T11:00', 'UTC')).toBe('2026-03-10T11:00:00.000Z');
    // Warsaw is UTC+1 in winter and UTC+2 in summer.
    expect(iso('2026-01-15T12:00', 'Europe/Warsaw')).toBe('2026-01-15T11:00:00.000Z');
    expect(iso('2026-07-01T12:00', 'Europe/Warsaw')).toBe('2026-07-01T10:00:00.000Z');
    expect(iso('2026-07-01T08:30', 'America/New_York')).toBe('2026-07-01T12:30:00.000Z');
    expect(iso('2026-03-10T05:30', 'Asia/Kolkata')).toBe('2026-03-10T00:00:00.000Z');
  });

  it('lands on the previous UTC day when the offset puts it there', () => {
    expect(iso('2026-03-10T00:30', 'Europe/Warsaw')).toBe('2026-03-09T23:30:00.000Z');
  });

  it('keeps seconds when the value has them', () => {
    expect(iso('2026-03-10T11:00:30', 'UTC')).toBe('2026-03-10T11:00:30.000Z');
  });

  it('moves a time skipped by spring-forward past the gap', () => {
    // 29 Mar 2026: Warsaw jumps from 02:00 CET to 03:00 CEST, so 02:30
    // never happens; it is read as 03:30 CEST.
    expect(iso('2026-03-29T02:30', 'Europe/Warsaw')).toBe('2026-03-29T01:30:00.000Z');
    expect(iso('2026-03-29T03:00', 'Europe/Warsaw')).toBe('2026-03-29T01:00:00.000Z');
  });

  it('reads a time repeated by fall-back as its first occurrence', () => {
    // 25 Oct 2026: Warsaw falls back from 03:00 CEST to 02:00 CET, so
    // 02:30 happens at 00:30Z and again at 01:30Z.
    expect(iso('2026-10-25T02:30', 'Europe/Warsaw')).toBe('2026-10-25T00:30:00.000Z');
    expect(iso('2026-10-25T03:30', 'Europe/Warsaw')).toBe('2026-10-25T02:30:00.000Z');
  });

  it('rejects malformed values and dates that do not exist', () => {
    for (const raw of [
      undefined,
      '',
      'yesterday',
      '2026-03-10',
      '2026-03-10 11:00',
      '10/03/2026 11:00',
      '2026-03-10T11:00Z',
      '2026-06-31T10:00',
      '2026-02-29T10:00',
      '2026-03-10T24:00',
      '2026-03-10T10:60',
    ]) {
      expect(parseDateTimeLocal(raw, 'UTC'), String(raw)).toBeNull();
    }
  });
});

describe('untilExclusiveEnd', () => {
  it('ends after the whole minute an HH:MM value names', () => {
    expect(untilExclusiveEnd('2026-03-10T13:00', 'Europe/Warsaw')?.toISOString()).toBe(
      '2026-03-10T12:01:00.000Z',
    );
    expect(untilExclusiveEnd('2026-07-01T10:15', 'UTC')?.toISOString()).toBe(
      '2026-07-01T10:16:00.000Z',
    );
  });

  it('ends after the second when the value has seconds', () => {
    expect(untilExclusiveEnd('2026-07-01T10:15:30', 'UTC')?.toISOString()).toBe(
      '2026-07-01T10:15:31.000Z',
    );
  });

  it('is 60 s after the start across a clock change', () => {
    // 01:59 on the Warsaw spring-forward night is followed by 03:00 CEST.
    const start = parseDateTimeLocal('2026-03-29T01:59', 'Europe/Warsaw')!;
    const end = untilExclusiveEnd('2026-03-29T01:59', 'Europe/Warsaw')!;
    expect(end.getTime() - start.getTime()).toBe(60_000);
    expect(toDateTimeLocalValue(end, 'Europe/Warsaw')).toBe('2026-03-29T03:00');
  });

  it('is null whenever parseDateTimeLocal is', () => {
    for (const raw of ['', 'yesterday', '2026-06-31T10:00', undefined]) {
      expect(untilExclusiveEnd(raw, 'UTC')).toBeNull();
    }
  });
});

describe('toDateTimeLocalValue', () => {
  it('shows an instant as wall-clock minutes in the zone', () => {
    const d = new Date('2026-07-01T10:00:45Z');
    expect(toDateTimeLocalValue(d, 'Europe/Warsaw')).toBe('2026-07-01T12:00');
    expect(toDateTimeLocalValue(d, 'UTC')).toBe('2026-07-01T10:00');
    expect(toDateTimeLocalValue(new Date('2026-03-09T23:30:00Z'), 'Europe/Warsaw')).toBe(
      '2026-03-10T00:30',
    );
  });

  it('round-trips through parseDateTimeLocal', () => {
    for (const zone of ['UTC', 'Europe/Warsaw', 'America/New_York', 'Asia/Kolkata']) {
      const d = new Date('2026-07-01T10:15:00Z');
      expect(parseDateTimeLocal(toDateTimeLocalValue(d, zone), zone)?.toISOString()).toBe(
        d.toISOString(),
      );
    }
  });
});

describe('formatDateTimeInZone', () => {
  it('formats to the second in the zone, on a 24-hour clock', () => {
    expect(formatDateTimeInZone(new Date('2026-03-10T10:00:05Z'), 'Europe/Warsaw')).toBe(
      '2026-03-10 11:00:05',
    );
    expect(formatDateTimeInZone(new Date('2026-03-10T00:00:00Z'), 'UTC')).toBe(
      '2026-03-10 00:00:00',
    );
  });
});
