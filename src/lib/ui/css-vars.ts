import type { CSSProperties } from 'react';

export type CssVarName = `--${string}`;

/**
 * An inline style made only of custom properties, the one kind of inline
 * style the design system allows (DS-06): the CSS module reads the
 * variable, so values stay data and every colour and size stays a token.
 *
 *   <span className={styles.bar} style={cssVars({ '--v': 78 })} />
 */
export function cssVars(vars: Readonly<Record<CssVarName, string | number>>): CSSProperties {
  return { ...vars } as CSSProperties;
}
