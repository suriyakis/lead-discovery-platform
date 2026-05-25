'use client';

// P62-24: collapsible Recent runs section with bulk-select + delete.
// Owns the per-row checkbox state so the toolbar can show a live
// "N selected" counter and disable Delete until at least one row is
// ticked.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ConfirmFormButton } from './ConfirmFormButton';

export interface RunRow {
  id: string;
  status: string;
  recordCount: number;
  createdAtIso: string;
}

interface Props {
  connectorId: string;
  rows: RunRow[];
  canEdit: boolean;
  /** Server action — receives FormData with id[] entries. */
  onDelete: (formData: FormData) => Promise<void>;
}

export function ConnectorRunsList({
  connectorId,
  rows,
  canEdit,
  onDelete,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const allIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const allChecked = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someChecked = !allChecked && selected.size > 0;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(allIds));
  }

  return (
    <details className="runs-section" open={false}>
      <summary>
        <span className="runs-summary-title">
          Recent runs ({rows.length})
        </span>
        <span className="runs-summary-hint muted small">click to expand</span>
      </summary>

      {rows.length === 0 ? (
        <p className="muted">No runs yet.</p>
      ) : (
        <form>
          <div className="runs-toolbar">
            <label className="runs-toolbar-check">
              <input
                type="checkbox"
                checked={allChecked}
                ref={(el) => {
                  if (el) el.indeterminate = someChecked;
                }}
                onChange={toggleAll}
                aria-label={allChecked ? 'Deselect all' : 'Select all'}
              />
              <span>
                {selected.size > 0
                  ? `${selected.size} selected`
                  : `${rows.length} run${rows.length === 1 ? '' : 's'}`}
              </span>
            </label>
            {canEdit ? (
              <ConfirmFormButton
                formAction={onDelete}
                message={`Permanently delete ${selected.size} run${selected.size === 1 ? '' : 's'}? Logs, scraped source records, and qualifications attached to these runs will go with them. This cannot be undone.`}
                className="ghost-btn small danger"
                disabled={selected.size === 0}
              >
                Delete selected
              </ConfirmFormButton>
            ) : null}
          </div>

          <ul className="runs-list">
            {rows.map((r) => {
              const when = new Date(r.createdAtIso);
              return (
                <li
                  key={r.id}
                  className={`runs-row${selected.has(r.id) ? ' is-checked' : ''}`}
                >
                  {canEdit ? (
                    <input
                      type="checkbox"
                      name="ids"
                      value={r.id}
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      aria-label={`Select run ${r.id}`}
                    />
                  ) : null}
                  <Link
                    href={`/connectors/${connectorId}/runs/${r.id}`}
                    className="runs-row-link"
                  >
                    Run #{r.id}
                  </Link>
                  <span
                    className={`runs-status runs-status-${r.status}`}
                    title="Run status"
                  >
                    {r.status}
                  </span>
                  <span className="muted small">
                    {r.recordCount} record{r.recordCount === 1 ? '' : 's'}
                  </span>
                  <span className="muted small runs-when">
                    {when.toLocaleString()}
                  </span>
                </li>
              );
            })}
          </ul>
        </form>
      )}
    </details>
  );
}
