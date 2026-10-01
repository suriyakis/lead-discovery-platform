// Test-only probe: throws during render so smoke/e2e tests can assert that
// app/error.tsx (the branded backstop) renders instead of Next's default
// error page. Off unless ENABLE_TEST_ROUTES=1 — everywhere else, including
// production, it is an ordinary 404.

import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export const metadata = { robots: { index: false, follow: false } };

export default function ErrorBoundaryProbe(): never {
  if (process.env.ENABLE_TEST_ROUTES !== '1') notFound();
  throw new Error('test-only error boundary probe');
}
