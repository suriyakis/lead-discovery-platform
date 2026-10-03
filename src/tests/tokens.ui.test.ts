// DS-06 acceptance: every colour pair the meaning map promises (§6.1)
// reads on the real surfaces. The token values come from
// src/styles/tokens.css itself; OKLCH is converted to sRGB and tints are
// composited in gamma space, as the browser draws them.
//
// Surfaces: the page (--bg), flat panels (--surface), the top of the card
// gradient (.24), raised (--surface-raised), the input fill
// (--surface-input) and a well (--bg-deep at 60% over the card top).

import { describe, expect, it } from 'vitest';
import { loadCssFile, rootTokens, splitTopLevel } from './helpers/css-cascade';
import {
  composite,
  contrast,
  luminance,
  oklchToSrgb,
  resolveColor,
  type Rgba,
} from './helpers/color';

const tokens = rootTokens(loadCssFile('src/styles/tokens.css'));
const color = (name: string) => resolveColor(`var(${name})`, tokens);

/** The first stop of the --surface-card gradient: the card's lightest band. */
function cardTop(): Rgba {
  const gradient = tokens.get('--surface-card')!;
  const inner = /^linear-gradient\((.*)\)$/.exec(gradient)![1]!;
  const [, firstStop] = splitTopLevel(inner, ',');
  return oklchToSrgb(firstStop!);
}

const card = cardTop();
const SURFACES: ReadonlyArray<[string, Rgba]> = [
  ['page --bg', color('--bg')],
  ['--surface', color('--surface')],
  ['card top', card],
  ['--surface-raised', color('--surface-raised')],
  ['--surface-input', color('--surface-input')],
  ['well over the card', composite(color('--well'), card)],
];

const TONES = ['neutral', 'info', 'live', 'ai', 'attention', 'success', 'danger'] as const;

function ratios(fg: Rgba, on: (surface: Rgba) => Rgba = (s) => s) {
  return SURFACES.map(([label, surface]) => {
    const bg = on(surface);
    return { label, ratio: Math.round(contrast(fg, bg) * 100) / 100 };
  });
}

describe('colour maths', () => {
  it('converts OKLCH to sRGB', () => {
    const white = oklchToSrgb('oklch(1 0 0)');
    const black = oklchToSrgb('oklch(0 0 0)');
    expect([white.r, white.g, white.b].map((x) => Math.round(x * 1000) / 1000)).toEqual([1, 1, 1]);
    expect([black.r, black.g, black.b]).toEqual([0, 0, 0]);
    // CSS Color 4's oklch() for pure sRGB red.
    const red = oklchToSrgb('oklch(0.62796 0.25768 29.2339)');
    expect(red.r).toBeCloseTo(1, 2);
    expect(red.g).toBeCloseTo(0, 2);
    expect(red.b).toBeCloseTo(0, 2);
    expect(contrast(white, black)).toBeCloseTo(21, 5);
  });

  it('composites a tint in gamma space, not in linear light', () => {
    const half = composite({ r: 1, g: 1, b: 1, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 });
    // The browser blends the encoded values: 50% white over black is
    // #808080 (0.5 encoded, luminance 0.214), not linear 0.5 (#bcbcbc).
    expect(half.r).toBeCloseTo(0.5, 6);
    expect(luminance(half)).toBeCloseTo(0.214, 3);
  });

  it('reads color-mix(in oklab, x P%, transparent) as x at P% alpha', () => {
    const soft = resolveColor('var(--info-soft)', tokens);
    const primary = color('--primary');
    expect(soft.a).toBeCloseTo(0.12, 6);
    expect([soft.r, soft.g, soft.b]).toEqual([primary.r, primary.g, primary.b]);
  });
});

describe('token contrast on every surface (§6.1)', () => {
  it('body and secondary text read at >= 4.5:1', () => {
    for (const name of ['--fg', '--fg-muted']) {
      for (const r of ratios(color(name)))
        expect(r.ratio, `${name} on ${r.label}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('--fg-subtle (placeholder, disabled, tertiary) reads at >= 4.5:1', () => {
    for (const r of ratios(color('--fg-subtle'))) {
      expect(r.ratio, `--fg-subtle on ${r.label}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('--border-control (input, checkbox and radio edges) reaches >= 3:1', () => {
    for (const r of ratios(color('--border-control'))) {
      expect(r.ratio, `--border-control against ${r.label}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("each tone's text reads at >= 4.5:1 on its own tint", () => {
    for (const tone of TONES) {
      const text = color(`--tone-${tone}`);
      const tint = color(`--${tone}-soft`);
      expect(tint.a, `--${tone}-soft is a 12% tint`).toBeCloseTo(0.12, 6);
      for (const r of ratios(text, (surface) => composite(tint, surface))) {
        expect(r.ratio, `${tone} on --${tone}-soft over ${r.label}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('--on-primary reads at >= 4.5:1 on primary, at rest and on hover', () => {
    for (const fill of ['--primary', '--primary-hover']) {
      expect(
        contrast(color('--on-primary'), color(fill)),
        `--on-primary on ${fill}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('user-tag hues read at >= 4.5:1 as text', () => {
    for (let i = 1; i <= 6; i++) {
      for (const r of ratios(color(`--tag-${i}`))) {
        expect(r.ratio, `--tag-${i} on ${r.label}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('every tone token points at its meaning (the map in tokens.css)', () => {
    expect(Object.fromEntries(TONES.map((t) => [t, tokens.get(`--tone-${t}`)]))).toEqual({
      neutral: 'var(--fg-muted)',
      info: 'var(--primary)',
      live: 'var(--teal)',
      ai: 'var(--violet)',
      attention: 'var(--amber)',
      success: 'var(--success)',
      danger: 'var(--danger)',
    });
    expect(tokens.get('--tone-muted')).toBe('var(--fg-subtle)');
  });
});
