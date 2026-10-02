// PC-08: the owner-alert sink. Publishes an AlertMessage to an ntfy topic
// with ntfy's JSON publishing API (POST to the server root with the topic
// in the body: no header encoding limits on titles, one request shape for
// ntfy.sh and self-hosted servers).
//
// Never throws: a failure comes back as { ok: false, error } with the
// error masked AND scrubbed of the topic and the token, so a failure
// stored or shown anywhere cannot leak them.

import type { NtfyTarget } from './alert-config';
import type { AlertMessage } from './alert-messages';
import { describeError, maskSensitive } from './mask';

export const NTFY_TIMEOUT_MS = 5000;
/** ntfy turns a message over 4096 bytes into an attachment; stay below. */
export const NTFY_MAX_MESSAGE_BYTES = 3800;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface SinkResult {
  ok: boolean;
  /** HTTP status of the answer, null when there was none. */
  httpStatus: number | null;
  /** Masked, topic- and token-free. Null on success. */
  error: string | null;
}

/** Cut a string to at most `maxBytes` of UTF-8, on a character boundary. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = '';
  let bytes = 0;
  const budget = maxBytes - Buffer.byteLength('…', 'utf8');
  for (const ch of text) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > budget) break;
    out += ch;
    bytes += b;
  }
  return `${out}…`;
}

export interface NtfyRequest {
  url: string;
  init: { method: 'POST'; headers: Record<string, string>; body: string };
}

/** Pure: the HTTP request that publishes `message`. */
export function buildNtfyRequest(target: NtfyTarget, message: AlertMessage): NtfyRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (target.token) headers.Authorization = `Bearer ${target.token}`;
  const body: Record<string, unknown> = {
    topic: target.topic,
    title: message.title,
    message: truncateUtf8(message.body, NTFY_MAX_MESSAGE_BYTES),
    priority: message.priority,
    tags: message.tags,
  };
  if (message.click) body.click = message.click;
  return {
    url: `${target.serverUrl}/`,
    init: { method: 'POST', headers, body: JSON.stringify(body) },
  };
}

/** Replace the topic and token wherever they appear, then mask. */
export function scrubSinkError(text: string, target: NtfyTarget): string {
  let out = text;
  for (const [secret, label] of [
    [target.token, '[token]'],
    [target.topic, '[topic]'],
  ] as const) {
    if (secret) out = out.split(secret).join(label);
  }
  return maskSensitive(out, 300);
}

function causeCode(err: unknown): string | null {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : null;
}

export async function sendNtfy(
  target: NtfyTarget,
  message: AlertMessage,
  options: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<SinkResult> {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? NTFY_TIMEOUT_MS;
  const req = buildNtfyRequest(target, message);
  try {
    const res = await doFetch(req.url, { ...req.init, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return { ok: true, httpStatus: res.status, error: null };
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      // The status says enough.
    }
    return {
      ok: false,
      httpStatus: res.status,
      error: scrubSinkError(`ntfy answered ${res.status}${detail ? `: ${detail}` : ''}`, target),
    };
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return {
        ok: false,
        httpStatus: null,
        error: `ntfy did not answer within ${Math.round(timeoutMs / 1000)} s`,
      };
    }
    // Scrub the RAW text first: masking could split the topic and leave
    // part of it behind for the scrub to miss.
    const raw = err instanceof Error ? err.message || err.name : describeError(err).message;
    const code = causeCode(err);
    return {
      ok: false,
      httpStatus: null,
      error: scrubSinkError(code ? `${raw} (${code})` : raw, target),
    };
  }
}
