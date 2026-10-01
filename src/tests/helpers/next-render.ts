// Helpers for tests that exercise App Router pages and server actions
// directly (no Next server): server-render a page's React tree to HTML
// and read where a next/navigation redirect() was pointing.
//
// Pages are async server components, so a test awaits the page function
// itself (that runs every query the real request would run), then hands
// the returned tree to React's streaming renderer, which also resolves
// nested async components such as /pipeline/[id]'s ConversationSection.

import type { ReactNode } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { isNextRedirectError } from '@/lib/server-redirect';

/**
 * Render a server-component tree to HTML. Rejects with the first render
 * error so a broken page fails the test the way it would 500 in Next.
 */
export async function renderToHtml(node: ReactNode): Promise<string> {
  const errors: unknown[] = [];
  const stream = await renderToReadableStream(node, {
    onError(err) {
      errors.push(err);
    },
  });
  await stream.allReady;
  const html = await new Response(stream).text();
  if (errors.length > 0) throw errors[0];
  return html;
}

/**
 * The URL a redirect() error points at, or null for any other value.
 * Next encodes it in the digest as `NEXT_REDIRECT;<type>;<url>;<status>;`
 * (the same split Next's own getURLFromRedirectError uses).
 */
export function redirectTarget(err: unknown): string | null {
  if (!isNextRedirectError(err)) return null;
  const digest = (err as { digest: string }).digest;
  if (!digest.startsWith('NEXT_REDIRECT')) return null;
  return digest.split(';').slice(2, -2).join(';');
}

/**
 * Run `fn` and return the URL it redirected to. Fails when `fn` resolves
 * without redirecting; re-throws any non-redirect error unchanged.
 */
export async function expectRedirect(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    const target = redirectTarget(err);
    if (target !== null) return target;
    throw err;
  }
  throw new Error('expected a redirect() but the call returned normally');
}
