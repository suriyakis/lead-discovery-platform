// DS-08 in the browser: what Next actually serves for the brand kit.
// src/tests/brand.test.ts checks the files and the metadata objects; this
// checks the wiring: /manifest.webmanifest and its icons, and the <link>
// and <meta> tags (favicon, apple-touch-icon, manifest, theme-color,
// og:image) on a page anyone can open, each answering 200 with an image.
// The per-route "one wordmark" check is in e2e/smoke.spec.ts.
//
// Needs no session and no seed data: everything here is public.

import { expect, test, type APIRequestContext } from '@playwright/test';

const BRAND_NAME = 'Leadsonar';
/** --bg as sRGB (src/lib/brand.ts BRAND_COLOURS.bg). */
const PAGE_COLOUR = '#09121c';

/** GET a same-origin URL (absolute or relative) and expect an image of `type`. */
async function expectImage(request: APIRequestContext, href: string, type: RegExp) {
  const url = new URL(href, 'http://same-origin.invalid');
  const res = await request.get(`${url.pathname}${url.search}`);
  expect(res.status(), `GET ${href}`).toBe(200);
  expect(res.headers()['content-type'], `content-type of ${href}`).toMatch(type);
  expect((await res.body()).length, `${href} is empty`).toBeGreaterThan(100);
}

test.describe('the installable shell', () => {
  test('/manifest.webmanifest names Leadsonar, opens standalone on Today, and its icons answer 200', async ({
    request,
  }) => {
    const res = await request.get('/manifest.webmanifest');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/manifest+json');
    const manifest = (await res.json()) as {
      name: string;
      short_name: string;
      display: string;
      start_url: string;
      theme_color: string;
      background_color: string;
      icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
    };
    expect(manifest.name).toBe(BRAND_NAME);
    expect(manifest.short_name).toBe(BRAND_NAME);
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/today');
    expect(manifest.theme_color).toBe(PAGE_COLOUR);
    expect(manifest.background_color).toBe(PAGE_COLOUR);
    expect(manifest.icons.map((i) => `${i.purpose}:${i.sizes}`).sort()).toEqual([
      'any:192x192',
      'any:512x512',
      'maskable:192x192',
      'maskable:512x512',
    ]);
    for (const icon of manifest.icons) await expectImage(request, icon.src, /^image\/png/);
  });

  test('a public page links the favicon, touch icon, manifest and link preview, and each answers 200', async ({
    browser,
    baseURL,
  }) => {
    // Signed out: what a phone's "Add to Home Screen" or a link unfurler sees.
    const context = await browser.newContext({ baseURL });
    try {
      const page = await context.newPage();
      const response = await page.goto('/');
      expect(response?.status()).toBe(200);
      const request = context.request;
      const attr = (selector: string, name: string) =>
        page.locator(selector).first().getAttribute(name);

      await expect(page).toHaveTitle(BRAND_NAME);

      const icons = await page
        .locator('link[rel="icon"]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? ''));
      expect(
        icons.some((h) => h.startsWith('/icon.svg')),
        icons.join(', '),
      ).toBe(true);
      expect(
        icons.some((h) => h.startsWith('/favicon.ico')),
        icons.join(', '),
      ).toBe(true);
      for (const href of icons)
        await expectImage(request, href, /^image\/(svg\+xml|x-icon|vnd\.microsoft\.icon)/);

      const touch = await attr('link[rel="apple-touch-icon"]', 'href');
      expect(touch, 'apple-touch-icon link').toBeTruthy();
      await expectImage(request, touch!, /^image\/png/);

      expect(await attr('link[rel="manifest"]', 'href')).toMatch(/^\/manifest\.webmanifest/);
      expect(await attr('meta[name="theme-color"]', 'content')).toBe(PAGE_COLOUR);
      expect(await attr('meta[name="apple-mobile-web-app-title"]', 'content')).toBe(BRAND_NAME);

      // og:image is absolute, on the app's own origin (metadataBase), so
      // link previews never point at localhost:3000.
      const og = await attr('meta[property="og:image"]', 'content');
      expect(og, 'og:image').toBeTruthy();
      expect(new URL(og!).origin).toBe(new URL(baseURL!).origin);
      await expectImage(request, og!, /^image\/png/);
      expect(await attr('meta[property="og:image:width"]', 'content')).toBe('1200');
      expect(await attr('meta[property="og:image:height"]', 'content')).toBe('630');
      expect(await attr('meta[property="og:image:alt"]', 'content')).toContain(BRAND_NAME);
      expect(await attr('meta[property="og:site_name"]', 'content')).toBe(BRAND_NAME);
      expect(await attr('meta[name="twitter:card"]', 'content')).toBe('summary_large_image');

      // The page's one brand lockup: a named image beside the wordmark.
      await expect(page.locator('[data-brand-wordmark]')).toHaveCount(1);
      await expect(page.getByRole('img', { name: BRAND_NAME })).toHaveCount(1);
    } finally {
      await context.close();
    }
  });
});
