// Phase 51 — IMAP error classification + backoff schedule.
// Pure helpers; no DB / no network. Asserts the gates that prevent the
// 2-minute IMAP tick from pounding upstream mail servers into fail2ban.

import { describe, expect, it } from 'vitest';
import {
  classifyImapError,
  computeBackoffMs,
  nextSyncAfterEmpty,
} from '@/lib/services/imap-backoff';

describe('classifyImapError', () => {
  it('flags imapflow AUTHENTICATIONFAILED as auth', () => {
    const err = new Error(
      'Command failed: NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)',
    );
    expect(classifyImapError(err)).toBe('auth');
  });

  it('flags Dovecot Invalid credentials as auth', () => {
    expect(classifyImapError(new Error('Invalid credentials (Failure)'))).toBe(
      'auth',
    );
  });

  it('flags Gmail Application-specific password required as auth', () => {
    expect(
      classifyImapError(
        new Error('Application-specific password required (Failure)'),
      ),
    ).toBe('auth');
  });

  it('flags LOGIN_DISABLED as auth', () => {
    expect(classifyImapError(new Error('LOGIN_DISABLED'))).toBe('auth');
  });

  it('flags Account locked as auth', () => {
    expect(classifyImapError(new Error('Account locked due to abuse'))).toBe(
      'auth',
    );
  });

  it('treats socket timeout as transient', () => {
    expect(classifyImapError(new Error('Socket timed out after 20000ms'))).toBe(
      'transient',
    );
  });

  it('treats ECONNREFUSED as transient', () => {
    expect(
      classifyImapError(new Error('connect ECONNREFUSED 1.2.3.4:993')),
    ).toBe('transient');
  });

  it('treats unknown errors as transient (bias is safer)', () => {
    expect(classifyImapError(new Error('something exploded'))).toBe(
      'transient',
    );
  });

  it('accepts non-Error inputs', () => {
    expect(classifyImapError('AUTHENTICATIONFAILED')).toBe('auth');
    expect(classifyImapError(null)).toBe('transient');
  });
});

describe('computeBackoffMs', () => {
  it('returns 0 for zero / negative counts', () => {
    expect(computeBackoffMs(0)).toBe(0);
    expect(computeBackoffMs(-3)).toBe(0);
  });

  it('starts at 2 minutes after the first failure', () => {
    expect(computeBackoffMs(1)).toBe(2 * 60 * 1000);
  });

  it('doubles each step: 2, 4, 8, 16, 32 minutes', () => {
    expect(computeBackoffMs(2)).toBe(4 * 60 * 1000);
    expect(computeBackoffMs(3)).toBe(8 * 60 * 1000);
    expect(computeBackoffMs(4)).toBe(16 * 60 * 1000);
    expect(computeBackoffMs(5)).toBe(32 * 60 * 1000);
  });

  it('caps at 60 minutes (so a permanently broken mailbox still attempts hourly)', () => {
    expect(computeBackoffMs(6)).toBe(60 * 60 * 1000);
    expect(computeBackoffMs(7)).toBe(60 * 60 * 1000);
    expect(computeBackoffMs(99)).toBe(60 * 60 * 1000);
  });
});

describe('nextSyncAfterEmpty', () => {
  const NOW = new Date('2026-05-15T12:00:00Z');

  it('returns null under the 5-empty threshold (normal 2-min cadence)', () => {
    expect(nextSyncAfterEmpty(NOW, 0)).toBeNull();
    expect(nextSyncAfterEmpty(NOW, 4)).toBeNull();
  });

  it('extends to 15 minutes once the threshold is reached', () => {
    const next = nextSyncAfterEmpty(NOW, 5)!;
    expect(next.getTime() - NOW.getTime()).toBe(15 * 60 * 1000);
  });

  it('stays at 15 minutes for higher counts (no further stretching)', () => {
    const next = nextSyncAfterEmpty(NOW, 50)!;
    expect(next.getTime() - NOW.getTime()).toBe(15 * 60 * 1000);
  });
});
