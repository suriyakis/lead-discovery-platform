// DS-09 (absorbs ia:F-11) in the browser, on the seeded demo workspace.
//
// Pilots:
//   - /pipeline: 'closing' and every close reason except won render
//     neutral, won renders success; the funnel is one hue (the primary at
//     falling opacity) and uses the same labels as the state filter and
//     the Today overview funnel.
//   - /health: the score of 78 and every warning finding render amber.
//   - /review, /pipeline, /health: no raw enum (NEEDS_REVIEW,
//     needs_review, synced_to_crm, …) anywhere in the visible text.
// Colours are compared as computed in the page: each badge's text colour
// against a probe painted with the tone's token, so the CSS, not only the
// data-tone attribute, is what is checked.
// F-11: on the pages the audit listed, no badge text and no audit-log kind
// reads as a snake_case or dotted code.
//
// Needs a running app seeded by scripts/seed-demo.ts (playwright.config.ts).

import { expect, type Page } from '@playwright/test';
import { TONE_MAPS, type Tone } from '../src/lib/ui/tone';
import { signedInTest as test } from './session';

/** Every snake_case or dotted value of a mapped set: the raw codes. */
const RAW_CODES = [...new Set(Object.values(TONE_MAPS).flatMap((map) => Object.keys(map)))].filter(
  (code) => /[_.]/.test(code),
);

/** A snake_case or dotted code as a whole badge text. */
const CODE_TEXT = /^[a-z0-9]+(?:[._][a-z0-9]+)+$/i;

async function open(page: Page, url: string) {
  const res = await page.goto(url, { waitUntil: 'load' });
  expect(res?.status(), `HTTP status of ${url}`).toBeLessThan(500);
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
}

/** The computed text colour of the tone's token, from a probe in the page. */
async function toneColour(page: Page, tone: Tone): Promise<string> {
  return page.evaluate((t) => {
    const probe = document.createElement('span');
    probe.style.color = `var(--tone-${t})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, tone);
}

/** Text colour and data-tone of every badge matching `selector`. */
async function badges(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((els) =>
    els.map((el) => ({
      value: el.getAttribute('data-value'),
      tone: el.getAttribute('data-tone'),
      colour: getComputedStyle(el).color,
      text: (el as HTMLElement).innerText.trim(),
    })),
  );
}

/** The visible text of the page's main content. */
async function visibleText(page: Page): Promise<string> {
  return page.locator('main').first().innerText();
}

function expectNoRawEnums(text: string, url: string) {
  const found = RAW_CODES.filter((code) =>
    new RegExp(`(^|[^\\w.])${code.replace(/\./g, '\\.')}($|[^\\w.])`, 'i').test(text),
  );
  expect(found, `raw enum values visible on ${url}`).toEqual([]);
}

test.describe('pilot: /pipeline', () => {
  test("'closing' and every close reason but won are neutral; won is success", async ({ page }) => {
    await open(page, '/pipeline?state=closed');
    const neutral = await toneColour(page, 'neutral');
    const success = await toneColour(page, 'success');

    const reasons = await badges(page, '[data-signal="close_reason"]');
    // The seed closes four leads: won, lost, no_response, wrong_fit.
    expect(reasons.map((r) => r.value).sort()).toEqual(['lost', 'no_response', 'won', 'wrong_fit']);
    for (const r of reasons) {
      if (r.value === 'won') {
        expect(r.tone).toBe('success');
        expect(r.colour, 'won').toBe(success);
        expect(r.text).toBe('Won');
      } else {
        expect(r.tone, r.value!).toBe('neutral');
        expect(r.colour, r.value!).toBe(neutral);
      }
    }

    const stages = await badges(page, '[data-signal="outreach_stage"]');
    expect(stages.some((s) => s.value === 'closing')).toBe(true);
    for (const s of stages) {
      expect(s.tone, `stage ${s.value}`).toBe('neutral');
      expect(s.colour, `stage ${s.value}`).toBe(neutral);
    }
    expect(stages.find((s) => s.value === 'closing')?.text).toBe('Closing');
  });

  test('the funnel is one hue, stepped, and shares its labels with the filter and Today', async ({
    page,
  }) => {
    await open(page, '/pipeline');
    const fills = page.locator('.pipeline-funnel-card [data-step]');
    await expect(fills).toHaveCount(7);
    const sample = await fills.evaluateAll((els) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      return els.map((el) => {
        const colour = getComputedStyle(el).backgroundColor;
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = colour;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        return {
          step: el.getAttribute('data-step'),
          rgba: [r!, g!, b!, a!],
          stepColour: getComputedStyle(el).getPropertyValue('--step-colour').trim(),
        };
      });
    });
    expect(sample.map((s) => s.step)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    const hue = ([r, g, b]: number[]) => {
      const [R, G, B] = [r!, g!, b!].map((x) => x / 255) as [number, number, number];
      const max = Math.max(R, G, B);
      const min = Math.min(R, G, B);
      const d = max - min;
      if (d === 0) return 0;
      const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
      return (h * 60 + 360) % 360;
    };
    const first = hue(sample[0]!.rgba);
    for (const s of sample) {
      expect(Math.abs(hue(s.rgba) - first), `step ${s.step} hue`).toBeLessThanOrEqual(4);
    }
    // Opacity falls step by step: one hue, not seven.
    const alphas = sample.map((s) => s.rgba[3]!);
    for (let i = 1; i < alphas.length; i++) expect(alphas[i]!).toBeLessThan(alphas[i - 1]!);
    // Every step is the primary token mixed with transparency.
    const primary = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
    );
    for (const s of sample) expect(s.stepColour, `step ${s.step}`).toContain(primary);

    const funnelLabels = await page
      .locator('.pipeline-funnel-card [data-funnel-row]')
      .evaluateAll((els) =>
        els.map((el) => el.firstElementChild?.firstElementChild?.textContent?.trim()),
      );
    const filterLabels = await page
      .locator('select[name="state"] option')
      .evaluateAll((els) => els.map((el) => el.textContent?.trim()));
    expect(filterLabels.slice(1, 8)).toEqual(funnelLabels);

    await open(page, '/today?view=overview');
    const todayLabels = await page
      .locator('[data-funnel-row]')
      .evaluateAll((els) =>
        els.map((el) => el.firstElementChild?.firstElementChild?.textContent?.trim()),
      );
    expect(todayLabels).toEqual(funnelLabels);
  });
});

test.describe('pilot: /health', () => {
  test('a health score of 78 and a warning finding render amber', async ({ page }) => {
    await open(page, '/health');
    const amber = await toneColour(page, 'attention');
    // AP-06: the latest saved report sits under Reports (the live score
    // under Right now depends on the seed's current state).
    const score = page.locator('section[aria-labelledby="health-reports"] [data-tone]').first();
    await expect(score).toHaveAttribute('data-tone', 'attention');
    await expect(score).toContainText('78');
    expect(await score.evaluate((el) => getComputedStyle(el).color)).toBe(amber);

    const findings = await badges(page, '[data-signal="health_finding_severity"]');
    const warnings = findings.filter((f) => f.value === 'warning');
    expect(warnings.length).toBeGreaterThan(0);
    for (const w of warnings) {
      expect(w.tone).toBe('attention');
      expect(w.colour).toBe(amber);
      expect(w.text).toBe('Warning');
    }
    for (const info of findings.filter((f) => f.value === 'info')) {
      expect(info.colour).toBe(await toneColour(page, 'neutral'));
    }
  });
});

test.describe('pilots show no raw enum', () => {
  const PILOTS = [
    '/review',
    '/review?state=all',
    '/review?state=needs_review',
    '/pipeline',
    '/pipeline?state=closed',
    '/pipeline?view=kanban',
    '/health',
  ];
  for (const url of PILOTS) {
    test(url, async ({ page }) => {
      await open(page, url);
      expectNoRawEnums(await visibleText(page), url);
    });
  }

  test('/review shows states as labelled badges, amber only where a decision waits', async ({
    page,
  }) => {
    await open(page, '/review?state=needs_review');
    const rows = await badges(page, '[data-signal="review_item_state"]');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.text).toBe('Needs review');
      expect(r.tone).toBe('attention');
    }
    await open(page, '/review?state=all');
    const all = await badges(page, '[data-signal="review_item_state"]');
    for (const r of all.filter((x) => x.value === 'new')) expect(r.tone).toBe('neutral');
  });
});

test.describe('ia:F-11: no code-shaped labels on the audited pages', () => {
  const PAGES = [
    '/today',
    '/today?tab=drafts',
    '/today?tab=replies',
    '/today?tab=followups',
    '/today?view=overview',
    '/review',
    '/leads',
    '/pipeline',
    '/drafts',
    '/notifications',
    '/communication/follow-ups?status=all',
    '/mailbox/queue?status=all',
    '/settings/usage',
    '/settings/audit',
    '/admin/audit',
  ];
  for (const url of PAGES) {
    test(url, async ({ page }) => {
      await open(page, url);
      const texts = await page
        // Badges and chips (Alerts carry a tone too but are sentences: role=alert|status).
        .locator('main :is(.badge, [data-tone]):not([role]), main .timeline strong')
        .evaluateAll((els) =>
          els.map((el) => (el as HTMLElement).innerText.trim()).filter(Boolean),
        );
      const offenders = texts.filter((t) => CODE_TEXT.test(t) || t.includes('_'));
      expect(offenders, `code-shaped badge text on ${url}`).toEqual([]);
    });
  }

  test('the bell feed labels every kind and the audit filter lists labels', async ({ page }) => {
    await open(page, '/notifications');
    const kinds = await badges(page, '[data-signal="notification_kind"]');
    expect(kinds.length).toBeGreaterThan(5);
    for (const k of kinds) expect(k.text, k.value!).not.toBe(k.value);
    await open(page, '/settings/audit');
    const options = await page
      .locator('select[name="kind"] option')
      .evaluateAll((els) =>
        els.map((el) => ({ value: el.getAttribute('value'), text: el.textContent?.trim() })),
      );
    expect(options.length).toBeGreaterThan(5);
    for (const o of options.slice(1)) {
      expect(o.text, o.value!).not.toBe(o.value);
      expect(o.text, o.value!).not.toMatch(CODE_TEXT);
    }
  });
});
