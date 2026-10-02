// A small, honest CSS cascade for tests: parse globals.css, match its
// selectors against fixture markup with cheerio (css-select understands
// :is/:where/:not/:has), and resolve which declaration wins by
// !important → specificity → source order. No layout engine, no
// inheritance beyond what a test passes in — enough to assert "this
// element ends up with that colour/border/top" against the REAL
// stylesheet instead of grepping it.
//
// Dynamic pseudo-classes (:hover, :focus-visible, …) never match here:
// css-select either reports them as non-matching or throws, and a
// throwing selector is skipped. Tests for those states read the rules.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CheerioAPI } from 'cheerio';

export interface CssDecl {
  prop: string;
  value: string;
  important: boolean;
}

export interface CssRule {
  /** The full selector list as written (whitespace-normalised). */
  selectorText: string;
  selectors: string[];
  decls: CssDecl[];
  /** Enclosing @media / @supports conditions, outermost first. */
  conditions: string[];
  /** Source order — later wins at equal specificity. */
  order: number;
  /** 1-based line of the opening brace, for failure messages. */
  line: number;
}

export type Specificity = readonly [number, number, number];

/** Vitest runs from the repo root (see vitest.config.ts). */
export function loadGlobalsCss(): string {
  return readFileSync(path.resolve(process.cwd(), 'src/app/globals.css'), 'utf8');
}

// ---- parsing ----------------------------------------------------------

/** Split on `sep` at depth 0, ignoring separators inside (), [] and strings. */
export function splitTopLevel(input: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === sep && depth === 0) {
      out.push(input.slice(start, i));
      start = i + 1;
    }
  }
  out.push(input.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

function findBlockEnd(css: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < css.length; i++) {
    const ch = css[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced block at offset ${open}`);
}

function parseDecls(body: string): CssDecl[] {
  return splitTopLevel(body, ';').flatMap((chunk) => {
    const colon = chunk.indexOf(':');
    if (colon < 0) return [];
    const prop = chunk.slice(0, colon).trim().toLowerCase();
    let value = chunk
      .slice(colon + 1)
      .replace(/\s+/g, ' ')
      .trim();
    const important = /!\s*important$/i.test(value);
    if (important) value = value.replace(/\s*!\s*important$/i, '').trim();
    return [{ prop, value, important }];
  });
}

export function parseCss(source: string): CssRule[] {
  // Blank comments out but keep their newlines so line numbers hold.
  const css = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const rules: CssRule[] = [];
  const walk = (from: number, to: number, conditions: string[]) => {
    let i = from;
    while (i < to) {
      const open = css.indexOf('{', i);
      if (open < 0 || open >= to) return;
      const prelude = css.slice(i, open).replace(/\s+/g, ' ').trim();
      const close = findBlockEnd(css, open);
      if (/^@(media|supports)\b/i.test(prelude)) {
        walk(open + 1, close, [...conditions, prelude]);
      } else if (!prelude.startsWith('@')) {
        // @keyframes / @font-face bodies are not style rules.
        rules.push({
          selectorText: prelude,
          selectors: splitTopLevel(prelude, ','),
          decls: parseDecls(css.slice(open + 1, close)),
          conditions,
          order: rules.length,
          line: css.slice(0, open).split('\n').length,
        });
      }
      i = close + 1;
    }
  };
  walk(0, css.length, []);
  return rules;
}

// ---- specificity -------------------------------------------------------

const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);

function maxSpecificity(list: string): Specificity {
  return splitTopLevel(list, ',')
    .map(specificity)
    .reduce<Specificity>((best, s) => (compareSpecificity(s, best) > 0 ? s : best), [0, 0, 0]);
}

/** Selectors Level 4 specificity of ONE complex selector. */
export function specificity(selector: string): Specificity {
  let a = 0;
  let b = 0;
  let c = 0;
  const s = selector.trim();
  let i = 0;
  const readName = () => {
    const m = /^-?[_a-zA-Z -￿\\][-_a-zA-Z0-9 -￿\\]*/.exec(s.slice(i));
    const name = m ? m[0] : '';
    i += name.length;
    return name;
  };
  const readParens = () => {
    let depth = 0;
    const start = i;
    for (; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') {
        depth--;
        if (depth === 0) {
          i++;
          return s.slice(start + 1, i - 1);
        }
      }
    }
    throw new Error(`unbalanced parens in ${selector}`);
  };
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '#') {
      i++;
      readName();
      a++;
    } else if (ch === '.') {
      i++;
      readName();
      b++;
    } else if (ch === '[') {
      i = s.indexOf(']', i) + 1;
      b++;
    } else if (ch === ':') {
      if (s[i + 1] === ':') {
        i += 2;
        readName();
        if (s[i] === '(') readParens();
        c++;
        continue;
      }
      i++;
      const name = readName().toLowerCase();
      const args = s[i] === '(' ? readParens() : null;
      if (name === 'where') continue;
      if ((name === 'is' || name === 'not' || name === 'has') && args !== null) {
        const [x, y, z] = maxSpecificity(args);
        a += x;
        b += y;
        c += z;
      } else if (LEGACY_PSEUDO_ELEMENTS.has(name)) {
        c++;
      } else {
        b++;
      }
    } else if (ch === '*') {
      i++;
    } else if (/[-_a-zA-Z]/.test(ch)) {
      readName();
      c++;
    } else {
      i++; // combinators, whitespace
    }
  }
  return [a, b, c];
}

export function compareSpecificity(x: Specificity, y: Specificity): number {
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

// ---- cascade -----------------------------------------------------------

export interface CascadeOptions {
  /** Which @media/@supports preludes apply. Default: none of them. */
  conditionMatches?: (prelude: string) => boolean;
}

export interface Winner {
  value: string;
  important: boolean;
  specificity: Specificity;
  rule: CssRule;
}

/** Longhands the tests care about, from the shorthands globals.css uses. */
function expand(decl: CssDecl): CssDecl[] {
  const { prop, value, important } = decl;
  if (prop === 'border') {
    if (value === 'none' || value === '0') {
      return [{ prop: 'border-style', value: 'none', important }];
    }
    const out: CssDecl[] = [decl];
    for (const part of splitTopLevel(value, ' ')) {
      if (/^(none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)$/.test(part)) {
        out.push({ prop: 'border-style', value: part, important });
      } else if (/^(\d|\.|thin|medium|thick)/.test(part)) {
        out.push({ prop: 'border-width', value: part, important });
      } else {
        out.push({ prop: 'border-color', value: part, important });
      }
    }
    return out;
  }
  if (prop === 'padding') {
    const parts = splitTopLevel(value, ' ');
    const [top, right = top, bottom = top] = parts;
    return [
      decl,
      { prop: 'padding-top', value: top!, important },
      { prop: 'padding-bottom', value: bottom!, important },
      { prop: 'padding-right', value: right!, important },
    ];
  }
  return [decl];
}

/**
 * The winning declaration per property for the single element `target`
 * selects in `$`. Selectors css-select cannot evaluate are skipped.
 */
export function cascade(
  $: CheerioAPI,
  target: string,
  rules: ReadonlyArray<CssRule>,
  opts: CascadeOptions = {},
): Map<string, Winner> {
  const el = $(target);
  if (el.length !== 1) throw new Error(`"${target}" matched ${el.length} elements, need 1`);
  const conditionMatches = opts.conditionMatches ?? (() => false);
  const winners = new Map<string, Winner>();
  for (const rule of rules) {
    if (!rule.conditions.every(conditionMatches)) continue;
    let best: Specificity | null = null;
    for (const sel of rule.selectors) {
      let hit = false;
      try {
        hit = el.is(sel);
      } catch {
        hit = false;
      }
      if (hit) {
        const sp = specificity(sel);
        if (!best || compareSpecificity(sp, best) > 0) best = sp;
      }
    }
    if (!best) continue;
    for (const decl of rule.decls.flatMap(expand)) {
      const prev = winners.get(decl.prop);
      const beats =
        !prev ||
        (decl.important && !prev.important) ||
        (decl.important === prev.important &&
          (compareSpecificity(best, prev.specificity) > 0 ||
            (compareSpecificity(best, prev.specificity) === 0 && rule.order >= prev.rule.order)));
      if (beats) {
        winners.set(decl.prop, {
          value: decl.value,
          important: decl.important,
          specificity: best,
          rule,
        });
      }
    }
  }
  return winners;
}

/** Computed-ish value of one property (undefined when nothing sets it). */
export function styleOf(
  $: CheerioAPI,
  target: string,
  rules: ReadonlyArray<CssRule>,
  prop: string,
  opts?: CascadeOptions,
): string | undefined {
  return cascade($, target, rules, opts).get(prop)?.value;
}

// ---- values --------------------------------------------------------------

/** Custom properties declared on :root. */
export function rootTokens(rules: ReadonlyArray<CssRule>): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const rule of rules) {
    if (rule.conditions.length > 0 || !rule.selectors.includes(':root')) continue;
    for (const d of rule.decls) if (d.prop.startsWith('--')) tokens.set(d.prop, d.value);
  }
  return tokens;
}

/** Replace var(--x[, fallback]) with :root values, recursively. */
export function resolveVars(value: string, tokens: ReadonlyMap<string, string>, depth = 0): string {
  if (depth > 10) throw new Error(`var() cycle resolving ${value}`);
  const out = value.replace(
    /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g,
    (_m, name: string, fallback?: string) => {
      const v = tokens.get(name) ?? fallback;
      if (v === undefined) throw new Error(`undefined custom property ${name}`);
      return v;
    },
  );
  return out.includes('var(') ? resolveVars(out, tokens, depth + 1) : out;
}

export interface Oklch {
  l: number;
  c: number;
  h: number;
  alpha: number;
}

export function parseOklch(value: string): Oklch {
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/.exec(
    value.trim(),
  );
  if (!m) throw new Error(`not a plain oklch() colour: ${value}`);
  const l = Number(m[1]) / (m[2] ? 100 : 1);
  const alpha = m[5] === undefined ? 1 : Number(m[5]) / (m[6] ? 100 : 1);
  return { l, c: Number(m[3]), h: Number(m[4]), alpha };
}

function oklchToLinearSrgb({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return [
    clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}

/** WCAG 2 contrast ratio of two opaque oklch() colours. */
export function contrastRatio(fg: string, bg: string): number {
  const lum = (v: string) => {
    const col = parseOklch(v);
    if (col.alpha < 1) throw new Error(`contrastRatio needs opaque colours, got ${v}`);
    const [r, g, b] = oklchToLinearSrgb(col);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** px for a rem/em/px length (em relative to `fontPx`). */
export function toPx(length: string, fontPx = 16): number {
  const m = /^(-?[\d.]+)(rem|em|px)?$/.exec(length.trim());
  if (!m) throw new Error(`unsupported length: ${length}`);
  const n = Number(m[1]);
  if (m[2] === 'rem') return n * 16;
  if (m[2] === 'em') return n * fontPx;
  return n;
}
