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
import { PLATFORM_AUDIT_KINDS } from '@/lib/audit-scope';

const ROOT = path.resolve(__dirname, '..', '..');
const ADMIN_DIR = path.join(ROOT, 'src', 'app', 'admin');

/**
 * Files still allowed to use getWorkspaceContext, each with the change
 * that removes it. The check below FAILS once the file stops using it, so
 * an entry cannot outlive its reason — delete the entry when that happens.
 */
const PENDING_EXCEPTIONS: Record<string, string> = {
  // Empty since the Phase 0 integration: PC-02 made the /admin/providers
  // live checks platform-only, so no console file needs the old guard.
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
    // PC-06: holds and the platform outbound stop.
    'src/lib/services/holds.ts',
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

describe('platform audit kinds are registered (audit-scope.ts)', () => {
  // The console labels a workspace_id-NULL row `platform` only when its
  // kind is in PLATFORM_AUDIT_KINDS; anything else reads as a row orphaned
  // by a workspace delete. So every kind written at platform scope must be
  // listed — and written as a literal, so this check can see it. The list
  // is append-only: rows of a kind no longer written still exist. (The
  // first version only saw recordPlatformAuditEvent() and a literal
  // insert(auditLog) call, so the F-06 remediation's auditInTx rows
  // slipped past it and read as 'no workspace' in /admin/audit.)
  const SOURCE_DIRS = [path.join(ROOT, 'src'), path.join(ROOT, 'scripts')];
  const sources = SOURCE_DIRS.flatMap((d) => walk(d))
    .map((full) => ({
      rel: path.relative(ROOT, full).split(path.sep).join('/'),
      // Comments may name the function; only code counts.
      src: readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, ''),
    }))
    .filter((f) => !f.rel.startsWith('src/tests/'));

  /**
   * The keys of the object literal around `at`, at that object's own
   * nesting level: nested objects (a payload) are cut out, so their keys
   * never count. null when `at` is not inside braces.
   */
  function enclosingObjectOwnText(src: string, at: number): string | null {
    let depth = 0;
    let start = -1;
    for (let i = at - 1; i >= 0; i--) {
      if (src[i] === '}') depth++;
      else if (src[i] === '{') {
        if (depth === 0) {
          start = i;
          break;
        }
        depth--;
      }
    }
    if (start < 0) return null;
    let own = '';
    depth = 0;
    for (let i = start + 1; i < src.length; i++) {
      const ch = src[i]!;
      if (ch === '{') depth++;
      else if (ch === '}') {
        if (depth === 0) return own;
        depth--;
      } else if (depth === 0) own += ch;
    }
    return null;
  }

  function writtenPlatformKinds(): { kinds: string[]; nonLiteral: string[] } {
    const kinds: string[] = [];
    const nonLiteral: string[] = [];
    for (const f of sources) {
      // recordPlatformAuditEvent(actor, { kind: '...' })
      const callRe = /(?<!function )\brecordPlatformAuditEvent\(/g;
      for (const m of f.src.matchAll(callRe)) {
        const after = f.src.slice(m.index!, m.index! + 400);
        const k = /^recordPlatformAuditEvent\(\s*[^,]+,\s*\{\s*kind:\s*'([^']+)'/.exec(after);
        if (k) kinds.push(k[1]!);
        else nonLiteral.push(`${f.rel}@${m.index}`);
      }
      // Any other row filed at platform scope: an object literal with
      // `workspaceId: null` and a kind — insert(auditLog).values({ ... }),
      // the remediation engine's auditInTx(tx, { ... }) (flow:F-06), a
      // seeded row. The helpers that only forward a caller's kind are
      // checked at their call sites instead.
      for (const m of f.src.matchAll(/\bworkspaceId:\s*null\b/g)) {
        const own = enclosingObjectOwnText(f.src, m.index!);
        if (own === null || !/\bkind:/.test(own)) continue;
        const k = /\bkind:\s*'([^']+)'/.exec(own);
        if (k) kinds.push(k[1]!);
        else if (!(f.rel === 'src/lib/services/audit.ts' && /\bkind:\s*event\.kind\b/.test(own)))
          nonLiteral.push(`${f.rel}@${m.index}`);
      }
    }
    return { kinds, nonLiteral };
  }

  it('finds the platform-scope writers (sanity check for the scanner)', () => {
    const { kinds } = writtenPlatformKinds();
    expect(kinds).toEqual(
      expect.arrayContaining([
        'user.set_account_status',
        'admin.workspace.delete',
        'admin.audit.refile',
        'admin.audit.refile_revert',
        // auditInTx(tx, { workspaceId: null, ... }) in the F-06 scripts
        'remediation.apply',
        'remediation.revert',
      ]),
    );
  });

  it('every kind written at platform scope is in PLATFORM_AUDIT_KINDS', () => {
    const { kinds, nonLiteral } = writtenPlatformKinds();
    expect(nonLiteral, 'a platform-scope audit write needs a literal kind').toEqual([]);
    const known = new Set<string>(PLATFORM_AUDIT_KINDS);
    const missing = [...new Set(kinds)].filter((k) => !known.has(k)).sort();
    expect(missing, 'add these to PLATFORM_AUDIT_KINDS in src/lib/audit-scope.ts').toEqual([]);
  });
});
