// flow:F-04 — pure helpers behind failing-mailbox visibility: describing
// and classifying connection errors, the operator advice (a refused 587
// points at 465), the failing re-check schedule, the SMTP transport
// options for implicit TLS, and the Alert primitive's markup.

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Alert } from '@/components/Alert';
import {
  adviseConnectionFailure,
  classifyConnectionFailure,
  describeConnectionError,
  isAuthFailure,
  parseStoredMailboxError,
  portFromMessage,
  type MailboxEndpoints,
} from '@/lib/mail/connection-errors';
import { resolveImapSecure, resolveSmtpSecure, smtpTransportOptions } from '@/lib/mail/smtp-imap';
import {
  FAILING_RECHECK_AUTH_BASE_MS,
  FAILING_RECHECK_BASE_MS,
  FAILING_RECHECK_CAP_MS,
  classifyImapError,
  failingRecheckDelayMs,
} from '@/lib/services/imap-backoff';

const HOUR = 60 * 60 * 1000;

const ENDPOINTS: MailboxEndpoints = {
  smtpHost: 'mail.kensington-green.pl',
  smtpPort: 587,
  imapHost: 'mail.kensington-green.pl',
  imapPort: 993,
};

function imapflowAuthError(): Error {
  return Object.assign(new Error('Command failed'), {
    authenticationFailed: true,
    serverResponseCode: 'AUTHENTICATIONFAILED',
    response: 'Authentication failed.',
  });
}

describe('describeConnectionError', () => {
  it("keeps imapflow's response code and text behind a bare 'Command failed'", () => {
    expect(describeConnectionError(imapflowAuthError())).toBe(
      'Command failed: [AUTHENTICATIONFAILED] Authentication failed.',
    );
    const select = Object.assign(new Error('Command failed'), {
      responseText: 'Mailbox does not exist',
      response: { tag: 'A3' },
    });
    expect(describeConnectionError(select)).toBe('Command failed: Mailbox does not exist');
  });

  it('does not repeat what a nodemailer message already says', () => {
    const eauth = Object.assign(new Error('Invalid login: 535 5.7.8 Error: authentication failed'), {
      code: 'EAUTH',
      response: '535 5.7.8 Error: authentication failed',
    });
    expect(describeConnectionError(eauth)).toBe('Invalid login: 535 5.7.8 Error: authentication failed');
    expect(describeConnectionError(new Error('connect ECONNREFUSED 51.89.234.14:587'))).toBe(
      'connect ECONNREFUSED 51.89.234.14:587',
    );
    expect(describeConnectionError('plain string')).toBe('plain string');
  });
});

describe('auth detection', () => {
  it('reads the structured flags imapflow and nodemailer set', () => {
    expect(isAuthFailure(imapflowAuthError())).toBe(true);
    expect(isAuthFailure(Object.assign(new Error('x'), { code: 'EAUTH' }))).toBe(true);
    expect(isAuthFailure(Object.assign(new Error('x'), { serverResponseCode: 'AUTHORIZATIONFAILED' }))).toBe(true);
    expect(isAuthFailure(new Error('Command failed'))).toBe(false);
    expect(isAuthFailure(null)).toBe(false);
  });

  it('classifyImapError calls a refused imapflow LOGIN auth, not transient (X7: 13 retries)', () => {
    expect(classifyImapError(imapflowAuthError())).toBe('auth');
    expect(classifyImapError(new Error('Command failed'))).toBe('transient');
    expect(classifyImapError(Object.assign(new Error('Command failed'), { response: 'Invalid credentials (Failure)' }))).toBe(
      'auth',
    );
  });

  it('classifies stored text by cause', () => {
    expect(classifyConnectionFailure('Invalid login: 535 5.7.8 Error: authentication failed')).toBe('auth');
    expect(classifyConnectionFailure('Command failed: [AUTHENTICATIONFAILED] Authentication failed.')).toBe('auth');
    expect(classifyConnectionFailure('connect ECONNREFUSED 51.89.234.14:587')).toBe('refused');
    expect(classifyConnectionFailure('getaddrinfo ENOTFOUND mail.example.invalid')).toBe('dns');
    expect(classifyConnectionFailure('C0:error:0A00010B:SSL routines:ssl3_get_record:wrong version number')).toBe('tls');
    expect(classifyConnectionFailure('Connection timeout')).toBe('timeout');
    expect(classifyConnectionFailure('Command failed')).toBe('other');
  });
});

describe('adviseConnectionFailure', () => {
  it('a refused SMTP 587 points at port 465 with TLS on connect (prod mailbox 1)', () => {
    const advice = adviseConnectionFailure('smtp', 'connect ECONNREFUSED 51.89.234.14:587', ENDPOINTS);
    expect(advice).toContain('refused connections on SMTP port 587');
    expect(advice).toContain('set the SMTP port to 465');
    expect(advice).toContain('Test again');
  });

  it('reads the port from the message before the configured one', () => {
    expect(portFromMessage('connect ECONNREFUSED 51.89.234.14:587')).toBe(587);
    expect(portFromMessage('connect ECONNREFUSED ::1:465')).toBe(465);
    expect(portFromMessage('Command failed')).toBeNull();
    const advice = adviseConnectionFailure('smtp', 'connect ECONNREFUSED 1.2.3.4:465', ENDPOINTS);
    expect(advice).toContain('Try port 587 (STARTTLS)');
  });

  it('gives a next step for every cause', () => {
    expect(adviseConnectionFailure('imap', 'Command failed: [AUTHENTICATIONFAILED] Authentication failed.', ENDPOINTS)).toContain(
      'refused the login',
    );
    expect(adviseConnectionFailure('smtp', 'getaddrinfo ENOTFOUND mail.kensington-green.pl', ENDPOINTS)).toContain(
      'could not be found',
    );
    expect(adviseConnectionFailure('smtp', 'ssl3_get_record:wrong version number', ENDPOINTS)).toContain(
      'Port 465 uses TLS on connect and 587 uses STARTTLS',
    );
    expect(adviseConnectionFailure('imap', 'Socket timed out after 20000ms', ENDPOINTS)).toContain('did not answer');
    expect(adviseConnectionFailure('imap', 'connect ECONNREFUSED 1.2.3.4:143', ENDPOINTS)).toContain('993');
    expect(adviseConnectionFailure('imap', 'Command failed', ENDPOINTS)).toContain('Check the IMAP settings');
  });
});

describe('parseStoredMailboxError', () => {
  it('splits prefixed, legacy and empty errors', () => {
    expect(parseStoredMailboxError('SMTP: Invalid login: 535')).toEqual({ protocol: 'smtp', message: 'Invalid login: 535' });
    expect(parseStoredMailboxError('IMAP: Socket timed out')).toEqual({ protocol: 'imap', message: 'Socket timed out' });
    // Prod mailbox 1 (X7): no colon.
    expect(parseStoredMailboxError('SMTP connect ECONNREFUSED 51.89.234.14:587')).toEqual({
      protocol: 'smtp',
      message: 'connect ECONNREFUSED 51.89.234.14:587',
    });
    // Prod mailbox 2: the old IMAP auto-pause stored the bare message.
    expect(parseStoredMailboxError('Command failed')).toEqual({ protocol: 'imap', message: 'Command failed' });
    expect(parseStoredMailboxError(null).protocol).toBe('imap');
  });
});

describe('failingRecheckDelayMs', () => {
  it('waits as long as the mailbox has been failing, from 1 h (6 h after a refused login) to a 24 h cap', () => {
    expect(failingRecheckDelayMs(0, false)).toBe(FAILING_RECHECK_BASE_MS);
    expect(failingRecheckDelayMs(0, true)).toBe(FAILING_RECHECK_AUTH_BASE_MS);
    expect(FAILING_RECHECK_BASE_MS).toBe(HOUR);
    expect(FAILING_RECHECK_AUTH_BASE_MS).toBe(6 * HOUR);
    expect(failingRecheckDelayMs(4 * HOUR, false)).toBe(4 * HOUR);
    expect(failingRecheckDelayMs(4 * HOUR, true)).toBe(6 * HOUR);
    expect(failingRecheckDelayMs(30 * 24 * HOUR, false)).toBe(FAILING_RECHECK_CAP_MS);
    expect(FAILING_RECHECK_CAP_MS).toBe(24 * HOUR);
    expect(failingRecheckDelayMs(-5, false)).toBe(HOUR);
    expect(failingRecheckDelayMs(Number.NaN, false)).toBe(HOUR);
  });

  it('doubles the interval between failed re-checks', () => {
    // Episode starts at t=0; each re-check happens when its gate passes.
    let t = 0;
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      const wait = failingRecheckDelayMs(t, false);
      waits.push(wait / HOUR);
      t += wait;
    }
    expect(waits).toEqual([1, 1, 2, 4, 8, 16, 24]);
  });
});

describe('SMTP transport (port 465 = implicit TLS)', () => {
  const base = {
    smtpHost: 'mail.kensington-green.pl',
    smtpUser: 'u',
    smtpPassword: 'p',
    imap: null,
  };

  it('port 465 always connects with TLS, 587 / 25 always start plain and use STARTTLS', () => {
    expect(smtpTransportOptions({ ...base, smtpPort: 465, smtpSecure: false })).toMatchObject({
      host: 'mail.kensington-green.pl',
      port: 465,
      secure: true,
    });
    expect(smtpTransportOptions({ ...base, smtpPort: 587, smtpSecure: true }).secure).toBe(false);
    expect(resolveSmtpSecure(25, true)).toBe(false);
    expect(resolveSmtpSecure(2525, true)).toBe(true);
    expect(resolveImapSecure(993, false)).toBe(true);
    expect(resolveImapSecure(143, true)).toBe(false);
  });
});

describe('Alert primitive', () => {
  it('renders tone, title, body and action; danger is announced', () => {
    const html = renderToStaticMarkup(
      createElement(
        Alert,
        { tone: 'danger', title: 'This mailbox is failing', action: createElement('button', null, 'Test again') },
        createElement('p', null, 'Last error'),
      ),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-tone="danger"');
    expect(html).toContain('This mailbox is failing');
    expect(html).toContain('<button>Test again</button>');
    expect(html).toContain('<p>Last error</p>');
    expect(html).not.toContain('style=');
  });

  it('info is a status, and the action slot is optional', () => {
    const html = renderToStaticMarkup(createElement(Alert, { tone: 'info' }, 'hello'));
    expect(html).toContain('role="status"');
    expect(html).not.toContain('<button');
  });
});
