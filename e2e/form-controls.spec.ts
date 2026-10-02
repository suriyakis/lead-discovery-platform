// DS-10 in the browser, on the seeded demo workspace.
//
// 1. On the fourteen acceptance pages, every visible input, select and
//    textarea is a control-token height (28, 36 or 44px; a textarea at
//    least one control tall), has no browser-default background, and has
//    16px text or more on a phone (coarse pointer). Checkboxes and radios
//    are boxes, not text controls, and are left out.
// 2. The signature preview renders inside a sandboxed iframe, and the
//    app's base input styles are absent inside it (computed style); pasted
//    signature HTML cannot run script as the app.
// 3. axe reports 0 serious or critical label violations on the pilot pages
//    (the review date filter, settings/outreach) and on the settings forms
//    that adopted the components.
//
// Needs a running app seeded by scripts/seed-demo.ts (playwright.config.ts).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { signedInTest as test } from './session';

const ACCEPTANCE_PAGES: ReadonlyArray<[string, string]> = [
  ['draft detail', '/drafts/39'],
  ['suppression', '/mailbox/suppression'],
  ['members', '/settings/members'],
  ['admin users', '/admin/users'],
  ['recipe detail', '/connectors/1/recipes/1'],
  ['review', '/review'],
  ['leads', '/leads'],
  ['pipeline', '/pipeline'],
  ['settings audit', '/settings/audit'],
  ['thread', '/communication/7'],
  ['billing', '/settings/billing'],
  ['outreach', '/settings/outreach'],
  ['admin providers', '/admin/providers'],
  ['product new', '/products/new'],
];

const CONTROL_HEIGHTS = [28, 36, 44];

async function open(page: Page, url: string) {
  const res = await page.goto(url, { waitUntil: 'load' });
  expect(res?.status(), `HTTP status of ${url}`).toBeLessThan(400);
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
}

interface Control {
  tag: string;
  type: string;
  name: string | null;
  height: number;
  background: string;
  uaBackground: string;
  fontSize: number;
  where: string;
}

/** Every visible text-like control, with the browser's own default background for its tag. */
async function visibleControls(page: Page): Promise<Control[]> {
  return page.evaluate(() => {
    // Document styles never reach a shadow root: its controls show the UA look.
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const ua: Record<string, string> = {};
    for (const tag of ['input', 'select', 'textarea']) {
      const el = document.createElement(tag);
      root.append(el);
      ua[tag] = getComputedStyle(el).backgroundColor;
    }
    host.remove();
    const boxes = new Set([
      'hidden',
      'checkbox',
      'radio',
      'range',
      'color',
      'submit',
      'button',
      'reset',
      'image',
      'file',
    ]);
    const where = (el: Element) => {
      const parts: string[] = [];
      for (let e: Element | null = el, i = 0; e && i < 3; e = e.parentElement, i++) {
        parts.push(
          e.tagName.toLowerCase() + (e.classList.length ? `.${[...e.classList].join('.')}` : ''),
        );
      }
      return parts.join(' < ');
    };
    const out: Control[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('input, select, textarea')) {
      const tag = el.tagName.toLowerCase();
      const type = tag === 'input' ? (el.getAttribute('type') ?? 'text').toLowerCase() : tag;
      if (tag === 'input' && boxes.has(type)) continue;
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (rect.width === 0 || rect.height === 0 || cs.visibility === 'hidden') continue;
      out.push({
        tag,
        type,
        name: el.getAttribute('name'),
        height: rect.height,
        background: cs.backgroundColor,
        uaBackground: ua[tag]!,
        fontSize: parseFloat(cs.fontSize),
        where: where(el),
      });
    }
    return out;
  });
}

test.describe('acceptance pages: every visible control is a token height, filled, 16px on a phone', () => {
  for (const [name, url] of ACCEPTANCE_PAGES) {
    test(`${name} (${url})`, async ({ page }, info) => {
      const phone = info.project.name === 'mobile';
      await open(page, url);
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(phone);
      const controls = await visibleControls(page);
      expect(controls.length, `visible controls on ${url}`).toBeGreaterThan(0);
      // On a coarse pointer --control-md is 44px, so a textarea's floor is 44.
      const floor = phone ? 44 : 36;
      const problems = controls.flatMap((c) => {
        const out: string[] = [];
        const label = `${c.tag}[${c.type}] ${c.name ?? ''} (${c.where})`;
        if (c.tag === 'textarea') {
          if (c.height < floor - 0.5) out.push(`${label}: ${c.height}px, under ${floor}px`);
        } else if (!CONTROL_HEIGHTS.some((h) => Math.abs(c.height - h) < 0.5)) {
          out.push(`${label}: ${c.height}px tall`);
        }
        if (c.background === c.uaBackground) out.push(`${label}: browser-default background`);
        if (phone && c.fontSize < 16) out.push(`${label}: ${c.fontSize}px text on a phone`);
        return out;
      });
      expect(problems).toEqual([]);
    });
  }
});

test.describe('the signature preview is an isolated email document', () => {
  test('renders in a sandboxed iframe where base input styles are absent', async ({
    page,
  }, info) => {
    await open(page, '/mailbox/signatures');
    const frame = page.locator('iframe[data-email-preview]');
    await expect(frame).toHaveCount(1);
    expect(await frame.getAttribute('sandbox')).toBe('allow-same-origin');
    await expect
      .poll(() =>
        frame.evaluate((el: HTMLIFrameElement) => el.contentDocument?.body?.textContent ?? ''),
      )
      .toContain('Kind regards');
    // The rendered signature is not in the page's own DOM (the Raw HTML
    // panel shows its source as text, which is not an exact match).
    await expect(page.locator('main').getByText('Kind regards,', { exact: true })).toHaveCount(0);

    const styles = await frame.evaluate((el: HTMLIFrameElement) => {
      const doc = el.contentDocument!;
      // The sizes first: the probe below adds a line to the email.
      const height = el.getBoundingClientRect().height;
      const content = doc.body.getBoundingClientRect().height;
      const probe = doc.createElement('input');
      doc.body.append(probe);
      const inFrame = getComputedStyle(probe);
      const outside = document.createElement('input');
      document.body.append(outside);
      const inPage = getComputedStyle(outside);
      const result = {
        frame: {
          minHeight: inFrame.minHeight,
          background: inFrame.backgroundColor,
          scheme: inFrame.colorScheme,
        },
        page: { minHeight: inPage.minHeight, background: inPage.backgroundColor },
        sheets: doc.styleSheets.length,
        css: Array.from(doc.styleSheets)
          .flatMap((s) => Array.from(s.cssRules).map((r) => r.cssText))
          .join('\n'),
        height,
        content,
      };
      probe.remove();
      outside.remove();
      return result;
    });
    // In the page a bare input is the base control; in the frame it is not.
    expect(styles.page.minHeight).toBe(info.project.name === 'mobile' ? '44px' : '36px');
    expect(styles.frame.minHeight).not.toBe(styles.page.minHeight);
    expect(styles.frame.background).not.toBe(styles.page.background);
    expect(styles.frame.scheme).not.toBe('dark');
    // One stylesheet: the mail-client canvas, nothing of the app's.
    expect(styles.sheets).toBe(1);
    expect(styles.css).not.toMatch(/--surface-input|--control-md|@layer/);
    // The frame is sized to its content (plus its 1px border).
    expect(Math.abs(styles.height - styles.content)).toBeLessThanOrEqual(3);
  });

  test('pasted signature HTML cannot run script as the app', async ({ page }) => {
    await open(page, '/mailbox/signatures');
    const title = await page.title();
    await page.getByRole('button', { name: 'New signature' }).click();
    await page
      .locator('textarea[name="bodyHtml"]')
      .fill(
        '<p>Pasted</p><img src="data:," onerror="parent.document.title=\'pwned\'">' +
          '<script>parent.document.title = "pwned";</script>',
      );
    const frame = page.locator('iframe[data-email-preview]');
    await expect(frame).toHaveCount(1);
    await expect
      .poll(() =>
        frame.evaluate((el: HTMLIFrameElement) => el.contentDocument?.body?.innerHTML ?? ''),
      )
      .toContain('<p>Pasted</p>');
    await page.waitForTimeout(500);
    expect(await page.title()).toBe(title);
  });

  test('the gallery sample keeps a form control in the browser look', async ({ page }) => {
    test.skip(process.env.ENABLE_TEST_ROUTES !== '1', 'the gallery needs ENABLE_TEST_ROUTES=1');
    await open(page, '/dev/gallery');
    const probe = await page
      .locator('#email-preview iframe[data-email-preview]')
      .evaluate((el: HTMLIFrameElement) => {
        const input = el.contentDocument!.querySelector('[data-isolation-probe]')!;
        const cs = getComputedStyle(input);
        return { minHeight: cs.minHeight, radius: cs.borderTopLeftRadius };
      });
    expect(probe.minHeight).not.toBe('36px');
    expect(probe.radius).not.toBe('6px'); // --radius-sm
  });
});

// base.css draws every checkbox itself (appearance: none), so a legacy
// accent-color no longer colours one. The contexts that picked a colour
// carry a tone instead: the destructive Remove step stays red, and the
// row-selection checkboxes stay teal.
test.describe('checked boxes keep their tone', () => {
  const CASES = [
    ['/settings/outreach', '.followup-step-remove input[type="checkbox"]', 'danger'],
    ['/review', '.row-select input[type="checkbox"]', 'live'],
  ] as const;
  for (const [url, selector, tone] of CASES) {
    test(`${url}: a checked ${selector} is the ${tone} tone, not the primary`, async ({ page }) => {
      await open(page, url);
      const box = page.locator(selector).first();
      await box.check();
      const colourOf = (token: string) =>
        page.evaluate((t) => {
          const probe = document.createElement('span');
          probe.style.backgroundColor = `var(${t})`;
          document.body.append(probe);
          const colour = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return colour;
        }, token);
      const expected = await colourOf(`--tone-${tone}`);
      expect(expected).not.toBe(await colourOf('--primary'));
      // Polled: the fill transitions in.
      await expect
        .poll(() => box.evaluate((el) => getComputedStyle(el).backgroundColor))
        .toBe(expected);
    });
  }
});

/** axe-core (a devDependency), injected into the page as a script. */
const AXE_SOURCE = readFileSync(
  path.join(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js'),
  'utf8',
);

/** axe rules about naming form controls and frames. */
const LABEL_RULES = [
  'label',
  'select-name',
  'aria-input-field-name',
  'aria-toggle-field-name',
  'form-field-multiple-labels',
  'label-title-only',
  'frame-title',
];

const AXE_PAGES = [
  '/review',
  '/settings/outreach',
  '/settings/members',
  '/settings/audit',
  '/settings/crm/1',
  '/mailbox/signatures',
];

test.describe('axe: no serious label violations on the pilot pages', () => {
  for (const url of AXE_PAGES) {
    test(url, async ({ page }) => {
      await open(page, url);
      await page.addScriptTag({ content: AXE_SOURCE });
      const violations = await page.evaluate(async (rules) => {
        const axe = (
          window as unknown as {
            axe: {
              run: (
                ...a: unknown[]
              ) => Promise<{
                violations: Array<{
                  id: string;
                  impact: string;
                  nodes: Array<{ target: string[] }>;
                }>;
              }>;
            };
          }
        ).axe;
        const result = await axe.run(document, { runOnly: { type: 'rule', values: rules } });
        return result.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.map((n) => n.target.join(' ')),
        }));
      }, LABEL_RULES);
      expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual(
        [],
      );
    });
  }
});
