// The Leadsonar mark and the lead/sonar wordmark (DS-08).
//
// BrandMark draws the hybrid mark inline from the geometry in
// src/lib/brand-mark.ts, on the tokens: the svg box is the tile (its own
// background is var(--gradient-mark)), the glyph is drawn in --bg and the
// echo in --amber. It is an image with a name (role="img" + <title>), so
// it reads as "Leadsonar" wherever it appears outside a labelled link.
//
// BrandLockup is the mark plus the wordmark, and it is how the brand shows
// in the chrome: once per page, in BrandHeader (app pages, the public
// pages and the backstops), AdminShell (the Platform console) or
// global-error. The wordmark carries data-brand-wordmark, which the tests
// and the e2e smoke count.
//
// No hooks beyond useId and no app imports, so the server shell, the
// client console and global-error (which avoids app components) can all
// render it.

import { useId } from 'react';
import { BRAND_NAME, BRAND_WORDMARK } from '@/lib/brand';
import {
  arcPath,
  MARK_ARC_WIDTH,
  MARK_ARCS,
  MARK_ECHO,
  MARK_GRID,
  MARK_ORIGIN,
  MARK_SWEEP,
  SWEEP_PATH,
} from '@/lib/brand-mark';
import styles from './Brand.module.css';

export function BrandMark({ className }: Readonly<{ className?: string }>) {
  const titleId = useId();
  return (
    <svg
      className={className ? `${styles.mark} ${className}` : styles.mark}
      viewBox={`0 0 ${MARK_GRID} ${MARK_GRID}`}
      role="img"
      aria-labelledby={titleId}
      focusable="false"
      data-brand-mark=""
    >
      <title id={titleId}>{BRAND_NAME}</title>
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth={MARK_ARC_WIDTH}>
        {MARK_ARCS.map((a) => (
          <path key={a.r} d={arcPath(a.r)} opacity={a.opacity} />
        ))}
        <path d={SWEEP_PATH} strokeWidth={MARK_SWEEP.width} opacity={MARK_SWEEP.opacity} />
      </g>
      <circle
        className={styles.echo}
        cx={MARK_ECHO.x}
        cy={MARK_ECHO.y}
        r={MARK_ECHO.r}
        strokeWidth={MARK_ECHO.ring}
      />
      <circle cx={MARK_ORIGIN.x} cy={MARK_ORIGIN.y} r={MARK_ORIGIN.r} fill="currentColor" />
    </svg>
  );
}

/**
 * When the wordmark shows: `always`, or `from-sm` = from 640px up, so a
 * phone header that also carries controls shows the mark alone (the
 * Direction A frame). A header with nothing else in it keeps the name.
 */
export type WordmarkVisibility = 'always' | 'from-sm';

/** "lead/sonar" in mono, the slash a step quieter. */
export function BrandWordmark({
  visibility = 'from-sm',
}: Readonly<{ visibility?: WordmarkVisibility }>) {
  return (
    <span
      className={visibility === 'from-sm' ? `${styles.wordmark} ${styles.fromSm}` : styles.wordmark}
      data-brand-wordmark={visibility}
    >
      {BRAND_WORDMARK.lead}
      <span className={styles.slash}>{BRAND_WORDMARK.slash}</span>
      {BRAND_WORDMARK.sonar}
    </span>
  );
}

/**
 * The mark and the wordmark, for inside a link that names itself
 * (aria-label), e.g. BrandHeader's home link. Laid out by that link.
 */
export function BrandLockup({ wordmark = 'from-sm' }: Readonly<{ wordmark?: WordmarkVisibility }>) {
  return (
    <>
      <BrandMark />
      <BrandWordmark visibility={wordmark} />
    </>
  );
}
