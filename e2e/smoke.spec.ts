// Route smoke test: every page of the app, at desktop (1440) and phone
// (390) width, signed in as the seeded super-admin. Each visit must
//   - answer with HTTP status < 500,
//   - land on the page itself (proves the session worked),
//   - show the brand once: exactly one lead/sonar wordmark (DS-08), and
//   - throw no uncaught error in the browser;
// and the document may not be wider than the viewport (DS-03: no sideways
// page scroll on any route, at either width). Defects already tracked
// elsewhere are tolerated via e2e/known-issues.json and show up as
// `known-issue` annotations in the report. It also checks that Next serves
// the branded 404 and error pages (DS-04), a few phone/desktop layout
// details (DS-03), and the DS-02 CSS acceptance measured in the browser.
//
// Needs a running app on BASE_URL seeded by scripts/seed-demo.ts, with
// SEED_DEMO_PASSWORD set to the password the seed used — see
// playwright.config.ts for the recipe.

import path from 'node:path';
import { expect, test as base, type Page } from '@playwright/test';
import { type KnownIssue, knownIssue, smokeRoutes } from './routes';

const ADMIN_EMAIL = 'demo-admin@example.com';
/** 390px viewport + 2px rounding slack. */
const MOBILE_MAX_SCROLL_WIDTH = 392;
/** 1440px viewport + 2px rounding slack. */
const DESKTOP_MAX_SCROLL_WIDTH = 1442;

/** Sign in once per worker via the team-login API; reuse the cookie. */
const test = base.extend<object, { workerStorageState: string }>({
  // (Playwright's fixture callback is usually called `use`; renamed so the
  // react-hooks lint rule doesn't mistake it for React's use().)
  storageState: ({ workerStorageState }, provide) => provide(workerStorageState),
  workerStorageState: [
    async ({ playwright }, provide, workerInfo) => {
      const password = process.env.SEED_DEMO_PASSWORD;
      if (!password) {
        throw new Error('Set SEED_DEMO_PASSWORD to the password scripts/seed-demo.ts seeded with.');
      }
      const file = path.join(
        workerInfo.project.outputDir,
        `.auth/${workerInfo.project.name}-${workerInfo.parallelIndex}.json`,
      );
      const api = await playwright.request.newContext({
        baseURL: workerInfo.project.use.baseURL,
      });
      const res = await api.post('/api/auth/team-login', {
        data: { email: ADMIN_EMAIL, password },
      });
      expect(res.status(), `team-login: ${await res.text()}`).toBe(200);
      await api.storageState({ path: file });
      await api.dispose();
      await provide(file);
    },
    { scope: 'worker' },
  ],
});

/** Open a page and let it settle: hydration, client effects, fonts. */
async function visit(page: Page, url: string) {
  const response = await page.goto(url, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {
    // Long-polling widgets never go idle; the load event is enough then.
  });
  await page.evaluate(() => document.fonts.ready);
  return response;
}

/**
 * Document width plus the elements that stick out of the viewport and
 * are not inside a scroll box of their own — the culprits to fix.
 */
async function measureOverflow(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const clips = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox !== 'visible') return true;
      }
      return false;
    };
    const offenders: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= vw + 2 || clips(el)) continue;
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2) : [];
      offenders.push(
        `${el.tagName.toLowerCase()}${cls.length ? `.${cls.join('.')}` : ''} → right ${Math.round(r.right)}px`,
      );
      if (offenders.length >= 8) break;
    }
    return { scrollWidth: document.documentElement.scrollWidth, offenders };
  });
}

/** Record a tolerated failure from e2e/known-issues.json on the test. */
function tolerate(issue: KnownIssue, detail: string) {
  test.info().annotations.push({
    type: 'known-issue',
    description: `${issue.id} (${issue.check}): ${detail} — ${issue.note}`,
  });
}

test.describe('every route renders', () => {
  for (const route of smokeRoutes()) {
    test(route.path, async ({ page, isMobile }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(`${err.name}: ${err.message}`));

      const response = await visit(page, route.path);
      expect(response, 'navigation produced no response').not.toBeNull();
      const status = response!.status();
      const knownStatus = status >= 500 ? knownIssue(route.path, 'status') : undefined;
      if (knownStatus) tolerate(knownStatus, `HTTP ${status}`);
      else expect(status, `HTTP status of ${route.path}`).toBeLessThan(500);
      expect(new URL(page.url()).pathname, 'landed on the wrong page (signed out?)').toMatch(
        route.landsOn,
      );

      // DS-08: one wordmark per page, whichever chrome draws it (AppShell's
      // header, the console topbar, a public page or a backstop).
      await expect(page.locator('[data-brand-wordmark]'), 'wordmarks on the page').toHaveCount(1);

      {
        // DS-03: no sideways page scroll on a phone, and none introduced at
        // desktop width either.
        const { scrollWidth, offenders } = await measureOverflow(page);
        const max = isMobile ? MOBILE_MAX_SCROLL_WIDTH : DESKTOP_MAX_SCROLL_WIDTH;
        const knownOverflow = scrollWidth > max ? knownIssue(route.path, 'overflow') : undefined;
        if (knownOverflow) tolerate(knownOverflow, `${scrollWidth}px wide`);
        else
          expect(
            scrollWidth,
            `${route.path} is ${scrollWidth}px wide at ${max - 2}px. Sticking out: ${offenders.join('; ') || 'n/a'}`,
          ).toBeLessThanOrEqual(max);
      }

      const unexpected = pageErrors.filter((message) => {
        const known = knownIssue(route.path, 'pageerror', message);
        if (known) tolerate(known, message.split('\n')[0]!.slice(0, 120));
        return !known;
      });
      expect(unexpected, 'uncaught errors in the page').toEqual([]);
    });
  }
});

// DS-04: Next must actually serve the branded backstops — the Vitest
// render tests (src/tests/error-pages.test.ts) can't show that wiring.
test.describe('branded backstop pages', () => {
  test('an unknown URL gets the branded 404', async ({ page }) => {
    const response = await visit(page, '/does-not-exist');
    expect(response?.status(), 'HTTP status of /does-not-exist').toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText("We couldn't find that page");
    await expect(page.locator('main.status-page .status-card')).toBeVisible();
    await expect(page.locator('.brand-header')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Go to Today' })).toHaveAttribute('href', '/today');
  });

  test('signed out, an unknown URL still gets the branded 404', async ({ browser, baseURL }) => {
    // A fresh context: no session cookie (the 404 page never looks one up).
    const context = await browser.newContext({ baseURL });
    try {
      const page = await context.newPage();
      const response = await visit(page, '/does-not-exist');
      expect(response?.status()).toBe(404);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        "We couldn't find that page",
      );
      await expect(page.locator('main.status-page .status-card')).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('a page that throws renders app/error.tsx', async ({ page }) => {
    test.skip(
      process.env.ENABLE_TEST_ROUTES !== '1',
      'needs the app (and this runner) started with ENABLE_TEST_ROUTES=1',
    );
    const response = await visit(page, '/test-only/error-boundary');
    expect(response?.status(), 'HTTP status of the throwing probe').toBe(500);
    const card = page.locator('main.status-page .status-card');
    await expect(card.getByRole('heading', { level: 1 })).toHaveText('Something went wrong');
    await expect(card.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(card.getByRole('link', { name: 'Contact support' })).toHaveAttribute(
      'href',
      '/support',
    );
    // The branded card never echoes the thrown message.
    await expect(card).not.toContainText('test-only error boundary probe');
  });
});

/** Left/right edges of the one element `selector` matches. */
async function edges(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} is not visible`);
  return { left: box.x, right: box.x + box.width };
}

test.describe('phone layout keeps the key controls on screen', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone-width checks');

  test('review detail: Approve and Reject inside the viewport', async ({ page }) => {
    await visit(page, '/review/8');
    for (const sel of ['form.approve-form button[type=submit]', 'form.reject-form button[type=submit]']) {
      const { left, right } = await edges(page, sel);
      expect(left, sel).toBeGreaterThanOrEqual(0);
      expect(right, sel).toBeLessThanOrEqual(390);
    }
  });

  test('draft detail: Approve and Reject inside the viewport', async ({ page }) => {
    await visit(page, '/drafts/39');
    const approve = page.getByRole('button', { name: 'Approve', exact: true });
    const reject = page.getByRole('button', { name: 'Reject', exact: true });
    for (const button of [approve, reject]) {
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    }
  });

  test('thread: the reply textarea fits the screen', async ({ page }) => {
    await visit(page, '/communication/7');
    const { left, right } = await edges(page, 'textarea[placeholder="Write your reply here…"]');
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(390);
  });

  test('header: e-mail and Sign out fold into the account menu', async ({ page }) => {
    await visit(page, '/today');
    const menu = page.locator('.brand-header details.header-account-menu');
    await menu.locator('summary').click();
    const signOut = menu.getByRole('button', { name: 'Sign out' });
    await expect(signOut).toBeVisible();
    await expect(menu.getByText(ADMIN_EMAIL)).toBeVisible();
    const box = await menu.locator('.header-account-menu-panel').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });

  // DS-05 (AP-03 Playwright acceptance): the registry's sidebar links
  // render inside the current layout on a phone — one strip above the
  // page that scrolls inside itself, never the page sideways.
  test('sidebar: the area links render inside the phone layout', async ({ page }) => {
    await visit(page, '/settings/usage');
    const links = page.locator('aside.sidebar a[data-area]');
    expect(await links.count()).toBe(9); // the seeded admin is a super-admin
    const strip = await page.locator('aside.sidebar nav.sidebar-nav').boundingBox();
    expect(strip!.x).toBeGreaterThanOrEqual(0);
    expect(strip!.x + strip!.width).toBeLessThanOrEqual(390);
    expect(strip!.height).toBeLessThan(80);
    // The current area is scrolled into view inside the strip.
    const current = await page.locator('aside.sidebar a[aria-current="page"]').boundingBox();
    expect(current!.x).toBeGreaterThanOrEqual(0);
    expect(current!.x + current!.width).toBeLessThanOrEqual(390);
    await expect(page.locator('aside.sidebar a[aria-current="page"]')).toHaveAttribute(
      'data-area',
      'settings',
    );
    // …and the page's own Settings sub-nav sits above the page content.
    await expect(page.locator('nav.area-subnav a[aria-current="page"]')).toHaveText('Usage');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(392);
  });
});

test.describe('desktop chrome is unchanged', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop-width checks');

  test('sidebar: Today and 8 areas under static headings; Search, account menu, one wordmark', async ({
    page,
  }) => {
    await visit(page, '/review');
    await expect(page.locator('aside.sidebar .sidebar-heading')).toHaveText([
      'Work',
      'Build',
      'Workspace',
      'Platform',
    ]);
    await expect(page.locator('aside.sidebar a[data-area] .sidebar-link-label')).toHaveText([
      'Today',
      'Review',
      'Pipeline',
      'Outreach',
      'Conversations',
      'Discovery',
      'Products',
      'Settings',
      'Platform console',
    ]);
    await expect(page.locator('aside.sidebar a[aria-current="page"]')).toHaveAttribute('data-area', 'review');
    await expect(page.locator('nav.area-tabs a[aria-current="page"]')).toHaveText('Queue');
    await expect(page.getByText('lead/sonar', { exact: true })).toHaveCount(1);
    await expect(page.locator('[data-command-palette-trigger]')).toBeVisible();
    await expect(page.locator('.brand-header details.header-account-menu')).toBeVisible();
  });

  test('Cmd-K opens from the Search button and finds Providers in the console', async ({ page }) => {
    await visit(page, '/admin');
    await page.locator('[data-command-palette-trigger]').click();
    const input = page.getByPlaceholder(/Jump to a page/);
    await expect(input).toBeVisible();
    await input.fill('providers');
    await expect(page.locator('li.cmdk-item').first()).toHaveAttribute('data-href', '/admin/providers');
  });
});

// DS-02 acceptance measured in the browser. src/tests/legacy-css-defects.test.ts
// checks the same rules through a CSS cascade model; this is the real thing.
test.describe('legacy CSS fixes hold in the browser (DS-02)', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop-width checks');

  /** The pages the DS-02 acceptance lists. */
  const DS02_PAGES = [
    '/products',
    '/knowledge',
    '/learning',
    '/connectors',
    '/connectors/1',
    '/mailbox',
    '/mailbox/1',
    '/communication/follow-ups',
    '/settings/crm',
    '/settings/crm/1',
  ];

  test('page-header CTAs read at >= 4.5:1; every ghost link has a 1px border and a >= 32px box', async ({
    page,
  }) => {
    let ctaCount = 0;
    let ghostCount = 0;
    for (const path of DS02_PAGES) {
      await visit(page, path);
      const found = await page.evaluate(() => {
        // Let the browser turn any CSS colour (oklch, color-mix, …) into sRGB.
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const g = canvas.getContext('2d', { willReadFrequently: true })!;
        const srgb = (css: string): number[] => {
          g.clearRect(0, 0, 1, 1);
          g.fillStyle = css;
          g.fillRect(0, 0, 1, 1);
          return Array.from(g.getImageData(0, 0, 1, 1).data);
        };
        const luminance = ([r, gr, b]: number[]) => {
          const lin = (v: number) => {
            const c = v / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * lin(r!) + 0.7152 * lin(gr!) + 0.0722 * lin(b!);
        };
        const contrast = (fg: string, bg: string) => {
          const [a, b] = [luminance(srgb(fg)), luminance(srgb(bg))];
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        };
        const shown = (el: Element) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
        };
        const label = (el: Element) => (el.textContent ?? '').trim().slice(0, 40);
        return {
          ctas: Array.from(document.querySelectorAll('.page-header .primary-btn'))
            .filter(shown)
            .map((el) => {
              const s = getComputedStyle(el);
              return { label: label(el), ratio: contrast(s.color, s.backgroundColor), bgAlpha: srgb(s.backgroundColor)[3] };
            }),
          ghosts: Array.from(document.querySelectorAll('a.ghost-btn'))
            .filter(shown)
            .map((el) => {
              const s = getComputedStyle(el);
              return {
                label: label(el),
                border: `${s.borderTopWidth} ${s.borderTopStyle}`,
                height: el.getBoundingClientRect().height,
              };
            }),
        };
      });
      for (const cta of found.ctas) {
        expect(cta.bgAlpha, `${path} CTA "${cta.label}" has an opaque fill`).toBe(255);
        expect(cta.ratio, `${path} CTA "${cta.label}" contrast`).toBeGreaterThanOrEqual(4.5);
      }
      for (const ghost of found.ghosts) {
        expect(ghost.border, `${path} ghost link "${ghost.label}" border`).toBe('1px solid');
        expect(ghost.height, `${path} ghost link "${ghost.label}" height`).toBeGreaterThanOrEqual(32);
      }
      ctaCount += found.ctas.length;
      ghostCount += found.ghosts.length;
    }
    // The seed renders both on these pages; zero would mean the selectors rotted.
    expect(ctaCount).toBeGreaterThan(0);
    expect(ghostCount).toBeGreaterThan(0);
  });

  test('after a 600px scroll the sidebar and the contacts toolbar sit below the header', async ({
    page,
  }) => {
    await visit(page, '/contacts');
    await page.evaluate(() => window.scrollTo(0, 600));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const tops = await page.evaluate(() => {
      const top = (sel: string) => document.querySelector(sel)?.getBoundingClientRect().top ?? null;
      return {
        scrollY: window.scrollY,
        headerBottom: document.querySelector('.brand-header')?.getBoundingClientRect().bottom ?? null,
        sidebar: top('aside.sidebar'),
        toolbar: top('.contacts-toolbar'),
      };
    });
    expect(tops.headerBottom).toBeGreaterThanOrEqual(56);
    for (const key of ['sidebar', 'toolbar'] as const) {
      expect(tops[key], `${key} rendered`).not.toBeNull();
      expect(tops[key]!, `${key} top after scrolling ${tops.scrollY}px`).toBeGreaterThanOrEqual(56);
    }
  });

  test('with reduced motion there are no running animations', async ({ page, browser, baseURL }) => {
    const animations = (p: Page) =>
      p.evaluate(() =>
        document
          .getAnimations()
          .map((a) => (a as CSSAnimation).animationName ?? a.constructor.name),
      );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const path of ['/today?view=overview', '/review', '/connectors']) {
      await visit(page, path);
      expect(await animations(page), `${path} animations`).toEqual([]);
    }
    // The signed-out landing page carries the pulsing hero badge.
    const context = await browser.newContext({ baseURL, reducedMotion: 'reduce' });
    try {
      const landing = await context.newPage();
      await visit(landing, '/');
      expect(await animations(landing), '/ (signed out) animations').toEqual([]);
    } finally {
      await context.close();
    }
  });
});
