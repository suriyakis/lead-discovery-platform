// Test-only probe (DS-07 / MOB-03): a workspace page that throws during
// render, so e2e/app-shell.spec.ts can show the error renders inside the
// workspace frame (app/(app)/error.tsx) with the navigation intact. Off
// unless ENABLE_TEST_ROUTES=1 — everywhere else, including production, it
// is an ordinary 404.

import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export const metadata = { robots: { index: false, follow: false } };

export default function ShellErrorProbe(): never {
  if (process.env.ENABLE_TEST_ROUTES !== '1') notFound();
  throw new Error('test-only shell error probe');
}
