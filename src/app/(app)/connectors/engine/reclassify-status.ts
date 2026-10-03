// PC-38 (I028): the "Re-classify all" progress line on /connectors/engine.
// A plain module (no 'use server'), so the page and the tests share it.

import type { QualificationRun } from '@/lib/db/schema/qualification-runs';
import { formatUtc } from '@/lib/format-utc';

export interface ReclassifyStatus {
  /** 'info' while it works or after it finished; 'error' when it stopped
   *  short or failed. */
  tone: 'info' | 'error';
  text: string;
  /** Still queued or running: the page refreshes itself and the button
   *  waits. */
  active: boolean;
  /** Progress for a <progress> bar while it runs. */
  processed: number;
  total: number;
}

const n = (v: number) => v.toLocaleString('en-US');

function done(run: Pick<QualificationRun, 'processedRecords' | 'totalRecords'>): string {
  return `${n(run.processedRecords)} of ${n(run.totalRecords)} records`;
}

function written(run: Pick<QualificationRun, 'qualificationCount' | 'failedRecords'>): string {
  const failed =
    run.failedRecords > 0 ? `, ${n(run.failedRecords)} record(s) failed and were skipped` : '';
  return `${n(run.qualificationCount)} qualification(s) written${failed}`;
}

/**
 * One sentence about the workspace's newest run, or null when there never
 * was one. `live`: the run's job holds its lease right now (a 'running'
 * run without it was abandoned by a worker that died).
 */
export function describeReclassifyStatus(
  run: QualificationRun | null,
  live: boolean,
): ReclassifyStatus | null {
  if (!run) return null;
  const base = { processed: run.processedRecords, total: run.totalRecords };
  switch (run.status) {
    case 'queued':
      // A run handed back by a stopping worker, or resumed after its worker
      // died, keeps its progress.
      if (run.processedRecords > 0) {
        return {
          ...base,
          tone: 'info',
          active: true,
          text: `Re-classification resumes at ${done(run)} (${written(run)} so far), waiting for a worker.`,
        };
      }
      return {
        ...base,
        tone: 'info',
        active: true,
        text: `Re-classification queued at ${formatUtc(run.createdAt)}: ${n(run.totalRecords)} records against ${n(run.productCount)} product(s), waiting for a worker.`,
      };
    case 'running': {
      if (!live) {
        return {
          ...base,
          tone: 'error',
          active: false,
          text: `Re-classification stopped making progress at ${done(run)} (last progress ${formatUtc(run.heartbeatAt ?? run.startedAt ?? run.createdAt)}). Press Re-classify all to resume it from there.`,
        };
      }
      const pct =
        run.totalRecords > 0
          ? Math.min(100, Math.floor((run.processedRecords / run.totalRecords) * 100))
          : 0;
      return {
        ...base,
        tone: 'info',
        active: true,
        text: `Re-classifying: ${done(run)} (${pct}%), ${written(run)}. Started ${formatUtc(run.startedAt ?? run.createdAt)}.`,
      };
    }
    case 'succeeded':
      return {
        ...base,
        tone: 'info',
        active: false,
        text: `Last re-classification finished ${formatUtc(run.finishedAt ?? run.createdAt)}: ${done(run)}, ${written(run)}.`,
      };
    case 'stopped': {
      const why =
        run.stopReason === 'no_tokens'
          ? 'no tokens left. A workspace admin can buy a token pack in Settings → Billing, then run it again'
          : run.stopReason === 'held'
            ? 'Background AI is on hold for this workspace'
            : 'it was interrupted';
      return {
        ...base,
        tone: 'error',
        active: false,
        text: `Last re-classification stopped at ${done(run)} (${written(run)}): ${why}.`,
      };
    }
    default:
      return {
        ...base,
        tone: 'error',
        active: false,
        text: `Last re-classification failed: ${run.error ?? `stopped at ${done(run)}`}`,
      };
  }
}
