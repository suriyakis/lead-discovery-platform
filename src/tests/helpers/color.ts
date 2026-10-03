// Colour maths for the token contrast tests (DS-06): OKLCH → sRGB, the
// small subset of CSS colour syntax tokens.css uses, alpha compositing in
// gamma (encoded sRGB) space the way browsers blend, and WCAG 2 contrast.

import { oklchToLinearSrgb, parseOklch, splitTopLevel } from './css-cascade';

/** Gamma-encoded sRGB channels in [0, 1] plus alpha. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const encode = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const decode = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);

/** An `oklch(L C H [/ A])` literal as encoded sRGB (out-of-gamut channels clipped). */
export function oklchToSrgb(value: string): Rgba {
  const col = parseOklch(value);
  const [r, g, b] = oklchToLinearSrgb(col).map(encode) as [number, number, number];
  return { r, g, b, a: col.alpha };
}

/**
 * Resolve a token colour expression to sRGB: an oklch() literal, a
 * var() chain, or `color-mix(in oklab, <colour> P%, transparent)` (mixing
 * with transparent keeps the colour and scales its alpha, because CSS
 * mixes with premultiplied alpha).
 */
export function resolveColor(expr: string, tokens: ReadonlyMap<string, string>, depth = 0): Rgba {
  if (depth > 12) throw new Error(`colour cycle at ${expr}`);
  const value = expr.trim();
  const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
  if (ref) {
    const next = tokens.get(ref[1]!);
    if (next === undefined) throw new Error(`undefined colour token ${ref[1]}`);
    return resolveColor(next, tokens, depth + 1);
  }
  if (value.startsWith('oklch(')) return oklchToSrgb(value);
  const mix = /^color-mix\(\s*in oklab\s*,(.*)\)$/s.exec(value);
  if (mix) {
    const parts = splitTopLevel(mix[1]!, ',');
    if (parts.length !== 2 || parts[1] !== 'transparent') {
      throw new Error(`only color-mix(in oklab, <colour> P%, transparent) is supported: ${value}`);
    }
    const m = /^(.*)\s+([\d.]+)%$/s.exec(parts[0]!);
    if (!m) throw new Error(`color-mix needs a percentage on the first colour: ${value}`);
    const base = resolveColor(m[1]!, tokens, depth + 1);
    return { ...base, a: base.a * (Number(m[2]) / 100) };
  }
  throw new Error(`unsupported colour expression: ${value}`);
}

/** `fg` over an opaque `bg`, blended per channel in gamma space. */
export function composite(fg: Rgba, bg: Rgba): Rgba {
  if (bg.a !== 1) throw new Error('composite needs an opaque background');
  const mixChannel = (f: number, b: number) => f * fg.a + b * (1 - fg.a);
  return { r: mixChannel(fg.r, bg.r), g: mixChannel(fg.g, bg.g), b: mixChannel(fg.b, bg.b), a: 1 };
}

/** WCAG 2 relative luminance. */
export function luminance(c: Rgba): number {
  return 0.2126 * decode(c.r) + 0.7152 * decode(c.g) + 0.0722 * decode(c.b);
}

/** WCAG 2 contrast ratio; a translucent foreground is composited over `bg` first. */
export function contrast(fg: Rgba, bg: Rgba): number {
  const front = fg.a < 1 ? composite(fg, bg) : fg;
  const [hi, lo] = [luminance(front), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
