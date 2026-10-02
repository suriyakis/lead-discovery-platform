// flow:F-04 — describe and explain a mailbox connection failure. Pure: no
// DB, no network.
//
// Two problems this solves:
//   1. imapflow throws a bare `Error('Command failed')` for a refused IMAP
//      LOGIN and puts what matters on side properties
//      (`authenticationFailed`, `serverResponseCode`, `response`,
//      `responseText`). Storing only `.message` left prod with 13 identical
//      "Command failed" errors and no clue — and, because the text carried
//      no auth signature, the mailbox was retried as "transient" ten times
//      before it was paused (fail2ban bait on a shared host).
//   2. A stored error such as "connect ECONNREFUSED 51.89.234.14:587" is
//      not something an operator can act on. adviseConnectionFailure turns
//      it into a next step ("this server only takes port 465 …").

export type MailProtocol = 'smtp' | 'imap';

/** What kind of failure a stored / thrown error describes. */
export type ConnectionFailureCause =
  /** The server refused our credentials. */
  | 'auth'
  /** Nothing listens on that host:port (ECONNREFUSED). */
  | 'refused'
  /** No answer in time. */
  | 'timeout'
  /** The host name does not resolve. */
  | 'dns'
  /** TLS / STARTTLS handshake failure (often the wrong port for the mode). */
  | 'tls'
  | 'other';

/** The parts of a mailbox row the advice reads. */
export interface MailboxEndpoints {
  smtpHost: string;
  smtpPort: number;
  imapHost: string | null;
  imapPort: number | null;
}

/** IMAP response codes (RFC 5530) that mean "your credentials are wrong". */
const AUTH_RESPONSE_CODES = new Set(['AUTHENTICATIONFAILED', 'AUTHORIZATIONFAILED', 'EXPIRED']);

/**
 * Substrings imapflow / Dovecot / Outlook / Gmail / nodemailer use for a
 * refused login. Case-insensitive. Biased toward "auth": calling a
 * transient error auth costs one fewer retry, the reverse costs a stream of
 * bad logins.
 */
export const AUTH_FAILURE_SIGNATURES: readonly string[] = [
  'AUTHENTICATIONFAILED',
  'Invalid credentials',
  'Authentication failed',
  'auth failed',
  'LOGIN failed',
  'LOGIN_DISABLED',
  'AUTHORIZATIONFAILED',
  'Application-specific password required',
  'incorrect password',
  'bad password',
  'Account is disabled',
  'Account locked',
  'Invalid login',
  'Username and Password not accepted',
  'authentication unsuccessful',
  'EAUTH',
];

/** Does this text read like a refused login? */
export function looksLikeAuthFailure(text: string): boolean {
  const lower = text.toLowerCase();
  if (AUTH_FAILURE_SIGNATURES.some((sig) => lower.includes(sig.toLowerCase()))) return true;
  // SMTP 534 / 535 replies and the 5.7.8 / 5.7.9 / 5.7.14 enhanced codes.
  return /(?:^|[^\d.])53[45][ -]/.test(text) || /\b5\.7\.(?:8|9|14)\b/.test(text);
}

interface ErrorShape {
  message?: unknown;
  code?: unknown;
  authenticationFailed?: unknown;
  serverResponseCode?: unknown;
  response?: unknown;
  responseText?: unknown;
}

/** Did a thrown error come from a refused login (imapflow or nodemailer)? */
export function isAuthFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as ErrorShape;
  if (e.authenticationFailed === true) return true;
  if (e.code === 'EAUTH') return true;
  if (
    typeof e.serverResponseCode === 'string' &&
    AUTH_RESPONSE_CODES.has(e.serverResponseCode.toUpperCase())
  ) {
    return true;
  }
  return false;
}

/**
 * One line that keeps what the server said. imapflow's "Command failed"
 * gains its response code and text ("Command failed: [AUTHENTICATIONFAILED]
 * Authentication failed."); nodemailer messages already carry the reply.
 */
export function describeConnectionError(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const e = err as ErrorShape;
  const message = typeof e.message === 'string' && e.message.trim() ? e.message.trim() : String(err);
  const extra: string[] = [];
  const code = typeof e.serverResponseCode === 'string' ? e.serverResponseCode.trim() : '';
  if (code && !message.includes(code)) extra.push(`[${code}]`);
  const text =
    typeof e.responseText === 'string'
      ? e.responseText.trim()
      : typeof e.response === 'string'
        ? e.response.trim()
        : '';
  if (text && !message.includes(text)) extra.push(text);
  return extra.length > 0 ? `${message}: ${extra.join(' ')}` : message;
}

/** Classify a stored or described error by its text. */
export function classifyConnectionFailure(message: string): ConnectionFailureCause {
  if (looksLikeAuthFailure(message)) return 'auth';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return 'dns';
  if (/ECONNREFUSED|connection refused/i.test(message)) return 'refused';
  if (
    /wrong version number|ssl3_get_record|EPROTO|handshake|certificate|self[- ]signed|unable to verify|\bTLS\b|\bSSL\b/i.test(
      message,
    )
  ) {
    return 'tls';
  }
  if (/ETIMEDOUT|timed? ?out|timeout|greeting never received/i.test(message)) {
    return 'timeout';
  }
  return 'other';
}

// ---- PC-09: the failure class that drives recovery --------------------

/**
 * PC-09 — what a mailbox failure means for recovery (mailboxes.failure_class):
 *
 *   auth        the server refused our credentials (or one is missing).
 *               Retrying cannot help and every retry is one more failed
 *               login on what is often a shared host running fail2ban, so
 *               nothing retries it automatically: the owner fixes the
 *               settings (saving them runs one check) or clicks Test again.
 *   connection  the server could not be reached: refused, timed out, DNS,
 *               TLS, a dropped socket. No login happened, so probing is
 *               safe: credential-free probes back off from 30 min to 6 h,
 *               and one authenticated check follows once the host answers.
 *   ambiguous   anything else (imapflow's bare "Command failed", an odd
 *               reply): it may be a refused login in disguise, so at most
 *               one authenticated attempt per 6 h and four in total.
 */
export const MAILBOX_FAILURE_CLASSES = ['auth', 'connection', 'ambiguous'] as const;
export type MailboxFailureClass = (typeof MAILBOX_FAILURE_CLASSES)[number];

/** Node / nodemailer / imapflow error codes that mean "never got a
 *  usable connection" — no credentials were sent. */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'EPROTO',
  // nodemailer
  'ECONNECTION',
  'ESOCKET',
  'EDNS',
  'ETLS',
  // imapflow
  'NoConnection',
  'ConnectionClosed',
  'ConnectionTimeout',
  'GreetingTimeout',
  'UpgradeTimeout',
]);

/** Texts of a connection that dropped or never came up (beyond the
 *  refused / timeout / DNS / TLS causes classifyConnectionFailure names),
 *  and SMTP 421 (service not available, closing the channel). */
const CONNECTION_TEXT =
  /socket hang up|connection (?:closed|lost|reset|ended)|unexpected close|closed unexpectedly|network is unreachable|host is unreachable|no route to host|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|^421\b|\b421[ -]/i;

/**
 * PC-09: classify a mailbox failure for recovery. Takes what was thrown
 * (its structured flags and codes win) or, for a stored / described error,
 * only its text. Auth is checked first and biased toward "auth" (see
 * AUTH_FAILURE_SIGNATURES): misreading a refused login as anything else
 * would retry a login. A missing password is an auth failure too: only
 * the owner can fix it.
 */
export function classifyMailboxFailure(input: {
  error?: unknown;
  message?: string | null;
}): MailboxFailureClass {
  const err = input.error;
  if (err !== undefined && isAuthFailure(err)) return 'auth';
  const text = (input.message ?? (err !== undefined ? describeConnectionError(err) : '')).trim();
  if (looksLikeAuthFailure(text)) return 'auth';
  if (/password missing|secret[_ ]missing/i.test(text)) return 'auth';
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)) return 'connection';
  }
  const cause = classifyConnectionFailure(text);
  if (cause === 'refused' || cause === 'timeout' || cause === 'dns' || cause === 'tls') {
    return 'connection';
  }
  if (CONNECTION_TEXT.test(text)) return 'connection';
  return 'ambiguous';
}

/** The port named in "connect ECONNREFUSED 1.2.3.4:587" style messages. */
export function portFromMessage(message: string): number | null {
  // Greedy \S* so the LAST colon wins ("::1:465" is IPv6 ::1, port 465).
  const m = message.match(/(?:ECONNREFUSED|ETIMEDOUT|ECONNRESET)\s+\S*:(\d{1,5})\b/i);
  if (!m) return null;
  const port = Number(m[1]);
  return port > 0 && port <= 65535 ? port : null;
}

/**
 * Split a stored lastError ("SMTP: …", "IMAP: …", or a legacy unprefixed
 * IMAP message such as "Command failed") into protocol and message.
 * Legacy rows also hold "SMTP connect ECONNREFUSED …" (no colon).
 */
export function parseStoredMailboxError(lastError: string | null | undefined): {
  protocol: MailProtocol;
  message: string;
} {
  const raw = (lastError ?? '').trim();
  if (!raw) return { protocol: 'imap', message: 'unknown error (no message was recorded)' };
  const m = raw.match(/^(SMTP|IMAP)\b\s*:?\s*/i);
  if (!m) return { protocol: 'imap', message: raw };
  const rest = raw.slice(m[0].length).trim();
  return {
    protocol: m[1]!.toLowerCase() as MailProtocol,
    message: rest || 'unknown error (no message was recorded)',
  };
}

const EDIT = 'under Edit settings';

/**
 * The next step for an operator, in one or two sentences. Port-aware: a
 * refused 587 on a host that only takes implicit TLS (the Plesk host behind
 * workspace 1's mailbox listens on 25 / 465 / 993 only) points at 465.
 */
export function adviseConnectionFailure(
  protocol: MailProtocol,
  message: string,
  endpoints: MailboxEndpoints,
): string {
  const cause = classifyConnectionFailure(message);
  const host = protocol === 'smtp' ? endpoints.smtpHost : (endpoints.imapHost ?? 'the IMAP host');
  const configuredPort = protocol === 'smtp' ? endpoints.smtpPort : endpoints.imapPort;
  const port = portFromMessage(message) ?? configuredPort;
  const label = protocol === 'smtp' ? 'SMTP' : 'IMAP';
  const thenTest = 'then click Test again.';

  switch (cause) {
    case 'auth':
      return (
        `The ${label} server refused the login. Check the user name and password ${EDIT} ` +
        `(some providers require an app password), ${thenTest} ` +
        'Nothing retries the login automatically, so the server does not block us for repeated failed logins; saving the settings runs one check.'
      );
    case 'refused':
      if (protocol === 'smtp' && port === 587) {
        return (
          `${host} refused connections on SMTP port 587. Many hosting mail servers accept ` +
          `authenticated mail only on port 465 with TLS on connect: set the SMTP port to 465 ${EDIT}, ${thenTest}`
        );
      }
      if (protocol === 'smtp' && port === 465) {
        return `${host} refused connections on SMTP port 465. Try port 587 (STARTTLS) ${EDIT}, ${thenTest}`;
      }
      if (protocol === 'smtp' && port === 25) {
        return (
          `${host} refused connections on SMTP port 25, which is often closed to logins. ` +
          `Use port 465 (TLS on connect) or 587 (STARTTLS) ${EDIT}, ${thenTest}`
        );
      }
      if (protocol === 'imap' && port === 143) {
        return `${host} refused connections on IMAP port 143. Try port 993 (TLS on connect) ${EDIT}, ${thenTest}`;
      }
      return (
        `${host} refused connections on ${label} port ${port ?? '(unknown)'}. Check the host and port ${EDIT} ` +
        `(${protocol === 'smtp' ? '465 = TLS on connect, 587 = STARTTLS' : '993 = TLS on connect, 143 = STARTTLS'}), ${thenTest}`
      );
    case 'dns':
      return `The host name ${host} could not be found. Check it ${EDIT}, ${thenTest}`;
    case 'tls':
      return (
        `The TLS handshake with ${host} failed. ` +
        `${protocol === 'smtp' ? 'Port 465 uses TLS on connect and 587 uses STARTTLS' : 'Port 993 uses TLS on connect and 143 uses STARTTLS'}` +
        ` — check the port and the SSL/TLS setting ${EDIT}, ${thenTest}`
      );
    case 'timeout':
      return (
        `${host} did not answer on ${label} port ${port ?? '(unknown)'}. Check the host and port ${EDIT}, ` +
        `or whether the server is down, ${thenTest}`
      );
    default:
      return `Check the ${label} settings ${EDIT}, ${thenTest}`;
  }
}
