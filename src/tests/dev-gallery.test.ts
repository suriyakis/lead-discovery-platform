// DS-06: the component gallery at /dev/gallery. It is an ordinary 404
// unless ENABLE_TEST_ROUTES=1 (production never sets it), it shows every
// token in src/styles/tokens.css, and it renders the base controls and the
// primitives in their states. The browser half (layer order holding when
// a module chunk loads first, the 404 from a real server) is
// e2e/design-foundation.spec.ts.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from 'cheerio';
import { isNextRedirectError } from '@/lib/server-redirect';
import { UNLISTED_ROUTES } from '@/lib/nav/registry';
import ComponentGallery, { dynamic, metadata } from '@/app/dev/gallery/page';
import { galleryTokenNames, TOKEN_GROUPS, TONES } from '@/app/dev/gallery/_catalog';
import { loadCssFile, rootTokens } from './helpers/css-cascade';
import { closeReason } from '@/lib/db/schema/pipeline';
import { reviewItemState } from '@/lib/db/schema/review';
import { NOTIFICATION_KINDS } from '@/lib/kinds/notification';

afterEach(() => {
  delete process.env.ENABLE_TEST_ROUTES;
  vi.unstubAllEnvs();
});

function notFoundDigest(): string | undefined {
  try {
    ComponentGallery();
  } catch (err) {
    expect(isNextRedirectError(err)).toBe(true);
    return (err as { digest: string }).digest;
  }
  return undefined;
}

describe('/dev/gallery is dev and test only', () => {
  it('is a plain 404 unless ENABLE_TEST_ROUTES=1', () => {
    expect(notFoundDigest()).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
    process.env.ENABLE_TEST_ROUTES = 'true';
    expect(notFoundDigest()).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
  });

  it('is a 404 in a production build that does not set the flag', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(notFoundDigest()).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
  });

  it('reads the flag per request (never prerendered) and stays out of search', () => {
    expect(dynamic).toBe('force-dynamic');
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(UNLISTED_ROUTES['/dev/gallery']).toMatch(/ENABLE_TEST_ROUTES=1/);
  });
});

describe('/dev/gallery with ENABLE_TEST_ROUTES=1', () => {
  const render = () => {
    process.env.ENABLE_TEST_ROUTES = '1';
    return load(renderToStaticMarkup(createElement(ComponentGallery)));
  };

  it('renders one page with the design-system scope and every section', () => {
    const $ = render();
    expect($('h1')).toHaveLength(1);
    expect($('h1').text()).toBe('Component gallery');
    expect($('main[data-ds]')).toHaveLength(1);
    for (const id of [
      ...TOKEN_GROUPS.map((g) => g.id),
      'tones',
      'form-controls',
      'alerts',
      'badges',
      'brand',
      'layers',
    ]) {
      expect($(`section#${id}`), id).toHaveLength(1);
      expect($(`nav a[href="#${id}"]`), id).toHaveLength(1);
    }
  });

  it('shows every token of tokens.css, and nothing tokens.css lacks', () => {
    const tokens = [...rootTokens(loadCssFile('src/styles/tokens.css')).keys()].filter(
      (n) => !n.startsWith('--brand-'),
    );
    const shown = galleryTokenNames();
    expect(new Set(shown).size, 'a token is listed twice').toBe(shown.length);
    expect([...shown].sort()).toEqual([...tokens].sort());
    const $ = render();
    for (const name of shown) {
      expect($(`code:contains("${name}")`).length, name).toBeGreaterThan(0);
    }
  });

  it('every tone of the meaning map appears on every surface', () => {
    const $ = render();
    for (const { tone } of TONES) {
      const chips = $(`[data-tone-sample="${tone}"] [style*="--t:var(--tone-${tone})"]`);
      expect(chips.length, tone).toBe(6);
      expect(chips.first().text(), tone).toBe(tone);
    }
  });

  it('shows the badge family: every tone, real value sets, counts, scores, tags, the funnel (DS-09)', () => {
    const $ = render();
    const badges = $('#badges');
    const tones = badges
      .find('[data-signal-sample="Badge tone"] [data-tone]')
      .toArray()
      .map((el) => $(el).attr('data-tone'));
    expect(tones).toEqual(TONES.map((t) => t.tone));
    for (const [set, values] of [
      ['review_item_state', reviewItemState.enumValues],
      ['close_reason', closeReason.enumValues],
      ['notification_kind', NOTIFICATION_KINDS],
    ] as const) {
      const shown = badges
        .find(`[data-signal="${set}"]`)
        .toArray()
        .map((el) => $(el).attr('data-value'));
      expect(shown, set).toEqual([...values]);
    }
    expect(badges.find('[data-signal-sample="Tag"] [data-hue]')).toHaveLength(6);
    expect(
      badges
        .find('[data-funnel-row] [data-step]')
        .toArray()
        .map((el) => $(el).attr('data-step')),
    ).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });

  it('renders each base control in its states, each with a label', () => {
    const $ = render();
    const controls = $('#form-controls input, #form-controls select, #form-controls textarea');
    expect(controls.length).toBeGreaterThanOrEqual(15);
    controls.each((_, el) => {
      const id = $(el).attr('id');
      const labelled =
        (id && $(`label[for="${id}"]`).length > 0) || $(el).closest('label').length > 0;
      expect(labelled, $.html(el)).toBe(true);
    });
    expect($('#form-controls input[aria-invalid="true"]').attr('aria-describedby')).toBe(
      'g-email-error',
    );
    expect(
      $('#form-controls input[disabled], #form-controls select[disabled]').length,
    ).toBeGreaterThanOrEqual(3);
    expect($('#form-controls input[type="checkbox"][checked]').length).toBeGreaterThanOrEqual(2);
    expect($('#form-controls input[type="checkbox"][role="switch"]')).toHaveLength(2);
    expect($('#form-controls input[type="radio"][checked]')).toHaveLength(1);
    expect($('#form-controls input[type="date"]')).toHaveLength(1);
  });

  it('renders the Alert primitive in all four tones', () => {
    const $ = render();
    expect(
      $('#alerts [data-tone]')
        .map((_, el) => $(el).attr('data-tone'))
        .get(),
    ).toEqual(['info', 'success', 'warning', 'danger', 'info']);
  });

  it('shows the brand: the lockup (the page’s one wordmark), the mark and two app icons (DS-08)', () => {
    const $ = render();
    expect($('[data-brand-wordmark]')).toHaveLength(1);
    expect($('#brand svg[data-brand-mark][role="img"]')).toHaveLength(2);
    expect(
      $('#brand img')
        .map((_, el) => $(el).attr('src'))
        .get(),
    ).toEqual(['/icons/icon-192.png', '/icons/icon-maskable-192.png']);
  });

  it('carries the cascade-layer probe the e2e test measures', () => {
    const $ = render();
    expect($('#layers ul.thread-list [data-layer-probe="legacy"]')).toHaveLength(1);
    expect($('#layers ul.thread-list [data-layer-probe="component"]')).toHaveLength(1);
    expect(
      $('#layers ol li')
        .map((_, el) => $(el).text())
        .get(),
    ).toEqual(['reset', 'tokens', 'base', 'legacy', 'components', 'patterns', 'utilities']);
  });

  it('styles samples only through custom properties (no inline colours or sizes)', () => {
    const $ = render();
    const styles = $('[style]')
      .map((_, el) => $(el).attr('style'))
      .get();
    expect(styles.length).toBeGreaterThan(50);
    for (const style of styles) {
      for (const decl of style.split(';').filter((d) => d.trim())) {
        expect(decl.trim(), style).toMatch(/^--[\w-]+:/);
      }
    }
  });
});
