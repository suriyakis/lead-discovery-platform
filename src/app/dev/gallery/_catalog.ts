// What the component gallery shows for each design token (DS-06). Every
// custom property in src/styles/tokens.css (except the legacy --brand-*
// aliases) is listed here exactly once with the job it does;
// src/tests/dev-gallery.test.ts fails when a token is added without an
// entry, so the gallery stays the complete review surface.

import type { CssVarName } from '@/lib/ui/css-vars';
import { TONES as TONE_LIST, TONE_MEANING, type Tone } from '@/lib/ui/tone';

/** How the gallery draws a token. */
export type SampleKind =
  | 'fill' // a swatch filled with the token
  | 'text' // sample text in the token colour on every surface
  | 'line' // a box outlined in the token
  | 'bar' // a bar whose length is the token
  | 'ramp' // funnel bars filled with the token, one step narrower each
  | 'height' // a bar whose height is the token
  | 'radius' // a box with the token's corner radius
  | 'shadow' // a box casting the token
  | 'type' // a type sample at the token size
  | 'value'; // listed with its use only (motion, stacking, fonts…)

export interface TokenEntry {
  name: CssVarName;
  use: string;
}

export interface TokenGroup {
  id: string;
  title: string;
  description?: string;
  kind: SampleKind;
  tokens: ReadonlyArray<TokenEntry>;
}

const t = (name: CssVarName, use: string): TokenEntry => ({ name, use });

export const TOKEN_GROUPS: ReadonlyArray<TokenGroup> = [
  {
    id: 'neutrals',
    title: 'Neutrals',
    description:
      'Blue-tinted surfaces, darkest to lightest. Wells sit inside cards; a card never holds a card.',
    kind: 'fill',
    tokens: [
      t('--bg', 'Page'),
      t('--bg-deep', 'Wells, sidebar'),
      t('--surface', 'Flat panels, table body'),
      t('--surface-card', 'Card (gradient)'),
      t('--surface-raised', 'Menus, selected row, secondary button'),
      t('--surface-input', 'Control fill'),
      t('--surface-overlay', 'Header, tab bar, sheets (with blur)'),
      t('--well', 'Nested item inside a card'),
      t('--scrim', 'Behind a modal dialog'),
    ],
  },
  {
    id: 'lines',
    title: 'Lines',
    kind: 'line',
    tokens: [
      t('--border-subtle', 'Row dividers'),
      t('--border', 'Card and panel edges'),
      t('--border-strong', 'Hover, selected'),
      t('--border-control', 'Input, checkbox and radio edges (3:1 on every surface)'),
    ],
  },
  {
    id: 'text',
    title: 'Text',
    description:
      'Each sample sits on the page, a surface, a card, a raised surface, an input fill and a well.',
    kind: 'text',
    tokens: [
      t('--fg', 'Body text'),
      t('--fg-muted', 'Secondary text, labels, meta'),
      t('--fg-subtle', 'Placeholder, disabled, tertiary (4.5:1 on every surface)'),
    ],
  },
  {
    id: 'signals',
    title: 'Signals',
    description: 'Each hue carries one meaning. Components pick a tone, never a hue.',
    kind: 'fill',
    tokens: [
      t('--primary', 'Act, you, links, scores'),
      t('--primary-hover', 'Primary under the pointer'),
      t('--on-primary', 'Text on primary'),
      t('--teal', 'Live, indexed, evidence'),
      t('--violet', 'AI-written, AI verdicts, learned rules'),
      t('--amber', 'Waits for a decision by this user'),
      t('--success', 'Approved, sent, won'),
      t('--danger', 'Rejected, failed, destructive'),
    ],
  },
  {
    id: 'sequence',
    title: 'Sequence',
    description: 'Ordered progressions such as the funnel: one hue, stepped opacity.',
    kind: 'ramp',
    tokens: [
      t('--seq-1', 'Step 1'),
      t('--seq-2', 'Step 2'),
      t('--seq-3', 'Step 3'),
      t('--seq-4', 'Step 4'),
      t('--seq-5', 'Step 5'),
      t('--seq-6', 'Step 6'),
      t('--seq-7', 'Step 7'),
    ],
  },
  {
    id: 'tags',
    title: 'User tags',
    description: 'Six fixed low-chroma hues for user-chosen tags. Never hashed, never a signal.',
    kind: 'text',
    tokens: [
      t('--tag-1', 'Tag hue 1'),
      t('--tag-2', 'Tag hue 2'),
      t('--tag-3', 'Tag hue 3'),
      t('--tag-4', 'Tag hue 4'),
      t('--tag-5', 'Tag hue 5'),
      t('--tag-6', 'Tag hue 6'),
    ],
  },
  {
    id: 'gradients',
    title: 'Brand gradients and motif lines',
    description: 'The only gradients allowed. The mark runs primary to teal.',
    kind: 'fill',
    tokens: [
      t('--gradient-card', 'Card surface'),
      t('--gradient-mark', 'Brand mark tile'),
      t('--grid-line', 'Grid-field motif'),
      t('--rings-line', 'Sonar-rings motif'),
      t('--glyph-check', 'Checked checkbox glyph'),
      t('--glyph-dash', 'Indeterminate checkbox glyph'),
    ],
  },
  {
    id: 'type',
    title: 'Type scale',
    description:
      'Eight steps. Weights 400 and 500; 600 for numerals only. Mono for machine values only.',
    kind: 'type',
    tokens: [
      t('--text-label', 'Instrument label: mono, uppercase, the only uppercase style'),
      t('--text-xs', 'Meta, hints, chips'),
      t('--text-sm', 'Default UI and body'),
      t('--text-md', 'List titles, prose, inputs on touch'),
      t('--text-lg', 'Section and card titles'),
      t('--text-xl', 'KPI values, drawer titles, the mobile page title'),
      t('--text-2xl', 'Page title'),
      t('--text-display', 'Greeting, landing, page empty states'),
    ],
  },
  {
    id: 'type-metrics',
    title: 'Type metrics',
    kind: 'value',
    tokens: [
      t('--font-sans', 'Inter, self-hosted through next/font'),
      t('--font-mono', 'JetBrains Mono: ids, domains, codes, scores, times'),
      t('--leading-label', 'Line height of the label step'),
      t('--leading-xs', 'Line height of xs'),
      t('--leading-sm', 'Line height of sm'),
      t('--leading-md', 'Line height of md'),
      t('--leading-lg', 'Line height of lg'),
      t('--leading-xl', 'Line height of xl'),
      t('--leading-2xl', 'Line height of 2xl'),
      t('--leading-display', 'Line height of display'),
      t('--leading-prose', 'Long-form text'),
      t('--text-mono', 'Mono inside sans, optically matched'),
      t('--weight-regular', 'Body'),
      t('--weight-medium', 'Headings, buttons, labels'),
      t('--weight-numeral', 'Numerals only'),
      t('--tracking-tight', '24px and up'),
      t('--tracking-label', 'Instrument labels'),
    ],
  },
  {
    id: 'space',
    title: 'Space',
    description: 'A 4px grid in 12 steps.',
    kind: 'bar',
    tokens: [
      t('--space-0_5', '2px'),
      t('--space-1', '4px'),
      t('--space-1_5', '6px'),
      t('--space-2', '8px: control gap'),
      t('--space-3', '12px'),
      t('--space-4', '16px: card gap, mobile card padding'),
      t('--space-5', '20px: card padding'),
      t('--space-6', '24px: mobile section gap'),
      t('--space-8', '32px: section gap'),
      t('--space-10', '40px'),
      t('--space-12', '48px'),
      t('--space-16', '64px'),
    ],
  },
  {
    id: 'rhythm',
    title: 'Rhythm',
    description: 'Card padding and section gap grow from 640px; the gutter from 640 and 1200px.',
    kind: 'bar',
    tokens: [
      t('--gap-control', 'Between controls in a row'),
      t('--pad-card', 'Inside a card'),
      t('--gap-card', 'Between cards'),
      t('--gap-section', 'Between sections'),
      t('--gutter', 'Page side padding'),
    ],
  },
  {
    id: 'radius',
    title: 'Radius',
    kind: 'radius',
    tokens: [
      t('--radius-xs', 'Chips, checkbox, code'),
      t('--radius-sm', 'Buttons, inputs, rows, wells'),
      t('--radius-md', 'Popovers, menus, toasts, alerts'),
      t('--radius-lg', 'Cards'),
      t('--radius-xl', 'Sheets, dialogs'),
      t('--radius-full', 'Avatars, dots, switch, pills'),
    ],
  },
  {
    id: 'elevation',
    title: 'Elevation and focus',
    description:
      'Cards never lift on hover; a hover changes the border. One glow per screen at most.',
    kind: 'shadow',
    tokens: [
      t('--shadow-card', 'Card'),
      t('--shadow-pop', 'Menus, popovers'),
      t('--shadow-modal', 'Dialogs, sheets'),
      t('--ring', 'Selected or focused card'),
      t('--glow', 'The one highlighted element'),
      t('--focus-ring-control', 'Focused input, select or textarea'),
    ],
  },
  {
    id: 'focus',
    title: 'Focus outline',
    kind: 'value',
    tokens: [t('--focus-outline', 'Keyboard focus on everything else (base.css)')],
  },
  {
    id: 'controls',
    title: 'Controls and rows',
    description:
      'Every control in a row uses one height token. On a coarse pointer --control-md is 44px.',
    kind: 'height',
    tokens: [
      t('--control-sm', '28px: compact toolbars'),
      t('--control-md', '36px: default (44px on touch)'),
      t('--control-lg', '44px: primary touch targets'),
      t('--row-sm', '40px: dense rows'),
      t('--row-md', '48px: table rows'),
      t('--row-lg', '64px: list rows with meta'),
    ],
  },
  {
    id: 'motion',
    title: 'Motion',
    description: 'Under prefers-reduced-motion only a short opacity fade remains (utilities.css).',
    kind: 'value',
    tokens: [
      t('--dur-1', '120ms: hover, press'),
      t('--dur-2', '200ms: open, close'),
      t('--dur-3', '320ms: sheets, drawers'),
      t('--ease-out', 'Entering'),
      t('--ease-in-out', 'Moving'),
      t('--dur-pulse', 'Live pulse (running processes only)'),
      t('--dur-flow', 'Flow-map dashes'),
    ],
  },
  {
    id: 'stacking',
    title: 'Stacking',
    description: 'Real overlays use the top layer and need no z-index.',
    kind: 'value',
    tokens: [
      t('--z-sticky', 'Sticky toolbars'),
      t('--z-header', 'App header'),
      t('--z-tabbar', 'Mobile tab bar'),
      t('--z-fab', 'Assistant launcher'),
      t('--z-overlay', 'Static overlays in mockups'),
    ],
  },
  {
    id: 'layout',
    title: 'Layout',
    description: 'Breakpoints: 640, 900 and 1200px, min-width only (src/lib/ui/breakpoints.ts).',
    kind: 'value',
    tokens: [
      t('--header-h', 'App header height (4rem until the DS-12 frame)'),
      t('--tabbar-h', 'Mobile tab bar height'),
      t('--safe-b', 'Bottom safe-area inset'),
      t('--sidebar-w', 'Sidebar width from 900px'),
      t('--rail-w', 'Right rail width from 1200px'),
      t('--content-max', 'Default page width'),
      t('--content-narrow', 'Forms and detail pages'),
      t('--content-prose', 'Readable line length'),
    ],
  },
];

/** The eight tones and what each one means: the meaning map of
 *  src/lib/ui/tone.ts (DS-09), the one source. */
export const TONES: ReadonlyArray<{ tone: Tone; use: string }> = TONE_LIST.map((tone) => ({
  tone,
  use: TONE_MEANING[tone],
}));

export type { Tone };

/** Tone tokens: the tone colour, plus a chip fill and border for all but muted. */
export function toneTokens(tone: Tone): CssVarName[] {
  return tone === 'muted'
    ? ['--tone-muted']
    : [`--tone-${tone}`, `--${tone}-soft`, `--${tone}-line`];
}

/**
 * The surfaces every text and tone sample is shown on. A translucent one
 * (the well) is drawn over the surface it lives on.
 */
export const SURFACES: ReadonlyArray<{ name: CssVarName; label: string; over?: CssVarName }> = [
  { name: '--bg', label: 'Page' },
  { name: '--surface', label: 'Surface' },
  { name: '--surface-card', label: 'Card' },
  { name: '--surface-raised', label: 'Raised' },
  { name: '--surface-input', label: 'Input' },
  { name: '--well', label: 'Well', over: '--surface-card' },
];

/** Every token name the gallery shows. */
export function galleryTokenNames(): CssVarName[] {
  return [
    ...TOKEN_GROUPS.flatMap((g) => g.tokens.map((x) => x.name)),
    ...TONES.flatMap((x) => toneTokens(x.tone)),
  ];
}
