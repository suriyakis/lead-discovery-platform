'use client';

// Last-resort backstop: an error in the root layout itself. This replaces
// the root layout, so it brings its own <html>/<body> and stylesheet and
// avoids every app component — whatever broke the layout may be shared
// with them. The one exception is the brand lockup (components/Brand.tsx):
// plain SVG and text over pure constants, nothing that could have broken.
// Links are plain <a> on purpose: a full page load is the most reliable
// way out of a broken root.

import './globals.css';
import { useEffect } from 'react';
import { BrandLockup } from '@/components/Brand';
import { BRAND_NAME } from '@/lib/brand';

export default function GlobalError({
  error,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <head>
        <title>{`Something went wrong · ${BRAND_NAME}`}</title>
      </head>
      <body>
        <header className="brand-header">
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full load is the point: the root layout is broken */}
          <a href="/" className="brand-link" aria-label={`${BRAND_NAME} home`}>
            <BrandLockup wordmark="always" />
          </a>
        </header>
        <main className="status-page">
          <div className="status-card status-card-error" role="alert">
            <p className="status-eyebrow">Unexpected error</p>
            <h1>{BRAND_NAME} couldn&apos;t load</h1>
            <p className="status-lede">
              Something went wrong before the app could start. Reload the page — if it
              keeps happening, contact support and quote the reference below.
            </p>
            {error.digest ? (
              <p className="status-ref">
                Reference <code>{error.digest}</code>
              </p>
            ) : null}
            <div className="status-actions">
              {/* reset() would re-render the same cached root; a real reload re-fetches it. */}
              <button
                type="button"
                className="primary-btn"
                onClick={() => window.location.reload()}
              >
                Reload page
              </button>
              <a href="/today">Go to Today</a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
