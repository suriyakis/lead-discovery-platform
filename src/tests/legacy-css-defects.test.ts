// DS-02: the legacy CSS defect pack (I143, I149, I150, I151, I152, I177).
//
// These run the REAL app stylesheets (globals.css → tokens, base, legacy,
// utilities) through a small cascade (helpers/css-cascade.ts): fixture
// markup shaped like the affected pages, the stylesheets' own selectors
// matched by cheerio, winners picked by !important → layer → specificity
// → order. So "the CTA in a page header keeps
// its label colour" is checked the way the browser decides it, not by
// grepping for a selector string.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { EmptyState } from '@/components/EmptyState';
import { HintBadge } from '@/components/HintBadge';
import { type SupportBadgeAudience, SupportStatusBadge } from '@/components/SupportStatusBadge';
import type { HintSeverity } from '@/lib/services/hints';
import {
  cascade,
  type CascadeOptions,
  contrastRatio,
  type CssRule,
  loadAppRules,
  parseOklch,
  resolveVars,
  rootTokens,
  specificity,
  styleOf,
  toPx,
  type Winner,
} from './helpers/css-cascade';

const rules = loadAppRules();
const tokens = rootTokens(rules);
const resolve = (v: string | undefined) => {
  if (v === undefined) throw new Error('property not set');
  return resolveVars(v, tokens);
};

/** The generic "bare section" card and "bare h2" rules. */
const sectionCardRule = rules.find((r) => r.selectorText.startsWith(':where(main) section'));
const sectionH2Rule = rules.find((r) => r.selectorText.startsWith(':where(main) h2'));

function srcFiles(ext: RegExp): string[] {
  const root = path.resolve(process.cwd(), 'src');
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => ext.test(f) && !f.split(path.sep).includes('tests'))
    .map((f) => path.join(root, f));
}

/** Rough single-line box height: what a 32px hit-target check needs. */
function boxHeightPx(win: Map<string, Winner>): number {
  const v = (p: string) => win.get(p)?.value;
  const fontPx = v('font-size') ? toPx(v('font-size')!) : 16;
  if (v('height')) return toPx(v('height')!, fontPx);
  const lineHeight = Number(v('line-height') ?? '1.5'); // body line-height
  const pad = (p: string) => (v(p) ? toPx(v(p)!, fontPx) : 0);
  const border =
    v('border-style') && v('border-style') !== 'none' ? toPx(v('border-width') ?? '0', fontPx) : 0;
  const natural = fontPx * lineHeight + pad('padding-top') + pad('padding-bottom') + 2 * border;
  return Math.max(natural, v('min-height') ? toPx(v('min-height')!, fontPx) : 0);
}

describe('page-header CTAs (DS-02 item 1)', () => {
  const $ = load(`
    <main class="app-main">
      <div class="page-header">
        <div class="page-intro"><p class="page-eyebrow"><a id="crumb" href="/">← Products</a></p></div>
        <div class="action-row">
          <a id="cta" class="primary-btn" href="/products/autofill">Autofill from URL / PDFs</a>
          <a id="ghost" class="ghost-btn" href="/products/new">New product (manual)</a>
        </div>
      </div>
    </main>`);

  it('a .primary-btn link keeps its own label colour, at ≥ 4.5:1 on the button', () => {
    const color = styleOf($, '#cta', rules, 'color');
    expect(color).toBe('var(--brand-primary-foreground)');
    const ratio = contrastRatio(resolve(color), resolve(styleOf($, '#cta', rules, 'background')));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('a .ghost-btn link keeps the ghost styling, plain links stay muted', () => {
    expect(styleOf($, '#ghost', rules, 'color')).toBe('var(--brand-muted)');
    expect(styleOf($, '#ghost', rules, 'border-style')).toBe('solid');
    expect(styleOf($, '#crumb', rules, 'color')).toBe('var(--brand-muted)');
  });

  it('the muted-link rule keeps its old specificity so contextual rules still win', () => {
    const rule = rules.find((r) => r.selectorText.startsWith('.page-header a:where('));
    expect(rule).toBeDefined();
    expect(specificity(rule!.selectorText)).toEqual([0, 1, 1]);
  });
});

describe('ghost buttons on any element (DS-02 item 2, I152)', () => {
  const contexts: Record<string, string> = {
    'page header link': `<main class="app-main"><div class="page-header"><a id="t" class="ghost-btn" href="/x">New</a></div></main>`,
    'bare link': `<main class="app-main"><p><a id="t" class="ghost-btn" href="/x">Open leads</a></p></main>`,
    'product card action': `<div class="product-card-actions"><a id="t" class="ghost-btn" href="/x">Edit</a></div>`,
    'pagination link': `<nav class="pagination"><span class="pagination-actions"><a id="t" class="ghost-btn" href="?page=2">Next →</a></span></nav>`,
    'pagination disabled span': `<span class="pagination-actions"><span id="t" class="ghost-btn is-disabled">← Prev</span></span>`,
    'mail filter bar': `<form class="mail-filters"><a id="t" class="ghost-btn" href="/x">Reset</a></form>`,
    // admin/users: the per-user "Edit profile + memberships →" link.
    'profile list (admin users)': `<ul class="profile-list"><li><form class="inline-form"><button type="submit">Apply</button><a id="t" class="ghost-btn" href="/admin/users/u1">Edit profile + memberships →</a></form></li></ul>`,
    'lead row': `<ul class="profile-list"><li><div class="lead-row"><strong>Acme</strong><a id="t" class="ghost-btn" href="/x">Open</a></div></li></ul>`,
    // /connectors "Connector settings": a compact .small context (31px in
    // Chromium before ghost links got a min-height).
    'connector template foot (small)': `<div class="connector-template-foot"><a class="primary-btn small" href="/x">New recipe</a><a id="t" class="ghost-btn small" href="/x">Connector settings</a></div>`,
  };

  for (const [name, html] of Object.entries(contexts)) {
    it(`${name}: 1px solid border and a ≥ 32px box`, () => {
      const $ = load(html);
      const win = cascade($, '#t', rules);
      expect(win.get('border-style')?.value).toBe('solid');
      expect(win.get('border-width')?.value).toBe('1px');
      expect(win.get('text-decoration')?.value).toBe('none');
      expect(boxHeightPx(win)).toBeGreaterThanOrEqual(32);
    });
  }

  it('list and row link rules style title links only, never button links', () => {
    const $ = load(`
      <ul class="profile-list"><li>
        <div class="lead-row">
          <a id="title" href="/admin/users/u1">Ada Lovelace</a>
          <a id="ghost" class="ghost-btn" href="/admin/users/u1">Edit profile + memberships →</a>
          <a id="cta" class="primary-btn" href="/admin/users/u1/invite">Invite</a>
        </div>
      </li></ul>`);
    // The title link keeps the list's look...
    expect(styleOf($, '#title', rules, 'color')).toBe('var(--brand-fg)');
    expect(styleOf($, '#title', rules, 'font-size')).toBe('1rem');
    expect(styleOf($, '#title', rules, 'font-weight')).toBe('600');
    // ...the ghost link is the same muted 0.875rem ghost as everywhere else...
    const ghost = cascade($, '#ghost', rules);
    expect(ghost.get('color')?.value).toBe('var(--brand-muted)');
    expect(ghost.get('font-size')?.value).toBe('0.875rem');
    expect(ghost.get('font-weight')).toBeUndefined();
    // ...and the primary CTA keeps its label colour and weight.
    const cta = cascade($, '#cta', rules);
    expect(cta.get('color')?.value).toBe('var(--brand-primary-foreground)');
    expect(cta.get('font-size')?.value).toBe('0.875rem');
    expect(cta.get('font-weight')?.value).toBe('500');
    // :hover can't be matched here, so check the hover rules by hand.
    const contextual = rules.filter((r) =>
      r.selectors.some((s) => /^\.(profile-list|lead-row) a\b/.test(s)),
    );
    expect(contextual.length).toBeGreaterThanOrEqual(3);
    for (const r of contextual) {
      for (const s of r.selectors) {
        expect(s, 'exclude the button links').toContain(':where(:not(.primary-btn, .ghost-btn))');
        expect(specificity(s)[1], s).toBeLessThanOrEqual(2);
      }
    }
  });

  it('a <button class="ghost-btn"> resolves exactly as before', () => {
    const $ = load(`<form><button id="t" class="ghost-btn" type="submit">Sign out</button></form>`);
    const win = cascade($, '#t', rules);
    expect(win.get('background')?.value).toBe('transparent');
    expect(win.get('border-color')?.value).toBe('var(--brand-border)');
    expect(win.get('color')?.value).toBe('var(--brand-muted)');
    expect(win.get('font-size')?.value).toBe('0.875rem');
    expect(win.get('padding')?.value).toBe('0.375rem 0.75rem');
    // Buttons keep the UA inline-block box — the link-only block does not reach them.
    expect(win.get('display')).toBeUndefined();
    expect(boxHeightPx(win)).toBeGreaterThanOrEqual(32);
  });

  it('a <button class="primary-btn"> still resets the UA font', () => {
    const $ = load(`<button id="t" class="primary-btn" type="submit">Save</button>`);
    const win = cascade($, '#t', rules);
    expect(win.get('font-size')?.value).toBe('0.875rem');
    expect(win.get('font-weight')?.value).toBe('500');
    expect(rules.some((r) => r.selectors.some((s) => /^button\.(ghost|primary)-btn/.test(s)))).toBe(
      false,
    );
  });
});

describe('badge tones (DS-02 item 3, I151)', () => {
  const tone = (cls: string) => {
    const $ = load(`<div style="display:flex"><span id="t" class="${cls}">x</span></div>`);
    return cascade($, '#t', rules);
  };

  it('a bare .badge is neutral and never shrinks in a flex row', () => {
    const win = tone('badge');
    expect(win.get('color')?.value).toBe('var(--brand-muted)');
    expect(win.get('background')?.value).toBe('var(--brand-input)');
    expect(win.get('flex-shrink')?.value).toBe('0');
    for (const prop of ['color', 'background', 'border-color']) {
      expect(parseOklch(resolve(win.get(prop)?.value)).c).toBeLessThanOrEqual(0.03);
    }
  });

  it('warn is amber (the old default), info is primary, good/bad unchanged', () => {
    expect(tone('badge badge-warn').get('color')?.value).toBe('var(--brand-accent-amber)');
    expect(tone('badge badge-info').get('color')?.value).toBe('var(--brand-primary)');
    expect(tone('badge badge-good').get('color')?.value).toBe('var(--brand-status-approved)');
    expect(tone('badge badge-bad').get('color')?.value).toBe('var(--brand-status-rejected)');
  });

  it('every badge-* and window-tab-* class the app uses has a rule', () => {
    const used = new Set<string>();
    for (const file of srcFiles(/\.tsx?$/)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/(?<![\w-])(badge-[a-z][\w-]*|window-tab-[a-z][\w-]*)/g))
        used.add(m[1]!);
    }
    expect(used).toContain('badge-warn');
    expect(used).toContain('window-tab-active');
    const defined = (cls: string) =>
      rules.some((r) => r.selectors.some((s) => new RegExp(`\\.${cls}(?![\\w-])`).test(s)));
    expect([...used].filter((cls) => !defined(cls))).toEqual([]);
  });

  it('the active window tab is highlighted', () => {
    const $ = load(
      `<nav class="window-tabs"><a id="t" class="window-tab window-tab-active" href="#">Inbox</a></nav>`,
    );
    expect(styleOf($, '#t', rules, 'background')).toBe('var(--brand-primary)');
    expect(styleOf($, '#t', rules, 'color')).toBe('var(--brand-primary-foreground)');
  });

  it('support threads: open is info (customer) / warn (admin inbox), closed is neutral', () => {
    const cls = (status: string, audience: SupportBadgeAudience) =>
      load(renderToStaticMarkup(createElement(SupportStatusBadge, { status, audience })))(
        'span',
      ).attr('class');
    expect(cls('open', 'customer')).toBe('badge badge-info');
    expect(cls('open', 'admin')).toBe('badge badge-warn');
    expect(cls('closed', 'customer')).toBe('badge');
    expect(cls('closed', 'admin')).toBe('badge');
    // ...and open and closed really look different now.
    const neutral = tone('badge').get('color')?.value;
    expect(tone('badge badge-info').get('color')?.value).not.toBe(neutral);
    expect(tone('badge badge-warn').get('color')?.value).not.toBe(neutral);
  });

  it('the four support pages render the thread status through SupportStatusBadge', () => {
    const pages: Record<string, SupportBadgeAudience> = {
      'src/app/(app)/support/page.tsx': 'customer',
      'src/app/(app)/support/[id]/page.tsx': 'customer',
      'src/app/admin/support/page.tsx': 'admin',
      'src/app/admin/support/[id]/page.tsx': 'admin',
    };
    for (const [file, audience] of Object.entries(pages)) {
      const src = readFileSync(path.resolve(process.cwd(), file), 'utf8');
      expect(src, file).toMatch(
        new RegExp(`<SupportStatusBadge status=\\{\\w+\\.status\\} audience="${audience}" />`),
      );
    }
  });

  it('no status ternary uses the (now neutral) bare badge as its highlighted branch', () => {
    const offenders: string[] = [];
    for (const file of srcFiles(/\.tsx$/)) {
      const src = readFileSync(file, 'utf8');
      if (/\? ['"]badge['"] :/.test(src)) offenders.push(path.relative(process.cwd(), file));
    }
    expect(offenders).toEqual([]);
  });

  // DS-09 moved HintBadge onto the Badge primitive: the tone is a
  // data-tone from the meaning map (src/lib/ui/tone.ts), not a class.
  const sample: Record<HintSeverity, string> = {
    info: 'info',
    action: 'attention',
    warning: 'attention',
    critical: 'danger',
    success: 'success',
    note: 'neutral',
  };
  for (const [severity, tone] of Object.entries(sample) as Array<[HintSeverity, string]>) {
    it(`HintBadge renders ${severity} in the ${tone} tone`, () => {
      const html = renderToStaticMarkup(
        createElement(HintBadge, { hint: { type: 't', severity, text: 'x' } }),
      );
      expect(load(html)('[data-tone]').first().attr('data-tone')).toBe(tone);
    });
  }
});

describe('bare-only section cards and h2s (DS-02 item 4, I149)', () => {
  it('the generic rules match bare elements only, at (0,0,1)', () => {
    expect(sectionCardRule).toBeDefined();
    expect(sectionH2Rule).toBeDefined();
    for (const sel of [...sectionCardRule!.selectors, ...sectionH2Rule!.selectors]) {
      expect(specificity(sel)).toEqual([0, 0, 1]);
    }
    expect(rules.some((r) => r.selectors.some((s) => /^main (section|h2)$/.test(s)))).toBe(false);
  });

  const $ = load(`
    <main class="app-main">
      <section id="bare"><h2 id="bare-h2">Sources</h2></section>
      <section id="grid" class="cockpit-grid"><h2 id="classed-h2" class="section-title">Today's signals</h2></section>
      <section id="research" class="lead-research"><h2 id="research-h2">Research</h2></section>
      <section id="plc" class="profile-list-card"><h2 id="plc-h2">Lead context</h2></section>
      <section id="admin" class="connector-admin-section"><h2 id="admin-h2">Admin: other connector instances</h2></section>
    </main>
    <div><section id="outside"></section></div>`);

  it('bare sections are cards; classed grids are not; opt-in cards stay cards', () => {
    expect(styleOf($, '#bare', rules, 'background')).toBe('var(--brand-card)');
    expect(styleOf($, '#bare', rules, 'box-shadow')).toBe('var(--brand-shadow)');
    expect(styleOf($, '#grid', rules, 'background')).toBeUndefined();
    expect(styleOf($, '#grid', rules, 'box-shadow')).toBeUndefined();
    expect(styleOf($, '#research', rules, 'background')).toBe('var(--brand-card)');
    expect(styleOf($, '#plc', rules, 'background')).toBe('var(--brand-card)');
    expect(styleOf($, '#outside', rules, 'background')).toBeUndefined();
  });

  it('contextual h2 rules keep winning; classed h2s lose the mono label style', () => {
    expect(styleOf($, '#bare-h2', rules, 'font-family')).toBe('var(--brand-mono)');
    expect(styleOf($, '#bare-h2', rules, 'text-transform')).toBe('uppercase');
    expect(styleOf($, '#classed-h2', rules, 'font-family')).toBeUndefined();
    expect(styleOf($, '#classed-h2', rules, 'text-transform')).toBeUndefined();
    expect(styleOf($, '#classed-h2', rules, 'font-size')).toBe('1.15rem');
    // The unclassed h2 inside .lead-research keeps its contextual size + layout.
    expect(styleOf($, '#research-h2', rules, 'font-size')).toBe('0.8rem');
    expect(styleOf($, '#research-h2', rules, 'display')).toBe('inline-flex');
    expect(styleOf($, '#admin-h2', rules, 'font-size')).toBe('0.92rem');
  });

  it('no classed <section>/<h2> anywhere in the app picks up the generic rules', () => {
    const OPT_IN = new Set(['profile-list-card', 'lead-research']);
    const sectionClasses = new Set<string>();
    const h2Classes = new Set<string>();
    for (const file of srcFiles(/\.tsx$/)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<(section|h2)\b[^>]*?className="([^"]+)"/g)) {
        const first = m[2]!.split(/\s+/)[0]!;
        (m[1] === 'section' ? sectionClasses : h2Classes).add(first);
      }
    }
    expect(sectionClasses.size).toBeGreaterThan(10);
    expect(h2Classes.size).toBeGreaterThan(5);
    const from = (html: string, prop: string): CssRule | undefined =>
      cascade(load(html), '#t', rules).get(prop)?.rule;
    for (const cls of sectionClasses) {
      const rule = from(`<main><section id="t" class="${cls}"></section></main>`, 'box-shadow');
      if (OPT_IN.has(cls)) expect(rule, cls).toBe(sectionCardRule);
      else expect(rule, cls).not.toBe(sectionCardRule);
    }
    for (const cls of h2Classes) {
      expect(from(`<main><h2 id="t" class="${cls}">x</h2></main>`, 'font-family'), cls).not.toBe(
        sectionH2Rule,
      );
    }
  });
});

describe('EmptyState on the dark theme (DS-02 item 5, I150)', () => {
  const html = renderToStaticMarkup(
    createElement(EmptyState, {
      title: 'No leads in this view',
      hint: 'Try widening filters above.',
      ctaLabel: 'Open leads',
      ctaHref: '/leads',
    }),
  );

  it('uses the shared .empty-state pattern, no inline colours', () => {
    const $ = load(html);
    expect($('div').first().attr('class')).toBe('empty-state');
    expect(html).not.toContain('style=');
    expect(html).not.toMatch(/oklch\(0\.(85|99) 0 0/);
    expect($('.empty-state-title').text()).toBe('No leads in this view');
    expect($('a.primary-btn').attr('href')).toBe('/leads');
  });

  it('renders dark, with a readable title and CTA', () => {
    const $ = load(`<main class="app-main"><section>${html}</section></main>`);
    $('.empty-state').attr('id', 'box');
    $('.empty-state-title').attr('id', 'title');
    $('.empty-state a').attr('id', 'cta');
    expect(styleOf($, '#box', rules, 'background')).toBe('var(--brand-card)');
    expect(styleOf($, '#box', rules, 'border-style')).toBe('dashed');
    expect(styleOf($, '#title', rules, 'color')).toBe('var(--brand-fg)');
    const cta = cascade($, '#cta', rules);
    expect(cta.get('color')?.value).toBe('var(--brand-primary-foreground)');
    expect(
      contrastRatio(resolve(cta.get('color')?.value), resolve(cta.get('background')?.value)),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe('sticky offsets below the header (DS-02 item 6, I143)', () => {
  it('--header-h drives the header height and is at least 56px', () => {
    const header = rules.find(
      (r) => r.selectorText === '.brand-header' && r.conditions.length === 0,
    );
    expect(header?.decls.find((d) => d.prop === 'height')?.value).toBe('var(--header-h)');
    expect(toPx(resolve('var(--header-h)'))).toBeGreaterThanOrEqual(56);
  });

  const cases: Array<[string, string]> = [
    ['<aside id="t" class="sidebar"></aside>', 'var(--header-h)'],
    ['<form><div id="t" class="mail-toolbar"></div></form>', 'var(--header-h)'],
    ['<form><div id="t" class="contacts-toolbar"></div></form>', 'var(--header-h)'],
    ['<aside id="t" class="mail-rail"></aside>', 'calc(var(--header-h) + 1rem)'],
    ['<aside id="t" class="signature-preview"></aside>', 'calc(var(--header-h) + 1rem)'],
  ];
  for (const [html, top] of cases) {
    it(`${/class="([^"]+)"/.exec(html)![1]} sticks at ${top}`, () => {
      const $ = load(html);
      expect(styleOf($, '#t', rules, 'position')).toBe('sticky');
      expect(styleOf($, '#t', rules, 'top')).toBe(top);
    });
  }

  it('nothing else sticks at top: 0 under the app header', () => {
    // .admin-topbar lives in AdminShell, which has no .brand-header.
    const ALLOWED = new Set(['.brand-header', '.admin-topbar']);
    const offenders = rules
      .filter((r) => r.decls.some((d) => d.prop === 'position' && d.value === 'sticky'))
      .filter((r) => !ALLOWED.has(r.selectorText))
      .filter((r) => !(r.decls.find((d) => d.prop === 'top')?.value ?? '').includes('--header-h'))
      .map((r) => `${r.selectorText} (${r.file}:${r.line})`);
    expect(offenders).toEqual([]);
  });
});

describe('focus rings and reduced motion (DS-02 item 7, I177)', () => {
  it('every outline:none either replaces the indicator or has a :focus-visible ring', () => {
    const problems: string[] = [];
    for (const r of rules) {
      if (!r.decls.some((d) => d.prop === 'outline' && d.value === 'none')) continue;
      if (r.selectors.some((s) => s.includes(':focus'))) {
        // A focus-state rule must put something visible in place of the outline.
        if (!r.decls.some((d) => ['box-shadow', 'border-color'].includes(d.prop))) {
          problems.push(`${r.selectorText} removes the focus outline with no replacement`);
        }
        continue;
      }
      for (const sel of r.selectors) {
        const owner = sel.split(/\s+/)[0]!;
        const ring = rules.find(
          (x) =>
            x.selectors.some((s) => s.startsWith(owner) && s.includes(':focus-visible')) &&
            x.decls.some((d) => d.prop === 'outline' && /solid/.test(d.value)),
        );
        if (!ring) problems.push(`${sel} has outline:none but no :focus-visible ring on ${owner}`);
      }
    }
    expect(problems).toEqual([]);
  });

  const reduced: CascadeOptions = {
    conditionMatches: (p) => /prefers-reduced-motion:\s*reduce/.test(p),
  };

  // DS-06 moved the switch from legacy (!important) to the top layer
  // (utilities.css): it still beats every legacy and component rule, and
  // Direction A keeps only a short opacity fade.
  it('reduced motion stops the hero pulse and every movement but a short fade', () => {
    const $ = load(`
      <span id="dot" class="hero-badge-dot"></span>
      <a id="cta" class="primary-btn" href="#">Go</a>
      <a id="ghost" class="ghost-btn" href="#">Back</a>
      <ul class="profile-list"><li id="row">x</li></ul>`);
    expect(styleOf($, '#dot', rules, 'animation')).toMatch(/hero-pulse/);
    expect(styleOf($, '#dot', rules, 'animation', reduced)).toBe('none');
    for (const id of ['#cta', '#ghost', '#row']) {
      expect(styleOf($, id, rules, 'transition'), id).not.toBe('none');
      expect(styleOf($, id, rules, 'transition-property'), id).toBeUndefined();
      expect(styleOf($, id, rules, 'transition-property', reduced), id).toBe('opacity');
      expect(styleOf($, id, rules, 'transition-duration', reduced), id).toBe('var(--dur-1)');
    }
    const motion = rules.filter((r) => r.conditions.some((c) => /prefers-reduced-motion/.test(c)));
    expect(motion.map((r) => r.layer)).toEqual(['utilities']);
    expect(motion.flatMap((r) => r.decls).filter((d) => d.important)).toEqual([]);
  });
});
