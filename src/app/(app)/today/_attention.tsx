// Today › what needs fixing (AP-06, PC-33's attention block): the problems
// the diagnostics engine finds — the same list /health shows and the
// assistant reads — at the top of both Today views, most severe first,
// each with its fix link. Info and advisory findings stay on /health.
// Reads the engine's 30 s memo: Today renders on every navigation home.

import Link from 'next/link';
import { Alert } from '@/components/Alert';
import { FindingList } from '@/components/FindingList';
import { getWorkspaceDiagnostics } from '@/lib/diagnostics/engine';
import { fixHref } from '@/lib/diagnostics/hrefs';
import { isProblem } from '@/lib/diagnostics/types';
import type { WorkspaceContext } from '@/lib/services/context';
import styles from './today.module.css';

/** At most this many problems on Today; the rest are on /health. */
export const TODAY_MAX_PROBLEMS = 5;

export async function TodayAttention({ ctx }: Readonly<{ ctx: WorkspaceContext }>) {
  const healthHref = fixHref.health();
  let problems;
  try {
    problems = (await getWorkspaceDiagnostics(ctx)).findings.filter(isProblem);
  } catch (err) {
    console.error('[today] workspace checks unavailable:', err);
    return (
      <Alert tone="warning" title="The workspace checks could not run">
        Today&apos;s list of problems is unavailable; <Link href={healthHref}>Health checks</Link>{' '}
        tries again.
      </Alert>
    );
  }
  if (problems.length === 0) return null;
  const shown = problems.slice(0, TODAY_MAX_PROBLEMS);
  return (
    <section className={styles.attention} aria-labelledby="today-attention">
      <div className={styles.attentionHead}>
        <h2 id="today-attention" className="section-title">
          Needs fixing
        </h2>
        <Link href={healthHref} className="small">
          {problems.length > shown.length
            ? `All ${problems.length} problems on Health checks`
            : 'Health checks'}
        </Link>
      </div>
      <FindingList findings={shown} label="Problems in this workspace" compact />
    </section>
  );
}
