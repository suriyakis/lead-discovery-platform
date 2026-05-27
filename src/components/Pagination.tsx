import Link from 'next/link';

interface Props {
  basePath: string;
  /** Query params already present (NOT including `page`). Round-tripped on
   *  every page link so the user keeps their filter when paging. */
  query: Record<string, string | undefined>;
  page: number;
  pageSize: number;
  total: number;
  /** Short label shown next to the count ("leads", "items", etc.). */
  unitLabel?: string;
}

function buildHref(base: string, q: Record<string, string | undefined>, page: number): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== '') params.set(k, v);
  }
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * Server-rendered prev / next pager. Page numbers are 1-indexed in the
 * URL. When there is only one page or none, the row collapses to a
 * single muted line stating the total — no buttons, no noise.
 */
export function Pagination({ basePath, query, page, pageSize, total, unitLabel = 'items' }: Props) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(1, page), pageCount);
  const start = total === 0 ? 0 : (clamped - 1) * pageSize + 1;
  const end = Math.min(clamped * pageSize, total);

  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="pagination-summary">
        {total === 0
          ? `No ${unitLabel}`
          : `${start}–${end} of ${total} ${unitLabel}`}
        {pageCount > 1 ? (
          <span className="pagination-page-info">
            {' '}· Page {clamped} of {pageCount}
          </span>
        ) : null}
      </span>
      {pageCount > 1 ? (
        <span className="pagination-actions">
          {clamped > 1 ? (
            <Link href={buildHref(basePath, query, clamped - 1)} className="ghost-btn">
              ← Prev
            </Link>
          ) : (
            <span className="ghost-btn is-disabled" aria-disabled="true">← Prev</span>
          )}
          {clamped < pageCount ? (
            <Link href={buildHref(basePath, query, clamped + 1)} className="ghost-btn">
              Next →
            </Link>
          ) : (
            <span className="ghost-btn is-disabled" aria-disabled="true">Next →</span>
          )}
        </span>
      ) : null}
    </nav>
  );
}
