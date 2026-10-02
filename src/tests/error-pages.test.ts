// DS-04 backstops: the branded error, global-error and not-found pages.
// Rendered to static markup — no browser, no Next server — so this file
// checks what the components render, not that Next serves them. That part
// is the "branded backstop pages" block in e2e/smoke.spec.ts: /does-not-exist
// → 404 + not-found.tsx, and (with ENABLE_TEST_ROUTES=1 on the app and the
// runner) /test-only/error-boundary → 500 + error.tsx.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isNextRedirectError } from '@/lib/server-redirect';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

import AppError from '@/app/error';
import GlobalError from '@/app/global-error';
import NotFound, { metadata as notFoundMetadata } from '@/app/not-found';
import ErrorBoundaryProbe from '@/app/test-only/error-boundary/page';

const SECRET = 'relation "review_items" does not exist at character 42';

function boom(digest?: string): Error & { digest?: string } {
  return Object.assign(new Error(SECRET), digest ? { digest } : {});
}

afterEach(() => {
  delete process.env.ENABLE_TEST_ROUTES;
});

describe('app/error.tsx', () => {
  it('renders the branded card with a retry and the digest as a reference', () => {
    const html = renderToStaticMarkup(
      createElement(AppError, { error: boom('4180871043'), reset: () => {} }),
    );
    expect(html).toContain('brand-header');
    expect(html).toContain('lead/sonar');
    expect(html).toContain('status-card');
    expect(html).toContain('Something went wrong');
    expect(html).toContain('Try again');
    expect(html).toContain('href="/today"');
    expect(html).toContain('href="/support"');
    expect(html).toContain('<code>4180871043</code>');
    expect(html).not.toContain('Application error');
  });

  it('never shows the raw error message', () => {
    const html = renderToStaticMarkup(createElement(AppError, { error: boom(), reset: () => {} }));
    expect(html).not.toContain('review_items');
    expect(html).not.toContain('Reference');
  });
});

describe('app/global-error.tsx', () => {
  it('brings its own document and the brand chrome', () => {
    const html = renderToStaticMarkup(
      createElement(GlobalError, { error: boom('99'), reset: () => {} }),
    );
    expect(html).toMatch(/^<html lang="en">/);
    expect(html).toContain('<body>');
    expect(html).toContain('<title>Something went wrong · Leadsonar</title>');
    expect(html).toContain('brand-header');
    expect(html).toContain('Reload page');
    expect(html).toContain('<code>99</code>');
    expect(html).not.toContain('review_items');
  });
});

describe('app/not-found.tsx', () => {
  it('renders the branded 404 with a way back', () => {
    const html = renderToStaticMarkup(createElement(NotFound));
    expect(html).toContain('brand-header');
    expect(html).toContain('404');
    expect(html).toContain('find that page');
    expect(html).toMatch(/href="\/today"[^>]*class="primary-btn"|class="primary-btn"[^>]*href="\/today"/);
    expect(notFoundMetadata.title).toBe('Page not found · Leadsonar');
  });
});

describe('test-only error-boundary probe', () => {
  it('is a plain 404 unless ENABLE_TEST_ROUTES=1', () => {
    let caught: unknown;
    try {
      ErrorBoundaryProbe();
    } catch (err) {
      caught = err;
    }
    expect(isNextRedirectError(caught)).toBe(true);
    expect((caught as { digest: string }).digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
  });

  it('throws an ordinary error (→ error.tsx) when enabled', () => {
    process.env.ENABLE_TEST_ROUTES = '1';
    expect(() => ErrorBoundaryProbe()).toThrow('test-only error boundary probe');
  });
});
