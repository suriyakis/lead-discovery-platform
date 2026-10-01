// DS-03: mobile overflow containment (I059, I144, I145, I146).
//
// The real globals.css runs through the test cascade (helpers/
// css-cascade.ts) at two viewport widths — 1440 (desktop) and 390 (the
// phone the audit measured) — so each check reads "at this width, this
// element ends up with that value", the way the browser decides it. The
// source scans keep the fixes from regressing: no new unwrapped table,
// no inline grid a media query can't reach. The end-to-end proof
// (scrollWidth <= 392 on every route) is e2e/smoke.spec.ts.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { TableScroll } from '@/components/TableScroll';
import { cascade, type CascadeOptions, loadGlobalsCss, parseCss } from './helpers/css-cascade';

const navigation = vi.hoisted(() => ({ pathname: '/review' }));
vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname }));

const { Sidebar, sectionStartsOpen, COMPACT_SIDEBAR_QUERY } = await import('@/components/Sidebar');

const css = loadGlobalsCss();
const rules = parseCss(css);

/** Which @media preludes hold at a viewport `width` (screen, no motion prefs). */
function atWidth(width: number): CascadeOptions {
  return {
    conditionMatches: (prelude) => {
      const body = prelude.replace(/^@media\s*/i, '');
      const tests = [...body.matchAll(/\((min|max)-width:\s*([\d.]+)(px|rem)\)/g)];
      if (tests.length === 0) return false; // prefers-reduced-motion, print, …
      return tests.every(([, kind, n, unit]) => {
        const px = Number(n) * (unit === 'rem' ? 16 : 1);
        return kind === 'max' ? width <= px : width >= px;
      });
    },
  };
}
const DESKTOP = atWidth(1440);
const PHONE = atWidth(390);

const valueAt = (html: string, target: string, prop: string, at: CascadeOptions) =>
  cascade(load(html), target, rules, at).get(prop)?.value;

function srcFiles(ext: RegExp): string[] {
  const root = path.resolve(process.cwd(), 'src');
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => ext.test(f) && !f.split(/[\\/]/).includes('tests'))
    .map((f) => path.join(root, f));
}
const rel = (f: string) => path.relative(process.cwd(), f);

describe('the app column can shrink to the viewport (DS-03 item 1)', () => {
  const shell = `<div class="app-shell"><div class="app-body" id="body"><aside class="sidebar"></aside><main class="app-main" id="main"><h1 id="h1">Title</h1></main></div></div>`;

  it('desktop keeps the 16rem sidebar; the content track has a 0 minimum', () => {
    expect(valueAt(shell, '#body', 'grid-template-columns', DESKTOP)).toBe('16rem minmax(0, 1fr)');
  });

  it('phone: one content track, still with a 0 minimum', () => {
    expect(valueAt(shell, '#body', 'grid-template-columns', PHONE)).toBe('minmax(0, 1fr)');
  });

  it('no .app-body rule uses a bare 1fr track (its auto minimum let wide content widen the page)', () => {
    for (const r of rules.filter((x) => x.selectors.includes('.app-body'))) {
      const cols = r.decls.find((d) => d.prop === 'grid-template-columns')?.value ?? '';
      expect(cols.replace(/minmax\([^)]*\)/g, ''), `line ${r.line}`).not.toMatch(/\b1fr\b/);
    }
  });

  it('.app-main has min-width: 0 and a single 1rem gutter on a phone', () => {
    expect(valueAt(shell, '#main', 'min-width', DESKTOP)).toBe('0');
    expect(valueAt(shell, '#main', 'padding', DESKTOP)).toBe('2rem 1.5rem 4rem');
    expect(valueAt(shell, '#main', 'padding', PHONE)).toBe('1.5rem 1rem 3rem');
    const wrap = `<main class="app-main"><div class="dashboard-wrap" id="w"></div></main>`;
    expect(valueAt(wrap, '#w', 'padding-right', PHONE)).toBe('0');
    expect(valueAt(wrap, '#w', 'padding-left', PHONE)).toBe('0');
    expect(valueAt(wrap, '#w', 'padding', DESKTOP)).toBe('2rem 2.25rem');
  });

  it('page titles, dd values and mailto/http links break anywhere instead of overflowing', () => {
    const html = `<main><h1 id="h1">x</h1><dl id="dl"><dt>Mail</dt><dd id="dd">a@b.c</dd></dl>
      <p><a id="mail" href="mailto:a@b.c">a@b.c</a> <a id="web" href="https://x.example">x</a> <a id="rel" href="/x">x</a></p></main>`;
    expect(valueAt(html, '#h1', 'overflow-wrap', PHONE)).toBe('anywhere');
    expect(valueAt(html, '#dd', 'overflow-wrap', PHONE)).toBe('anywhere');
    expect(valueAt(html, '#dd', 'min-width', PHONE)).toBe('0');
    expect(valueAt(html, '#dl', 'grid-template-columns', PHONE)).toBe('max-content minmax(0, 1fr)');
    expect(valueAt(html, '#mail', 'overflow-wrap', PHONE)).toBe('anywhere');
    expect(valueAt(html, '#web', 'overflow-wrap', PHONE)).toBe('anywhere');
    expect(valueAt(html, '#rel', 'overflow-wrap', PHONE)).toBeUndefined();
  });

  it('desktop keeps the definition-list sizing; long values only break if they would overflow', () => {
    const html = `<main><dl id="dl"><dt>Mail</dt><dd id="dd">a@b.c</dd></dl><a id="mail" href="mailto:a@b.c">a@b.c</a></main>`;
    // `anywhere` would shrink the column's min-content and re-wrap the
    // thread page's lead context on desktop; break-word does not.
    expect(valueAt(html, '#dl', 'grid-template-columns', DESKTOP)).toBe('max-content 1fr');
    expect(valueAt(html, '#dd', 'overflow-wrap', DESKTOP)).toBe('break-word');
    expect(valueAt(html, '#dd', 'min-width', DESKTOP)).toBeUndefined();
    expect(valueAt(html, '#mail', 'overflow-wrap', DESKTOP)).toBe('break-word');
  });
});

describe('controls and inline forms (DS-03 item 1, I146)', () => {
  it('inputs, selects and textareas never outgrow their column', () => {
    for (const tag of ['input', 'select', 'textarea']) {
      const html = `<main class="app-main"><form class="inline-form"><label><span>x</span><${tag} id="c"></${tag}></label></form></main>`;
      expect(valueAt(html, '#c', 'max-width', PHONE), tag).toBe('100%');
    }
  });

  it('.inline-form is defined once, wraps, and gives its fields a floor to wrap at', () => {
    const displayRules = rules.filter(
      (r) => r.selectors.includes('.inline-form') && r.decls.some((d) => d.prop === 'display'),
    );
    expect(displayRules.map((r) => r.line)).toHaveLength(1);
    const html = `<form class="inline-form" id="f"><label id="l"><span>Name</span><input /></label><button>Save</button></form>`;
    expect(valueAt(html, '#f', 'display', PHONE)).toBe('flex');
    expect(valueAt(html, '#f', 'flex-wrap', PHONE)).toBe('wrap');
    expect(valueAt(html, '#l', 'min-width', PHONE)).toBe('min(10rem, 100%)');
    // Desktop keeps the old sizing: a floor there wrapped compact rows
    // such as the member role form on /settings/members.
    expect(valueAt(html, '#l', 'min-width', DESKTOP)).toBeUndefined();
    expect(valueAt(html, '#l', 'flex', DESKTOP)).toBe('1');
  });

  it('review/draft decision forms stack under 600px and stay a row on desktop', () => {
    for (const cls of ['approve-form', 'reject-form']) {
      const html = `<form class="${cls}" id="f"><label><input name="reason" /></label><button id="b" type="submit">Go</button></form>`;
      expect(valueAt(html, '#f', 'flex-direction', DESKTOP), cls).toBeUndefined();
      expect(valueAt(html, '#f', 'flex-direction', PHONE), cls).toBe('column');
      expect(valueAt(html, '#f', 'align-items', PHONE), cls).toBe('stretch');
      expect(valueAt(html, '#b', 'align-self', PHONE), cls).toBe('flex-start');
    }
  });

  it('every auto-fit / auto-fill card grid caps its minimum at 100% of the container', () => {
    const grids = rules.flatMap((r) =>
      r.decls
        .filter((d) => d.prop === 'grid-template-columns' && /repeat\(auto-fi(t|ll)/.test(d.value))
        .map((d) => ({ line: r.line, value: d.value })),
    );
    expect(grids.length).toBeGreaterThan(10);
    for (const g of grids) {
      expect(g.value, `globals.css line ${g.line}`).toMatch(/minmax\(min\(100%, [\d.]+(px|rem)\), 1fr\)/);
    }
  });
});

describe('page-specific culprits found by the 390px route probe', () => {
  it('fieldsets drop the UA min-content minimum (autopilot, knowledge/new, products/autofill)', () => {
    const html = `<form class="edit-draft-form"><fieldset class="ks-kind-fields" id="fs"><label><select id="s"></select></label></fieldset></form>`;
    expect(valueAt(html, '#fs', 'min-width', PHONE)).toBe('0');
    expect(valueAt(html, '#s', 'max-width', PHONE)).toBe('100%');
  });

  it('filter-bar selects shrink inside their label (admin/audit, leads)', () => {
    const html = `<form class="leads-controls"><label id="l">Workspace <select id="s"></select></label></form>`;
    expect(valueAt(html, '#l', 'max-width', PHONE)).toBe('100%');
    expect(valueAt(html, '#s', 'min-width', PHONE)).toBe('0');
  });

  it('bulk-list rows keep their one-line ellipsis instead of widening (leads, review)', () => {
    const html = `<ul class="lead-list bulk-selectable-list"><li id="li"><p class="muted" id="p">long snippet</p></li></ul>`;
    expect(valueAt(html, '#li', 'grid-template-columns', DESKTOP)).toBe('1.5rem minmax(0, 1fr)');
    expect(valueAt(html, '#p', 'text-overflow', PHONE)).toBe('ellipsis');
  });

  it('meta rows and badges wrap long URLs / addresses (inbox, signatures)', () => {
    const meta = `<ul class="profile-list"><li><div class="meta" id="m"><span id="u">https://directory.example.it/azienda/x</span></div></li></ul>`;
    expect(valueAt(meta, '#m', 'flex-wrap', PHONE)).toBe('wrap');
    expect(valueAt(meta, '#u', 'overflow-wrap', PHONE)).toBe('anywhere');
    expect(valueAt(meta, '#u', 'min-width', PHONE)).toBe('0');
    // Desktop keeps the one-line row (/mailbox lays its meta out that way).
    expect(valueAt(meta, '#m', 'flex-wrap', DESKTOP)).toBeUndefined();
    expect(valueAt(meta, '#u', 'min-width', DESKTOP)).toBeUndefined();
    const badge = `<span class="badge" id="b">mailbox: Sales · sales@northwind-insulation.example.com</span>`;
    expect(valueAt(badge, '#b', 'max-width', PHONE)).toBe('100%');
    // break-word, not anywhere: anywhere shrinks the badge's min-content and
    // split "CANCELED" in the /admin billing table on desktop.
    expect(valueAt(badge, '#b', 'overflow-wrap', DESKTOP)).toBe('break-word');
  });

  it('the recipe editor stacks Name and the Active toggle under 600px', () => {
    const html = `<form class="recipe-form"><div class="recipe-form-grid" id="g"></div></form>`;
    expect(valueAt(html, '#g', 'grid-template-columns', DESKTOP)).toBe('1fr auto');
    expect(valueAt(html, '#g', 'grid-template-columns', PHONE)).toBe('minmax(0, 1fr)');
  });
});

describe('wide tables scroll in their own box (DS-03 item 2, I145)', () => {
  it('<TableScroll> renders a .table-scroll region named by its label', () => {
    const $ = load(
      renderToStaticMarkup(
        createElement(
          TableScroll,
          { label: 'Token ledger' },
          createElement('table', { className: 'data-table' }),
        ),
      ),
    );
    const box = $('div.table-scroll');
    expect(box).toHaveLength(1);
    expect(box.attr('role')).toBe('region');
    expect(box.attr('aria-label')).toBe('Token ledger');
    expect(box.children('table.data-table')).toHaveLength(1);
  });

  it('without a label it is a plain box; extra classes are kept', () => {
    const $ = load(
      renderToStaticMarkup(
        createElement(TableScroll, { className: 'data-table-wrap' }, createElement('table')),
      ),
    );
    const box = $('div');
    expect(box.attr('class')).toBe('table-scroll data-table-wrap');
    expect(box.attr('role')).toBeUndefined();
  });

  it('.table-scroll scrolls horizontally and never exceeds its column', () => {
    const html = `<div class="table-scroll" id="t"><table class="data-table"></table></div>`;
    expect(valueAt(html, '#t', 'overflow-x', PHONE)).toBe('auto');
    expect(valueAt(html, '#t', 'max-width', PHONE)).toBe('100%');
  });

  it('every JSX <table> in src sits inside <TableScroll> or a .data-table-wrap', () => {
    const unwrapped: string[] = [];
    let tables = 0;
    for (const file of srcFiles(/\.tsx$/)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/^[ \t]*<table\b/gm)) {
        tables++;
        const before = src.slice(0, m.index);
        const depth =
          (before.match(/<TableScroll\b/g)?.length ?? 0) - (before.match(/<\/TableScroll>/g)?.length ?? 0);
        const lastLines = before.split('\n').slice(-3).join('\n');
        if (depth <= 0 && !/data-table-wrap|table-scroll/.test(lastLines)) {
          unwrapped.push(`${rel(file)}:${before.split('\n').length}`);
        }
      }
    }
    expect(tables).toBeGreaterThanOrEqual(10);
    expect(unwrapped).toEqual([]);
  });
});

describe('settings tabs are a scroll-snap strip (DS-03 item 3)', () => {
  const html = `<nav class="settings-nav" id="nav"><a id="a" class="active" href="/settings/usage">Usage</a></nav>`;

  it('scrolls sideways inside itself, tabs keep their width', () => {
    expect(valueAt(html, '#nav', 'overflow-x', PHONE)).toBe('auto');
    expect(valueAt(html, '#nav', 'scroll-snap-type', PHONE)).toBe('x proximity');
    expect(valueAt(html, '#a', 'flex', PHONE)).toBe('0 0 auto');
    expect(valueAt(html, '#a', 'white-space', PHONE)).toBe('nowrap');
    expect(valueAt(html, '#a', 'scroll-snap-align', PHONE)).toBe('start');
  });

  it('keeps the baseline without a negative margin the scroller would clip', () => {
    expect(valueAt(html, '#nav', 'box-shadow', DESKTOP)).toBe('inset 0 -1px 0 var(--brand-border)');
    expect(valueAt(html, '#nav', 'border-bottom', DESKTOP)).toBeUndefined();
    expect(valueAt(html, '#a', 'margin-bottom', DESKTOP)).toBeUndefined();
    expect(valueAt(html, '#a', 'border-bottom', DESKTOP)).toBe('2px solid transparent');
  });

  it('draws the focus ring inside the strip', () => {
    const focus = rules.find((r) => r.selectorText === '.settings-nav a:focus-visible');
    expect(focus?.decls.find((d) => d.prop === 'outline-offset')?.value).toBe('-2px');
  });
});

describe('header fits a phone (DS-03 item 4, I144)', () => {
  const header = `<header class="brand-header" id="h"><a class="brand-link" id="brand" href="/">lead/sonar</a>
    <div class="brand-header-right" id="right">
      <label class="workspace-switcher" id="ws"><span class="workspace-switcher-icon">🏢</span><select id="sel"><option>Northwind Insulation Ltd • default — owner</option></select></label>
      <span class="who header-account-inline" id="email">demo-admin@example.com</span>
      <form class="header-account-inline" id="signout"><button class="ghost-btn">Sign out</button></form>
      <details class="header-account-menu" id="menu"><summary class="ghost-btn" id="sum">Account</summary>
        <div class="header-account-menu-panel" id="panel"><span class="who" id="pemail">demo-admin@example.com</span></div></details>
    </div></header>`;

  it('desktop: e-mail and Sign out inline, compact menu hidden, select uncapped', () => {
    expect(valueAt(header, '#email', 'display', DESKTOP)).toBeUndefined();
    expect(valueAt(header, '#signout', 'display', DESKTOP)).toBeUndefined();
    expect(valueAt(header, '#menu', 'display', DESKTOP)).toBe('none');
    expect(valueAt(header, '#sel', 'max-width', DESKTOP)).toBe('100%');
    expect(valueAt(header, '#h', 'padding', DESKTOP)).toBe('0 1.5rem');
  });

  it('phone: e-mail + Sign out fold into the menu; the select shrinks with an ellipsis', () => {
    expect(valueAt(header, '#email', 'display', PHONE)).toBe('none');
    expect(valueAt(header, '#signout', 'display', PHONE)).toBe('none');
    expect(valueAt(header, '#menu', 'display', PHONE)).toBe('block');
    expect(valueAt(header, '#panel', 'position', PHONE)).toBe('absolute');
    expect(valueAt(header, '#panel', 'max-width', PHONE)).toBe('calc(100vw - 2rem)');
    expect(valueAt(header, '#pemail', 'overflow-wrap', PHONE)).toBe('anywhere');
    expect(valueAt(header, '#sel', 'min-width', PHONE)).toBe('0');
    expect(valueAt(header, '#sel', 'max-width', PHONE)).toBe('10rem');
    expect(valueAt(header, '#sel', 'text-overflow', PHONE)).toBe('ellipsis');
    expect(valueAt(header, '#ws', 'min-width', PHONE)).toBe('0');
    expect(valueAt(header, '#h', 'padding', PHONE)).toBe('0 1rem');
  });

  it('the right slot may shrink, the brand may not', () => {
    expect(valueAt(header, '#right', 'min-width', DESKTOP)).toBe('0');
    expect(valueAt(header, '#brand', 'flex-shrink', DESKTOP)).toBe('0');
  });

  it('AppShell renders both account variants with the classes the CSS keys on', () => {
    const src = readFileSync(path.resolve(process.cwd(), 'src/components/AppShell.tsx'), 'utf8');
    expect(src).toContain('<span className="who header-account-inline">{email}</span>');
    expect(src).toContain('<form action={signOutAction} className="header-account-inline">');
    expect(src).toMatch(/<details className="header-account-menu">[\s\S]*signOutAction[\s\S]*<\/details>/);
  });
});

describe('inline grids moved to classes with single-column fallbacks (DS-03 item 5, I059)', () => {
  const grid = (cls: string) => `<div class="${cls}" id="g"><div></div><div></div></div>`;
  const cases: Array<[string, string, string, number]> = [
    // class, desktop columns, phone columns, collapse breakpoint
    ['thread-layout', 'minmax(0, 0.85fr) minmax(0, 0.85fr) minmax(0, 1.6fr)', 'minmax(0, 1fr)', 900],
    ['signatures-browse', 'minmax(0, 1fr) minmax(0, 1fr)', 'minmax(0, 1fr)', 900],
    ['provider-defaults-grid', '1fr 1fr 1fr', 'minmax(0, 1fr)', 700],
    ['thread-bilingual', '1fr 1fr', 'minmax(0, 1fr)', 600],
    ['reply-fields', '1fr 1fr', 'minmax(0, 1fr)', 600],
  ];

  for (const [cls, desktop, phone, bp] of cases) {
    it(`.${cls}: ${desktop} on desktop, one column at ${bp}px and below`, () => {
      expect(valueAt(grid(cls), '#g', 'display', DESKTOP)).toBe('grid');
      expect(valueAt(grid(cls), '#g', 'grid-template-columns', DESKTOP)).toBe(desktop);
      expect(valueAt(grid(cls), '#g', 'grid-template-columns', atWidth(bp + 1))).toBe(desktop);
      expect(valueAt(grid(cls), '#g', 'grid-template-columns', atWidth(bp))).toBe(phone);
      expect(valueAt(grid(cls), '#g', 'grid-template-columns', PHONE)).toBe(phone);
    });
  }

  it('follow-up rows: a right-hand column on desktop, full width under the subject on a phone', () => {
    const html = `<div class="lead-row followup-row" id="row"><div></div><div class="followup-row-side" id="side"></div></div>`;
    expect(valueAt(html, '#row', 'align-items', DESKTOP)).toBe('flex-start');
    expect(valueAt(html, '#row', 'flex-wrap', DESKTOP)).toBe('wrap');
    expect(valueAt(html, '#side', 'min-width', DESKTOP)).toBe('11rem');
    expect(valueAt(html, '#side', 'min-width', PHONE)).toBe('0');
    expect(valueAt(html, '#side', 'width', PHONE)).toBe('100%');
  });

  it('no component sets an inline gridTemplateColumns (media queries cannot reach it)', () => {
    const hits = srcFiles(/\.tsx$/).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (/gridTemplateColumns\s*:/.test(line) ? [`${rel(file)}:${i + 1}`] : [])),
    );
    expect(hits).toEqual([]);
  });

  it('no inline min-width wider than a phone column (15rem / 240px)', () => {
    const hits = srcFiles(/\.tsx$/).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => {
          const m = /minWidth:\s*'([\d.]+)(rem|px)'/.exec(line);
          if (!m) return [];
          const px = Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
          return px > 240 ? [`${rel(file)}:${i + 1} (${m[1]}${m[2]})`] : [];
        }),
    );
    expect(hits).toEqual([]);
  });
});

describe('platform console on a phone (DS-03 item 7, I146)', () => {
  const html = `<div class="admin-shell"><div class="admin-topbar" id="bar"></div><main class="admin-main" id="main"><div class="dashboard-wrap" id="w"><h1>Users</h1></div></main></div>`;

  it('desktop is unchanged', () => {
    expect(valueAt(html, '#main', 'padding', DESKTOP)).toBe('1.5rem');
    expect(valueAt(html, '#w', 'padding', DESKTOP)).toBe('2rem 2.25rem');
    expect(valueAt(html, '#bar', 'padding', DESKTOP)).toBe('0.6rem 1.25rem');
  });

  it('phone: one 1rem gutter instead of .admin-main + .dashboard-wrap padding', () => {
    expect(valueAt(html, '#main', 'padding', PHONE)).toBe('1rem');
    expect(valueAt(html, '#w', 'padding', PHONE)).toBe('0');
    expect(valueAt(html, '#bar', 'padding', PHONE)).toBe('0.5rem 1rem');
  });

  it('phone: the section tabs become their own scrolling row', () => {
    const bar = `<div class="admin-topbar"><span class="admin-topbar-brand">Platform console</span>
      <nav id="nav"><a class="admin-nav-link" id="l" href="/admin">Overview</a></nav>
      <a class="admin-topbar-exit" href="/dashboard">Back to app</a></div>`;
    expect(valueAt(bar, '#nav', 'flex-wrap', DESKTOP)).toBe('wrap');
    expect(valueAt(bar, '#nav', 'overflow-x', DESKTOP)).toBeUndefined();
    expect(valueAt(bar, '#nav', 'flex-wrap', PHONE)).toBe('nowrap');
    expect(valueAt(bar, '#nav', 'overflow-x', PHONE)).toBe('auto');
    expect(valueAt(bar, '#nav', 'flex', PHONE)).toBe('1 0 100%');
    expect(valueAt(bar, '#nav', 'order', PHONE)).toBe('1');
    expect(valueAt(bar, '#l', 'white-space', PHONE)).toBe('nowrap');
  });
});

describe('sidebar collapses inactive groups on a phone', () => {
  it('sectionStartsOpen: desktop keeps the defaults, compact keeps only active + Emergency', () => {
    const plain = { defaultOpen: true, emphasize: false };
    const closedByDefault = { defaultOpen: false, emphasize: false };
    const emergency = { defaultOpen: true, emphasize: true };
    expect(sectionStartsOpen(plain, false, false)).toBe(true);
    expect(sectionStartsOpen(closedByDefault, false, false)).toBe(false);
    expect(sectionStartsOpen(closedByDefault, true, false)).toBe(true);
    expect(sectionStartsOpen(plain, false, true)).toBe(false);
    expect(sectionStartsOpen(plain, true, true)).toBe(true);
    expect(sectionStartsOpen(closedByDefault, true, true)).toBe(true);
    expect(sectionStartsOpen(emergency, false, true)).toBe(true);
  });

  it('the media query matches the CSS breakpoint that stacks the sidebar', () => {
    expect(COMPACT_SIDEBAR_QUERY).toBe('(max-width: 800px)');
    expect(css).toMatch(/@media \(max-width: 800px\) \{\s*\.sidebar \{\s*position: static;/);
  });

  it('server render: desktop open state, active group marked, not yet compact-ready', () => {
    navigation.pathname = '/review';
    const $ = load(renderToStaticMarkup(createElement(Sidebar, { isSuperAdmin: true })));
    expect($('aside.sidebar').attr('data-compact-ready')).toBeUndefined();
    const groups = $('details.sidebar-group')
      .toArray()
      .map((el) => ({
        title: $(el).children('summary').text(),
        open: $(el).attr('open') !== undefined,
        active: $(el).hasClass('sidebar-group-active'),
      }));
    expect(groups.filter((g) => g.active).map((g) => g.title)).toEqual(['Discovery']);
    expect(groups.filter((g) => g.open).map((g) => g.title)).toEqual([
      'Discovery',
      'Knowledge base',
      'Pipeline',
      'Outreach',
      'Emergency',
    ]);
  });

  it('before hydration a phone already shows only the active group and Emergency', () => {
    navigation.pathname = '/settings/usage';
    const html = renderToStaticMarkup(createElement(Sidebar, { isSuperAdmin: true }));
    const $ = load(html);
    const visible = (at: CascadeOptions) =>
      $('details.sidebar-group')
        .toArray()
        .filter((el) => $(el).attr('open') !== undefined)
        .map((el) => $(el).children('summary').text())
        .filter((title) => {
          const id = `list-${title.replace(/\W+/g, '-')}`;
          $(`details.sidebar-group:has(> summary:contains("${title}")) > ul.sidebar-list`).attr('id', id);
          return cascade($, `#${id}`, rules, at).get('display')?.value !== 'none';
        });
    expect(visible(DESKTOP)).toEqual(['Discovery', 'Knowledge base', 'Pipeline', 'Outreach', 'Workspace', 'Emergency']);
    expect(visible(PHONE)).toEqual(['Workspace', 'Emergency']);
    // Once Sidebar's effect has run, the CSS stands down and <details> rules.
    $('aside.sidebar').attr('data-compact-ready', '');
    expect(visible(PHONE)).toEqual(['Discovery', 'Knowledge base', 'Pipeline', 'Outreach', 'Workspace', 'Emergency']);
  });
});
