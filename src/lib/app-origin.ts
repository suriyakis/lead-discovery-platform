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

/** The origin the deployment configures (APP_URL, AUTH_URL, NEXTAUTH_URL), if any. */
export function configuredAppOrigin(env: Env = process.env): URL | null {
  for (const name of ['APP_URL', 'AUTH_URL', 'NEXTAUTH_URL'] as const) {
    const parsed = HttpUrl.safeParse(env[name]);
    if (parsed.success) return new URL(new URL(parsed.data).origin);
  }
  return null;
}

export function appOrigin(env: Env = process.env): URL {
  return configuredAppOrigin(env) ?? new URL(DEFAULT_APP_ORIGIN);
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
 * else localhost.
 */
export function appUrl(
  pathAndQuery: string,
  opts: { env?: Env; headers?: HeaderSource } = {},
): string {
  const origin =
    configuredAppOrigin(opts.env ?? process.env) ??
    (opts.headers ? requestOrigin(opts.headers) : null) ??
    new URL(DEFAULT_APP_ORIGIN);
  return new URL(pathAndQuery, origin).href;
}
