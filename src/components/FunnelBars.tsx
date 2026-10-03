// FunnelBars (DS-09): an ordered progression as horizontal bars in one hue.
// Each row's fill steps down the --seq ramp (tokens.css: the primary at
// 100% falling to 40%), so position and length carry the progression and
// no stage gets a colour of its own (the old cold-to-warm rainbow read as
// meaning). Used by the /pipeline funnel and the Today overview card, both
// labelled from PIPELINE_STATE_LABEL, so the two always agree.

import Link from 'next/link';
import { cssVars } from '@/lib/ui/css-vars';
import { sequenceStep } from '@/lib/ui/tone';
import styles from './FunnelBars.module.css';

export interface FunnelRow {
  key: string;
  label: string;
  count: number;
  /** Makes the row a link (drill-in). Omit inside a card that is a link. */
  href?: string;
}

/** Bar length in percent of the largest row (0 for an empty funnel). */
export function funnelPercent(count: number, max: number): number {
  if (max <= 0 || count <= 0) return 0;
  return Math.round((Math.min(count, max) / max) * 100);
}

export function FunnelBars({
  rows,
  label,
}: Readonly<{ rows: ReadonlyArray<FunnelRow>; label: string }>) {
  const max = Math.max(0, ...rows.map((r) => r.count));
  return (
    <ol className={styles.funnel} aria-label={label}>
      {rows.map((row, i) => {
        const inner = (
          <>
            <span className={styles.label}>{row.label}</span>
            <span className={styles.track} aria-hidden="true">
              <span
                className={styles.fill}
                data-step={sequenceStep(i, rows.length)}
                style={cssVars({ '--v': funnelPercent(row.count, max) })}
              />
            </span>
            <span className={styles.count}>{row.count}</span>
          </>
        );
        return (
          <li key={row.key} data-funnel-row={row.key}>
            {row.href ? (
              <Link href={row.href} className={styles.row}>
                {inner}
              </Link>
            ) : (
              <span className={styles.row}>{inner}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
