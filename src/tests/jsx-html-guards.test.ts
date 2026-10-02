// Guards for two markup mistakes React only reports in the browser
// (deliverable ia:F-08, audit I115 and X5).
//
// 1. A <form> inside another <form>. The HTML parser drops the inner form,
//    so the server HTML and React's tree disagree: hydration fails (error
//    418), the page is re-rendered on the client, and the inner form's
//    submit button stops working. /settings/crm/[id] shipped exactly that
//    (its Test-connection form sat inside the Save form). Give the second
//    action a `formAction` button on the outer form instead.
// 2. `selected` on an <option>. React warns and ignores it on update; use
//    `defaultValue` (an array for <select multiple>) on the <select>.
//    /knowledge/new and /knowledge/[id] did this.
//
// Vitest renders pages on the server only, so neither shows up in a
// behavioural test. This scans the JSX statically: a form nested in
// another form inside one component's markup, and any <option selected>.
// A form nested through a child component is out of its reach.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCAN_DIRS = ['src/app', 'src/components'];

function listTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsx(full));
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

function tagName(node: ts.Node): string | null {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  return null;
}

function attributesOf(node: ts.Node): ts.JsxAttributes | null {
  if (ts.isJsxElement(node)) return node.openingElement.attributes;
  if (ts.isJsxSelfClosingElement(node)) return node.attributes;
  return null;
}

function line(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** `file:line` of every <form> that sits inside another <form>. */
function findNestedForms(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: string[] = [];
  const visit = (node: ts.Node, insideForm: boolean): void => {
    const isForm = tagName(node) === 'form';
    if (isForm && insideForm) hits.push(`${fileName}:${line(sf, node)}`);
    ts.forEachChild(node, (child) => visit(child, insideForm || isForm));
  };
  visit(sf, false);
  return hits;
}

/** `file:line` of every <option> that carries a `selected` prop. */
function findSelectedOptions(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (tagName(node) === 'option') {
      const attrs = attributesOf(node);
      const hasSelected = attrs?.properties.some(
        (p) => ts.isJsxAttribute(p) && p.name.getText() === 'selected',
      );
      if (hasSelected) hits.push(`${fileName}:${line(sf, node)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

const files = SCAN_DIRS.flatMap((d) => listTsx(path.join(repoRoot, d))).map((full) => ({
  name: path.relative(repoRoot, full).split(path.sep).join('/'),
  source: readFileSync(full, 'utf8'),
}));

describe('JSX markup guards', () => {
  it('scans the app (sanity check)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('detects a nested form, including one behind a condition or a map', () => {
    const fixture = `
      export function Page({ ok, rows }: { ok: boolean; rows: string[] }) {
        return (
          <form action={save}>
            <button>Save</button>
            {ok ? <form action={test}><button>Test</button></form> : null}
            {rows.map((r) => <form key={r} action={del} />)}
          </form>
        );
      }
      export function Fine() {
        return (<><form action={a} /><form action={b} /></>);
      }`;
    expect(findNestedForms('fixture.tsx', fixture)).toEqual(['fixture.tsx:6', 'fixture.tsx:7']);
  });

  it('no component renders a <form> inside another <form>', () => {
    const hits = files.flatMap((f) => findNestedForms(f.name, f.source));
    expect(hits).toEqual([]);
  });

  it('detects selected on an option', () => {
    const fixture = `
      export const S = ({ v }: { v: string }) => (
        <select>
          <option value="a" selected={v === 'a'}>A</option>
          <option value="b">B</option>
        </select>
      );`;
    expect(findSelectedOptions('fixture.tsx', fixture)).toEqual(['fixture.tsx:4']);
  });

  it('no <option> sets `selected`; selects use defaultValue', () => {
    const hits = files.flatMap((f) => findSelectedOptions(f.name, f.source));
    expect(hits).toEqual([]);
  });
});
