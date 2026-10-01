// Static guards for the /admin console (PC-03).
//
// The console must act through PlatformContext (requirePlatformAdmin),
// never through getWorkspaceContext(): a WorkspaceContext there resolves
// to whatever workspace the super-admin's switcher points at, and that is
// how platform audit rows leaked into tenants (I051). These checks read
// the source so a regression fails CI before it ever writes a row.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const ADMIN_DIR = path.join(ROOT, 'src', 'app', 'admin');

/**
 * Files still allowed to use getWorkspaceContext, each with the change
 * that removes it. The check below FAILS once the file stops using it, so
 * an entry cannot outlive its reason — delete the entry when that happens.
 */
const PENDING_EXCEPTIONS: Record<string, string> = {
  'src/app/admin/providers/page.tsx':
    'PC-02 makes "Test active AI provider" and the per-vendor key test platform-only; those two actions are the last users',
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const files = walk(ADMIN_DIR).map((full) => ({
  rel: path.relative(ROOT, full).split(path.sep).join('/'),
  src: readFileSync(full, 'utf8'),
}));

/** Body text of each inline server action (from its 'use server' to the
 *  next top-level-ish `async function` or end of file). */
function serverActionBodies(src: string): string[] {
  const parts = src.split(/['"]use server['"];?/);
  return parts.slice(1).map((p) => p.split(/\n\s*async function /)[0] ?? p);
}

describe('/admin console uses PlatformContext', () => {
  it('finds the console files', () => {
    expect(files.length).toBeGreaterThanOrEqual(11); // 10 pages + layout
  });

  it('nothing under src/app/admin uses getWorkspaceContext (except listed pending changes)', () => {
    const offenders = files
      .filter((f) => /\bgetWorkspaceContext\b/.test(f.src))
      .map((f) => f.rel)
      .filter((rel) => !(rel in PENDING_EXCEPTIONS));
    expect(offenders).toEqual([]);
  });

  it('every pending exception is still needed (remove the entry once its change lands)', () => {
    for (const rel of Object.keys(PENDING_EXCEPTIONS)) {
      const f = files.find((x) => x.rel === rel);
      expect(f, `${rel} no longer exists — drop it from PENDING_EXCEPTIONS`).toBeDefined();
      expect(
        /\bgetWorkspaceContext\b/.test(f!.src),
        `${rel} no longer uses getWorkspaceContext — drop it from PENDING_EXCEPTIONS`,
      ).toBe(true);
    }
  });

  it('every console page and the layout call requirePlatformAdmin()', () => {
    const missing = files
      .filter((f) => /\/(page|layout)\.tsx$/.test(f.rel))
      .filter((f) => !/await requirePlatformAdmin\(\)/.test(f.src))
      .map((f) => f.rel);
    expect(missing).toEqual([]);
  });

  it('every inline server action re-checks the platform admin itself', () => {
    const unguarded: string[] = [];
    for (const f of files) {
      serverActionBodies(f.src).forEach((body, i) => {
        if (/await requirePlatformAdmin\(\)/.test(body)) return;
        // Pending files may still use the old guard, but it must be a guard.
        if (
          f.rel in PENDING_EXCEPTIONS &&
          /await getWorkspaceContext\(\)/.test(body) &&
          /isSuperAdmin\(/.test(body)
        ) {
          return;
        }
        unguarded.push(`${f.rel} (server action #${i + 1})`);
      });
    }
    expect(unguarded).toEqual([]);
  });

  it('the no-op Impersonate control is gone from the console (I047)', () => {
    const hits = files.filter((f) => /impersonat/i.test(f.src)).map((f) => f.rel);
    expect(hits).toEqual([]);
  });
});

describe('platform services cannot fall back to an ambient workspace', () => {
  const SERVICES = [
    'src/lib/services/admin.ts',
    'src/lib/services/users.ts',
    'src/lib/services/support.ts',
    'src/lib/services/token-ledger.ts',
    'src/lib/services/secrets.ts',
    'src/lib/services/platform-settings.ts',
  ];

  it('none of them resolves a session workspace', () => {
    for (const rel of SERVICES) {
      const src = readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src, rel).not.toMatch(/\bgetWorkspaceContext\b|from '\.\/auth-context'/);
    }
  });

  it('admin.ts never audits through a WorkspaceContext', () => {
    const src = readFileSync(path.join(ROOT, 'src/lib/services/admin.ts'), 'utf8');
    expect(src).not.toMatch(/import[^;]*\bWorkspaceContext\b[^;]*;/);
    expect(src).not.toMatch(/recordAuditEvent\(\s*ctx\b/);
  });
});
