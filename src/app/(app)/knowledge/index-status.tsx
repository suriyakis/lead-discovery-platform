// KL-06: how a knowledge source's index status reads to an operator. One
// place so /knowledge, /knowledge/[id], /documents/[id] and the product
// page say the same thing (I104: no "pending" on a source that already
// feeds drafts, no green badge on one whose text changed).

import type { KnowledgeIndexStatus, KnowledgeSource } from '@/lib/db/schema/documents';

const BADGE_CLASS: Record<KnowledgeIndexStatus, string> = {
  queued: 'badge badge-info',
  indexing: 'badge badge-info',
  indexed: 'badge badge-good',
  stale: 'badge badge-warn',
  failed: 'badge badge-bad',
};

/** Still moving: a page showing it polls until it settles. A stale source
 *  with a queued or running run is moving too. */
export function indexStatusMoving(status: KnowledgeIndexStatus, runActive = false): boolean {
  return status === 'queued' || status === 'indexing' || (status === 'stale' && runActive);
}

export function IndexStatusBadge({ status }: { status: KnowledgeIndexStatus }) {
  return (
    <span className={BADGE_CLASS[status]} data-index-status={status}>
      {status}
    </span>
  );
}

/** One sentence under the badge. */
export function indexStatusExplanation(
  source: Pick<KnowledgeSource, 'indexStatus' | 'indexedAt' | 'lastIndexError'>,
  runActive: boolean,
): string {
  const previous = source.indexedAt
    ? 'Drafts keep using the version indexed before.'
    : 'Drafts cannot use it until it is indexed.';
  switch (source.indexStatus) {
    case 'queued':
      return source.lastIndexError
        ? `Waiting to retry after an error: ${source.lastIndexError.slice(0, 200)} ${previous}`
        : 'Waiting for the indexing job. This page updates on its own.';
    case 'indexing':
      return 'Indexing now. This page updates on its own.';
    case 'indexed':
      return 'Up to date: drafts and replies use the current version.';
    case 'stale':
      if (!source.indexedAt) {
        return runActive ? 'Not indexed yet; indexing is queued.' : 'Not indexed yet. Click Index now.';
      }
      return runActive
        ? `Changed since it was indexed; re-indexing is queued. ${previous}`
        : `Changed since it was indexed. Click Re-index. ${previous}`;
    case 'failed':
      return `Indexing failed${source.lastIndexError ? `: ${source.lastIndexError.slice(0, 300)}` : '.'} ${previous}`;
  }
}
