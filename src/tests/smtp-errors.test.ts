// flow:F-05 (I007) — SMTP failure classification, one case per code.
// Pure: no database.

import { describe, expect, it } from 'vitest';
import {
  classifySmtpError,
  hardRejectedFromPartial,
  isRecipientHardBounceText,
  isRecipientHardRejection,
  parseEnhancedStatus,
} from '@/lib/mail/smtp-errors';

/** A nodemailer-shaped error (lib/smtp-connection _formatError). */
function smtpError(
  code: string,
  command: string | null,
  response: string | null,
  extra: Record<string, unknown> = {},
): Error {
  const err = new Error(response ? `${code}: ${response}` : code) as Error & Record<string, unknown>;
  err.code = code;
  if (command) err.command = command;
  if (response) {
    err.response = response;
    const m = response.match(/^\d+/);
    if (m) err.responseCode = Number(m[0]);
  }
  Object.assign(err, extra);
  return err;
}

/** All recipients refused at RCPT TO — the shape nodemailer throws. */
function rcptRejected(perRecipient: Array<[string, string]>): Error {
  const rejectedErrors = perRecipient.map(([recipient, response]) =>
    Object.assign(smtpError('EENVELOPE', 'RCPT TO', response), { recipient }),
  );
  const last = perRecipient[perRecipient.length - 1]![1];
  return smtpError('EENVELOPE', 'RCPT TO', last, {
    rejected: perRecipient.map(([r]) => r),
    rejectedErrors,
  });
}

const ONE = ['anna@target.com'];

describe('classifySmtpError — sender-side failures never name a recipient', () => {
  const cases: Array<[string, Error, string]> = [
    [
      'EAUTH 535 5.7.8 bad credentials',
      smtpError('EAUTH', 'AUTH PLAIN', '535 5.7.8 Error: authentication failed: UGFzc3dvcmQ6'),
      'auth',
    ],
    [
      'EAUTH 534 5.7.9 application-specific password required',
      smtpError('EAUTH', 'AUTH LOGIN', '534-5.7.9 Application-specific password required.'),
      'auth',
    ],
    [
      'EAUTH without a server reply (missing credentials)',
      smtpError('EAUTH', 'API', null),
      'auth',
    ],
    [
      '530 5.7.0 Authentication required at MAIL FROM',
      smtpError('EENVELOPE', 'MAIL FROM', '530 5.7.0 Authentication required'),
      'auth',
    ],
    ['ECONNECTION refused', smtpError('ESOCKET', 'CONN', null, { message: 'connect ECONNREFUSED 51.89.234.14:587' }), 'connection'],
    ['ETIMEDOUT greeting never received', smtpError('ETIMEDOUT', 'CONN', null), 'connection'],
    ['421 4.7.0 too many connections (CONN)', smtpError('EPROTOCOL', 'CONN', '421 4.7.0 Too many concurrent SMTP connections'), 'transient'],
    ['450 4.2.0 greylisted at RCPT', rcptRejected([['anna@target.com', '450 4.2.0 <anna@target.com>: Recipient address rejected: Greylisted']]), 'transient'],
    ['451 4.7.1 try again later at RCPT', rcptRejected([['anna@target.com', '451 4.7.1 Service unavailable - try again later']]), 'transient'],
    ['452 4.2.2 mailbox full at RCPT', rcptRejected([['anna@target.com', '452 4.2.2 The email account that you tried to reach is over quota']]), 'transient'],
    ['454 4.7.0 TLS not available', smtpError('EPROTOCOL', 'STARTTLS', '454 4.7.0 TLS not available due to local problem'), 'transient'],
    ['550 5.7.1 relaying denied at RCPT', rcptRejected([['anna@target.com', '550 5.7.1 Relaying denied']]), 'rejected'],
    ['554 5.7.1 relay access denied at RCPT', rcptRejected([['anna@target.com', '554 5.7.1 <anna@target.com>: Relay access denied']]), 'rejected'],
    ['554 relay access denied without an enhanced code', rcptRejected([['anna@target.com', '554 Relay access denied']]), 'rejected'],
    ['550 5.4.1 recipient address rejected: access denied (Exchange Online)', rcptRejected([['anna@target.com', '550 5.4.1 Recipient address rejected: Access denied. AS(201806281)']]), 'rejected'],
    ['550 5.7.1 client host blocked (blocklist) at RCPT', rcptRejected([['anna@target.com', '550 5.7.1 Service unavailable; Client host [203.0.113.5] blocked using zen.spamhaus.org']]), 'rejected'],
    ['550 5.1.8 sender address rejected at RCPT', rcptRejected([['anna@target.com', '550 5.1.8 <sales@nulife.pl>: Sender address rejected: Domain not found']]), 'rejected'],
    // Postfix checks sender restrictions at RCPT TO (smtpd_delay_reject=yes):
    // reject_unlisted_sender answers with a 5.1.x code about OUR address.
    ['550 5.1.0 sender address rejected: user unknown, at RCPT (Postfix)', rcptRejected([['anna@target.com', '550 5.1.0 <sales@nulife.pl>: Sender address rejected: User unknown in virtual mailbox table']]), 'rejected'],
    ['550 5.1.1 sender address rejected, at RCPT', rcptRejected([['anna@target.com', '550 5.1.1 <sales@nulife.pl>: Sender address rejected']]), 'rejected'],
    ['550 5.1.0 sender rejected, single RCPT error without rejectedErrors', smtpError('EENVELOPE', 'RCPT TO', '550 5.1.0 <sales@nulife.pl>: Sender address rejected: User unknown in local recipient table', { rejected: ['anna@target.com'] }), 'rejected'],
    ['550 5.1.1 user unknown naming another address (not the recipient)', rcptRejected([['anna@target.com', '550 5.1.1 <sales@nulife.pl>: User unknown in virtual mailbox table']]), 'rejected'],
    ['550 5.1.1 recipient rejected by policy (sender-side wording wins)', rcptRejected([['anna@target.com', '550 5.1.1 <anna@target.com>: Recipient address rejected: blocked by policy']]), 'rejected'],
    ['553 5.1.7 bad sender address syntax at RCPT', rcptRejected([['anna@target.com', '553 5.1.7 The sender address <sales@> is not a valid RFC-5321 address']]), 'rejected'],
    ['552 5.2.2 mailbox full (permanent) at RCPT', rcptRejected([['anna@target.com', '552 5.2.2 Mailbox full']]), 'rejected'],
    ['550 generic "mailbox unavailable" at RCPT', rcptRejected([['anna@target.com', '550 Requested action not taken: mailbox unavailable']]), 'rejected'],
    ['550 5.7.1 sender rejected at MAIL FROM', smtpError('EENVELOPE', 'MAIL FROM', '550 5.7.1 Sender rejected: policy'), 'rejected'],
    ['554 5.7.1 message rejected as spam at DATA', smtpError('EMESSAGE', 'DATA', '554 5.7.1 Message rejected as spam'), 'rejected'],
    ['552 5.3.4 message too big at DATA', smtpError('EMESSAGE', 'DATA', '552 5.3.4 Message size exceeds fixed limit'), 'rejected'],
    ['550 5.1.1 after DATA is not RCPT-stage', smtpError('EMESSAGE', 'DATA', '550 5.1.1 <anna@target.com>: user unknown'), 'rejected'],
    ['bare 550 without a command (no stage)', Object.assign(new Error('rejected'), { responseCode: 550 }), 'rejected'],
    ['plain error, no code', new Error('something broke'), 'unknown'],
  ];

  for (const [name, err, kind] of cases) {
    it(`${name} → ${kind}, nobody suppressed`, () => {
      const c = classifySmtpError(err, ONE);
      expect(c.kind).toBe(kind);
      expect(c.hardRejectedRecipients).toEqual([]);
    });
  }
});

describe('classifySmtpError — recipient hard rejections at RCPT TO', () => {
  // [name, recipient as sent, server reply]
  const hard: Array<[string, string, string]> = [
    ['550 5.1.1 user unknown', 'Anna@Target.com', '550 5.1.1 <anna@target.com>: Recipient address rejected: User unknown in virtual mailbox table'],
    ['550-5.1.1 Gmail multi-line', 'Anna@Target.com', "550-5.1.1 The email account that you tried to reach does not exist. Please try double-checking"],
    ['550 5.1.10 null MX', 'Anna@Target.com', '550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup'],
    ['553 5.1.3 bad destination syntax', 'anna@target..com', '553 5.1.3 <anna@target..com>: Recipient address rejected: bad syntax'],
    ['550 5.1.2 bad destination system', 'anna@target.invalid', '550 5.1.2 <anna@target.invalid>: Host or domain name not found'],
    ['550 5.2.1 mailbox disabled', 'Anna@Target.com', '550 5.2.1 The email account that you tried to reach is disabled'],
    ['550 user unknown, no enhanced code', 'Anna@Target.com', '550 <anna@target.com>... User unknown'],
    ['550 no such user, no enhanced code', 'Anna@Target.com', '550 No such user here'],
    ['550 5.0.0 with user-unknown text', 'Anna@Target.com', '550 5.0.0 <anna@target.com>: User unknown'],
  ];
  for (const [name, recipient, response] of hard) {
    it(`${name} → recipient_hard for that address`, () => {
      const c = classifySmtpError(rcptRejected([[recipient, response]]), [recipient]);
      expect(c.kind).toBe('recipient_hard');
      expect(c.hardRejectedRecipients).toEqual([recipient.toLowerCase()]);
      expect(c.command).toBe('RCPT TO');
    });
  }

  it('mixed RCPT replies suppress only the unknown address', () => {
    const err = rcptRejected([
      ['gone@target.com', '550 5.1.1 <gone@target.com>: user unknown'],
      ['busy@target.com', '451 4.7.1 <busy@target.com>: greylisted, try again'],
    ]);
    const c = classifySmtpError(err, ['gone@target.com', 'busy@target.com']);
    expect(c.kind).toBe('recipient_hard');
    expect(c.hardRejectedRecipients).toEqual(['gone@target.com']);
  });

  it('never reports an address we did not send to', () => {
    const err = rcptRejected([['someone-else@target.com', '550 5.1.1 user unknown']]);
    expect(classifySmtpError(err, ONE).hardRejectedRecipients).toEqual([]);
  });

  it('without per-recipient detail, attributes only when there was one recipient', () => {
    const single = smtpError('EENVELOPE', 'RCPT TO', '550 5.1.1 user unknown');
    expect(classifySmtpError(single, ONE).hardRejectedRecipients).toEqual(['anna@target.com']);
    const several = smtpError('EENVELOPE', 'RCPT TO', '550 5.1.1 user unknown');
    expect(
      classifySmtpError(several, ['a@target.com', 'b@target.com']).hardRejectedRecipients,
    ).toEqual([]);
  });
});

describe('hardRejectedFromPartial — refusals on an accepted send', () => {
  it('keeps only attempted addresses refused as non-existent', () => {
    expect(
      hardRejectedFromPartial(
        [
          { address: 'Gone@Target.com', responseCode: 550, response: '550 5.1.1 user unknown' },
          { address: 'busy@target.com', responseCode: 451, response: '451 4.7.1 greylisted' },
          { address: 'policy@target.com', responseCode: 550, response: '550 5.7.1 relay denied' },
        ],
        ['gone@target.com', 'busy@target.com', 'policy@target.com'],
      ),
    ).toEqual(['gone@target.com']);
    expect(hardRejectedFromPartial(undefined, ONE)).toEqual([]);
  });
});

describe('enhanced status + stored failure text', () => {
  it('parses the enhanced code after the reply code, not an IP address', () => {
    expect(parseEnhancedStatus('550 5.1.1 <a@b>: user unknown')).toBe('5.1.1');
    expect(parseEnhancedStatus('550-5.1.10 not found')).toBe('5.1.10');
    expect(parseEnhancedStatus('550 Client host [5.1.2.3] blocked')).toBeNull();
    expect(parseEnhancedStatus(null)).toBeNull();
  });

  it('isRecipientHardRejection needs a permanent code', () => {
    expect(isRecipientHardRejection(450, '450 4.1.1 user unknown (try later)')).toBe(false);
    expect(isRecipientHardRejection(550, '550 5.1.1 user unknown')).toBe(true);
    expect(isRecipientHardRejection(null, '550 5.2.1 disabled')).toBe(true);
  });

  it('isRecipientHardRejection: a 5.1.x reply about the sender is never about the recipient', () => {
    expect(
      isRecipientHardRejection(
        550,
        '550 5.1.0 <sales@nulife.pl>: Sender address rejected: User unknown in virtual mailbox table',
        'anna@target.com',
      ),
    ).toBe(false);
    // Sender wording alone is enough, even without a recipient to compare.
    expect(
      isRecipientHardRejection(550, '550 5.1.1 <sales@nulife.pl>: Sender address rejected'),
    ).toBe(false);
    // A named address must be the recipient.
    expect(
      isRecipientHardRejection(550, '550 5.1.1 <other@target.com>: User unknown', 'anna@target.com'),
    ).toBe(false);
    expect(
      isRecipientHardRejection(550, '550 5.1.1 <Anna@Target.com>: User unknown', 'anna@target.com'),
    ).toBe(true);
  });

  it('hardRejectedFromPartial ignores sender-side refusals on an accepted send', () => {
    expect(
      hardRejectedFromPartial(
        [
          {
            address: 'anna@target.com',
            responseCode: 550,
            response: '550 5.1.0 <sales@nulife.pl>: Sender address rejected: User unknown',
          },
        ],
        ONE,
      ),
    ).toEqual([]);
  });

  it('reads stored failure reasons the way Retry needs', () => {
    expect(
      isRecipientHardBounceText(
        "550 Can't send mail - all recipients were rejected: 550 5.1.1 <a@x.com>: user unknown",
      ),
    ).toBe(true);
    expect(isRecipientHardBounceText('550 user unknown')).toBe(true);
    expect(isRecipientHardBounceText('535 Invalid login: 535 5.7.8 authentication failed')).toBe(false);
    expect(isRecipientHardBounceText('SMTP error: 554 transaction failed')).toBe(false);
    expect(isRecipientHardBounceText('421 4.7.0 try later')).toBe(false);
    expect(
      isRecipientHardBounceText(
        "550 Can't send mail - all recipients were rejected: 550 5.1.0 <sales@nulife.pl>: Sender address rejected: User unknown",
      ),
    ).toBe(false);
    expect(isRecipientHardBounceText(null)).toBe(false);
  });
});
