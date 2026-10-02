'use client';

// Branded backstop for any uncaught error below the root layout that no
// nearer boundary catches — a page outside the workspace frame that
// throws, or a server action that throws something no action handler
// expected. Replaces Next's bare "Application error: a server-side
// exception has occurred" page. Workspace pages have their own boundary
// inside the frame (app/(app)/error.tsx, DS-07); both render ErrorCard.

import { useEffect } from 'react';
import { BrandHeader } from '@/components/BrandHeader';
import { ErrorCard } from '@/components/StatusCards';
import { BRAND_NAME } from '@/lib/brand';

export default function AppError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <>
      <title>{`Something went wrong · ${BRAND_NAME}`}</title>
      <BrandHeader />
      <main className="status-page">
        <ErrorCard digest={error.digest} reset={reset} />
      </main>
    </>
  );
}
