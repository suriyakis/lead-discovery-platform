'use client';

// The branded error card, shared by the backstop outside the workspace
// frame (app/error.tsx: it brings its own BrandHeader) and the one inside
// it (app/(app)/error.tsx, DS-07 / MOB-03: a page that throws keeps the
// frame — header, sidebar, the pause control — on screen, I078). The 404
// card is NotFoundCard.tsx.
//
// Never render error.message: for server errors Next already swaps it for
// a generic string in production, and for client errors it may carry
// internals. The digest is the safe correlation id — it matches the
// server log line for the same failure.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

export function ErrorCard({
  digest,
  reset,
}: Readonly<{
  digest?: string;
  reset: () => void;
}>) {
  const router = useRouter();
  const [retrying, startRetry] = useTransition();

  // A server-component error is cached in the RSC payload: reset() alone
  // re-renders the same failure. Refresh first so the retry re-fetches.
  function retry() {
    startRetry(() => {
      router.refresh();
      reset();
    });
  }

  return (
    <div className="status-card status-card-error" role="alert">
      <p className="status-eyebrow">Unexpected error</p>
      <h1>Something went wrong</h1>
      <p className="status-lede">
        This page ran into a problem it couldn&apos;t recover from. Try again — if it keeps
        happening, contact support and quote the reference below.
      </p>
      {digest ? (
        <p className="status-ref">
          Reference <code>{digest}</code>
        </p>
      ) : null}
      <div className="status-actions">
        <button type="button" className="primary-btn" onClick={retry} disabled={retrying}>
          {retrying ? 'Retrying…' : 'Try again'}
        </button>
        <Link href="/today">Go to Today</Link>
        <Link href="/support">Contact support</Link>
      </div>
    </div>
  );
}
