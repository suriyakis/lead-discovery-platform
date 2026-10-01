// Route smoke test: every page of the app, at desktop (1440) and phone
// (390) width, signed in as the seeded super-admin. Each visit must
//   - answer with HTTP status < 500,
//   - land on the page itself (proves the session worked), and
//   - throw no uncaught error in the browser;
// and at phone width the document may not be wider than the viewport
// (DS-03: no sideways page scroll on any route). Defects already tracked
// elsewhere are tolerated via e2e/known-issues.json and show up as
// `known-issue` annotations in the report. It also checks that Next serves
// the branded 404 and error pages (DS-04), and a few phone/desktop layout
// details (DS-03).
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

      if (isMobile) {
        const { scrollWidth, offenders } = await measureOverflow(page);
        const knownOverflow =
          scrollWidth > MOBILE_MAX_SCROLL_WIDTH ? knownIssue(route.path, 'overflow') : undefined;
        if (knownOverflow) tolerate(knownOverflow, `${scrollWidth}px wide`);
        else
          expect(
            scrollWidth,
            `${route.path} is ${scrollWidth}px wide at 390px. Sticking out: ${offenders.join('; ') || 'n/a'}`,
          ).toBeLessThanOrEqual(MOBILE_MAX_SCROLL_WIDTH);
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
    await expect(page.getByRole('link', { name: 'Go to your dashboard' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
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
    await visit(page, '/dashboard');
    await expect(page.locator('.brand-header .header-account-inline').first()).toBeHidden();
    const menu = page.locator('.brand-header details.header-account-menu');
    await menu.locator('summary').click();
    const signOut = menu.getByRole('button', { name: 'Sign out' });
    await expect(signOut).toBeVisible();
    await expect(menu.getByText(ADMIN_EMAIL)).toBeVisible();
    const box = await menu.locator('.header-account-menu-panel').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });

  test('sidebar: only the current group (and Emergency) start open', async ({ page }) => {
    await visit(page, '/review');
    await expect(page.locator('aside.sidebar[data-compact-ready]')).toHaveCount(1);
    const open = await page
      .locator('aside.sidebar details.sidebar-group[open] > summary')
      .allTextContents();
    expect(open).toEqual(['Discovery', 'Emergency']);
  });
});

test.describe('desktop chrome is unchanged', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop-width checks');

  test('sidebar keeps its default open groups; header shows e-mail + Sign out', async ({
    page,
  }) => {
    await visit(page, '/review');
    await expect(page.locator('aside.sidebar[data-compact-ready]')).toHaveCount(1);
    const open = await page
      .locator('aside.sidebar details.sidebar-group[open] > summary')
      .allTextContents();
    expect(open).toEqual(['Discovery', 'Knowledge base', 'Pipeline', 'Outreach', 'Emergency']);
    await expect(page.locator('.brand-header span.who.header-account-inline')).toHaveText(
      ADMIN_EMAIL,
    );
    await expect(page.locator('.brand-header details.header-account-menu')).toBeHidden();
  });
});
