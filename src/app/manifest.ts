// The web app manifest, served at /manifest.webmanifest (DS-08, I176).
// Installing Leadsonar from a phone gives a standalone window on the page
// colour that opens on Today, with the brand icons: `any` icons are the
// rounded tile, `maskable` ones keep the glyph inside the safe zone. The
// icon files are generated from src/lib/brand-mark.ts (pnpm brand:icons).

import type { MetadataRoute } from 'next';
import { BRAND_COLOURS, BRAND_DESCRIPTION, BRAND_NAME } from '@/lib/brand';
import { BRAND_ICON_FILES } from '@/lib/brand-mark';
import { HOME_PATH } from '@/lib/nav/registry';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: BRAND_NAME,
    short_name: BRAND_NAME,
    description: BRAND_DESCRIPTION,
    start_url: HOME_PATH,
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: BRAND_COLOURS.bg,
    theme_color: BRAND_COLOURS.bg,
    categories: ['business', 'productivity'],
    icons: BRAND_ICON_FILES.flatMap((f) =>
      f.manifest
        ? [
            {
              src: f.manifest.src,
              sizes: `${f.sizes[0]!.width}x${f.sizes[0]!.height}`,
              type: 'image/png',
              purpose: f.manifest.purpose,
            },
          ]
        : [],
    ),
  };
}
