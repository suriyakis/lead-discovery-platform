/**
 * Typed error handling for server (form) actions.
 *
 * Every service module throws its own `XxxServiceError` carrying a
 * machine `code` ('permission_denied', 'not_found', 'conflict',
 * 'invalid_input', 'insufficient_tokens', ...). A form action that lets
 * one of those escape crashes the whole page into the error boundary,
 * even though the failure is expected and the operator only needs a
 * sentence explaining it (I078).
 *
 * `describeActionError` is the one place that turns such an error into
 * that sentence. It is deliberately strict about what it handles:
 *
 *   - Next's redirect()/notFound() control-flow throws are rethrown, so
 *     it is safe to call from any catch block.
 *   - Only instances of the service-error classes the caller lists are
 *     described. Anything else (a bug, a DB outage) is rethrown and
 *     reaches app/error.tsx, the branded backstop — we never dress an
 *     unknown failure up as a friendly banner, and we never echo an
 *     unknown error's message (it may carry SQL or provider detail).
 *
 * What a `not_found` or `conflict` *means* differs per action (a double
 * submit of "end session" is a success; "connector is inactive" is not),
 * so the caller decides how to flash it — this module only classifies and
 * phrases.
 *
 * Usage inside a server action:
 *
 *   try {
 *     await approveReviewItem(ctx, id, reason);
 *   } catch (err) {
 *     const failure = describeActionError(err, [ReviewServiceError]);
 *     redirect(withFlash(`/review/${id}`, { error: failure.message }));
 *   }
 *   redirect(`/review/${id}`);
 */

import { isNextRedirectError } from '@/lib/server-redirect';

/** The shape every service error class in src/lib/services shares. */
export interface CodedError extends Error {
  readonly code: string;
}

/** A service error class, e.g. `ReviewServiceError` or `TokenError`. */
export type CodedErrorClass = abstract new (...args: never[]) => CodedError;

export interface ActionFailure {
  /** The service error code, normalised (`forbidden` → `permission_denied`). */
  code: string;
  /** One readable sentence for an `?error=` / `?message=` flash. */
  message: string;
}

/** Longest flash text we put in a URL. Service messages are short; this
 *  only guards against a pathological one blowing up the redirect URL. */
export const MAX_FLASH_LENGTH = 300;

export const DEFAULT_ACTION_MESSAGES: Readonly<Record<string, string>> = {
  permission_denied:
    "You don't have permission to do that. Ask a workspace admin if you need it.",
  // Role-neutral: the people who hit this (members and managers clicking
  // Generate draft or Run now) can't buy — only workspace admins can.
  insufficient_tokens:
    'No tokens left — a workspace admin can buy a token pack in Settings → Billing.',
  not_found: 'That item no longer exists — it may have been removed in the meantime.',
  conflict:
    'That item changed in the meantime, so nothing was done. Reload the page to see its current state.',
};

export const FALLBACK_ACTION_MESSAGE =
  "That didn't work. Try again — if it keeps happening, contact support.";

const CODE_ALIASES: Readonly<Record<string, string>> = {
  forbidden: 'permission_denied',
};

/**
 * Classify an error thrown inside a server action.
 *
 * @param err       whatever the catch block caught
 * @param expected  the service-error classes this action knows how to explain
 * @param messages  per-action wording that overrides the defaults, keyed by code
 * @throws          the original error when it is a Next redirect/notFound, or
 *                  when it is not an instance of one of `expected`
 */
export function describeActionError(
  err: unknown,
  expected: readonly CodedErrorClass[],
  messages: Readonly<Partial<Record<string, string>>> = {},
): ActionFailure {
  if (isNextRedirectError(err)) throw err;
  const typed = expected.some((cls) => err instanceof cls) ? (err as CodedError) : null;
  if (!typed || typeof typed.code !== 'string') throw err;

  const code = CODE_ALIASES[typed.code] ?? typed.code;
  const override = messages[code];
  if (override) return { code, message: clampFlash(override) };

  const known = DEFAULT_ACTION_MESSAGES[code];
  if (known) return { code, message: known };

  // Validation messages are written for the person who submitted the
  // form ("comment too long (5000 char max)") — show them, tidied up.
  if (code === 'invalid_input' && typed.message.trim()) {
    return { code, message: clampFlash(asSentence(typed.message)) };
  }

  // invariant_violation, internal, …: a bug or a race we did not plan
  // for. Tell the operator plainly and leave the detail in the logs.
  console.error(`[action] ${typed.name} (${code}):`, typed);
  return { code, message: FALLBACK_ACTION_MESSAGE };
}

/**
 * Append flash params to an in-app path, keeping any existing query string
 * and #hash. Values are encoded with URLSearchParams (spaces become '+',
 * which Next decodes back into spaces in `searchParams`).
 */
export function withFlash(
  path: string,
  flash: { message?: string | null; error?: string | null },
): string {
  const url = new URL(path, 'http://flash.invalid');
  if (flash.message) url.searchParams.set('message', clampFlash(flash.message));
  if (flash.error) url.searchParams.set('error', clampFlash(flash.error));
  return `${url.pathname}${url.search}${url.hash}`;
}

/** A `searchParams` flash value as safe display text (arrays and empty values dropped). */
export function flashText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? clampFlash(trimmed) : null;
}

function clampFlash(text: string): string {
  return text.length > MAX_FLASH_LENGTH ? `${text.slice(0, MAX_FLASH_LENGTH - 1)}…` : text;
}

function asSentence(text: string): string {
  const t = text.trim();
  const capped = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…)]$/.test(capped) ? capped : `${capped}.`;
}
