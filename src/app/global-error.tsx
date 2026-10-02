'use client';

// Last-resort backstop: an error in the root layout itself. This replaces
// the root layout, so it brings its own <html>/<body> and stylesheet and
// avoids every app component — whatever broke the layout may be shared
// with them. Links are plain <a> on purpose: a full page load is the most
// reliable way out of a broken root.

import './globals.css';
import { useEffect } from 'react';

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
        <title>Something went wrong · Leadsonar</title>
      </head>
      <body>
        <header className="brand-header">
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full load is the point: the root layout is broken */}
          <a href="/" className="brand-link" aria-label="lead/sonar home">
            <span className="brand-mark" aria-hidden="true">
              <span className="brand-mark-inner" />
            </span>
            <span className="brand-wordmark">lead/sonar</span>
          </a>
        </header>
        <main className="status-page">
          <div className="status-card status-card-error" role="alert">
            <p className="status-eyebrow">Unexpected error</p>
            <h1>Leadsonar couldn&apos;t load</h1>
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
