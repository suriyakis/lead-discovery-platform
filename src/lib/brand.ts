// The brand kit's words and colours, in one place (DS-08).
//
// One product name: "Leadsonar". Operators see it in the tab title, the
// installed app and link previews, and anything we write in the product's
// voice (the in-app guide, its handbook, test emails that land in real
// inboxes) says it too; the old working title is gone from src/
// (tests/brand.test.ts greps for it). "lead/sonar" is only the mono
// wordmark beside the mark, shown once per page (components/Brand.tsx).
// docs/design/IA.md holds the vocabulary.
//
// Pure constants: client components, route handlers and scripts import it.

/** The product's name in prose, titles and the installed app. */
export const BRAND_NAME = 'Leadsonar';

/** The mono wordmark beside the mark: `lead` + `/` + `sonar`. */
export const BRAND_WORDMARK = { lead: 'lead', slash: '/', sonar: 'sonar' } as const;

/** The wordmark as plain text ("lead/sonar"). */
export const BRAND_WORDMARK_TEXT = `${BRAND_WORDMARK.lead}${BRAND_WORDMARK.slash}${BRAND_WORDMARK.sonar}`;

/** The line under the name: metadata, the web app manifest, link previews. */
export const BRAND_TAGLINE = 'Ping the market, keep the echoes that matter.';

/** The longer description: <meta name="description">, the manifest, og:description. */
export const BRAND_DESCRIPTION = `${BRAND_TAGLINE} B2B lead discovery, qualification, outreach, and intelligence — with evidence and a learning layer.`;

/**
 * sRGB renderings of the Direction A tokens (src/styles/tokens.css) for
 * the places that cannot read a CSS custom property: the favicon and the
 * app icons, the web app manifest and <meta name="theme-color">.
 * tests/brand.test.ts recomputes each one from tokens.css (OKLCH → sRGB,
 * out-of-gamut channels clipped), so a token change that is not carried
 * over here fails the suite.
 */
export const BRAND_COLOURS = {
  /** --bg: the page, the browser chrome around the installed app, the glyph. */
  bg: '#09121c',
  /** --primary: where the mark's gradient starts. */
  primary: '#00bffa',
  /** --teal: where the mark's gradient ends. */
  teal: '#00c8b7',
  /** --amber: the echo, the one lead the sweep found. */
  amber: '#f9ad26',
  /** --fg: text on the link-preview card. */
  fg: '#eff2f5',
  /** --fg-muted: secondary text on the link-preview card. */
  fgMuted: '#a5afba',
} as const;

export type BrandColour = keyof typeof BRAND_COLOURS;

/** The token each BRAND_COLOURS entry renders (tests/brand.test.ts checks the pairs). */
export const BRAND_COLOUR_TOKENS: Readonly<Record<BrandColour, `--${string}`>> = {
  bg: '--bg',
  primary: '--primary',
  teal: '--teal',
  amber: '--amber',
  fg: '--fg',
  fgMuted: '--fg-muted',
};
