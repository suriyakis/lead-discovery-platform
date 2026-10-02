// MOB-02 in the browser: the sidebar badges ARE /api/attention.
//
//   - GET /api/attention answers 401 to a signed-out request, never cached;
//   - signed in, on several pages, every sidebar badge equals the number
//     the registry's count policy makes of /api/attention's summary (the
//     same projection the Sidebar's useAttention() runs);
//   - the Sidebar refetches in the browser: the server-rendered page does
//     not ask again on mount, a window focus does (useAttention's trigger).
//
// Needs a running app seeded by scripts/seed-demo.ts (playwright.config.ts).

import { expect, test as base, type Page } from '@playwright/test';
import { signedInTest as test } from './session';

interface Summary {
  workspaceId: string;
  counts: Record<string, number | null>;
}

/** What a badge prints for a number: nothing for 0, 99+ above 99, — unknown. */
function badgeText(value: number | null): string {
  if (value === null) return '—';
  if (value <= 0) return '';
  return value > 99 ? '99+' : String(value);
}

/** The sidebar badges the registry's count policy makes of a summary. */
function expectedBadges(s: Summary): Record<string, { text: string; tone?: string }> {
  const c = s.counts;
  const sum = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);
  const review = badgeText(c['review.open'] ?? null);
  const outreach = badgeText(sum(c['drafts.approve'] ?? null, c['followUps.approve'] ?? null));
  return {
    // Amber only while a needs_review item waits (DS-05).
    review: {
      text: review,
      tone:
        review && review !== '—' && (c['review.needsReview'] ?? 0) > 0 ? 'attention' : 'neutral',
    },
    outreach: { text: outreach, tone: outreach && outreach !== '—' ? 'attention' : 'neutral' },
    // Gated until I084: no number at all.
    conversations: { text: '' },
    today: { text: '' },
    pipeline: { text: '' },
  };
}

async function sidebarBadges(page: Page) {
  return page.locator('aside.sidebar a[data-area]').evaluateAll((links) =>
    Object.fromEntries(
      links.map((a) => {
        const badge = a.querySelector('.nav-count');
        return [
          a.getAttribute('data-area'),
          {
            text: badge?.querySelector('[aria-hidden="true"]')?.textContent?.trim() ?? '',
            tone: badge?.getAttribute('data-tone') ?? undefined,
          },
        ];
      }),
    ),
  );
}

base('GET /api/attention answers 401 when signed out, never cached', async ({ request }) => {
  const res = await request.get('/api/attention');
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ error: 'unauthorized' });
  expect(res.headers()['cache-control']).toContain('no-store');
});

test.describe('sidebar badges equal /api/attention', () => {
  for (const path of ['/today', '/review', '/drafts', '/pipeline']) {
    test(`on ${path}`, async ({ page }) => {
      await page.goto(path, { waitUntil: 'load' });
      const res = await page.request.get('/api/attention');
      expect(res.status()).toBe(200);
      expect(res.headers()['cache-control']).toContain('no-store');
      const summary = (await res.json()) as Summary;
      const shown = await sidebarBadges(page);
      const expected = expectedBadges(summary);
      for (const [area, want] of Object.entries(expected)) {
        expect(shown[area]?.text, `${area} badge text`).toBe(want.text);
        if (want.text && want.tone) expect(shown[area]?.tone, `${area} badge tone`).toBe(want.tone);
      }
    });
  }
});

test('the Sidebar keeps its numbers current in the browser (useAttention)', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/attention') requests.push(r.method());
  });
  await page.goto('/today', { waitUntil: 'load' });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  // The server rendered the summary: no second request on mount.
  expect(requests).toEqual([]);
  // A focus asks again.
  const refetch = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/attention');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const req = await refetch;
  const res = await req.response();
  expect(res?.status()).toBe(200);
  const summary = (await res!.json()) as Summary;
  // The badges still equal the fresh answer.
  const expected = expectedBadges(summary);
  await expect
    .poll(async () => (await sidebarBadges(page)).review?.text)
    .toBe(expected.review!.text);
});
