// The branded 404 card, shared by app/not-found.tsx (unmatched URLs, with
// its own BrandHeader) and app/(app)/not-found.tsx (a workspace page's
// notFound(), inside the workspace frame — DS-07 / MOB-03). A server
// component: no session lookup, nothing that can fail.

import Link from 'next/link';

export function NotFoundCard() {
  return (
    <div className="status-card">
      <p className="status-eyebrow">404 · Not found</p>
      <h1>We couldn&apos;t find that page</h1>
      <p className="status-lede">
        The link may be mistyped, or the page was moved or removed — or the item belongs to a
        workspace you&apos;re not signed in to.
      </p>
      <div className="status-actions">
        <Link href="/today" className="primary-btn">
          Go to Today
        </Link>
        <Link href="/support">Contact support</Link>
      </div>
    </div>
  );
}
