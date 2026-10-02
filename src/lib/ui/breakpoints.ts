// The design system's three breakpoints (DS-06, Direction A). CSS cannot
// read custom properties inside @media, so the numbers live here: client
// code (matchMedia) imports them, and the CSS budget test
// (src/tests/design-foundation-css.test.ts) rejects any other width in new
// stylesheets. Mobile first: queries are min-width only.

export const BREAKPOINTS = {
  /** Two-column forms, header search label, wider gutters. */
  sm: 640,
  /** The sidebar replaces the drawer and the mobile tab bar. */
  md: 900,
  /** Right rails and the widest gutter. */
  lg: 1200,
} as const;

export type Breakpoint = keyof typeof BREAKPOINTS;

/** `(min-width: 900px)`: the only kind of width query new CSS may use. */
export function minWidthQuery(bp: Breakpoint): string {
  return `(min-width: ${BREAKPOINTS[bp]}px)`;
}
