// DS-05 (absorbing AP-03 and ia:F-10): one navigation registry drives the
// Sidebar, the area tabs and Settings sub-nav, Cmd-K, the Platform
// console nav, the mobile tab bar and the route table. These tests pin
// the registry against the real src/app tree and render the navigation
// components to prove they read it and agree with each other.
//
// No database: pure data checks plus react-dom/server renders with a
// stubbed next/navigation.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from 'cheerio';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { appRouteFiles, appRoutePatterns, SEEDED_PATHS } from '../../e2e/routes';
import {
  ACCOUNT_MENU,
  DETAIL_ROUTES,
  HOME_PATH,
  INTERIM_EMERGENCY_STOP,
  MOBILE_TAB_BAR,
  NAV_ACTIONS,
  NAV_AREAS,
  NAV_GROUPS,
  UNLISTED_ROUTES,
} from '@/lib/nav/registry';
import {
  areaById,
  areaHref,
  detailPatternRegExp,
  hasNavCapability,
  paletteRoutes,
  resolveNavCount,
  resolveNavLocation,
  sidebarAreas,
  splitHref,
  tabById,
  type NavViewer,
} from '@/lib/nav/resolve';
import { routeTable } from '@/lib/nav/route-table';
import { LEGACY_REDIRECTS, legacyRedirectTarget } from '@/lib/nav/redirects';
import {
  canAdminWorkspace,
  canRead,
  canWrite,
  WORKSPACE_ROLES,
  type WorkspaceRole,
} from '@/lib/services/context';

const nav = vi.hoisted(() => ({ pathname: '/today', search: '' }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({
    push() {},
    replace() {},
    refresh() {},
    prefetch() {},
    back() {},
    forward() {},
  }),
}));

const { Sidebar } = await import('@/components/Sidebar');
const { CommandPalette, rankPaletteResults } = await import('@/components/CommandPalette');
const { AdminShell } = await import('@/components/AdminShell');
const { AreaFrameView } = await import('@/components/AreaNav');
const { BrandHeader } = await import('@/components/BrandHeader');

const PATTERNS = appRoutePatterns();
// Route pattern → page file (the workspace pages sit in the (app) route
// group, DS-07, so a URL is not a file path).
const PAGE_FILES = appRouteFiles();
const pageFile = (pattern: string) => {
  const file = PAGE_FILES.get(pattern);
  if (!file) throw new Error(`no page file for ${pattern}`);
  return file;
};

const MEMBER: NavViewer = { role: 'member', isSuperAdmin: false };
const VIEWER: NavViewer = { role: 'viewer', isSuperAdmin: false };
const ADMIN: NavViewer = { role: 'admin', isSuperAdmin: false };
const SUPER: NavViewer = { role: 'super_admin', isSuperAdmin: true };

const noEntities = async () => [];

/** Tab patterns: the pathname of every tab href. */
const tabPatterns = () => NAV_AREAS.flatMap((a) => a.tabs.map((t) => splitHref(t.href).pathname));

/** "/review/[id]" or "/review" → the app pattern it is (or matches). */
function patternFor(pathname: string): string | undefined {
  return PATTERNS.find((p) => detailPatternRegExp(p).test(pathname));
}

function renderSidebar(viewer: NavViewer, pathname = '/today') {
  nav.pathname = pathname;
  return load(
    renderToStaticMarkup(
      createElement(Sidebar, { isSuperAdmin: viewer.isSuperAdmin, role: viewer.role }),
    ),
  );
}

/** The sidebar's area links: where each goes and what it says. */
function sidebarItems($: ReturnType<typeof load>) {
  return $('aside.sidebar a[data-area]')
    .toArray()
    .map((el) => ({ href: $(el).attr('href')!, label: $(el).find('.sidebar-link-label').text() }));
}

function renderPalette(viewer: NavViewer) {
  return load(
    renderToStaticMarkup(
      createElement(CommandPalette, {
        fetchEntities: noEntities,
        isSuperAdmin: viewer.isSuperAdmin,
        role: viewer.role,
        defaultOpen: true,
      }),
    ),
  );
}

function renderArea(pathname: string, viewer: NavViewer = ADMIN, search = '') {
  nav.pathname = pathname;
  return load(
    renderToStaticMarkup(
      createElement(AreaFrameView, { viewer, search }, createElement('h1', null, 'Page')),
    ),
  );
}

/** Every element of a React tree, depth first (function components are not called). */
function* walk(node: ReactNode): Generator<React.ReactElement> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (!isValidElement(node)) return;
  yield node;
  yield* walk((node.props as { children?: ReactNode }).children);
}

// ---- the registry against src/app ---------------------------------------

describe('navigation registry ↔ src/app (DS-05, AP-03 b/c, ia:F-10)', () => {
  it('every page.tsx is registered exactly once: an area tab, a detail route, or unlisted with a reason', () => {
    const tabs = new Set(tabPatterns());
    const problems: string[] = [];
    for (const p of PATTERNS) {
      const homes = [
        tabs.has(p) ? 'tab' : null,
        p in DETAIL_ROUTES ? 'detail' : null,
        p in UNLISTED_ROUTES ? 'unlisted' : null,
      ].filter(Boolean);
      if (homes.length !== 1) problems.push(`${p}: ${homes.join('+') || 'not registered'}`);
    }
    expect(problems).toEqual([]);
    for (const [p, reason] of Object.entries(UNLISTED_ROUTES)) {
      expect(reason.length, `${p} needs a reason`).toBeGreaterThan(20);
    }
  });

  it('a new page without a registry entry fails the check', () => {
    const withNewPage = [...PATTERNS, '/brand-new-page'];
    const tabs = new Set(tabPatterns());
    const unregistered = withNewPage.filter(
      (p) => !tabs.has(p) && !(p in DETAIL_ROUTES) && !(p in UNLISTED_ROUTES),
    );
    expect(unregistered).toEqual(['/brand-new-page']);
  });

  it('every registry href, detail route and unlisted entry resolves to a page file', () => {
    const hrefs = [
      ...NAV_AREAS.flatMap((a) => a.tabs.map((t) => t.href)),
      ...NAV_ACTIONS.map((a) => a.href),
      INTERIM_EMERGENCY_STOP.href,
    ];
    for (const href of hrefs) {
      const { pathname } = splitHref(href);
      expect(PATTERNS, `${href} has no page`).toContain(pathname);
    }
    for (const p of [...Object.keys(DETAIL_ROUTES), ...Object.keys(UNLISTED_ROUTES)]) {
      expect(PATTERNS, `${p} has no page`).toContain(p);
    }
    for (const d of Object.values(DETAIL_ROUTES)) {
      if (d.openedFrom) expect(PATTERNS).toContain(d.openedFrom);
      expect(() => areaById(d.area)).not.toThrow();
      if (d.tab) expect(tabById(d.tab).area.id).toBe(d.area);
    }
  });

  it('a dynamic detail page says which list it is opened from', () => {
    for (const [p, d] of Object.entries(DETAIL_ROUTES)) {
      if (p.includes('[')) expect(d.openedFrom, p).toBeTruthy();
    }
  });

  it('each href has exactly one label', () => {
    const labels = new Map<string, Set<string>>();
    const add = (href: string, label: string) =>
      labels.set(href, (labels.get(href) ?? new Set()).add(label));
    for (const a of NAV_AREAS) for (const t of a.tabs) add(t.href, t.label);
    for (const a of NAV_ACTIONS) add(a.href, a.label);
    for (const [p, d] of Object.entries(DETAIL_ROUTES)) if (!p.includes('[')) add(p, d.label);
    const clashes = [...labels].filter(([, set]) => set.size > 1);
    expect(clashes).toEqual([]);
    // …and no href is registered twice as a tab.
    const tabHrefs = NAV_AREAS.flatMap((a) => a.tabs.map((t) => t.href));
    expect(new Set(tabHrefs).size).toBe(tabHrefs.length);
    // Cmd-K lists each href once, for every kind of viewer.
    for (const viewer of [VIEWER, MEMBER, ADMIN, SUPER]) {
      const hrefs = paletteRoutes(viewer).map((r) => r.href);
      expect(new Set(hrefs).size, viewer.role ?? 'none').toBe(hrefs.length);
    }
  });

  it('every superAdminOnly entry is under /admin, and every /admin page is super-admin only', () => {
    for (const a of NAV_AREAS.filter((x) => x.superAdminOnly)) {
      for (const t of a.tabs) expect(t.href.startsWith('/admin'), t.href).toBe(true);
    }
    for (const [p, d] of Object.entries(DETAIL_ROUTES)) {
      if (areaById(d.area).superAdminOnly) expect(p.startsWith('/admin'), p).toBe(true);
    }
    for (const p of PATTERNS.filter((x) => x.startsWith('/admin'))) {
      const loc = resolveNavLocation(p.replace(/\[[^\]]+\]/g, '1'));
      expect(loc?.area.superAdminOnly, p).toBe(true);
    }
  });

  it('the IA: Today + 8 areas in 3 groups + the Platform console', () => {
    expect(NAV_GROUPS.map((g) => g.heading)).toEqual([
      null,
      'Work',
      'Build',
      'Workspace',
      'Platform',
    ]);
    const byGroup = (g: string) =>
      sidebarAreas(SUPER)
        .filter((a) => a.group === g)
        .map((a) => a.label);
    expect(byGroup('today')).toEqual(['Today']);
    expect(byGroup('work')).toEqual(['Review', 'Pipeline', 'Outreach', 'Conversations']);
    expect(byGroup('build')).toEqual(['Discovery', 'Products']);
    expect(byGroup('workspace')).toEqual(['Settings']);
    expect(byGroup('platform')).toEqual(['Platform console']);
    expect(areaHref(areaById('today'))).toBe(HOME_PATH);
    expect(HOME_PATH).toBe('/today');
  });

  it('the mobile tab bar has 5 items: Today, Review, Outreach, Conversations, More', () => {
    expect(MOBILE_TAB_BAR).toHaveLength(5);
    expect(
      MOBILE_TAB_BAR.map((i) => (i.kind === 'area' ? areaById(i.area).label : i.label)),
    ).toEqual(['Today', 'Review', 'Outreach', 'Conversations', 'More']);
  });

  it('the account menu holds My account and Help & support', () => {
    expect(ACCOUNT_MENU.map((id) => tabById(id).tab.label)).toEqual([
      'My account',
      'Help & support',
    ]);
  });

  it('the generated route table has one row per registered page, in nav order', () => {
    const rows = routeTable();
    const patterns = new Set(rows.map((r) => r.pattern));
    const registered = PATTERNS.filter((p) => !(p in UNLISTED_ROUTES));
    expect([...patterns].sort()).toEqual([...registered].sort());
    expect(rows[0]!.href).toBe(HOME_PATH);
    expect(rows.at(-1)!.areaId).toBe('console');
  });
});

// ---- locations ------------------------------------------------------------

describe('resolveNavLocation', () => {
  it.each([
    ['/today', '', 'today', 'today.needs'],
    ['/today', 'view=overview', 'today', 'today.overview'],
    ['/today', 'tab=drafts', 'today', 'today.needs'],
    ['/notifications', '', 'today', 'today.activity'],
    ['/onboarding', '', 'today', 'today.needs'],
    ['/review', '', 'review', 'review.queue'],
    ['/review/8', '', 'review', 'review.queue'],
    ['/leads', '', 'review', 'review.byProduct'],
    ['/contacts/1', '', 'pipeline', 'pipeline.contacts'],
    ['/communication', '', 'conversations', 'conversations.threads'],
    ['/communication/follow-ups', '', 'outreach', 'outreach.followUps'],
    ['/communication/7', '', 'conversations', 'conversations.threads'],
    ['/mailbox/queue', '', 'outreach', 'outreach.queue'],
    ['/mailbox/1/compose', '', 'conversations', 'conversations.threads'],
    ['/mailbox/1', '', 'settings', 'settings.mailboxes'],
    ['/connectors/new', '', 'discovery', 'discovery.searches'],
    ['/connectors/engine', '', 'discovery', 'discovery.schedules'],
    ['/connectors/1/runs/1', '', 'discovery', 'discovery.searches'],
    ['/products/autofill', '', 'products', 'products.list'],
    ['/support/1', '', 'support', 'support.threads'],
    ['/admin', '', 'console', 'console.overview'],
    ['/admin/workspaces/3', '', 'console', 'console.workspaces'],
  ])('%s?%s → %s / %s', (pathname, search, area, tab) => {
    const loc = resolveNavLocation(pathname, search);
    expect(loc?.area.id).toBe(area);
    expect(loc?.tab?.id).toBe(tab);
  });

  it('pages outside the app areas have no location', () => {
    expect(resolveNavLocation('/')).toBeNull();
    expect(resolveNavLocation('/pending')).toBeNull();
  });
});

// ---- capabilities -----------------------------------------------------------

describe('nav capabilities follow the service role matrix (services/context.ts)', () => {
  const ctx = (role: WorkspaceRole) => ({ workspaceId: 1n, userId: 'u', role });

  it.each(WORKSPACE_ROLES)(
    '%s: write and admin entries show exactly when the page allows',
    (role) => {
      const viewer: NavViewer = { role, isSuperAdmin: false };
      expect(hasNavCapability('read', viewer)).toBe(canRead(ctx(role)));
      expect(hasNavCapability('write', viewer)).toBe(canWrite(ctx(role)));
      expect(hasNavCapability('admin', viewer)).toBe(canAdminWorkspace(ctx(role)));
    },
  );

  it('the loop covers every role (pnpm typecheck fails when one is missing)', () => {
    expectTypeOf<Exclude<WorkspaceRole, (typeof WORKSPACE_ROLES)[number]>>().toEqualTypeOf<never>();
    expect(new Set(WORKSPACE_ROLES).size).toBe(WORKSPACE_ROLES.length);
  });

  it('a viewer with no workspace sees read entries only; a super-admin sees everything', () => {
    const none: NavViewer = { role: null, isSuperAdmin: false };
    expect(hasNavCapability('read', none)).toBe(true);
    expect(hasNavCapability('write', none)).toBe(false);
    expect(hasNavCapability('admin', none)).toBe(false);
    for (const cap of ['read', 'write', 'admin'] as const)
      expect(hasNavCapability(cap, { role: null, isSuperAdmin: true })).toBe(true);
  });
});

// ---- count policy ---------------------------------------------------------

describe('count gates are data (DS-05 item 4)', () => {
  const review = areaById('review').count;
  const outreach = areaById('outreach').count;
  const replies = areaById('conversations').count;

  it('prod-shaped: 310 untouched "new" records give a neutral Review count', () => {
    const c = resolveNavCount(review, { reviewPending: 310, reviewNeedsReview: 0 });
    expect(c).toMatchObject({ value: 310, text: '99+', tone: 'neutral' });
    expect(c!.label).toBe('310 records waiting for review');
  });

  it('with needs_review > 0 the Review count takes the attention tone', () => {
    expect(resolveNavCount(review, { reviewPending: 311, reviewNeedsReview: 1 })?.tone).toBe(
      'attention',
    );
  });

  it('Conversations shows no count while its gate (I084) is unmet', () => {
    expect(replies?.gate).toMatchObject({ kind: 'blocked', until: 'I084' });
    expect(resolveNavCount(replies, { repliesUnhandled: 12 })).toBeNull();
  });

  it('drafts and follow-ups awaiting approval are a decision: attention', () => {
    expect(resolveNavCount(outreach, { outreachPending: 1 })?.tone).toBe('attention');
  });

  it('zero, unknown or missing values render no badge', () => {
    expect(resolveNavCount(outreach, { outreachPending: 0 })).toBeNull();
    expect(resolveNavCount(outreach, { outreachPending: null })).toBeNull();
    expect(resolveNavCount(outreach, {})).toBeNull();
    expect(resolveNavCount(undefined, { outreachPending: 3 })).toBeNull();
  });
});

// ---- rendered navigation --------------------------------------------------

describe('Sidebar renders the registry', () => {
  const items = sidebarItems;

  it('8 items for a workspace member, 9 for a super-admin', () => {
    expect(items(renderSidebar(MEMBER))).toHaveLength(8);
    expect(items(renderSidebar(VIEWER))).toHaveLength(8);
    expect(items(renderSidebar(SUPER))).toHaveLength(9);
    expect(items(renderSidebar(SUPER)).at(-1)).toEqual({
      href: '/admin',
      label: 'Platform console',
    });
  });

  it('shows the group headings as static labels, not accordions', () => {
    const $ = renderSidebar(SUPER);
    expect(
      $('.sidebar-heading')
        .toArray()
        .map((el) => $(el).text()),
    ).toEqual(['Work', 'Build', 'Workspace', 'Platform']);
    expect($('details, summary')).toHaveLength(0);
  });

  it('marks the area of the current page, detail pages included', () => {
    for (const [pathname, area] of [
      ['/review/8', 'review'],
      ['/mailbox/queue', 'outreach'],
      ['/autopilot', 'settings'],
      ['/today', 'today'],
    ] as const) {
      const $ = renderSidebar(MEMBER, pathname);
      expect($('a[aria-current="page"]').attr('data-area'), pathname).toBe(area);
      expect($('a.active')).toHaveLength(1);
    }
  });

  it('carries no wordmark: the brand header shows it once per page (I139)', () => {
    nav.pathname = '/today';
    const html = renderToStaticMarkup(
      createElement('div', null, [
        createElement(BrandHeader, { key: 'h' }),
        createElement(Sidebar, { key: 's', isSuperAdmin: true, role: 'super_admin' }),
      ]),
    );
    expect(html.match(/data-brand-wordmark/g)).toHaveLength(1);
    expect(html.match(/data-brand-mark/g)).toHaveLength(1);
    expect(renderSidebar(SUPER).html()).not.toMatch(/sonar|data-brand-/);
  });

  it('pins the interim Emergency stop for every write role, opening the workspace pause (PC-05)', () => {
    for (const viewer of [
      MEMBER,
      ADMIN,
      { role: 'owner', isSuperAdmin: false } as NavViewer,
      SUPER,
    ]) {
      const $ = renderSidebar(viewer);
      const stop = $('.sidebar-foot a.sidebar-stop');
      expect(stop.attr('href')).toBe('/mailbox/queue#pause');
      expect(stop.text()).toContain('Emergency stop');
      expect(stop.text()).toContain('Pauses all automation');
      expect(stop.attr('data-interim')).toBe('ia:F-18');
    }
    expect(renderSidebar(VIEWER)('.sidebar-stop')).toHaveLength(0);
  });

  it('the Inbox Bell icon is gone; Today uses the House icon', () => {
    expect(areaById('today').icon).toBe('House');
    expect(renderSidebar(MEMBER).html()).not.toContain('lucide-bell');
  });
});

describe('nothing the old sidebar linked was lost (AP-03, explicit diff)', () => {
  /** The sidebar before DS-05 (Sidebar.tsx SECTIONS + PINNED), as shipped in Phase 0. */
  const OLD_SIDEBAR = [
    '/inbox',
    '/dashboard',
    '/connectors/engine',
    '/connectors',
    '/review',
    '/leads',
    '/products',
    '/knowledge',
    '/documents',
    '/learning',
    '/pipeline',
    '/contacts',
    '/drafts',
    '/communication',
    '/mailbox',
    '/mailbox/queue',
    '/mailbox/signatures',
    '/mailbox/suppression',
    '/mailbox/deliverability',
    '/settings/outreach',
    '/settings/members',
    '/settings/integrations',
    '/settings/crm',
    '/settings/usage',
    '/settings/billing',
    '/settings/audit',
    '/settings/account',
    '/support',
    '/autopilot',
    '/admin',
  ];
  /** Where each one lives now; anything not listed is a sidebar item itself. */
  const NOW: Record<string, string> = {
    '/inbox': 'redirect → Today',
    '/dashboard': 'redirect → Today › Overview',
    '/settings/account': 'account menu + Settings › You',
    '/support': 'account menu',
  };
  /** Deliberate additions reachable from the navigation that the old sidebar lacked. */
  const ADDED = ['/today', '/notifications', '/health'];

  it('every old sidebar link is a sidebar item, an area tab, an account-menu entry or a redirect', () => {
    const sidebarHrefs = new Set(sidebarAreas(SUPER).map(areaHref));
    const tabHrefs = new Set(NAV_AREAS.flatMap((a) => a.tabs.map((t) => t.href)));
    const menuHrefs = new Set(ACCOUNT_MENU.map((id) => tabById(id).tab.href));
    const redirected = new Set(LEGACY_REDIRECTS.map((r) => r.from));
    const lost = OLD_SIDEBAR.filter(
      (href) =>
        !sidebarHrefs.has(href) &&
        !tabHrefs.has(href) &&
        !menuHrefs.has(href) &&
        !redirected.has(href),
    );
    expect(lost).toEqual([]);
    for (const href of Object.keys(NOW)) {
      expect(sidebarHrefs.has(href), `${href} is ${NOW[href]}, not a sidebar item`).toBe(false);
    }
    expect(menuHrefs).toEqual(new Set(['/settings/account', '/support']));
  });

  it('the additions are reachable too (Health and Notifications were in no navigation)', () => {
    for (const href of ADDED) {
      expect(
        NAV_AREAS.some((a) => a.tabs.some((t) => t.href === href)),
        href,
      ).toBe(true);
      expect(
        paletteRoutes(MEMBER).some((r) => r.href === href),
        href,
      ).toBe(true);
    }
  });
});

describe('Cmd-K renders the registry (I082, I171)', () => {
  const entries = ($: ReturnType<typeof load>) =>
    $('li.cmdk-item')
      .toArray()
      .map((el) => ({
        href: $(el).attr('data-href')!,
        label: $(el).find('.cmdk-item-label').text(),
      }));

  it('Sidebar and CommandPalette produce the same labels for the same pages', () => {
    for (const viewer of [MEMBER, ADMIN, SUPER]) {
      const sidebar = sidebarItems(renderSidebar(viewer));
      expect(sidebar.length).toBeGreaterThanOrEqual(8);
      const palette = entries(renderPalette(viewer));
      for (const item of sidebar) {
        expect(palette, `${viewer.role}: ${item.label}`).toContainEqual(item);
      }
    }
  });

  it('every Cmd-K route is a registered page, and nothing else is listed', () => {
    const registered = new Set([
      ...NAV_AREAS.flatMap((a) => a.tabs.map((t) => t.href)),
      ...NAV_ACTIONS.map((a) => a.href),
    ]);
    for (const e of entries(renderPalette(SUPER))) expect(registered).toContain(e.href);
  });

  const top = (viewer: NavViewer, q: string) =>
    rankPaletteResults(
      paletteRoutes(viewer).map((r) => ({ ...r, description: r.sub, sub: undefined })),
      q,
    ).map((r) => r.href);

  it('finds Support, Health and Notifications', () => {
    expect(top(MEMBER, 'support')[0]).toBe('/support');
    expect(top(MEMBER, 'health')).toContain('/health');
    expect(top(MEMBER, 'notifications')[0]).toBe('/notifications');
  });

  it('finds Providers and the support inbox for a super-admin only', () => {
    expect(top(SUPER, 'providers')[0]).toBe('/admin/providers');
    expect(top(SUPER, 'support')).toContain('/admin/support');
    expect(top(MEMBER, 'providers')).not.toContain('/admin/providers');
    expect(paletteRoutes(MEMBER).some((r) => r.href.startsWith('/admin'))).toBe(false);
  });

  it('old names still find the renamed pages', () => {
    expect(top(MEMBER, 'crawl engine')[0]).toBe('/connectors/engine');
    expect(top(MEMBER, 'inbox')[0]).toBe('/today');
    expect(top(MEMBER, 'dashboard')[0]).toBe('/today?view=overview');
    expect(top(MEMBER, 'learning memory')[0]).toBe('/learning');
  });

  it('has its actions, admin-only ones only for admins', () => {
    const labels = (viewer: NavViewer) =>
      paletteRoutes(viewer)
        .filter((r) => r.group === 'Actions')
        .map((r) => r.label);
    expect(labels(ADMIN)).toEqual([
      'Emergency stop',
      'Add a teammate',
      'New product',
      'New search source',
    ]);
    // PC-05: any write role may pause, so members get the Emergency stop.
    expect(labels(MEMBER)).toEqual(['Emergency stop', 'New product', 'New search source']);
    expect(labels(VIEWER)).toEqual([]);
  });

  it('opens in the Platform console too, with a visible Search button', () => {
    nav.pathname = '/admin/users';
    const tree = AdminShell({ children: null, supportUnread: 2, fetchEntities: noEntities });
    const types = [...walk(tree)].map((el) => el.type);
    expect(types).toContain(CommandPalette);
    const $ = load(renderToStaticMarkup(tree));
    expect($('[data-command-palette-trigger]')).toHaveLength(1);
    // The console nav is the registry's console area, current tab marked.
    expect(
      $('.admin-topbar nav a')
        .toArray()
        .map((el) => $(el).attr('href')),
    ).toEqual(areaById('console').tabs.map((t) => t.href));
    expect($('.admin-topbar nav a[aria-current="page"]').attr('data-tab')).toBe('console.users');
    expect($('.admin-topbar nav a[data-tab="console.support"] .nav-count').text()).toContain('2');
    expect($('.admin-topbar-exit').attr('href')).toBe(HOME_PATH);
  });
});

describe("AreaNav: area tabs and the Settings sub-nav on today's URLs", () => {
  /** Every Settings page, and the item that must be current on it. */
  const SETTINGS_PAGES: Record<string, string> = {
    '/settings/members': 'settings.members',
    '/settings/billing': 'settings.billing',
    '/settings/usage': 'settings.usage',
    '/settings/audit': 'settings.audit',
    '/settings/outreach': 'settings.outreach',
    '/settings/integrations': 'settings.integrations',
    '/settings/crm': 'settings.crm',
    '/settings/crm/new': 'settings.crm',
    '/settings/crm/[id]': 'settings.crm',
    '/settings/account': 'settings.account',
    '/mailbox': 'settings.mailboxes',
    '/mailbox/new': 'settings.mailboxes',
    '/mailbox/[id]': 'settings.mailboxes',
    '/mailbox/[id]/edit': 'settings.mailboxes',
    '/mailbox/[id]/test': 'settings.mailboxes',
    '/mailbox/signatures': 'settings.signatures',
    '/mailbox/suppression': 'settings.suppression',
    '/autopilot': 'settings.autopilot',
    '/health': 'settings.health',
  };
  /**
   * Pages under those prefixes that deliberately live in another area
   * (docs/design/IA.md sitemap), and the redirect stubs.
   */
  const ELSEWHERE: Record<string, string> = {
    '/mailbox/queue': 'outreach',
    '/mailbox/deliverability': 'outreach',
    '/mailbox/[id]/compose': 'conversations',
    '/mailbox/threads/[id]': 'unlisted: redirect to the thread',
    '/settings': 'unlisted: redirect stub',
  };

  it('the table covers every page under /settings, /mailbox, /autopilot and /health', () => {
    const under = PATTERNS.filter((p) => /^\/(settings|mailbox|autopilot|health)(\/|$)/.test(p));
    expect([...Object.keys(SETTINGS_PAGES), ...Object.keys(ELSEWHERE)].sort()).toEqual(
      under.sort(),
    );
  });

  it.each(Object.entries(SETTINGS_PAGES))(
    '%s renders the Settings sub-nav with %s current',
    (pattern, tab) => {
      const pathname = SEEDED_PATHS[pattern] ?? pattern;
      const $ = renderArea(pathname);
      expect($('nav.area-subnav')).toHaveLength(1);
      expect($('nav.area-subnav a[aria-current="page"]').attr('data-tab')).toBe(tab);
      expect($('nav.area-subnav a.active')).toHaveLength(1);
      expect($('.area-frame-content h1').text()).toBe('Page');
      expect(
        $('.area-subnav-heading')
          .toArray()
          .map((el) => $(el).text()),
      ).toEqual(['Workspace', 'Mail & sending', 'Automation', 'Connections', 'You']);
    },
  );

  it('hides admin-only Settings items from members', () => {
    expect(renderArea('/settings/members', MEMBER)('a[data-tab="settings.audit"]')).toHaveLength(0);
    expect(renderArea('/settings/members', ADMIN)('a[data-tab="settings.audit"]')).toHaveLength(1);
  });

  it('shows an area tab strip with the current tab marked', () => {
    const $ = renderArea('/mailbox/queue');
    expect(
      $('nav.area-tabs a')
        .toArray()
        .map((el) => $(el).text()),
    ).toEqual(['Drafts', 'Follow-ups', 'Send queue', 'Deliverability']);
    expect($('nav.area-tabs a[aria-current="page"]').attr('data-tab')).toBe('outreach.queue');
  });

  it('Today: Needs you by default, Overview for ?view=overview', () => {
    expect(renderArea('/today')('a[aria-current="page"]').attr('data-tab')).toBe('today.needs');
    expect(
      renderArea('/today', ADMIN, 'view=overview')('a[aria-current="page"]').attr('data-tab'),
    ).toBe('today.overview');
  });

  it('a one-page area and pages outside the areas render the page untouched', () => {
    for (const pathname of ['/communication', '/']) {
      const $ = renderArea(pathname);
      expect($('nav')).toHaveLength(0);
      expect($('h1').text()).toBe('Page');
    }
  });
});

describe('legacy URLs (ia sitemap)', () => {
  it.each([
    ['/dashboard', {}, '/today?view=overview'],
    ['/inbox', {}, '/today'],
    ['/inbox', { tab: 'drafts' }, '/today?tab=drafts'],
    ['/dashboard', { error: 'x y' }, '/today?view=overview&error=x+y'],
  ] as const)('%s %j → %s', (from, search, to) => {
    expect(legacyRedirectTarget(from, search)).toBe(to);
  });

  it('every redirect row points at a registered page and its stub is unlisted', () => {
    for (const r of LEGACY_REDIRECTS) {
      expect(resolveNavLocation(splitHref(r.to).pathname, splitHref(r.to).query)).not.toBeNull();
      expect(UNLISTED_ROUTES[r.from]).toMatch(/redirect/);
      expect(patternFor(r.from)).toBe(r.from);
    }
  });
});

describe('docs/design/IA.md describes the registry', () => {
  const ia = readFileSync(path.resolve(process.cwd(), 'docs/design/IA.md'), 'utf8');

  it('names every area, Settings section, unlisted page and redirect', () => {
    for (const area of NAV_AREAS) expect(ia, area.label).toContain(area.label);
    const sections = new Set(areaById('settings').tabs.map((t) => t.section!));
    for (const section of sections) expect(ia, section).toContain(`| ${section} |`);
    for (const p of Object.keys(UNLISTED_ROUTES)) expect(ia, p).toContain(`\`${p}\``);
    for (const r of LEGACY_REDIRECTS) expect(ia, r.from).toContain(`\`${r.from}`);
  });
});

describe('vocabulary', () => {
  const NAV_SOURCES = [
    'src/lib/nav/registry.ts',
    'src/lib/nav/resolve.ts',
    'src/lib/nav/route-table.ts',
    'src/components/Sidebar.tsx',
    'src/components/CommandPalette.tsx',
    'src/components/AdminShell.tsx',
    'src/components/AreaNav.tsx',
  ];

  it("'God mode' appears in no navigation, source or rendered", () => {
    for (const f of NAV_SOURCES) {
      expect(readFileSync(path.resolve(process.cwd(), f), 'utf8'), f).not.toMatch(/god mode/i);
    }
    nav.pathname = '/admin';
    const rendered = [
      renderSidebar(SUPER).html(),
      renderPalette(SUPER).html(),
      renderToStaticMarkup(AdminShell({ children: null, fetchEntities: noEntities })),
    ];
    for (const html of rendered) expect(html).not.toMatch(/god mode/i);
  });

  it("/admin is called 'Platform console' everywhere it is named", () => {
    expect(areaById('console').label).toBe('Platform console');
    const crumbs = PATTERNS.filter((p) => p.startsWith('/admin')).map((p) =>
      readFileSync(pageFile(p), 'utf8'),
    );
    for (const src of crumbs) expect(src).not.toMatch(/<Link href="\/admin">Admin<\/Link>/);
  });

  it('no page still links to the retired /dashboard or /inbox', () => {
    const offenders = PATTERNS.flatMap((p) => {
      const file = pageFile(p);
      const src = readFileSync(file, 'utf8');
      return /href=["{`]\/(dashboard|inbox)\b|redirect\('\/(dashboard|inbox)/.test(src) ? [p] : [];
    });
    expect(offenders).toEqual([]);
  });
});
