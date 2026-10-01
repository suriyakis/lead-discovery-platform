// Guard: an inline server action must not capture a local function.
//
// An inline action is a function with a 'use server' directive declared
// inside a component. Next hoists it and serialises every variable it
// closes over into the rendered page, so it can be re-bound when the form
// posts. Strings, numbers, bigints, Dates and plain objects survive that
// trip; functions and classes do not. React then fails the action with
// "Functions cannot be passed directly to Client Components". That is
// how the /mailbox/[id] bulk Trash / Spam buttons broke (audit X4,
// deliverable flow:F-02) and, earlier, the /communication folder view
// (P61-24).
//
// Vitest never runs Next's server-actions transform, so a behavioural
// test cannot catch this. This test does it statically: for every
// inline action under src/app and src/components it collects the
// functions and classes declared in the enclosing component scopes and
// fails if the action body references one. Module-level helpers are
// fine (they are imported, not captured), and so are other server
// actions (they serialise as server references). Fix a failure by
// hoisting the helper to module scope or moving the action into a
// 'use server' module.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCAN_DIRS = ['src/app', 'src/components'];

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** True when the function body opens with a 'use server' directive. */
function hasUseServerDirective(fn: FunctionLike): boolean {
  const body = fn.body;
  if (!body || !ts.isBlock(body)) return false;
  for (const stmt of body.statements) {
    if (!ts.isExpressionStatement(stmt) || !ts.isStringLiteral(stmt.expression)) break;
    if (stmt.expression.text === 'use server') return true;
  }
  return false;
}

function unwrapExpression(expr: ts.Expression | undefined): ts.Expression | undefined {
  let e = expr;
  while (
    e &&
    (ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isTypeAssertionExpression(e))
  ) {
    e = e.expression;
  }
  return e;
}

/**
 * Names of functions / classes declared directly in a block that would be
 * captured by value. Nested server actions are excluded: they serialise
 * as server references.
 */
function capturableFunctionNames(statements: ts.NodeArray<ts.Statement>): Set<string> {
  const names = new Set<string>();
  for (const stmt of statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && !hasUseServerDirective(stmt)) {
      names.add(stmt.name.text);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      names.add(stmt.name.text);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const init = unwrapExpression(decl.initializer);
        if (!ts.isIdentifier(decl.name) || !init) continue;
        const isFn = ts.isArrowFunction(init) || ts.isFunctionExpression(init);
        if ((isFn && !hasUseServerDirective(init)) || ts.isClassExpression(init)) {
          names.add(decl.name.text);
        }
      }
    }
  }
  return names;
}

/** Identifiers the action body reads, minus property names (`a.b` → `b`). */
function referencedNames(fn: FunctionLike): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isJsxAttribute(parent) && parent.name === node);
      if (!isPropertyName) names.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return names;
}

interface Violation {
  location: string;
  action: string;
  captured: string[];
}

function findViolations(filePath: string): Violation[] {
  const source = readFileSync(filePath, 'utf8');
  if (!source.includes('use server')) return [];
  const relative = path.relative(repoRoot, filePath).split(path.sep).join('/');
  return findViolationsInSource(relative, source);
}

function findViolationsInSource(fileName: string, source: string): Violation[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node) && hasUseServerDirective(node)) {
      // Walk up to the module, collecting function/class declarations from
      // every block that sits inside an enclosing function. Module-level
      // declarations are not captured, so they are skipped.
      const captured = new Set<string>();
      let inline = false;
      for (let p: ts.Node | undefined = node.parent; p && !ts.isSourceFile(p); p = p.parent) {
        if (isFunctionLike(p)) inline = true;
        if (ts.isBlock(p)) {
          for (const name of capturableFunctionNames(p.statements)) captured.add(name);
        }
      }
      if (inline) {
        // Names the action declares itself shadow the outer ones.
        const own = new Set<string>();
        const collectOwn = (n: ts.Node): void => {
          if (
            (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isFunctionDeclaration(n)) &&
            n.name &&
            ts.isIdentifier(n.name)
          ) {
            own.add(n.name.text);
          }
          ts.forEachChild(n, collectOwn);
        };
        node.parameters.forEach(collectOwn);
        if (node.body) collectOwn(node.body);
        const hits = [...referencedNames(node)].filter((n) => captured.has(n) && !own.has(n));
        if (hits.length > 0) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          violations.push({
            location: `${fileName}:${line + 1}`,
            action: node.name && ts.isIdentifier(node.name) ? node.name.text : '<anonymous>',
            captured: hits.sort(),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function scan(): Violation[] {
  return SCAN_DIRS.flatMap((d) => sourceFiles(path.join(repoRoot, d))).flatMap(findViolations);
}

describe('inline server actions', () => {
  it('never capture a local function or class (Next cannot serialise them)', () => {
    expect(scan()).toEqual([]);
  });

  it('flags the pattern that broke /mailbox/[id] and accepts the safe ones', () => {
    // Self-check so a regression in the scanner itself can't make the
    // guard above pass vacuously. Only trashSelected is a violation.
    const source = `
      function moduleNote(n: number): string {
        return n + ' done';
      }

      export async function Page({ mailboxId }: { mailboxId: bigint }) {
        function parseIds(formData: FormData): bigint[] {
          return formData.getAll('ids').map((v) => BigInt(String(v)));
        }
        const affectedNote = (n: number) => n + ' moved';
        const label = 'Trash';

        async function trashSelected(formData: FormData) {
          'use server';
          const ids = parseIds(formData);
          sink(mailboxId, affectedNote(ids.length), label);
        }

        // Module-level helper, captured bigint, another inline action.
        async function spamSelected(formData: FormData) {
          'use server';
          await trashSelected(formData);
          sink(mailboxId, moduleNote(1));
        }

        // Its own parseIds shadows the component's.
        const restoreSelected = async (formData: FormData) => {
          'use server';
          const parseIds = (fd: FormData) => fd.getAll('ids').length;
          sink(parseIds(formData));
        };

        // Not a server action: free to use local helpers.
        const preview = (formData: FormData) => affectedNote(parseIds(formData).length);

        return (
          <form>
            <button formAction={trashSelected}>{label}</button>
            <button formAction={spamSelected}>{preview(new FormData())}</button>
            <button formAction={restoreSelected}>Restore</button>
          </form>
        );
      }
    `;
    expect(findViolationsInSource('fixture/page.tsx', source)).toEqual([
      {
        location: 'fixture/page.tsx:13',
        action: 'trashSelected',
        captured: ['affectedNote', 'parseIds'],
      },
    ]);
  });
});
