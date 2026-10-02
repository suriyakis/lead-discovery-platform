// DS-07 (absorbs ia:F-09, MOB-03, AP-05a) in the browser: the workspace
// frame is mounted once by src/app/(app)/layout.tsx and survives client
// navigation.
//
//   - the "Ask the platform" conversation survives five sidebar
//     navigations, with no full page load in between (I053);
//   - switching workspace (god mode, for the seeded super-admin) starts a
//     fresh conversation; a switch in another tab of the same browser is
//     announced (drift notice + Reload), never swapped in silently;
//   - approving on /review/[id] lowers the sidebar's Review count without
//     a full reload (the action's response re-renders the frame);
//   - a pause made in another browser shows this frame's banner on focus
//     (or at the next 60 s poll), without a reload (ia:F-09);
//   - the frame is rendered on the server once per full load, not once per
//     navigation (the ENABLE_TEST_ROUTES render probe);
//   - a page that throws renders inside the frame, navigation intact;
//   - /admin keeps its own console frame (AdminShell), not the sidebar.
//
// "Every route answers at its unchanged URL" is e2e/smoke.spec.ts: its
// route list is derived from src/app with route groups stripped.
//
// Needs a running app seeded by scripts/seed-demo.ts (playwright.config.ts).

import { expect, type Page } from '@playwright/test';
import { signedInTest as test } from './session';

const PROBE_COOKIE = 'leadsonar-e2e-shell-probe';
const testRoutesOn = process.env.ENABLE_TEST_ROUTES === '1';

/** Survives client navigation, gone after a full page load. */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __ds07Marker?: number }).__ds07Marker = 1;
  });
}

async function sameDocument(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __ds07Marker?: number }).__ds07Marker === 1);
}

async function goViaSidebar(page: Page, area: string, path: RegExp): Promise<void> {
  await page.locator(`aside.sidebar a[data-area="${area}"]`).click();
  await expect(page).toHaveURL(path);
  await expect(page.locator(`aside.sidebar a[data-area="${area}"]`)).toHaveAttribute(
    'aria-current',
    'page',
  );
}

async function reviewBadge(page: Page): Promise<string> {
  const badge = page.locator('aside.sidebar a[data-area="review"] .nav-count [aria-hidden="true"]');
  return (await badge.count()) === 0 ? '' : ((await badge.textContent()) ?? '').trim();
}

test.describe('the workspace frame is mounted once (DS-07)', () => {
  test('the assistant conversation survives navigation across five routes', async ({ page }) => {
    await page.goto('/today', { waitUntil: 'load' });
    await markDocument(page);
    await page.getByRole('button', { name: /Ask the platform/ }).click();
    const input = page.getByPlaceholder('Ask anything about the platform…');
    await input.fill('why am I getting no leads?');
    await input.press('Enter');
    const question = page.locator('[data-turn="user"]', { hasText: 'why am I getting no leads?' });
    await expect(question).toHaveCount(1);
    await expect(page.locator('[data-turn="assistant"]')).toHaveCount(1, { timeout: 30_000 });
    const answer = (await page.locator('[data-turn="assistant"]').textContent()) ?? '';

    for (const [area, path] of [
      ['review', /\/review(\?|$)/],
      ['outreach', /\/(drafts|today)/],
      ['pipeline', /\/pipeline/],
      ['conversations', /\/communication/],
      ['discovery', /\/connectors/],
    ] as const) {
      await goViaSidebar(page, area, path);
      await expect(question).toHaveCount(1);
      await expect(page.locator('[data-turn="assistant"]')).toHaveText(answer);
    }
    expect(await sameDocument(page), 'no full page load while navigating').toBe(true);
  });

  test('switching workspace (god mode) starts a fresh conversation', async ({ page }) => {
    await page.goto('/today', { waitUntil: 'load' });
    const switcher = page.locator('.workspace-switcher select');
    test.skip((await switcher.count()) === 0, 'the seeded user can reach only one workspace');
    await page.getByRole('button', { name: /Ask the platform/ }).click();
    const input = page.getByPlaceholder('Ask anything about the platform…');
    await input.fill('what needs me today?');
    await input.press('Enter');
    await expect(page.locator('[data-turn="user"]')).toHaveCount(1);

    const before = await page
      .locator('[data-shell-workspace]')
      .getAttribute('data-shell-workspace');
    const options = await switcher
      .first()
      .locator('option')
      .evaluateAll((els) => els.map((o) => (o as HTMLOptionElement).value));
    const target = options.find((v) => v && v !== before);
    test.skip(!target, 'no other workspace to switch to');
    page.once('dialog', (d) => void d.accept());
    await switcher.first().selectOption(target!);
    await expect(page.locator('[data-shell-workspace]')).toHaveAttribute(
      'data-shell-workspace',
      target!,
    );
    // The panel is keyed by the workspace: closed again, no transcript.
    await expect(page.locator('[data-turn]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Ask the platform/ })).toBeVisible();

    // Back to where the worker's other tests expect this session to be.
    const back = page.getByRole('button', { name: 'Return to my workspace' });
    if ((await back.count()) > 0) await back.click();
    else {
      page.once('dialog', (d) => void d.accept());
      await switcher.first().selectOption(before!);
    }
    await expect(page.locator('[data-shell-workspace]')).toHaveAttribute(
      'data-shell-workspace',
      before!,
    );
  });

  test('a switch in another tab is announced, never swapped in silently', async ({
    page,
    context,
  }) => {
    await page.goto('/today', { waitUntil: 'load' });
    const switcher = page.locator('.workspace-switcher select');
    test.skip((await switcher.count()) === 0, 'the seeded user can reach only one workspace');
    const home = await page.locator('[data-shell-workspace]').getAttribute('data-shell-workspace');
    const options = await switcher
      .first()
      .locator('option')
      .evaluateAll((els) => els.map((o) => (o as HTMLOptionElement).value));
    const target = options.find((v) => v && v !== home);
    test.skip(!target, 'no other workspace to switch to');
    await markDocument(page);

    // Another tab of the same browser (same session) switches.
    const other = await context.newPage();
    try {
      await other.goto('/today', { waitUntil: 'load' });
      other.once('dialog', (d) => void d.accept());
      await other.locator('.workspace-switcher select').selectOption(target!);
      await expect(other.locator('[data-shell-workspace]')).toHaveAttribute(
        'data-shell-workspace',
        target!,
      );

      // Back in the first tab: the frame says so and stays where it was.
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      const notice = page.locator('[data-workspace-drift-notice]');
      await expect(notice).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('[data-shell-workspace]')).toHaveAttribute(
        'data-shell-workspace',
        home!,
      );
      expect(await sameDocument(page)).toBe(true);
      // Reload opens it in the workspace the browser is in now.
      await notice.getByRole('button', { name: 'Reload' }).click();
      await expect(page.locator('[data-shell-workspace]')).toHaveAttribute(
        'data-shell-workspace',
        target!,
      );
      await expect(page.locator('[data-workspace-drift-notice]')).toHaveCount(0);
    } finally {
      // Back to where the worker's other tests expect this session to be.
      const back = page.getByRole('button', { name: 'Return to my workspace' });
      if ((await back.count()) > 0) await back.click();
      else {
        page.once('dialog', (d) => void d.accept());
        await page.locator('.workspace-switcher select').selectOption(home!);
      }
      await expect(page.locator('[data-shell-workspace]')).toHaveAttribute(
        'data-shell-workspace',
        home!,
      );
      await other.close();
    }
  });

  test('approving on /review/[id] lowers the sidebar Review count without a full reload', async ({
    page,
  }) => {
    await page.goto('/review?state=needs_review', { waitUntil: 'load' });
    const first = page.locator('a[href^="/review/"]').filter({ hasNotText: /^\s*$/ }).first();
    test.skip((await first.count()) === 0, 'no review item waiting in the seed');
    await first.click();
    await expect(page).toHaveURL(/\/review\/\d+/);
    await markDocument(page);
    const before = Number((await reviewBadge(page)) || '0');
    test.skip(!(before > 0), 'the Review badge shows no number to lower');
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect
      .poll(async () => Number((await reviewBadge(page)) || '0'), { timeout: 15_000 })
      .toBe(before - 1);
    expect(await sameDocument(page), 'no full page load after the decision').toBe(true);
  });

  test('the account menu closes when one of its links navigates', async ({ page }) => {
    await page.goto('/today', { waitUntil: 'load' });
    await page.locator('details.header-account-menu > summary').click();
    await page.locator('.header-account-links a[href="/support"]').click();
    await expect(page).toHaveURL(/\/support/);
    await expect(page.locator('details.header-account-menu')).not.toHaveAttribute('open', '');
  });

  test('a pause from another browser reaches this frame’s banner on focus, without a reload', async ({
    page,
    context,
    browser,
  }) => {
    const banner = page.getByRole('alert').filter({ hasText: 'Automation is paused' });
    await page.goto('/today', { waitUntil: 'load' });
    test.skip((await banner.count()) > 0, 'the workspace is already paused');
    await markDocument(page);

    // Context B: the same account in another browser pauses everything.
    const other = await browser.newContext({ storageState: await context.storageState() });
    try {
      const b = await other.newPage();
      await b.goto('/mailbox/queue#pause', { waitUntil: 'load' });
      await b.getByRole('button', { name: 'Pause all automation' }).click();
      await expect(b.getByRole('button', { name: 'Undo pause' })).toBeVisible();

      // Context A's frame learns it at the next poll, or at once on focus.
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(banner).toBeVisible({ timeout: 20_000 });
      expect(await sameDocument(page), 'the banner came without a full reload').toBe(true);

      await b.getByRole('button', { name: 'Undo pause' }).click();
      await expect(b.getByRole('button', { name: 'Pause all automation' })).toBeVisible();
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(banner).toHaveCount(0, { timeout: 20_000 });
    } finally {
      await other.close();
    }
  });

  test('/admin keeps its own console frame, not the workspace sidebar', async ({ page }) => {
    await page.goto('/admin', { waitUntil: 'load' });
    await expect(page.locator('.admin-shell .admin-topbar')).toBeVisible();
    await expect(page.locator('aside.sidebar')).toHaveCount(0);
    await expect(page.locator('[data-brand-wordmark]')).toHaveCount(1);
  });
});

test.describe('test-only probes (ENABLE_TEST_ROUTES=1)', () => {
  test.skip(!testRoutesOn, 'needs the app (and this runner) started with ENABLE_TEST_ROUTES=1');

  test('the frame renders on the server once per full load, not once per navigation', async ({
    page,
    context,
    baseURL,
  }) => {
    const probe = `ds07-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await context.addCookies([{ name: PROBE_COOKIE, value: probe, url: baseURL! }]);
    const renders = async () =>
      (
        (await (await page.request.get(`/api/test-only/shell-renders?probe=${probe}`)).json()) as {
          renders: number;
        }
      ).renders;
    await page.goto('/today', { waitUntil: 'load' });
    expect(await renders()).toBe(1);
    await goViaSidebar(page, 'review', /\/review/);
    await goViaSidebar(page, 'pipeline', /\/pipeline/);
    await goViaSidebar(page, 'products', /\/products/);
    expect(await renders(), 'client navigation does not render the frame again').toBe(1);
    await page.reload({ waitUntil: 'load' });
    expect(await renders()).toBe(2);
  });

  test('a page that throws renders inside the frame, with navigation intact', async ({ page }) => {
    const response = await page.goto('/test-only/shell-error', { waitUntil: 'load' });
    expect(response?.status()).toBe(500);
    await expect(page.locator('[data-shell-error] .status-card')).toBeVisible();
    await expect(page.locator('aside.sidebar')).toBeVisible();
    await expect(page.locator('[data-brand-wordmark]')).toHaveCount(1);
    await goViaSidebar(page, 'review', /\/review/);
    await expect(page.locator('[data-shell-error]')).toHaveCount(0);
  });
});
