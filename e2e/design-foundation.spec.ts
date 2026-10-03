// DS-06 in the browser: cascade layers survive Next's CSS pipeline.
//
// The component gallery (/dev/gallery, ENABLE_TEST_ROUTES=1) renders a
// list row that legacy's `.thread-list li` (specificity 0,1,1) pads by
// 14px, and a twin row that also carries a one-class rule (0,1,0) from a
// CSS module in the components layer. The module must win:
//   1. as Next serves the page;
//   2. with the compiled module chunk loaded BEFORE the global
//      stylesheets — the order a client-side navigation can produce —
//      because every chunk opens with the same @layer statement;
//   3. and, as a control, NOT without that statement, which shows the
//      statement is what holds the order.
// Also: /dev/gallery is a 404 when the flag is off.
//
// Needs no session and no seed data; the app (and this runner) need
// ENABLE_TEST_ROUTES=1, as in CI (see playwright.config.ts).

import { expect, type Page, test } from '@playwright/test';

const LAYERS = ['reset', 'tokens', 'base', 'legacy', 'components', 'patterns', 'utilities'];

interface SheetInfo {
  /** Index in document.styleSheets. */
  index: number;
  /** The names of the sheet's first rule when it is an @layer statement. */
  firstStatement: string[] | null;
  /** cssText of every top-level rule. */
  rules: Array<{ text: string; isStatement: boolean }>;
  hasProbe: boolean;
  hasLegacyLayer: boolean;
}

/** Walk the CSSOM of the open page: which sheet holds what. */
async function sheets(page: Page, probeClass: string): Promise<SheetInfo[]> {
  return page.evaluate((cls) => {
    const walk = (
      rules: CSSRuleList,
      visit: (r: CSSRule, layer: string | null) => void,
      layer: string | null,
    ) => {
      for (const rule of Array.from(rules)) {
        visit(rule, layer);
        if (rule instanceof CSSLayerBlockRule) walk(rule.cssRules, visit, rule.name);
        else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule)
          walk(rule.cssRules, visit, layer);
      }
    };
    return Array.from(document.styleSheets).map((sheet, index) => {
      let hasProbe = false;
      let hasLegacyLayer = false;
      walk(
        sheet.cssRules,
        (rule, layer) => {
          if (
            rule instanceof CSSStyleRule &&
            rule.selectorText === `.${cls}` &&
            layer === 'components'
          )
            hasProbe = true;
          if (rule instanceof CSSLayerBlockRule && rule.name === 'legacy') hasLegacyLayer = true;
        },
        null,
      );
      const first = sheet.cssRules[0];
      return {
        index,
        firstStatement: first instanceof CSSLayerStatementRule ? Array.from(first.nameList) : null,
        rules: Array.from(sheet.cssRules).map((r) => ({
          text: r.cssText,
          isStatement: r instanceof CSSLayerStatementRule,
        })),
        hasProbe,
        hasLegacyLayer,
      };
    });
  }, probeClass);
}

const paddingTop = (page: Page, which: 'legacy' | 'component') =>
  page.locator(`[data-layer-probe="${which}"]`).evaluate((el) => getComputedStyle(el).paddingTop);

test.describe('cascade layers (DS-06)', () => {
  test.skip(
    process.env.ENABLE_TEST_ROUTES !== '1',
    'needs the app (and this runner) started with ENABLE_TEST_ROUTES=1',
  );

  test('a components-layer rule beats a higher-specificity legacy rule', async ({ page }) => {
    const response = await page.goto('/dev/gallery');
    expect(response?.status()).toBe(200);
    const probeClass = await page
      .locator('[data-layer-probe="component"]')
      .getAttribute('data-probe-class');
    expect(probeClass).toBeTruthy();

    // Legacy's .thread-list li pads both rows; the module rule wins on its row.
    expect(await paddingTop(page, 'legacy')).toBe('14px');
    expect(await paddingTop(page, 'component')).toBe('4px');

    // …and the two rules are what this test claims they are.
    const legacyRule = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        for (const rule of Array.from(sheet.cssRules)) {
          if (!(rule instanceof CSSLayerBlockRule) || rule.name !== 'legacy') continue;
          const hit = Array.from(rule.cssRules).find(
            (r) => r instanceof CSSStyleRule && r.selectorText === '.thread-list li',
          ) as CSSStyleRule | undefined;
          if (hit) return hit.style.paddingTop;
        }
      }
      return null;
    });
    expect(legacyRule, 'legacy .thread-list li sets the padding').toBe('0.875rem');
    const info = await sheets(page, probeClass!);
    expect(info.filter((s) => s.hasProbe)).toHaveLength(1);
  });

  test('Next keeps the @layer statement at the top of every compiled stylesheet', async ({
    page,
  }) => {
    await page.goto('/dev/gallery');
    const probeClass = (await page
      .locator('[data-layer-probe="component"]')
      .getAttribute('data-probe-class'))!;
    const info = await sheets(page, probeClass);
    const layered = info.filter((s) => s.rules.some((r) => r.text.startsWith('@layer')));
    // The global layers and the page's module chunk at least.
    expect(layered.length).toBeGreaterThanOrEqual(2);
    for (const sheet of layered)
      expect(sheet.firstStatement, `stylesheet #${sheet.index}`).toEqual(LAYERS);
    const moduleSheet = info.find((s) => s.hasProbe)!;
    expect(moduleSheet.hasLegacyLayer, 'the module chunk is separate from the global CSS').toBe(
      false,
    );
    expect(moduleSheet.firstStatement).toEqual(LAYERS);
  });

  test('the module still wins when its chunk loads before the global CSS', async ({ page }) => {
    await page.goto('/dev/gallery');
    const probeClass = (await page
      .locator('[data-layer-probe="component"]')
      .getAttribute('data-probe-class'))!;
    const markup = await page.locator('[data-layer-probe-list]').evaluate((el) => el.outerHTML);
    const info = await sheets(page, probeClass);
    const moduleSheet = info.find((s) => s.hasProbe)!;
    const rest = info.filter((s) => s !== moduleSheet).flatMap((s) => s.rules.map((r) => r.text));

    const render = async (moduleCss: string) => {
      await page.setContent(
        `<!doctype html><html><head><style>${moduleCss}</style><style>${rest.join('\n')}</style></head>` +
          `<body><main data-ds>${markup}</main></body></html>`,
      );
      return {
        legacy: await paddingTop(page, 'legacy'),
        component: await paddingTop(page, 'component'),
      };
    };

    const asCompiled = moduleSheet.rules.map((r) => r.text).join('\n');
    expect(await render(asCompiled)).toEqual({ legacy: '14px', component: '4px' });

    // Control: the same chunk without its @layer statement declares
    // `components` first, which makes it the LOWEST layer — legacy wins.
    const withoutStatement = moduleSheet.rules
      .filter((r) => !r.isStatement)
      .map((r) => r.text)
      .join('\n');
    expect(await render(withoutStatement)).toEqual({ legacy: '14px', component: '14px' });
  });
});

test('/dev/gallery is a 404 without ENABLE_TEST_ROUTES', async ({ page }) => {
  test.skip(process.env.ENABLE_TEST_ROUTES === '1', 'the runner says the app has test routes on');
  const response = await page.goto('/dev/gallery');
  expect(response?.status()).toBe(404);
});
