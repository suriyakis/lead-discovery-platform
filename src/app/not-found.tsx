// Branded 404 for unmatched URLs and every notFound() call in the app.
// Stays static (no session lookup) so it renders even when auth or the
// database is having a bad day; /today sends signed-out visitors to
// the sign-in page on its own.

import type { Metadata } from 'next';
import Link from 'next/link';
import { BrandHeader } from '@/components/BrandHeader';
import { BRAND_NAME } from '@/lib/brand';

export const metadata: Metadata = {
  title: `Page not found · ${BRAND_NAME}`,
};

export default function NotFound() {
  return (
    <>
      <BrandHeader />
      <main className="status-page">
        <div className="status-card">
          <p className="status-eyebrow">404 · Not found</p>
          <h1>We couldn&apos;t find that page</h1>
          <p className="status-lede">
            The link may be mistyped, or the page was moved or removed — or the item
            belongs to a workspace you&apos;re not signed in to.
          </p>
          <div className="status-actions">
            <Link href="/today" className="primary-btn">
              Go to Today
            </Link>
            <Link href="/support">Contact support</Link>
          </div>
        </div>
      </main>
    </>
  );
}
