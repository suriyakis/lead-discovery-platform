// DS-03: the Playwright smoke test's route list (e2e/routes.ts) is derived
// from src/app. These checks run in the normal Vitest suite — no server
// needed — so a new page without a seeded path, or a stale entry, fails
// here first instead of silently dropping out of the e2e run.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  againstDevServer,
  appRoutePatterns,
  EXPECTED_LANDING,
  EXTRA_PATHS,
  KNOWN_ISSUES,
  knownIssue,
  patternToRegExp,
  SEEDED_PATHS,
  SKIPPED_PATTERNS,
  smokeRoutes,
} from '../../e2e/routes';

const patterns = appRoutePatterns();

describe('appRoutePatterns', () => {
  it('finds the app pages, static and dynamic, and no API routes', () => {
    expect(patterns).toContain('/');
    expect(patterns).toContain('/dashboard');
    expect(patterns).toContain('/review/[id]');
    expect(patterns).toContain('/connectors/[id]/recipes/[recipeId]');
    expect(patterns).toContain('/admin/workspaces/[id]');
    expect(patterns.some((p) => p.startsWith('/api'))).toBe(false);
    expect(patterns.length).toBeGreaterThanOrEqual(70);
  });

  const tmp = mkdtempSync(path.join(tmpdir(), 'app-routes-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('drops route groups, skips @slots and _private folders', () => {
    const touch = (rel: string) => {
      mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      writeFileSync(path.join(tmp, rel), '');
    };
    touch('page.tsx');
    touch('(marketing)/pricing/page.tsx');
    touch('blog/[slug]/page.tsx');
    touch('dash/@modal/login/page.tsx');
    touch('_lib/page.tsx');
    touch('docs/[...rest]/page.tsx');
    touch('blog/layout.tsx');
    expect(appRoutePatterns(tmp)).toEqual(['/', '/blog/[slug]', '/docs/[...rest]', '/pricing']);
  });
});

describe('patternToRegExp', () => {
  it('matches one segment per [param] and the rest for a catch-all', () => {
    expect(patternToRegExp('/review/[id]').test('/review/8')).toBe(true);
    expect(patternToRegExp('/review/[id]').test('/review/8/edit')).toBe(false);
    expect(patternToRegExp('/connectors/[id]/recipes/new').test('/connectors/1/recipes/new')).toBe(true);
    expect(patternToRegExp('/docs/[...rest]').test('/docs/a/b')).toBe(true);
    expect(patternToRegExp('/').test('/')).toBe(true);
  });
});

describe('smoke route list', () => {
  const routes = smokeRoutes(patterns);

  it('covers every app route except the documented skips', () => {
    const visited = new Set(routes.map((r) => r.pattern));
    const missing = patterns.filter((p) => !visited.has(p) && !(p in SKIPPED_PATTERNS));
    expect(missing).toEqual([]);
  });

  it('every seeded path matches its pattern, and no entry is stale', () => {
    for (const [pattern, routePath] of Object.entries(SEEDED_PATHS)) {
      expect(patterns, `SEEDED_PATHS key ${pattern}`).toContain(pattern);
      expect(patternToRegExp(pattern).test(routePath), `${routePath} vs ${pattern}`).toBe(true);
    }
    for (const pattern of Object.keys(SKIPPED_PATTERNS)) {
      expect(patterns, `SKIPPED_PATTERNS key ${pattern}`).toContain(pattern);
    }
  });

  it('visits each path once, extras included', () => {
    const paths = routes.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const extra of EXTRA_PATHS) expect(paths).toContain(extra);
  });

  it('landing expectations refer to visited paths; the rest must land on themselves', () => {
    const paths = new Set(routes.map((r) => r.path));
    for (const p of Object.keys(EXPECTED_LANDING)) expect(paths, p).toContain(p);
    const review = routes.find((r) => r.path === '/review/8');
    expect(review?.landsOn.test('/review/8')).toBe(true);
    expect(review?.landsOn.test('/')).toBe(false);
    const kanban = routes.find((r) => r.path === '/pipeline?view=kanban');
    expect(kanban?.landsOn.test('/pipeline')).toBe(true);
  });

  it('a new dynamic page without a seeded path fails loudly', () => {
    expect(() => smokeRoutes([...patterns, '/widgets/[id]'])).toThrow(/no seeded path for \/widgets\/\[id\]/);
  });
});

describe('known issues (e2e/known-issues.json)', () => {
  const visited = new Set(smokeRoutes(patterns).map((r) => r.path));

  it('every entry names a tracked id, a known check, visited paths and a note', () => {
    expect(KNOWN_ISSUES.length).toBeGreaterThan(0);
    for (const k of KNOWN_ISSUES) {
      expect(k.id, JSON.stringify(k)).toMatch(/^[IX]\d+$/);
      expect(['status', 'pageerror', 'overflow']).toContain(k.check);
      expect(k.paths.length).toBeGreaterThan(0);
      for (const p of k.paths) {
        if (p !== '*') expect(visited, `${k.id}: ${p} is not in the smoke route list`).toContain(p);
      }
      expect(k.note.length).toBeGreaterThan(20);
      if (k.check === 'pageerror') expect(k.match, `${k.id}: pageerror entries must say which error`).toBeTruthy();
      // A wildcard may only excuse one specific error text, never a whole check.
      if (k.paths.includes('*')) expect(k.match, `${k.id}: "*" needs a match`).toBeTruthy();
    }
  });

  it('no page is tolerated to overflow at phone width any more (DS-03)', () => {
    expect(KNOWN_ISSUES.filter((k) => k.check === 'overflow')).toEqual([]);
  });

  it('knownIssue() matches on path, check and message text only', () => {
    const dev = { devServer: true };
    expect(knownIssue('/drafts', 'pageerror', 'Error: Hydration failed because …', dev)?.id).toBe('X5');
    expect(knownIssue('/drafts', 'status', '', dev)).toBeUndefined();
    expect(knownIssue('/settings/crm/1', 'pageerror', 'Hydration failed because …', dev)).toBeUndefined();
    expect(knownIssue('/drafts', 'pageerror', 'TypeError: x is undefined', dev)).toBeUndefined();
  });

  it('defects fixed in Phase 0 are no longer excused (X3 lead page 500, I115 nested CRM form)', () => {
    expect(KNOWN_ISSUES.map((k) => k.id)).not.toContain('X3');
    expect(KNOWN_ISSUES.map((k) => k.id)).not.toContain('I115');
    for (const devServer of [true, false]) {
      expect(knownIssue('/pipeline/1', 'status', '', { devServer })).toBeUndefined();
      expect(
        knownIssue('/settings/crm/1', 'pageerror', 'Error: Minified React error #418', { devServer }),
      ).toBeUndefined();
    }
  });

  it('no page error is excused on every route: a new hydration failure elsewhere fails the smoke', () => {
    expect(KNOWN_ISSUES.filter((k) => k.check === 'pageerror' && k.paths.includes('*'))).toEqual([]);
    for (const path of ['/dashboard', '/review/8', '/drafts/39', '/admin/users']) {
      expect(knownIssue(path, 'pageerror', 'Error: Hydration failed because …', { devServer: true }), path).toBeUndefined();
    }
  });

  it('dev-server-only entries are not tolerated against a production server', () => {
    const msg = 'Error: Hydration failed because …';
    expect(knownIssue('/review', 'pageerror', msg, { devServer: true })?.id).toBe('X5');
    expect(knownIssue('/review', 'pageerror', msg, { devServer: false })).toBeUndefined();
    // A production build minifies React's message; nothing excuses it there.
    const minified =
      'Error: Minified React error #418; visit https://react.dev/errors/418?args[]=HTML&args[]= for the full message';
    expect(knownIssue('/review', 'pageerror', minified, { devServer: false })).toBeUndefined();
    expect(knownIssue('/dashboard', 'pageerror', minified, { devServer: true })).toBeUndefined();
  });

  it('againstDevServer(): CI means `next start`, E2E_SERVER overrides', () => {
    expect(againstDevServer({})).toBe(true);
    expect(againstDevServer({ CI: 'true' })).toBe(false);
    expect(againstDevServer({ CI: 'true', E2E_SERVER: 'dev' })).toBe(true);
    expect(againstDevServer({ E2E_SERVER: 'prod' })).toBe(false);
  });
});
