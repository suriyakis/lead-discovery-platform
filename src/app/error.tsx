'use client';

// Branded backstop for any uncaught error below the root layout — a page
// render that throws, or a server action that throws something no action
// handler expected. Replaces Next's bare "Application error: a server-side
// exception has occurred" page.
//
// Never render error.message: for server errors Next already swaps it for
// a generic string in production, and for client errors it may carry
// internals. The digest is the safe correlation id — it matches the
// server log line for the same failure.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useTransition } from 'react';
import { BrandHeader } from '@/components/BrandHeader';

export default function AppError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  const router = useRouter();
  const [retrying, startRetry] = useTransition();

  useEffect(() => {
    console.error(error);
  }, [error]);

  // A server-component error is cached in the RSC payload: reset() alone
  // re-renders the same failure. Refresh first so the retry re-fetches.
  function retry() {
    startRetry(() => {
      router.refresh();
      reset();
    });
  }

  return (
    <>
      <title>Something went wrong · Leadsonar</title>
      <BrandHeader />
      <main className="status-page">
        <div className="status-card status-card-error" role="alert">
          <p className="status-eyebrow">Unexpected error</p>
          <h1>Something went wrong</h1>
          <p className="status-lede">
            This page ran into a problem it couldn&apos;t recover from. Try again — if it
            keeps happening, contact support and quote the reference below.
          </p>
          {error.digest ? (
            <p className="status-ref">
              Reference <code>{error.digest}</code>
            </p>
          ) : null}
          <div className="status-actions">
            <button
              type="button"
              className="primary-btn"
              onClick={retry}
              disabled={retrying}
            >
              {retrying ? 'Retrying…' : 'Try again'}
            </button>
            <Link href="/today">Go to Today</Link>
            <Link href="/support">Contact support</Link>
          </div>
        </div>
      </main>
    </>
  );
}
