/**
 * Detect Next.js's redirect() throw so server actions can catch real
 * errors without swallowing redirects.
 *
 * Next.js implements `redirect()` and `notFound()` by throwing a special
 * error with a `digest` field beginning with `NEXT_REDIRECT` /
 * `NEXT_NOT_FOUND`. A naïve `try { ... redirect('/ok') } catch { ... }`
 * catches the redirect throw and routes it through the error path,
 * producing the classic "save succeeds in DB but UI flashes FAILED" bug.
 *
 * Use at the top of every server-action catch block:
 *
 *   try {
 *     await mutate();
 *     redirect('/ok');                  // throws NEXT_REDIRECT
 *   } catch (err) {
 *     if (isNextRedirectError(err)) throw err;   // <-- re-throw it
 *     redirect(`/back?error=${msg}`);
 *   }
 */
export function isNextRedirectError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const digest = (err as { digest?: unknown }).digest;
  if (typeof digest !== 'string') return false;
  return digest.startsWith('NEXT_REDIRECT') || digest.startsWith('NEXT_NOT_FOUND');
}
