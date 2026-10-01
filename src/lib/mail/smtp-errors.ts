// flow:F-05 (I007) — classify a failed SMTP submission before anything is
// suppressed. Pure: no DB, no network.
//
// The rule this module enforces: a send error may suppress a recipient
// ONLY when the receiving server rejected that recipient at the RCPT TO
// stage with a permanent "this address does not exist / is disabled"
// answer (enhanced status 5.1.x other than the sender-address codes
// 5.1.7 / 5.1.8, or 5.2.1; or a 550-class reply whose text says the user
// is unknown when no enhanced code is given). Everything else is about
// us or about the moment, never about the recipient:
//   - EAUTH / 530 / 534 / 535: our login was refused → the mailbox is
//     failing, not the prospect;
//   - connection errors (refused, timeout, TLS, DNS): no reply at all;
//   - any 4xx (421 / 450 / 451 / 452 / 454 …): greylisting, rate limits,
//     a full mailbox — try again later;
//   - any other 5xx (relay denied, policy / spam / reputation blocks,
//     message size, sender address problems, DATA-stage rejections).
//
// nodemailer shape (lib/smtp-connection): every server-reply error carries
// `code` ('EAUTH', 'EENVELOPE', 'EMESSAGE', 'ECONNECTION', …), `command`
// ('AUTH PLAIN', 'MAIL FROM', 'RCPT TO', 'DATA', 'CONN', …), `response`
// (the raw reply line) and `responseCode` (its leading digits). When every
// recipient is refused at RCPT TO it throws EENVELOPE with `rejected`
// (addresses) and `rejectedErrors` (one error per recipient, each with
// `recipient`, `response`, `responseCode`). When only some are refused the
// send succeeds and the same per-recipient errors come back on the result.
//
// The full taxonomy (stored stage + enhanced code on the failure row,
// queue backoff for transient failures) follows in F-28.

export type SmtpFailureKind =
  /** At least one recipient was refused as non-existent / disabled at RCPT TO. */
  | 'recipient_hard'
  /** The server refused our credentials — the mailbox is failing. */
  | 'auth'
  /** No usable SMTP reply: refused, reset, timeout, TLS or DNS failure. */
  | 'connection'
  /** A 4xx reply: greylisting, rate limit, full mailbox, service busy. */
  | 'transient'
  /** Any other permanent rejection — policy, relay, content, sender. */
  | 'rejected'
  /** Nothing we can read (no code, no reply). */
  | 'unknown';

export interface SmtpRecipientRejection {
  address: string;
  responseCode: number | null;
  response: string | null;
}

export interface SmtpFailureClassification {
  kind: SmtpFailureKind;
  responseCode: number | null;
  /** Enhanced status code (RFC 3463) from the reply, e.g. "5.1.1". */
  enhancedStatus: string | null;
  /** The SMTP command the server was answering, e.g. "RCPT TO". */
  command: string | null;
  /**
   * The only addresses a caller may suppress: recipients the server
   * refused as non-existent / disabled at RCPT TO, restricted to the
   * addresses we actually tried to send to (lower-cased).
   */
  hardRejectedRecipients: string[];
}

// The enhanced code follows the reply code ("550 5.1.1 …", "550-5.1.1 …").
// Anchoring on that keeps an IP address in the text ("[5.1.2.3]") from
// reading as a status code.
const ENHANCED_STATUS_RE = /(?:^|[^\d])[245]\d{2}[ -]([245])\.(\d{1,3})\.(\d{1,3})(?![.\d])/;

/** First RFC 3463 enhanced status code in an SMTP reply, or null. */
export function parseEnhancedStatus(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(ENHANCED_STATUS_RE);
  return m ? `${m[1]}.${Number(m[2])}.${Number(m[3])}` : null;
}

/**
 * Wording servers use for "this mailbox does not exist / is disabled" when
 * they send no enhanced status code. Deliberately narrow: RFC 5321's
 * generic "mailbox unavailable" also covers policy refusals, so it is
 * NOT on this list.
 */
const USER_UNKNOWN_RE = new RegExp(
  [
    String.raw`\buser unknown\b`,
    String.raw`\bunknown user\b`,
    String.raw`\bno such (?:user|mailbox|recipient|address|account)\b`,
    String.raw`\b(?:user|mailbox|recipient|address|account) (?:does not|doesn't|did not) exist\b`,
    String.raw`\b(?:user|mailbox|recipient) not found\b`,
    String.raw`\bunknown (?:recipient|mailbox|address)\b`,
    String.raw`\brecipient unknown\b`,
    String.raw`\binvalid (?:recipient|mailbox)\b`,
    String.raw`\b(?:mailbox|account|user) (?:is )?(?:disabled|deactivated)\b`,
  ].join('|'),
  'i',
);

/** Words that mean the refusal is about the sender, the content or policy. */
const SENDER_SIDE_RE =
  /relay|spam|block|blacklist|blocklist|denylist|policy|reputation|authenticat|rate limit|too many|spf|dkim|dmarc|reverse dns|\brdns\b|sender|not permitted|access denied/i;

/**
 * Does this single-recipient reply say the address does not exist / is
 * disabled? Only permanent (5xx) replies qualify; the enhanced code wins
 * when present, the text is a fallback for servers that send none (or the
 * uninformative 5.0.0).
 */
export function isRecipientHardRejection(
  responseCode: number | null | undefined,
  response: string | null | undefined,
): boolean {
  const text = response ?? '';
  const code = responseCode ?? leadingCode(text);
  if (code === null || code < 500 || code >= 600) return false;

  const enhanced = parseEnhancedStatus(text);
  if (enhanced && enhanced !== '5.0.0') {
    const [klass, subject, detail] = enhanced.split('.').map(Number);
    if (klass !== 5) return false;
    // X.1.7 / X.1.8 are about the SENDER's address (RFC 3463).
    if (subject === 1) return detail !== 7 && detail !== 8;
    // X.2.1: mailbox disabled, not accepting messages.
    return subject === 2 && detail === 1;
  }

  if (code !== 550 && code !== 551 && code !== 553) return false;
  if (SENDER_SIDE_RE.test(text)) return false;
  return USER_UNKNOWN_RE.test(text);
}

/**
 * Does a stored failure reason (as persisted on a failed mail_messages
 * row) read as a recipient hard bounce? Same rule as above, applied to
 * the free text; used for rows written before status 'bounced' was
 * reserved for recipient rejections.
 */
export function isRecipientHardBounceText(text: string | null | undefined): boolean {
  if (!text) return false;
  const m = text.match(/\b(5\d{2})\b/);
  if (!m) return false;
  return isRecipientHardRejection(Number(m[1]), text);
}

const CONNECTION_CODES: ReadonlySet<string> = new Set([
  'ECONNECTION',
  'ETIMEDOUT',
  'ESOCKET',
  'EDNS',
  'ETLS',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

const CONNECTION_TEXT_RE =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|connection (?:closed|refused|timeout|timed out)|greeting never received|socket|timed out|timeout/i;

interface SmtpErrorShape {
  code?: unknown;
  command?: unknown;
  response?: unknown;
  responseCode?: unknown;
  message?: unknown;
  recipient?: unknown;
  rejected?: unknown;
  rejectedErrors?: unknown;
}

/**
 * Classify a thrown send error. `attempted` is every address we tried to
 * deliver to (to + cc + bcc); hard rejections are only ever reported for
 * those addresses.
 */
export function classifySmtpError(
  err: unknown,
  attempted: ReadonlyArray<string>,
): SmtpFailureClassification {
  const e = (err && typeof err === 'object' ? err : {}) as SmtpErrorShape;
  const code = typeof e.code === 'string' ? e.code : null;
  const command = typeof e.command === 'string' ? e.command : null;
  const response = typeof e.response === 'string' ? e.response : null;
  const message =
    typeof e.message === 'string' ? e.message : err instanceof Error ? err.message : String(err ?? '');
  const responseCode =
    typeof e.responseCode === 'number' && Number.isFinite(e.responseCode)
      ? e.responseCode
      : leadingCode(response);
  const enhancedStatus = parseEnhancedStatus(response ?? message);
  const base = { responseCode, enhancedStatus, command };

  // 1. Our credentials were refused.
  const authByCode = responseCode === 534 || responseCode === 535;
  const authByEnhanced = enhancedStatus === '5.7.8' || enhancedStatus === '5.7.9';
  const authRequired =
    responseCode === 530 && /authenticat/i.test(`${response ?? ''} ${message}`);
  if (
    code === 'EAUTH' ||
    (command !== null && /^AUTH\b/i.test(command)) ||
    ((authByCode || authByEnhanced || authRequired) && !isRcpt(command))
  ) {
    return { kind: 'auth', ...base, hardRejectedRecipients: [] };
  }

  // 2. Recipient-stage rejections: decide per recipient.
  if (isRcpt(command)) {
    const rejections = collectRecipientRejections(e, attempted, responseCode, response);
    const wanted = new Set(attempted.map(normalize));
    const hard = unique(
      rejections
        .filter((r) => wanted.has(r.address))
        .filter((r) => isRecipientHardRejection(r.responseCode, r.response))
        .map((r) => r.address),
    );
    if (hard.length > 0) {
      return { kind: 'recipient_hard', ...base, hardRejectedRecipients: hard };
    }
    const anyTransient = rejections.some(
      (r) => r.responseCode !== null && r.responseCode >= 400 && r.responseCode < 500,
    );
    if (anyTransient || (responseCode !== null && responseCode < 500)) {
      return { kind: 'transient', ...base, hardRejectedRecipients: [] };
    }
    return { kind: 'rejected', ...base, hardRejectedRecipients: [] };
  }

  // 3. A server reply at any other stage — never about one recipient.
  if (responseCode !== null) {
    if (responseCode >= 400 && responseCode < 500) {
      return { kind: 'transient', ...base, hardRejectedRecipients: [] };
    }
    if (responseCode >= 500 && responseCode < 600) {
      return { kind: 'rejected', ...base, hardRejectedRecipients: [] };
    }
  }

  // 4. No reply at all.
  if ((code !== null && CONNECTION_CODES.has(code)) || CONNECTION_TEXT_RE.test(message)) {
    return { kind: 'connection', ...base, hardRejectedRecipients: [] };
  }
  return { kind: 'unknown', ...base, hardRejectedRecipients: [] };
}

/**
 * Per-recipient refusals that came back on a SUCCESSFUL send (some
 * recipients accepted, some refused). Returns the attempted addresses the
 * server refused as non-existent / disabled.
 */
export function hardRejectedFromPartial(
  rejected: ReadonlyArray<SmtpRecipientRejection> | undefined,
  attempted: ReadonlyArray<string>,
): string[] {
  if (!rejected || rejected.length === 0) return [];
  const wanted = new Set(attempted.map(normalize));
  return unique(
    rejected
      .map((r) => ({ ...r, address: normalize(r.address) }))
      .filter((r) => wanted.has(r.address))
      .filter((r) => isRecipientHardRejection(r.responseCode, r.response))
      .map((r) => r.address),
  );
}

// ---- internals -------------------------------------------------------

function isRcpt(command: string | null): boolean {
  return command !== null && /^RCPT\b/i.test(command);
}

function leadingCode(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.match(/^\s*(\d{3})\b/);
  return m ? Number(m[1]) : null;
}

function normalize(address: string): string {
  return address.trim().toLowerCase();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function collectRecipientRejections(
  e: SmtpErrorShape,
  attempted: ReadonlyArray<string>,
  responseCode: number | null,
  response: string | null,
): SmtpRecipientRejection[] {
  // Preferred: nodemailer's per-recipient errors.
  if (Array.isArray(e.rejectedErrors) && e.rejectedErrors.length > 0) {
    const out: SmtpRecipientRejection[] = [];
    for (const raw of e.rejectedErrors) {
      const r = (raw && typeof raw === 'object' ? raw : {}) as SmtpErrorShape;
      if (typeof r.recipient !== 'string') continue;
      const rResponse = typeof r.response === 'string' ? r.response : null;
      out.push({
        address: normalize(r.recipient),
        responseCode:
          typeof r.responseCode === 'number' ? r.responseCode : leadingCode(rResponse),
        response: rResponse,
      });
    }
    if (out.length > 0) return out;
  }
  // A single per-recipient error.
  if (typeof e.recipient === 'string') {
    return [{ address: normalize(e.recipient), responseCode, response }];
  }
  // Only the list of refused addresses: the last reply applies to all of
  // them only when there was exactly one.
  if (Array.isArray(e.rejected)) {
    const addrs = e.rejected.filter((a): a is string => typeof a === 'string');
    if (addrs.length === 1) {
      return [{ address: normalize(addrs[0]!), responseCode, response }];
    }
    return [];
  }
  // No per-recipient detail: attributable only when we sent to one address.
  if (attempted.length === 1) {
    return [{ address: normalize(attempted[0]!), responseCode, response }];
  }
  return [];
}
