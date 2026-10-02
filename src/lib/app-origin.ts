// The app's public origin, for the few places that need an absolute URL
// without a request in hand: the root layout's metadataBase, which turns
// the link-preview image (app/opengraph-image.png) into an absolute
// og:image URL. Without it Next falls back to http://localhost:3000 and
// every shared link would preview a localhost image.
//
// APP_URL is the deployment's public URL (.env.example); AUTH_URL /
// NEXTAUTH_URL, which every deployment sets for sign-in, back it up.

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

export function appOrigin(env: Readonly<Record<string, string | undefined>> = process.env): URL {
  for (const name of ['APP_URL', 'AUTH_URL', 'NEXTAUTH_URL'] as const) {
    const parsed = HttpUrl.safeParse(env[name]);
    if (parsed.success) return new URL(new URL(parsed.data).origin);
  }
  return new URL(DEFAULT_APP_ORIGIN);
}
