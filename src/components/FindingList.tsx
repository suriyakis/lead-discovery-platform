// AP-06: one list of diagnostics findings, as /health and Today show it —
// the severity badge, the title, the detail (unless compact) and the fix
// link. Server-safe (no hooks); styles in FindingList.module.css.

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { StatusBadge } from '@/components/Badge';
import type { FindingSeverity } from '@/lib/diagnostics/types';
import { fixHref } from '@/lib/diagnostics/hrefs';
import styles from './FindingList.module.css';

/** What a list row needs: a live Finding or a saved report's finding. */
export interface FindingRow {
  code: string;
  severity: FindingSeverity;
  advisory?: boolean;
  title?: string;
  detail?: string;
  /** Rows saved before AP-06 have only this sentence. */
  message?: string;
  href?: string | null;
}

export function FindingList({
  findings,
  compact = false,
  label,
}: Readonly<{
  findings: ReadonlyArray<FindingRow>;
  /** Title and fix link only (Today). */
  compact?: boolean;
  /** Accessible name of the list. */
  label: string;
}>) {
  return (
    <ul className={styles.list} aria-label={label}>
      {findings.map((f, i) => {
        const title = f.title ?? f.message ?? f.code;
        return (
          <li key={`${f.code}:${i}`} className={styles.row} data-code={f.code}>
            <span className={styles.badge}>
              <StatusBadge set="health_finding_severity" value={f.severity} size="sm" />
            </span>
            <div className={styles.body}>
              <p className={styles.title}>{title}</p>
              {!compact && f.title && f.detail ? <p className={styles.detail}>{f.detail}</p> : null}
            </div>
            {f.href ? (
              <Link href={f.href} className={styles.fix}>
                {/* Nothing to change here: the platform team acts. */}
                {f.href === fixHref.support() ? 'Contact support' : 'Fix'}{' '}
                <ArrowRight className="lucide" aria-hidden="true" />
                <span className="sr-only"> — {title}</span>
              </Link>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
