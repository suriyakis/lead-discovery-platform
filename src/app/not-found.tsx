// Branded 404 for unmatched URLs and every notFound() call outside the
// workspace frame (workspace pages render app/(app)/not-found.tsx inside
// it, DS-07). Stays static (no session lookup) so it renders even when
// auth or the database is having a bad day; /today sends signed-out
// visitors to the sign-in page on its own.

import type { Metadata } from 'next';
import { BrandHeader } from '@/components/BrandHeader';
import { NotFoundCard } from '@/components/NotFoundCard';
import { BRAND_NAME } from '@/lib/brand';

export const metadata: Metadata = {
  title: `Page not found · ${BRAND_NAME}`,
};

export default function NotFound() {
  return (
    <>
      <BrandHeader />
      <main className="status-page">
        <NotFoundCard />
      </main>
    </>
  );
}
