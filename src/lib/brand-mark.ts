// The Leadsonar mark, as data (DS-08; decision D17 in docs/design/IA.md).
//
// The hybrid mark: the market-navigator gradient tile (--gradient-mark,
// primary to teal at 135deg) carrying the sonar glyph of the old favicon:
// three arcs swept from the tile's bottom-left corner, the sweep line,
// and one amber echo (the lead it found), drawn in the page colour.
//
// One geometry, every medium:
//   - components/Brand.tsx draws it inline on the tokens (the tile is the
//     svg box's own background, so it is var(--gradient-mark) itself);
//   - markSvg() writes it with hex colours for the files that cannot read
//     CSS: src/app/icon.svg, the PNG app icons, favicon.ico and the
//     link-preview card (BRAND_ICON_FILES, rendered by
//     `pnpm brand:icons` = scripts/brand-icons.ts).
// tests/brand.test.ts holds the committed files to this module.
//
// Coordinates are on a 64-unit grid (the old favicon's), y pointing down.
// Pure data and string building: no React, no Node APIs.

import { BRAND_COLOURS, BRAND_NAME, BRAND_TAGLINE, BRAND_WORDMARK } from './brand';

export const MARK_GRID = 64;

/**
 * Corner radius of the tile on the grid. Inline, CSS draws the tile with
 * --radius-sm on a --control-sm box (6px on 28px, 13.7 units); the files
 * keep the old favicon's 14.
 */
export const MARK_TILE_RADIUS = 14;

/** Where the sweep starts: the sonar sits in the tile's bottom-left corner. */
export const MARK_ORIGIN = { x: 12, y: 52, r: 3.5 } as const;

/** The three range rings, fading outwards. */
export const MARK_ARCS = [
  { r: 10, opacity: 0.95 },
  { r: 20, opacity: 0.65 },
  { r: 30, opacity: 0.38 },
] as const;

export const MARK_ARC_WIDTH = 5;

/** The sweep line, from the origin towards the echo. */
export const MARK_SWEEP = { x: 41, y: 23, width: 3.5, opacity: 0.85 } as const;

/** The echo: an amber blip in a ring of page colour, so it reads on the gradient. */
export const MARK_ECHO = { x: 45, y: 19, r: 6.5, ring: 3 } as const;

/** A quarter ring of radius `r` around the origin, from 3 o'clock to 12. */
export function arcPath(r: number): string {
  const { x, y } = MARK_ORIGIN;
  return `M${x + r} ${y}A${r} ${r} 0 0 0 ${x} ${y - r}`;
}

export const SWEEP_PATH = `M${MARK_ORIGIN.x} ${MARK_ORIGIN.y}L${MARK_SWEEP.x} ${MARK_SWEEP.y}`;

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The glyph's ink box on the grid: round caps, the echo's ring and the origin dot included. */
export function glyphBounds(): Box {
  const cap = MARK_ARC_WIDTH / 2;
  const outer = MARK_ARCS[MARK_ARCS.length - 1]!.r;
  const echo = MARK_ECHO.r + MARK_ECHO.ring / 2;
  const { x, y, r } = MARK_ORIGIN;
  return {
    minX: Math.min(x - r, x - cap),
    minY: Math.min(y - outer - cap, MARK_ECHO.y - echo),
    maxX: Math.max(x + outer + cap, MARK_ECHO.x + echo),
    maxY: Math.max(y + r, y + cap),
  };
}

/**
 * Maskable icons are cropped by the platform to anything from a circle to
 * a square, so the glyph has to sit inside the safe zone: a circle of 40%
 * of the icon's size around its centre (W3C appmanifest, "icon masks").
 */
export const MASKABLE_SAFE_RADIUS = 0.4 * MARK_GRID;

/** Scale for the maskable glyph: its ink box's corners land inside the safe zone, with a margin. */
export const MASKABLE_SCALE = 0.8;

/** Grid → grid transform that centres the glyph and scales it into the safe zone. */
export function maskableTransform(): { scale: number; tx: number; ty: number } {
  const b = glyphBounds();
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const half = MARK_GRID / 2;
  return { scale: MASKABLE_SCALE, tx: half - MASKABLE_SCALE * cx, ty: half - MASKABLE_SCALE * cy };
}

/**
 * - `tile`: the rounded gradient tile on a transparent ground (favicon,
 *   the manifest's `any` icons).
 * - `square`: the same art, full bleed (apple-touch-icon: iOS rounds the
 *   corners itself and shows transparency as black).
 * - `maskable`: full bleed, the glyph scaled into the safe zone.
 */
export type MarkLayout = 'tile' | 'square' | 'maskable';

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/** The glyph as SVG elements with literal colours (for files; the inline mark uses tokens). */
function glyphElements(): string {
  const c = BRAND_COLOURS;
  const arcs = MARK_ARCS.map((a) => `<path d="${arcPath(a.r)}" opacity="${a.opacity}"/>`).join('');
  return (
    `<g fill="none" stroke="${c.bg}" stroke-linecap="round" stroke-width="${MARK_ARC_WIDTH}">` +
    arcs +
    `<path d="${SWEEP_PATH}" stroke-width="${MARK_SWEEP.width}" opacity="${MARK_SWEEP.opacity}"/>` +
    `</g>` +
    `<circle cx="${MARK_ECHO.x}" cy="${MARK_ECHO.y}" r="${MARK_ECHO.r}" fill="${c.amber}" stroke="${c.bg}" stroke-width="${MARK_ECHO.ring}"/>` +
    `<circle cx="${MARK_ORIGIN.x}" cy="${MARK_ORIGIN.y}" r="${MARK_ORIGIN.r}" fill="${c.bg}"/>`
  );
}

/** The mark as a standalone SVG document with hex colours. */
export function markSvg(layout: MarkLayout): string {
  const c = BRAND_COLOURS;
  const g = MARK_GRID;
  const rx = layout === 'tile' ? ` rx="${MARK_TILE_RADIUS}"` : '';
  let glyph = glyphElements();
  if (layout === 'maskable') {
    const t = maskableTransform();
    glyph = `<g transform="translate(${fmt(t.tx)} ${fmt(t.ty)}) scale(${t.scale})">${glyph}</g>`;
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${g} ${g}">`,
    `<!-- ${BRAND_NAME} mark (${layout}). Generated from src/lib/brand-mark.ts by pnpm brand:icons; do not edit. -->`,
    `<defs><linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0" stop-color="${c.primary}"/><stop offset="1" stop-color="${c.teal}"/>`,
    `</linearGradient></defs>`,
    `<rect width="${g}" height="${g}"${rx} fill="url(#tile)"/>`,
    glyph,
    `</svg>`,
    '',
  ].join('\n');
}

/** Alt text for the link-preview card; Next reads it from OG_IMAGE_ALT_FILE. */
export const OG_IMAGE_ALT = `${BRAND_NAME}: ${BRAND_TAGLINE}`;

export const OG_IMAGE_ALT_FILE = 'src/app/opengraph-image.alt.txt';

/** Where `pnpm brand:icons` records what it rendered (tests/brand.test.ts reads it). */
export const BRAND_ICON_LOCK_FILE = 'scripts/brand-icons.lock.json';

/** Per file: sha256 of the source it was rendered from, and of the bytes written. */
export interface BrandIconLock {
  files: Record<string, { source: string; output: string }>;
}

export const OG_IMAGE_SIZE = { width: 1200, height: 630 } as const;

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The link-preview card (og:image) as an HTML page: the mark, the
 * wordmark and the tagline on the page colour. The generator loads the
 * brand fonts from Google Fonts while it renders (the app self-hosts them
 * through next/font); offline it falls back to the system sans and mono.
 */
export function ogImageHtml(): string {
  const c = BRAND_COLOURS;
  const { width, height } = OG_IMAGE_SIZE;
  const mark = markSvg('tile').replace('<svg ', '<svg width="168" height="168" ');
  const w = BRAND_WORDMARK;
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=JetBrains+Mono:wght@500&display=block">',
    '<style>',
    `html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}`,
    `body{background:${c.bg};color:${c.fg};font-family:Inter,system-ui,sans-serif;display:flex;align-items:center;padding:0 96px;box-sizing:border-box;position:relative}`,
    // The motifs, faint: a 32px grid and the sonar rings swept from the mark's corner.
    `.grid{position:absolute;inset:0;background-image:linear-gradient(${c.fgMuted}10 1px,transparent 1px),linear-gradient(90deg,${c.fgMuted}10 1px,transparent 1px);background-size:32px 32px}`,
    `.glow{position:absolute;inset:0;background:radial-gradient(ellipse 70% 80% at 18% 50%,${c.primary}26,transparent 70%)}`,
    '.row{position:relative;display:flex;align-items:center;gap:56px}',
    `.word{font:500 76px/1 'JetBrains Mono',ui-monospace,monospace;letter-spacing:-0.02em}`,
    `.word span{color:${c.fgMuted}}`,
    `.tag{margin-top:28px;font:400 36px/1.25 Inter,system-ui,sans-serif;color:${c.fg};white-space:nowrap}`,
    `.desc{margin-top:16px;font:400 24px/1.4 Inter,system-ui,sans-serif;color:${c.fgMuted};white-space:nowrap}`,
    '</style></head><body>',
    '<div class="grid"></div><div class="glow"></div>',
    `<div class="row">${mark}<div>`,
    `<div class="word">${escapeHtml(w.lead)}<span>${escapeHtml(w.slash)}</span>${escapeHtml(w.sonar)}</div>`,
    `<div class="tag">${escapeHtml(BRAND_TAGLINE)}</div>`,
    `<div class="desc">B2B lead discovery, qualification and outreach — with evidence.</div>`,
    '</div></div>',
    '</body></html>',
    '',
  ].join('\n');
}

/** One generated brand file: where it goes, its pixel size and what it is rendered from. */
export interface BrandIconFile {
  /** Repo-relative path of the committed file. */
  file: string;
  kind: 'svg' | 'png' | 'ico';
  /** Pixel sizes: one for a PNG, every frame for an ICO, the grid for the SVG. */
  sizes: ReadonlyArray<{ width: number; height: number }>;
  /** The SVG or HTML document the file is rendered from. */
  source: string;
  /** For the manifest: its public URL and purpose (public/ files only). */
  manifest?: { src: string; purpose: 'any' | 'maskable' };
}

const square = (n: number) => ({ width: n, height: n });

/**
 * Every brand file `pnpm brand:icons` writes. Next serves the src/app ones
 * through its file conventions (icon.svg → <link rel="icon">, favicon.ico,
 * apple-icon.png → <link rel="apple-touch-icon">, opengraph-image.png →
 * og:image with its .alt.txt), app/manifest.ts lists the public/ ones.
 */
export const BRAND_ICON_FILES: ReadonlyArray<BrandIconFile> = [
  { file: 'src/app/icon.svg', kind: 'svg', sizes: [square(MARK_GRID)], source: markSvg('tile') },
  {
    file: 'src/app/favicon.ico',
    kind: 'ico',
    sizes: [square(16), square(32), square(48)],
    source: markSvg('tile'),
  },
  { file: 'src/app/apple-icon.png', kind: 'png', sizes: [square(180)], source: markSvg('square') },
  {
    file: 'src/app/opengraph-image.png',
    kind: 'png',
    sizes: [OG_IMAGE_SIZE],
    source: ogImageHtml(),
  },
  {
    file: 'public/icons/icon-192.png',
    kind: 'png',
    sizes: [square(192)],
    source: markSvg('tile'),
    manifest: { src: '/icons/icon-192.png', purpose: 'any' },
  },
  {
    file: 'public/icons/icon-512.png',
    kind: 'png',
    sizes: [square(512)],
    source: markSvg('tile'),
    manifest: { src: '/icons/icon-512.png', purpose: 'any' },
  },
  {
    file: 'public/icons/icon-maskable-192.png',
    kind: 'png',
    sizes: [square(192)],
    source: markSvg('maskable'),
    manifest: { src: '/icons/icon-maskable-192.png', purpose: 'maskable' },
  },
  {
    file: 'public/icons/icon-maskable-512.png',
    kind: 'png',
    sizes: [square(512)],
    source: markSvg('maskable'),
    manifest: { src: '/icons/icon-maskable-512.png', purpose: 'maskable' },
  },
];
