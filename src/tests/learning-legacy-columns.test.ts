// KL-01 acceptance 5 (grep guard): learning_lessons.enabled and
// learning_lessons.product_profile_id are retired. They stay DECLARED in
// src/lib/db/schema/learning.ts as the deprecated legacyEnabled /
// legacyProductProfileId (so the lane migration is purely additive; the
// contract PR drops them) and nothing else may touch them. A rule is in service when
// lifecycle = 'active', and applies where lessonInScope() says (scope_kind +
// lesson_scopes). Any remaining reference to the old columns — in Drizzle
// form or raw SQL — would silently read nothing (or break at runtime), so
// the build fails on one. drizzle/ is excluded: migrations are history.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCAN_DIRS = ['src', 'scripts', 'e2e'];
const THIS_FILE = path
  .relative(repoRoot, fileURLToPath(import.meta.url))
  .split(path.sep)
  .join('/');
/** Files that name the old columns on purpose: this guard, the schema that
 *  still declares them (deprecated), and the migration test that seeds the
 *  pre-KL-01 shape and checks the rollback. */
const ALLOWED = new Set([
  THIS_FILE,
  'src/lib/db/schema/learning.ts',
  'src/tests/learning-scope-migration.test.ts',
]);

const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /learningLessons\s*\.\s*enabled\b/, why: 'use learningLessons.lifecycle' },
  {
    pattern: /learningLessons\s*\.\s*productProfileId\b/,
    why: 'use lessonInScope() / lesson_scopes',
  },
  {
    pattern: /learning_lessons"?\s*\.\s*"?(enabled|product_profile_id)\b/,
    why: 'raw SQL on a retired learning_lessons column',
  },
  {
    pattern: /\blegacy(?:ProductProfileId|Enabled)\b/,
    why: 'deprecated column, dropped by the contract PR',
  },
];

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs|cjs|sql)$/.test(name)) out.push(full);
  }
}

describe('no reference to the retired learning_lessons columns', () => {
  it('src/, scripts/ and e2e/ are clean', () => {
    const files: string[] = [];
    for (const d of SCAN_DIRS) walk(path.join(repoRoot, d), files);
    expect(files.length).toBeGreaterThan(50);

    const hits: string[] = [];
    for (const file of files) {
      const rel = path.relative(repoRoot, file).split(path.sep).join('/');
      if (ALLOWED.has(rel)) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const f of FORBIDDEN) {
          if (f.pattern.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()} (${f.why})`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it('the schema declares them only as deprecated legacy* columns', async () => {
    const { learningLessons } = await import('@/lib/db/schema/learning');
    const columns = Object.keys(learningLessons);
    expect(columns).not.toContain('enabled');
    expect(columns).not.toContain('productProfileId');
    expect(columns).toContain('legacyEnabled');
    expect(columns).toContain('legacyProductProfileId');
    expect(columns).toContain('lifecycle');
    expect(columns).toContain('scopeKind');
  });
});
