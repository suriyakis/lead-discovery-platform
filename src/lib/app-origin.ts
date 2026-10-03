// The app's public origin, for the places that need an absolute URL of
// this app: the root layout's metadataBase (which turns the link-preview
// image, app/opengraph-image.png, into an absolute og:image URL; without
// it Next falls back to http://localhost:3000 and every shared link would
// preview a localhost image), and the Stripe success, cancel and portal
// return URLs (appUrl), which used to be hard-coded to production, so a
// checkout started on localhost or a preview deploy came back to the live
// site (I155).
//
// APP_URL is the deployment's public URL (.env.example); AUTH_URL /
// NEXTAUTH_URL, which every deployment sets for sign-in, back it up. When
// none is set, appUrl falls back to the origin the request came in on.
//
// A loopback value (localhost, 127.0.0.1, [::1]) never beats a real one:
// the base docker-compose.yml used to set APP_URL=http://localhost:3000 and
// compose merged it into the prod container (environment beats env_file).
// PC-36 removed it there and the deploy script now refuses a .env without
// an https APP_URL; this rule stays as the second guard. In production a
// loopback value is ignored; elsewhere it is used only when nothing
// better is known. Sent-mail links (mail.ts) and owner-alert links
// (ops/alert-config.ts) read their origin from here too.

import { z } from 'zod';

function isHttpUrl(v: string): boolean {
  try {
    return /^https?:$/.test(new URL(v).protocol);
  } catch {
    return false;
  }
}

// (Not z.string().url().refine(): zod still runs the refinement on a value
// .url() rejected, and new URL() would throw there.)
const HttpUrl = z.string().trim().refine(isHttpUrl, 'must be an http(s) URL');

export const DEFAULT_APP_ORIGIN = 'http://localhost:3000';

type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/i;

/** True for http(s)://localhost, 127.0.0.1 or [::1], on any port. */
export function isLoopbackOrigin(u: URL): boolean {
  return LOOPBACK_HOST.test(u.hostname);
}

/**
 * The origin the deployment configures (APP_URL, AUTH_URL, NEXTAUTH_URL), if
 * any: the first one that is not loopback, else (outside production) the
 * first loopback one.
 */
export function configuredAppOrigin(env: Env = process.env): URL | null {
  const origins = configuredOrigins(env);
  const real = origins.find((u) => !isLoopbackOrigin(u));
  if (real) return real;
  return env.NODE_ENV === 'production' ? null : (origins[0] ?? null);
}

/** Every parseable APP_URL, AUTH_URL, NEXTAUTH_URL origin, in that order. */
function configuredOrigins(env: Env): URL[] {
  const origins: URL[] = [];
  for (const name of ['APP_URL', 'AUTH_URL', 'NEXTAUTH_URL'] as const) {
    const parsed = HttpUrl.safeParse(env[name]);
    if (parsed.success) origins.push(new URL(new URL(parsed.data).origin));
  }
  return origins;
}

/**
 * The origin for links built with no request at hand (metadataBase, sent
 * mail): the configured one; when production has only a loopback value,
 * that value still beats the hard-coded default, since there is nothing
 * better to ask (a local production build on :3300 links :3300, not :3000).
 */
export function appOrigin(env: Env = process.env): URL {
  return configuredAppOrigin(env) ?? configuredOrigins(env)[0] ?? new URL(DEFAULT_APP_ORIGIN);
}

/** Request headers: next/headers' headers(), or a Request's headers. */
export interface HeaderSource {
  get(name: string): string | null;
}

const firstValue = (v: string | null) => v?.split(',')[0]?.trim() || null;

/**
 * The origin a request came in on, as the reverse proxy reports it
 * (X-Forwarded-Host / X-Forwarded-Proto), else its Host header. Null when
 * the headers name no usable host.
 */
export function requestOrigin(headers: HeaderSource): URL | null {
  const host = firstValue(headers.get('x-forwarded-host')) ?? firstValue(headers.get('host'));
  if (!host) return null;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  const proto = firstValue(headers.get('x-forwarded-proto')) ?? (local ? 'http' : 'https');
  const parsed = HttpUrl.safeParse(`${proto}://${host}`);
  return parsed.success ? new URL(new URL(parsed.data).origin) : null;
}

/**
 * An absolute URL of this app, for a link that leaves the app and comes
 * back (a Stripe return URL): the configured origin, else the request's,
 * else localhost. A loopback configured origin gives way to a request
 * that came in on a real host.
 */
export function appUrl(
  pathAndQuery: string,
  opts: { env?: Env; headers?: HeaderSource } = {},
): string {
  const configured = configuredAppOrigin(opts.env ?? process.env);
  const fromRequest = opts.headers ? requestOrigin(opts.headers) : null;
  const requestIsReal = fromRequest !== null && !isLoopbackOrigin(fromRequest);
  const configuredWins = configured !== null && !(isLoopbackOrigin(configured) && requestIsReal);
  const origin =
    (configuredWins ? configured : null) ??
    fromRequest ??
    configured ??
    new URL(DEFAULT_APP_ORIGIN);
  return new URL(pathAndQuery, origin).href;
}
