// The CSS architecture rules of DS-06 as plain functions, shared by
// src/tests/design-foundation-css.test.ts and
// scripts/legacy-css-baseline.ts (which rewrites the legacy baseline when
// legacy.css shrinks).

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BREAKPOINTS } from '../../lib/ui/breakpoints';
import { type CssRule, parseCss } from './css-cascade';

/** Lowest first. Every stylesheet and CSS module opens with this statement. */
export const LAYER_ORDER = [
  'reset',
  'tokens',
  'base',
  'legacy',
  'components',
  'patterns',
  'utilities',
] as const;

export const LAYER_STATEMENT = `@layer ${LAYER_ORDER.join(', ')};`;

export const LEGACY_CSS = 'src/styles/legacy.css';
export const LEGACY_BASELINE = 'src/styles/legacy.baseline.json';

/** Which layers each kind of stylesheet may put rules in. */
export function allowedLayers(file: string): ReadonlyArray<string> {
  if (file.endsWith('.module.css')) return ['components', 'patterns'];
  const byFile: Record<string, ReadonlyArray<string>> = {
    'src/styles/tokens.css': ['tokens'],
    'src/styles/base.css': ['reset', 'base'],
    'src/styles/legacy.css': ['legacy'],
    'src/styles/utilities.css': ['utilities'],
    'src/app/globals.css': [],
  };
  return byFile[file] ?? [];
}

/** The new-code scope of the design budget: everything but legacy. */
export function isNewScope(file: string): boolean {
  return file !== LEGACY_CSS && file !== 'src/app/globals.css';
}

/** Repo-relative (posix) paths of every .css file under src. */
export function listCssFiles(root = process.cwd()): string[] {
  return readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.css'))
    .map((f) => `src/${f.split(path.sep).join('/')}`)
    .sort();
}

export function readCss(file: string, root = process.cwd()): string {
  return readFileSync(path.join(root, file), 'utf8');
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The first statement of a stylesheet, comments skipped, whitespace normalised. */
export function firstStatement(css: string): string {
  const body = stripComments(css).trim();
  const end = body.search(/[;{]/);
  return end < 0 ? body : body.slice(0, end + 1).replace(/\s+/g, ' ');
}

/**
 * Top-level constructs of a stylesheet: statements (`@layer a, b;`,
 * `@import …;`) and blocks, each by its prelude.
 */
export function topLevel(css: string): Array<{ prelude: string; kind: 'statement' | 'block' }> {
  const src = stripComments(css);
  const out: Array<{ prelude: string; kind: 'statement' | 'block' }> = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    const semi = src.indexOf(';', i);
    if (semi >= 0 && (open < 0 || semi < open)) {
      const prelude = src.slice(i, semi).trim();
      if (prelude) out.push({ prelude: prelude.replace(/\s+/g, ' '), kind: 'statement' });
      i = semi + 1;
      continue;
    }
    if (open < 0) break;
    out.push({ prelude: src.slice(i, open).trim().replace(/\s+/g, ' '), kind: 'block' });
    let depth = 0;
    let quote: string | null = null;
    let j = open;
    for (; j < src.length; j++) {
      const ch = src[j]!;
      if (quote) {
        if (ch === '\\') j++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) break;
    }
    i = j + 1;
  }
  return out;
}

// ---- the design budget for new CSS ----------------------------------------

const NAMED_COLOURS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet ' +
    'brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan ' +
    'darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta ' +
    'darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue ' +
    'darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey ' +
    'dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray ' +
    'green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush ' +
    'lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray ' +
    'lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon ' +
    'mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue ' +
    'mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin ' +
    'navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen ' +
    'paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple ' +
    'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna ' +
    'silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle ' +
    'tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' '),
);

/** Properties whose values are names or text, never colours. */
const NOT_COLOUR =
  /^(font-family|content|grid-template-areas|grid-area|transition.*|animation.*|will-change|counter-.*|list-style-type|quotes)$/;

/** Colour literals in one declaration value (none allowed outside tokens.css). */
export function colourLiterals(prop: string, value: string): string[] {
  if (prop.startsWith('--') || NOT_COLOUR.test(prop)) return [];
  const found: string[] = [];
  const v = value.replace(/var\(\s*--[\w-]+/g, ' ');
  for (const m of v.matchAll(/#[0-9a-f]{3,8}\b/gi)) found.push(m[0]);
  for (const m of v.matchAll(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi))
    found.push(`${m[1]}()`);
  for (const word of v.toLowerCase().match(/[a-z-]+/g) ?? []) {
    if (NAMED_COLOURS.has(word)) found.push(word);
  }
  return found;
}

/** Properties whose sizes must come from tokens (spacing, type, radius, shadow, stacking). */
const SIZED =
  /^(font-size|font|margin(-.*)?|padding(-.*)?|gap|row-gap|column-gap|border(-[a-z]+)*-radius|box-shadow|z-index)$/;

/** Words allowed in a sized value once every var() is removed. */
const SIZE_KEYWORDS =
  /^(0|auto|inherit|initial|unset|revert|revert-layer|none|normal|inset|-?1px|-?[\d.]+%|-?[\d.]+|calc|min|max|clamp)$/;

/** Literal sizes in one declaration (1px hairlines, 0 and percentages are fine). */
export function literalSizes(prop: string, value: string): string[] {
  if (!SIZED.test(prop)) return [];
  if (prop === 'z-index') return /^(var\(.*\)|auto|inherit)$/.test(value.trim()) ? [] : [value];
  // Drop var(--name …) calls, innermost first, then look at what is left.
  let rest = value;
  for (let prev = ''; prev !== rest; ) {
    prev = rest;
    rest = rest.replace(/var\([^()]*\)/g, ' ');
  }
  const words = rest
    .replace(/[(),/*+]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => w !== '-');
  return words.filter((w) => !SIZE_KEYWORDS.test(w));
}

const ALLOWED_WIDTHS = new Set(Object.values(BREAKPOINTS).map((px) => `${px}px`));

/** Width conditions in an @media prelude that are not min-width at a breakpoint. */
export function badBreakpoints(prelude: string): string[] {
  const bad: string[] = [];
  for (const m of prelude.matchAll(/\(\s*((?:min-|max-)?(?:device-)?width)\s*:\s*([^)]+)\)/gi)) {
    if (m[1]!.toLowerCase() !== 'min-width' || !ALLOWED_WIDTHS.has(m[2]!.trim())) bad.push(m[0]);
  }
  if (/width\s*[<>=]/i.test(prelude)) bad.push(prelude);
  return bad;
}

// ---- the legacy freeze ----------------------------------------------------

export interface LegacyBaseline {
  file: string;
  /** Line count legacy.css may not exceed. */
  lines: number;
  /** Every selector legacy.css may use, with its @media context. */
  selectors: string[];
}

/** A rule's selectors, each keyed with its @media context. */
export function selectorKeys(rules: ReadonlyArray<CssRule>): string[] {
  const keys = new Set<string>();
  for (const r of rules) {
    const media = r.conditions.map((c) => c.replace(/^@media\s*/i, '')).join(' and ');
    for (const s of r.selectors) keys.add(media ? `@media ${media} ${s}` : s);
  }
  return [...keys].sort();
}

export function countLines(text: string): number {
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

/** The baseline legacy.css has right now (what the baseline script writes). */
export function currentLegacyBaseline(root = process.cwd()): LegacyBaseline {
  const text = readCss(LEGACY_CSS, root);
  return {
    file: LEGACY_CSS,
    lines: countLines(text),
    selectors: selectorKeys(parseCss(text, LEGACY_CSS)),
  };
}
