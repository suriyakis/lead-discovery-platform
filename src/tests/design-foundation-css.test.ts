// DS-06: the CSS architecture, enforced on the real files.
//
// - Cascade layers: every stylesheet and CSS module opens with the one
//   @layer statement, keeps every rule inside its own layers, and the app
//   loads its global CSS only through globals.css → tokens, base, legacy,
//   utilities. (That Next keeps the statement in a compiled module chunk
//   is e2e/design-foundation.spec.ts; stylelint takes these rules over
//   when DS-01 lands it.)
// - No !important anywhere: inside a layer it would beat every later one.
// - The new-code budget (tokens, base, utilities, modules): no colour
//   literals outside tokens.css, token-only sizes, min-width breakpoints
//   at 640/900/1200 only.
// - legacy.css is frozen against src/styles/legacy.baseline.json.
// - No var() reads a custom property nothing defines (I140).
// - The --brand-* names alias the new tokens and keep their values.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appLayerOrder,
  cssImports,
  loadCssFile,
  parseCss,
  resolveVars,
  rootTokens,
} from './helpers/css-cascade';
import {
  allowedLayers,
  badBreakpoints,
  colourLiterals,
  countLines,
  currentLegacyBaseline,
  firstStatement,
  isNewScope,
  LAYER_ORDER,
  LAYER_STATEMENT,
  LEGACY_BASELINE,
  LEGACY_CSS,
  type LegacyBaseline,
  listCssFiles,
  literalSizes,
  readCss,
  topLevel,
} from './helpers/css-budget';

const FILES = listCssFiles();
const NEW_SCOPE = FILES.filter(isNewScope);
const read = (file: string) => readCss(file);
const rulesOf = (file: string) => parseCss(read(file), file);

describe('cascade layers', () => {
  it('finds the stylesheets it polices', () => {
    for (const f of [
      'src/app/globals.css',
      'src/styles/tokens.css',
      'src/styles/base.css',
      'src/styles/legacy.css',
      'src/styles/utilities.css',
      'src/components/Alert.module.css',
    ]) {
      expect(FILES).toContain(f);
    }
  });

  it('every stylesheet and CSS module opens with the canonical @layer statement', () => {
    const wrong = FILES.filter((f) => firstStatement(read(f)) !== LAYER_STATEMENT).map(
      (f) => `${f}: ${firstStatement(read(f)).slice(0, 80)}`,
    );
    expect(wrong).toEqual([]);
    expect(appLayerOrder()).toEqual([...LAYER_ORDER]);
  });

  it('declares no other layer order anywhere', () => {
    for (const f of FILES) {
      const statements = topLevel(read(f)).filter(
        (c) => c.kind === 'statement' && c.prelude.startsWith('@layer'),
      );
      expect(
        statements.map((s) => `${s.prelude};`),
        f,
      ).toEqual([LAYER_STATEMENT]);
    }
  });

  it('every rule sits inside one of its file’s own layers (no unlayered CSS)', () => {
    const problems: string[] = [];
    for (const f of FILES) {
      const allowed = allowedLayers(f);
      for (const c of topLevel(read(f))) {
        if (c.kind === 'statement') {
          const ok =
            c.prelude.startsWith('@layer') ||
            (f === 'src/app/globals.css' && c.prelude.startsWith('@import'));
          if (!ok) problems.push(`${f}: top-level statement ${c.prelude}`);
          continue;
        }
        const layer = /^@layer\s+([\w-]+)$/.exec(c.prelude)?.[1];
        if (!layer || !allowed.includes(layer))
          problems.push(`${f}: top-level block "${c.prelude}"`);
      }
      for (const r of rulesOf(f)) {
        if (!r.layer || !allowed.includes(r.layer))
          problems.push(`${f}:${r.line} ${r.selectorText} in ${r.layer}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('a stylesheet that slips a rule outside its layer is caught', () => {
    const css = `${LAYER_STATEMENT}\n@layer components { .a { color: red; } }\n.b { color: red; }`;
    const loose = topLevel(css).filter(
      (c) => c.kind === 'block' && !c.prelude.startsWith('@layer'),
    );
    expect(loose.map((c) => c.prelude)).toEqual(['.b']);
    expect(parseCss(css).map((r) => r.layer)).toEqual(['components', null]);
  });

  it('globals.css is the statement plus tokens, base, legacy and utilities, in that order', () => {
    expect(cssImports('src/app/globals.css')).toEqual([
      'src/styles/tokens.css',
      'src/styles/base.css',
      'src/styles/legacy.css',
      'src/styles/utilities.css',
    ]);
    expect(rulesOf('src/app/globals.css')).toEqual([]);
  });

  it('only the root layout and global-error load global CSS, and only globals.css', () => {
    const root = path.resolve(process.cwd(), 'src');
    const importers: string[] = [];
    for (const f of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
      if (!/\.(ts|tsx)$/.test(f) || f.split(path.sep).includes('tests')) continue;
      const src = readFileSync(path.join(root, f), 'utf8');
      for (const m of src.matchAll(/^\s*import\s+['"]([^'"]+\.css)['"]/gm)) {
        importers.push(`${f.split(path.sep).join('/')} → ${m[1]}`);
      }
    }
    expect(importers.sort()).toEqual([
      'app/global-error.tsx → ./globals.css',
      'app/layout.tsx → ./globals.css',
    ]);
  });
});

describe('no !important', () => {
  it('appears in no stylesheet or module (it would outrank every later layer)', () => {
    const found = FILES.flatMap((f) =>
      rulesOf(f).flatMap((r) =>
        r.decls
          .filter((d) => d.important)
          .map((d) => `${f}:${r.line} ${r.selectorText} { ${d.prop} }`),
      ),
    );
    expect(found).toEqual([]);
  });
});

describe('design budget for new CSS (tokens, base, utilities, modules)', () => {
  it('has no colour literal outside tokens.css', () => {
    const found = NEW_SCOPE.filter((f) => f !== 'src/styles/tokens.css').flatMap((f) =>
      rulesOf(f).flatMap((r) =>
        r.decls.flatMap((d) =>
          colourLiterals(d.prop, d.value).map(
            (c) => `${f}:${r.line} ${r.selectorText} { ${d.prop}: ${c} }`,
          ),
        ),
      ),
    );
    expect(found).toEqual([]);
  });

  it('takes font sizes, spacing, radii, shadows and z-index from tokens', () => {
    const found = NEW_SCOPE.filter((f) => f !== 'src/styles/tokens.css').flatMap((f) =>
      rulesOf(f).flatMap((r) =>
        r.decls.flatMap((d) =>
          literalSizes(d.prop, d.value).map(
            (s) => `${f}:${r.line} ${r.selectorText} { ${d.prop}: ${s} }`,
          ),
        ),
      ),
    );
    expect(found).toEqual([]);
  });

  it('mixes colours in oklab (oklch would swing the hue: an amber tint over blue-grey turns teal)', () => {
    const found = NEW_SCOPE.flatMap((f) =>
      rulesOf(f).flatMap((r) =>
        r.decls
          .filter((d) => /color-mix\(\s*in\s+(?!oklab\b)/.test(d.value))
          .map((d) => `${f}:${r.line} ${r.selectorText} { ${d.prop} }`),
      ),
    );
    expect(found).toEqual([]);
  });

  it('uses min-width breakpoints at 640, 900 and 1200px only', () => {
    const found = NEW_SCOPE.flatMap((f) =>
      rulesOf(f).flatMap((r) =>
        r.conditions.flatMap(badBreakpoints).map((b) => `${f}:${r.line} ${b}`),
      ),
    );
    expect([...new Set(found)]).toEqual([]);
  });

  it('the budget checks catch what they are meant to', () => {
    expect(colourLiterals('color', '#fff')).toEqual(['#fff']);
    expect(colourLiterals('background', 'oklch(0.5 0.1 200)')).toEqual(['oklch()']);
    expect(colourLiterals('border', '1px solid white')).toEqual(['white']);
    expect(
      colourLiterals('background', 'color-mix(in oklab, var(--primary) 12%, transparent)'),
    ).toEqual([]);
    expect(literalSizes('padding', '0.5rem var(--space-2)')).toEqual(['0.5rem']);
    expect(literalSizes('margin', 'calc(-1 * var(--space-2))')).toEqual([]);
    expect(literalSizes('z-index', '60')).toEqual(['60']);
    expect(literalSizes('gap', 'var(--gap, var(--space-4))')).toEqual([]);
    expect(badBreakpoints('@media (max-width: 600px)')).toEqual(['(max-width: 600px)']);
    expect(badBreakpoints('@media (min-width: 700px)')).toEqual(['(min-width: 700px)']);
    expect(badBreakpoints('@media (min-width: 900px) and (pointer: coarse)')).toEqual([]);
  });
});

describe('legacy.css is frozen', () => {
  const baseline = JSON.parse(
    readFileSync(path.resolve(process.cwd(), LEGACY_BASELINE), 'utf8'),
  ) as LegacyBaseline;
  const now = currentLegacyBaseline();

  it('adds no lines', () => {
    expect(now.lines, `${LEGACY_CSS} grew past ${LEGACY_BASELINE}`).toBeLessThanOrEqual(
      baseline.lines,
    );
  });

  it('adds no selectors', () => {
    const added = now.selectors.filter((s) => !baseline.selectors.includes(s));
    expect(added, 'new legacy selectors: put new styles in a component module').toEqual([]);
  });

  it('the baseline is tight, so every removal is locked in (pnpm css:legacy-baseline)', () => {
    expect(baseline.lines, 'legacy.css shrank: run pnpm css:legacy-baseline').toBe(now.lines);
    expect(baseline.selectors.filter((s) => !now.selectors.includes(s))).toEqual([]);
  });

  it('is the old globals.css moved verbatim (not reindented), inside @layer legacy', () => {
    const text = read(LEGACY_CSS);
    expect(text).toContain(
      '\n@layer legacy {\n*,\n*::before,\n*::after {\n  box-sizing: border-box;\n}\n',
    );
    expect(text.trimEnd().endsWith('}\n}')).toBe(true);
    expect(countLines(text)).toBe(now.lines);
    expect(loadCssFile(LEGACY_CSS).every((r) => r.layer === 'legacy')).toBe(true);
    // The :root token block moved to tokens.css as aliases.
    expect(loadCssFile(LEGACY_CSS).filter((r) => r.selectors.includes(':root'))).toEqual([]);
  });
});

describe('custom properties', () => {
  /** Everything that defines a custom property: CSS declarations, inline style keys, next/font. */
  function definedProperties(): Set<string> {
    const names = new Set<string>();
    for (const f of FILES) {
      for (const r of rulesOf(f))
        for (const d of r.decls) if (d.prop.startsWith('--')) names.add(d.prop);
    }
    for (const src of uiSources()) {
      // { '--x': … } and { ['--x' as string]: … }
      for (const m of src.text.matchAll(/['"`](--[\w-]+)['"`](?:\s+as\s+\w+)?\]?\s*:/g))
        names.add(m[1]!);
      for (const m of src.text.matchAll(/variable:\s*['"](--[\w-]+)['"]/g)) names.add(m[1]!);
    }
    return names;
  }

  /** TS/TSX that renders app UI. Standalone HTML renderers under app/api carry their own CSS. */
  function uiSources(): Array<{ file: string; text: string }> {
    const root = path.resolve(process.cwd(), 'src');
    return readdirSync(root, { recursive: true, encoding: 'utf8' })
      .map((f) => f.split(path.sep).join('/'))
      .filter(
        (f) =>
          /\.(ts|tsx)$/.test(f) &&
          /^(app|components|lib\/ui)\//.test(f) &&
          !f.startsWith('app/api/'),
      )
      .map((f) => ({
        file: `src/${f}`,
        // Comments may mention var(--x) as prose.
        text: readFileSync(path.join(root, f), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|\s)\/\/.*$/gm, '$1'),
      }));
  }

  it('no var() reads a property nothing defines (a fallback does not excuse it)', () => {
    const defined = definedProperties();
    const undefinedRefs: string[] = [];
    for (const f of FILES) {
      const css = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (!defined.has(m[1]!)) undefinedRefs.push(`${f}: ${m[1]}`);
      }
    }
    for (const src of uiSources()) {
      for (const m of src.text.matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (!defined.has(m[1]!)) undefinedRefs.push(`${src.file}: ${m[1]}`);
      }
    }
    expect([...new Set(undefinedRefs)]).toEqual([]);
  });

  const tokens = rootTokens(loadCssFile('src/styles/tokens.css'));
  const resolve = (name: string) => resolveVars(`var(${name})`, tokens);

  it('every --brand-* name is an alias of a new token, except four legacy-only decorations', () => {
    const LEGACY_ONLY = [
      '--brand-glow',
      '--brand-grid-line',
      '--brand-shadow',
      '--brand-shadow-hover',
    ];
    const brand = [...tokens.keys()].filter((n) => n.startsWith('--brand-'));
    expect(brand.length).toBe(21);
    for (const name of brand) {
      const value = tokens.get(name)!;
      if (LEGACY_ONLY.includes(name)) {
        expect(value, name).not.toMatch(/var\(--brand-/);
        continue;
      }
      expect(value, name).toMatch(/^var\(--(?!brand-)[\w-]+\)$/);
    }
  });

  it('the aliases keep the values legacy.css was drawn with (only the mark changes hue)', () => {
    // The pre-DS-06 :root values of globals.css.
    const before: Record<string, string> = {
      '--brand-bg': 'oklch(0.18 0.025 250)',
      '--brand-fg': 'oklch(0.96 0.005 250)',
      '--brand-muted': 'oklch(0.75 0.02 250)',
      '--brand-border': 'oklch(0.34 0.025 250)',
      '--brand-card': 'oklch(0.215 0.025 250)',
      '--brand-card-elevated': 'oklch(0.235 0.025 250)',
      '--brand-input': 'oklch(0.26 0.025 250)',
      '--brand-primary': 'oklch(0.74 0.17 225)',
      '--brand-primary-foreground': 'oklch(0.15 0.025 250)',
      '--brand-accent-teal': 'oklch(0.74 0.15 185)',
      '--brand-accent-amber': 'oklch(0.8 0.16 75)',
      '--brand-status-approved': 'oklch(0.78 0.17 150)',
      '--brand-status-rejected': 'oklch(0.73 0.19 25)',
      '--brand-grid-line': 'oklch(0.3 0.025 250 / 0.4)',
      '--brand-radius': '8px', // was 0.5rem
      '--brand-mono':
        "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace",
      '--brand-sans':
        "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    };
    for (const [name, value] of Object.entries(before)) expect(resolve(name), name).toBe(value);
    expect(resolve('--header-h')).toBe('4rem');
    // The deliberate primary-hue alignment: the mark now runs primary → teal
    // (it was oklch(0.72 0.14 220) → oklch(0.72 0.12 180)).
    expect(resolve('--brand-mark-gradient')).toBe(
      'linear-gradient(135deg, oklch(0.74 0.17 225), oklch(0.74 0.15 185))',
    );
  });
});
