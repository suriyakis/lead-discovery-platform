// KL-06: the indexing runs of a source (or of a document's sources), as
// receipts — what each run did, how many attempts it took, why it failed.
// Shared by /knowledge/[id] and /documents/[id].

import type { IndexingJob } from '@/lib/db/schema/rag';

const NOTE_LABELS: Record<string, string> = {
  unchanged: 'text and model unchanged, nothing re-embedded',
  embedded: 'embedded',
  superseded: 'superseded by a newer request',
  timed_out: 'stopped after 15 minutes',
};

const REASON_LABELS: Record<string, string> = {
  create: 'new source',
  edit: 'after an edit',
  reindex: 'Re-index',
  document: 'from the document page',
  reextract_ocr: 'Re-extract with OCR',
};

export function IndexRunList({ jobs }: { jobs: ReadonlyArray<IndexingJob> }) {
  if (jobs.length === 0) return null;
  return (
    <ul className="timeline" data-testid="index-runs">
      {jobs.map((j) => {
        const parts: string[] = [];
        if (j.reason) parts.push(REASON_LABELS[j.reason] ?? j.reason);
        if (j.attempts > 1) parts.push(`attempt ${j.attempts}`);
        if (j.status === 'succeeded' || j.chunkCount > 0) parts.push(`${j.chunkCount} chunks`);
        if (j.embeddingModel) parts.push(j.embeddingModel);
        if (j.note) parts.push(NOTE_LABELS[j.note] ?? j.note);
        if (j.status === 'queued' && j.nextAttemptAt) {
          parts.push(`next try ${j.nextAttemptAt.toLocaleString()}`);
        }
        if (j.error) parts.push(j.error.slice(0, 200));
        return (
          <li key={j.id.toString()} data-run-status={j.status}>
            <span className="muted">{j.createdAt.toLocaleString()}</span>{' '}
            <strong>{j.status}</strong>
            {parts.length > 0 ? ` · ${parts.join(' · ')}` : ''}
          </li>
        );
      })}
    </ul>
  );
}
