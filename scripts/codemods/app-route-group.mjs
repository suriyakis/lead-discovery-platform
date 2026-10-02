#!/usr/bin/env node
// DS-07 (absorbs MOB-03, AP-05a, ia:F-09): move the workspace pages into
// the (app) route group, so src/app/(app)/layout.tsx mounts the app shell
// ONCE and it survives client-side navigation (the "Ask the platform"
// conversation, Cmd-K's entity cache, I053). Route groups do not appear
// in URLs: every page keeps its address.
//
// Re-runnable on purpose. A branch opened before the move runs it again
// after rebasing instead of hand-moving files:
//
//   node scripts/codemods/app-route-group.mjs           apply
//   node scripts/codemods/app-route-group.mjs --check   report, exit 1 if anything is left to do
//   node scripts/codemods/app-route-group.mjs --root <dir>   another checkout (tests)
//
// What it does, each step idempotent:
//   1. git mv src/app/<dir> → src/app/(app)/<dir> for every SHELLED_DIRS
//      entry. When both exist (a branch added files under the old place
//      after the move) the missing files are moved one by one; a file that
//      exists in both places is a conflict to merge by hand (exit 1).
//      Outside a git work tree it renames on disk.
//   2. Rewrites path references to the moved folders in src/, e2e/,
//      scripts/ and docs/ ('@/app/review/…', 'src/app/review/…',
//      '../app/review/…', 'app/review/…' → the (app) path). TODO.md is the
//      integrator's and is left alone.
//   3. Unwraps the per-page <AppShell>…</AppShell> (the layout renders the
//      shell now): the tags become fragments and the import goes. Anything
//      it cannot unwrap mechanically is reported for a hand edit.
// A second run finds nothing to do and changes nothing.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The group every shelled workspace page lives in. */
export const GROUP = '(app)';

/**
 * Top-level src/app folders whose pages render inside the workspace shell.
 * Not here, on purpose: admin (its own layout and AdminShell), api, the
 * signed-out landing page, /pending, the retired /dashboard and /inbox
 * redirect stubs, /go (a route handler), the dev gallery and test-only
 * probes.
 */
export const SHELLED_DIRS = Object.freeze([
  'autopilot',
  'communication',
  'connectors',
  'contacts',
  'documents',
  'drafts',
  'health',
  'knowledge',
  'leads',
  'learning',
  'mailbox',
  'notifications',
  'onboarding',
  'pipeline',
  'products',
  'review',
  'settings',
  'support',
  'today',
  'workspace-changed',
]);

/** Folders whose text files may name a moved path. */
const REWRITE_ROOTS = ['src', 'e2e', 'scripts', 'docs'];
const REWRITE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.md', '.json', '.css']);
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.results', '.report', '.auth']);
const SELF = 'scripts/codemods/app-route-group.mjs';

const dirAlternation = SHELLED_DIRS.map((d) => d.replace(/[-]/g, '\\-')).join('|');
/**
 * "app/<dir>" as a path segment: preceded by a slash, a quote, a
 * backtick, whitespace or "(" and followed by a path or string end. An
 * already-moved "app/(app)/<dir>" never matches ("app)" is not "app/").
 */
export const PATH_REF = new RegExp(
  `(^|[/'"\`\\s(])app/(${dirAlternation})(?=[/'"\`\\s.,;:)\\]]|$)`,
  'gm',
);

const APPSHELL_IMPORT = /^import \{ AppShell \} from '@\/components\/AppShell';\r?\n/gm;
const APPSHELL_OPEN = /<AppShell\b[^>]*>/g;
const APPSHELL_CLOSE = /<\/AppShell>/g;

const toPosix = (p) => p.split(path.sep).join('/');

function isGitWorkTree(root) {
  try {
    return (
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() === 'true'
    );
  } catch {
    return false;
  }
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function removeEmptyDirs(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
  for (const entry of readdirSync(dir)) removeEmptyDirs(path.join(dir, entry));
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}

/** Step 1: what moves where. */
function planMoves(root) {
  const appDir = path.join(root, 'src', 'app');
  const moves = [];
  const conflicts = [];
  for (const dir of SHELLED_DIRS) {
    const from = path.join(appDir, dir);
    const to = path.join(appDir, GROUP, dir);
    if (!existsSync(from)) continue;
    if (!existsSync(to)) {
      moves.push({ from, to, whole: true });
      continue;
    }
    for (const file of listFiles(from)) {
      const target = path.join(to, path.relative(from, file));
      if (existsSync(target)) conflicts.push(toPosix(path.relative(root, file)));
      else moves.push({ from: file, to: target, whole: false });
    }
  }
  return { moves, conflicts };
}

function applyMoves(root, moves, useGit) {
  for (const m of moves) {
    mkdirSync(path.dirname(m.to), { recursive: true });
    if (useGit) {
      execFileSync('git', ['mv', '-k', path.relative(root, m.from), path.relative(root, m.to)], {
        cwd: root,
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      // `git mv -k` skips untracked files: move those on disk.
      if (existsSync(m.from) && !m.whole) renameSync(m.from, m.to);
      if (existsSync(m.from) && m.whole) {
        for (const left of listFiles(m.from)) {
          const target = path.join(m.to, path.relative(m.from, left));
          mkdirSync(path.dirname(target), { recursive: true });
          renameSync(left, target);
        }
      }
    } else {
      renameSync(m.from, m.to);
    }
  }
  for (const dir of SHELLED_DIRS) removeEmptyDirs(path.join(root, 'src', 'app', dir));
}

/** A module under the group, except the group's own files (the layout
 *  renders the shell; error/not-found sit inside it). */
function isGroupPageFile(relPath) {
  if (!relPath.startsWith(`src/app/${GROUP}/`) || !/\.(tsx|ts)$/.test(relPath)) return false;
  return relPath.slice(`src/app/${GROUP}/`.length).includes('/');
}

/** Steps 2 and 3 on one file's text. */
export function transformSource(relPath, text) {
  let next = text.replace(PATH_REF, (_m, lead, dir) => `${lead}app/${GROUP}/${dir}`);
  if (isGroupPageFile(relPath)) {
    next = next
      .replace(APPSHELL_IMPORT, '')
      .replace(APPSHELL_OPEN, '<>')
      .replace(APPSHELL_CLOSE, '</>');
  }
  return next;
}

function planRewrites(root) {
  const edits = [];
  const leftovers = [];
  for (const top of REWRITE_ROOTS) {
    const base = path.join(root, top);
    if (!existsSync(base)) continue;
    for (const file of listFiles(base)) {
      const rel = toPosix(path.relative(root, file));
      if (rel === SELF) continue;
      if (!REWRITE_EXTENSIONS.has(path.extname(file))) continue;
      const text = readFileSync(file, 'utf8');
      const next = transformSource(rel, text);
      if (next !== text) edits.push({ file, rel, text: next });
      if (isGroupPageFile(rel) && /<\/?AppShell\b|components\/AppShell'/.test(next)) {
        leftovers.push(rel);
      }
    }
  }
  return { edits, leftovers };
}

export function run({ root, check }) {
  const report = { moved: [], rewritten: [], conflicts: [], leftovers: [] };
  const { moves, conflicts } = planMoves(root);
  report.moved = moves.map((m) => toPosix(path.relative(root, m.from)));
  report.conflicts = conflicts;
  if (!check && conflicts.length === 0) applyMoves(root, moves, isGitWorkTree(root));

  // Rewrites are planned on the tree as it is now (after the moves when
  // applying), so a file that just moved is rewritten at its new path.
  const { edits, leftovers } = planRewrites(root);
  report.rewritten = edits.map((e) => e.rel);
  report.leftovers = leftovers;
  if (!check && conflicts.length === 0) {
    for (const e of edits) writeFileSync(e.file, e.text);
  }
  return report;
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const rootIdx = args.indexOf('--root');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(rootIdx >= 0 ? args[rootIdx + 1] : path.join(here, '..', '..'));

  const report = run({ root, check });
  const pending = report.moved.length + report.rewritten.length;
  if (report.conflicts.length > 0) {
    console.error(
      `app-route-group: ${report.conflicts.length} file(s) exist in both the old and the ${GROUP} folder — merge by hand, then re-run:\n  ${report.conflicts.join('\n  ')}`,
    );
    process.exit(1);
  }
  if (pending === 0 && report.leftovers.length === 0) {
    console.log('app-route-group: nothing to do');
    return;
  }
  const verb = check ? 'would' : 'did';
  if (report.moved.length > 0) {
    console.log(
      `app-route-group: ${verb} move ${report.moved.length} path(s):\n  ${report.moved.join('\n  ')}`,
    );
  }
  if (report.rewritten.length > 0) {
    console.log(
      `app-route-group: ${verb} rewrite ${report.rewritten.length} file(s):\n  ${report.rewritten.join('\n  ')}`,
    );
  }
  if (report.leftovers.length > 0) {
    console.error(
      `app-route-group: AppShell is still referenced (unwrap by hand; the (app) layout renders it):\n  ${report.leftovers.join('\n  ')}`,
    );
  }
  if (check || report.leftovers.length > 0) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
