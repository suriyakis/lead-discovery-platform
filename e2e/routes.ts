// Route list for the Playwright smoke test (e2e/smoke.spec.ts).
//
// Derived from src/app: every page.tsx is a route pattern. Static patterns
// are visited as-is; dynamic ones ([id] segments) need a concrete path in
// SEEDED_PATHS, pointing at a row scripts/seed-demo.ts creates. The seed
// is deterministic (TRUNCATE … RESTART IDENTITY, then a fixed insert
// order), so these ids are stable. smokeRoutes() throws when a new
// dynamic page has no entry, and src/tests/e2e-routes.test.ts checks the
// list in the normal Vitest run, so a new page can't silently go untested.

import { readdirSync } from 'node:fs';
import path from 'node:path';
import knownIssuesJson from './known-issues.json';

/** Concrete paths for dynamic route patterns, from scripts/seed-demo.ts. */
export const SEEDED_PATHS: Readonly<Record<string, string>> = {
  '/admin/support/[id]': '/admin/support/1',
  // demo-member@example.com (the admin's own row works too; this is the
  // more interesting one: a plain member with workspace memberships).
  '/admin/users/[id]': '/admin/users/0d3e0000-0000-4000-8000-00000000a002',
  '/admin/workspaces/[id]': '/admin/workspaces/1',
  // Thread with a linked lead, a translation pair and the reply panel.
  '/communication/[threadId]': '/communication/7',
  '/connectors/[id]': '/connectors/1',
  '/connectors/[id]/recipes/[recipeId]': '/connectors/1/recipes/1',
  '/connectors/[id]/recipes/new': '/connectors/1/recipes/new',
  '/connectors/[id]/runs/[runId]': '/connectors/1/runs/1',
  '/contacts/[id]': '/contacts/1',
  '/documents/[id]': '/documents/1',
  // status 'draft': the approve / reject decision forms render.
  '/drafts/[id]': '/drafts/39',
  '/knowledge/[id]': '/knowledge/1',
  '/learning/[id]': '/learning/1',
  '/mailbox/[id]': '/mailbox/1',
  '/mailbox/[id]/compose': '/mailbox/1/compose',
  '/mailbox/[id]/edit': '/mailbox/1/edit',
  '/mailbox/[id]/test': '/mailbox/1/test',
  '/mailbox/threads/[id]': '/mailbox/threads/1',
  '/pipeline/[id]': '/pipeline/1',
  '/products/[id]': '/products/1',
  // state 'needs_review': approve / reject / generate-draft forms render.
  '/review/[id]': '/review/8',
  '/settings/crm/[id]': '/settings/crm/1',
  '/support/[id]': '/support/1',
};

/** Other states of a page whose layout differs enough to visit too. */
export const EXTRA_PATHS: ReadonlyArray<string> = [
  '/drafts/1', // approved draft: the enqueue panel instead of the decisions
  '/pipeline?view=kanban',
  '/inbox?tab=drafts', // the retired URL: a 308 to /today?tab=drafts
  '/today?tab=drafts',
  '/today?view=overview',
  '/communication?folder=sent',
];

/** Patterns the smoke test deliberately does not visit, and why. */
export const SKIPPED_PATTERNS: Readonly<Record<string, string>> = {
  // It can't pass the generic "status < 500" visit by design. The
  // "branded backstop pages" block in e2e/smoke.spec.ts visits it with its
  // own expectations (500 + app/error.tsx) when ENABLE_TEST_ROUTES=1.
  '/test-only/error-boundary':
    'throws on purpose (404 unless ENABLE_TEST_ROUTES=1); visited by the "branded backstop pages" smoke tests',
};

/**
 * Pages that send the signed-in demo admin somewhere else. The smoke test
 * asserts the landing pathname, which also proves the session cookie
 * worked (a signed-out visit would land on "/").
 */
export const EXPECTED_LANDING: Readonly<Record<string, RegExp>> = {
  '/': /^\/today$/,
  '/pending': /^\/today$/,
  // DS-05: the retired home pages redirect (308) to Today.
  '/dashboard': /^\/today$/,
  '/inbox': /^\/today$/,
  '/inbox?tab=drafts': /^\/today$/,
  // The first Settings page in the navigation registry.
  '/settings': /^\/settings\/members$/,
  '/mailbox/threads/1': /^\/communication\/1$/, // legacy URL, 308 to the thread viewer
};

export interface SmokeRoute {
  /** The src/app pattern the visit exercises, e.g. "/review/[id]". */
  pattern: string;
  /** What the browser opens. */
  path: string;
  /** The pathname the page must end up on. */
  landsOn: RegExp;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "/review/[id]" → /^\/review\/[^/]+$/ (catch-all segments match the rest). */
export function patternToRegExp(pattern: string): RegExp {
  const body = pattern
    .split('/')
    .map((seg) => {
      if (/^\[\[?\.\.\..+\]\]?$/.test(seg)) return '.+';
      if (/^\[.+\]$/.test(seg)) return '[^/]+';
      return escapeRe(seg);
    })
    .join('/');
  return new RegExp(`^${body}$`);
}

/**
 * Every page route under src/app, as a pattern ("/", "/review/[id]", …).
 * Route groups "(x)" don't appear in the URL; parallel-route slots "@x"
 * and private folders "_x" aren't routes of their own.
 */
export function appRoutePatterns(appDir = path.resolve(process.cwd(), 'src/app')): string[] {
  const files = readdirSync(appDir, { recursive: true, encoding: 'utf8' });
  const patterns = new Set<string>();
  for (const file of files) {
    const parts = file.split(/[\\/]/);
    if (parts.at(-1) !== 'page.tsx' && parts.at(-1) !== 'page.ts') continue;
    const dirs = parts.slice(0, -1);
    if (dirs.some((d) => d.startsWith('@') || d.startsWith('_'))) continue;
    const segs = dirs.filter((d) => !(d.startsWith('(') && d.endsWith(')')));
    patterns.add(`/${segs.join('/')}`);
  }
  return [...patterns].sort();
}

const pathnameOf = (p: string) => new URL(p, 'http://smoke.invalid').pathname;

/** The full visit list: every app route (minus SKIPPED) plus EXTRA_PATHS. */
export function smokeRoutes(patterns: ReadonlyArray<string> = appRoutePatterns()): SmokeRoute[] {
  const routes: SmokeRoute[] = [];
  const unmapped: string[] = [];
  for (const pattern of patterns) {
    if (pattern in SKIPPED_PATTERNS) continue;
    const isDynamic = pattern.includes('[');
    const routePath = isDynamic ? SEEDED_PATHS[pattern] : pattern;
    if (!routePath) {
      unmapped.push(pattern);
      continue;
    }
    routes.push({ pattern, path: routePath, landsOn: landingFor(routePath) });
  }
  if (unmapped.length > 0) {
    throw new Error(
      `e2e/routes.ts: no seeded path for ${unmapped.join(', ')} — add one to SEEDED_PATHS ` +
        '(an id scripts/seed-demo.ts creates) or a reason to SKIPPED_PATTERNS.',
    );
  }
  for (const extra of EXTRA_PATHS) {
    const pattern = patterns.find((p) => patternToRegExp(p).test(pathnameOf(extra)));
    if (!pattern) throw new Error(`e2e/routes.ts: EXTRA_PATHS entry ${extra} matches no app route`);
    routes.push({ pattern, path: extra, landsOn: landingFor(extra) });
  }
  return routes;
}

function landingFor(routePath: string): RegExp {
  return EXPECTED_LANDING[routePath] ?? new RegExp(`^${escapeRe(pathnameOf(routePath))}$`);
}

// ---- known issues ---------------------------------------------------------
//
// e2e/known-issues.json lists defects that are already tracked and owned
// by another deliverable, so the smoke test stays green while they are
// open. A known failure is tolerated (and annotated on the test), never
// required: the same page can behave differently under `next dev` and a
// production build. Delete the entry in the PR that fixes the defect.

export type SmokeCheck = 'status' | 'pageerror' | 'overflow';

export interface KnownIssue {
  /** Audit id of the tracked defect (I…/X…). */
  id: string;
  check: SmokeCheck;
  /**
   * Visit paths exactly as in the smoke route list, or "*" for every route.
   * Prefer the paths where the defect was seen: a wildcard also hides the
   * same failure on routes that never had it.
   */
  paths: string[];
  /**
   * For `pageerror`: only errors whose message contains this text (or any
   * of these texts). A production build minifies React's messages, so a
   * hydration failure there reads "Minified React error #418", not
   * "Hydration failed" — list both when the defect is real in both.
   */
  match?: string | string[];
  /** Only tolerated against `next dev`; a production server must pass. */
  devServerOnly?: boolean;
  note: string;
}

export const KNOWN_ISSUES: ReadonlyArray<KnownIssue> = knownIssuesJson as KnownIssue[];

/**
 * Whether the smoke runs against `next dev`. The CI job builds the app and
 * runs `next start`; local runs use `next dev` (see playwright.config.ts).
 * E2E_SERVER=dev|prod overrides the guess.
 */
export function againstDevServer(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  if (env.E2E_SERVER === 'dev') return true;
  if (env.E2E_SERVER === 'prod') return false;
  return !env.CI;
}

/**
 * The tracked issue that explains `check` failing on `visitPath`, if any.
 * The first matching entry wins, so list specific paths before "*".
 */
export function knownIssue(
  visitPath: string,
  check: SmokeCheck,
  message = '',
  { devServer = againstDevServer() }: { devServer?: boolean } = {},
): KnownIssue | undefined {
  return KNOWN_ISSUES.find(
    (k) =>
      k.check === check &&
      (k.paths.includes(visitPath) || k.paths.includes('*')) &&
      (k.match === undefined || [k.match].flat().some((text) => message.includes(text))) &&
      (!k.devServerOnly || devServer),
  );
}
