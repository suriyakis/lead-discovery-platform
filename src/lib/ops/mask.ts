// PC-07: masking for operational records (ops_events, job_heartbeats).
//
// Error messages from background work quote whatever the failing layer
// had in hand: an SMTP greeting with the login, a connection string with
// its password, a provider error echoing the API key, a recipient
// address. Ops records are read by people who must not see those (the
// platform console, later the tenant's incident list and alert sinks), so
// every message and payload string is masked BEFORE it is stored.
//
// Masking is deliberately lossy and conservative: it keeps the shape of
// the message (what failed, where) and drops the secrets and personal
// data in it.

const MAX_MESSAGE_LENGTH = 1000;

const REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  // Credentials in a URL: scheme://user:pass@host → scheme://***@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1***@'],
  // Authorization headers and bearer tokens.
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  // key=value / key: value pairs whose key names a secret.
  [
    /\b(pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    '$1$2[redacted]',
  ],
  // Well-known key prefixes, even when short.
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{6,}/g, '[redacted-key]'],
  [/\bAIza[0-9A-Za-z_-]{10,}/g, '[redacted-key]'],
  // E-mail addresses: keep the domain (it says which provider failed).
  [/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '***@$1'],
  // Long opaque tokens (API keys, session ids, UUIDs, hashes): 24+ word
  // characters mixing letters and digits.
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, '[redacted]'],
];

/** Mask secrets and personal data in a free-text message and cap its length. */
export function maskSensitive(text: string, maxLength: number = MAX_MESSAGE_LENGTH): string {
  let out = text;
  for (const [pattern, replacement] of REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > maxLength) out = `${out.slice(0, maxLength - 1)}…`;
  return out;
}

/** The masked name + message of anything thrown. */
export function describeError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return {
      name: err.name || 'Error',
      message: maskSensitive(err.message || String(err)),
    };
  }
  if (typeof err === 'string') return { name: 'Error', message: maskSensitive(err) };
  let text: string;
  try {
    text = JSON.stringify(err) ?? String(err);
  } catch {
    text = String(err);
  }
  return { name: 'Error', message: maskSensitive(text) };
}

/**
 * JSON-safe, masked copy of a payload: strings are masked, bigints become
 * strings, Dates ISO strings; depth, array length and key count are
 * bounded so a runaway summary cannot bloat a row.
 */
export function maskPayload(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return maskSensitive(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) return describeError(value);
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => maskPayload(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n++ >= 40) break;
      if (typeof v === 'function' || typeof v === 'symbol') continue;
      out[k] = maskPayload(v, depth + 1);
    }
    return out;
  }
  return null;
}
