// Legacy URLs the IA retired, and where each one goes now (DS-05).
//
// The old pages stay as redirect stubs (src/app/dashboard/page.tsx,
// src/app/inbox/page.tsx) so bookmarks, stored notification hrefs and old
// e-mails keep working: each stub answers a permanent redirect (308) to
// legacyRedirectTarget(). The query string is kept — /inbox?tab=drafts
// lands on /today?tab=drafts — so a deep link survives the move.
// docs/design/IA.md lists the same table; src/tests/nav-registry.test.ts
// pins every row.

import { HOME_PATH } from './registry';

export interface LegacyRedirect {
  /** The retired page (a src/app pattern). */
  from: string;
  /** Where it lives now; may carry a query of its own. */
  to: string;
  /** Why it moved. */
  reason: string;
}

export const LEGACY_REDIRECTS: ReadonlyArray<LegacyRedirect> = [
  {
    from: '/dashboard',
    to: `${HOME_PATH}?view=overview`,
    reason: 'Today replaces the dashboard; its signals are the Overview tab.',
  },
  {
    from: '/inbox',
    to: HOME_PATH,
    reason: 'Today replaces the approval inbox; ?tab picks the same section.',
  },
];

type SearchParamsInput =
  | URLSearchParams
  | Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;

function toSearchParams(input: SearchParamsInput | undefined): URLSearchParams {
  if (!input) return new URLSearchParams();
  if (input instanceof URLSearchParams) return new URLSearchParams(input);
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    for (const one of typeof v === 'string' ? [v] : v) out.append(k, one);
  }
  return out;
}

/**
 * The target for a retired URL: the row's destination with the visitor's
 * own query parameters added (the row's own parameters win on a clash).
 */
export function legacyRedirectTarget(from: string, search?: SearchParamsInput): string {
  const row = LEGACY_REDIRECTS.find((r) => r.from === from);
  if (!row) throw new Error(`no legacy redirect for ${from}`);
  const target = new URL(row.to, 'http://nav.invalid');
  for (const [k, v] of toSearchParams(search)) {
    if (!target.searchParams.has(k)) target.searchParams.append(k, v);
  }
  const query = target.searchParams.toString();
  return query ? `${target.pathname}?${query}` : target.pathname;
}
