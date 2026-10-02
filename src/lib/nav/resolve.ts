// Behaviour over the navigation registry (./registry.ts): who sees what,
// where a URL lives, what a badge shows, and what Cmd-K lists. Pure
// functions — the Sidebar, AreaNav, CommandPalette, AdminShell and the
// route table all call these, so they cannot disagree.

import type { WorkspaceRole } from '@/lib/services/context';
import {
  DETAIL_ROUTES,
  NAV_ACTIONS,
  NAV_AREAS,
  NAV_GROUPS,
  type DetailRoute,
  type NavAction,
  type NavArea,
  type NavCapability,
  type NavCountSpec,
  type NavCountValues,
  type NavTab,
  type NavTone,
} from './registry';

/** Who is looking: their role in the active workspace, if any. */
export interface NavViewer {
  role: WorkspaceRole | null;
  isSuperAdmin: boolean;
}

const WRITE_ROLES: ReadonlySet<WorkspaceRole> = new Set([
  'owner',
  'admin',
  'manager',
  'member',
  'super_admin',
]);
const ADMIN_ROLES: ReadonlySet<WorkspaceRole> = new Set(['owner', 'admin', 'super_admin']);

/** Same matrix as services/context.ts canRead / canWrite / canAdminWorkspace. */
export function hasNavCapability(
  capability: NavCapability | undefined,
  viewer: NavViewer,
): boolean {
  if (viewer.isSuperAdmin) return true;
  switch (capability ?? 'read') {
    case 'read':
      return true;
    case 'write':
      return viewer.role !== null && WRITE_ROLES.has(viewer.role);
    case 'admin':
      return viewer.role !== null && ADMIN_ROLES.has(viewer.role);
  }
}

export function canSeeArea(area: NavArea, viewer: NavViewer): boolean {
  return !area.superAdminOnly || viewer.isSuperAdmin;
}

export function visibleTabs(area: NavArea, viewer: NavViewer): NavTab[] {
  if (!canSeeArea(area, viewer)) return [];
  return area.tabs.filter((t) => hasNavCapability(t.capability, viewer));
}

export function visibleActions(viewer: NavViewer): NavAction[] {
  return NAV_ACTIONS.filter((a) => hasNavCapability(a.capability, viewer));
}

export function areaById(id: string): NavArea {
  const area = NAV_AREAS.find((a) => a.id === id);
  if (!area) throw new Error(`nav registry: no area "${id}"`);
  return area;
}

export function tabById(id: string): { area: NavArea; tab: NavTab } {
  for (const area of NAV_AREAS) {
    const tab = area.tabs.find((t) => t.id === id);
    if (tab) return { area, tab };
  }
  throw new Error(`nav registry: no tab "${id}"`);
}

/** The area's click target: its first tab. */
export function areaHref(area: NavArea): string {
  return area.tabs[0]!.href;
}

const groupRank = (area: NavArea) => NAV_GROUPS.findIndex((g) => g.id === area.group);

/** Areas in sidebar order (group, then order). */
export function orderedAreas(areas: ReadonlyArray<NavArea> = NAV_AREAS): NavArea[] {
  return [...areas].sort((a, b) => groupRank(a) - groupRank(b) || a.order - b.order);
}

/** The sidebar's items for this viewer, in order. */
export function sidebarAreas(viewer: NavViewer): NavArea[] {
  return orderedAreas(NAV_AREAS.filter((a) => a.placement === 'sidebar' && canSeeArea(a, viewer)));
}

// ---- where a URL lives ------------------------------------------------

/** Pathname and query of an href ("/today?view=overview"). */
export function splitHref(href: string): { pathname: string; query: URLSearchParams } {
  const url = new URL(href, 'http://nav.invalid');
  return { pathname: url.pathname, query: url.searchParams };
}

/** "/review/[id]" → /^\/review\/[^/]+$/ */
export function detailPatternRegExp(pattern: string): RegExp {
  const body = pattern
    .split('/')
    .map((seg) => (/^\[.+\]$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${body}$`);
}

interface DetailMatcher {
  pattern: string;
  re: RegExp;
  route: DetailRoute;
}

const DETAIL_MATCHERS: ReadonlyArray<DetailMatcher> = Object.entries(DETAIL_ROUTES).map(
  ([pattern, route]) => ({ pattern, re: detailPatternRegExp(pattern), route }),
);
const STATIC_DETAILS = DETAIL_MATCHERS.filter((m) => !m.pattern.includes('['));
const DYNAMIC_DETAILS = DETAIL_MATCHERS.filter((m) => m.pattern.includes('['));

export interface NavLocation {
  area: NavArea;
  /** The tab to mark current (for a detail page: its parent tab). */
  tab: NavTab | null;
  /** Set when the page is an entity page or a create flow. */
  detail: (DetailRoute & { pattern: string }) | null;
}

/** Prefix match: the path itself or anything below it ("/" never matches). */
function prefixLength(pathname: string, prefix: string): number {
  if (prefix === '/') return -1;
  return pathname === prefix || pathname.startsWith(`${prefix}/`) ? prefix.length : -1;
}

function queryMatches(tabQuery: URLSearchParams, search: URLSearchParams): boolean {
  for (const [k, v] of tabQuery) if (search.get(k) !== v) return false;
  return true;
}

function detailLocation({ pattern, route }: DetailMatcher): NavLocation {
  const area = areaById(route.area);
  const tab = route.tab ? tabById(route.tab).tab : null;
  return { area, tab, detail: { ...route, pattern } };
}

/** The tab owning `path`: the longest matching prefix (exact: only `path`). */
function bestTab(
  path: string,
  params: URLSearchParams,
  exact: boolean,
): { area: NavArea; tab: NavTab } | null {
  let best: { area: NavArea; tab: NavTab; score: number } | null = null;
  for (const area of NAV_AREAS) {
    for (const tab of area.tabs) {
      const { pathname: hrefPath, query } = splitHref(tab.href);
      if (!queryMatches(query, params)) continue;
      for (const prefix of exact ? [hrefPath] : (tab.match ?? [hrefPath])) {
        const len = exact ? (prefix === path ? prefix.length : -1) : prefixLength(path, prefix);
        if (len < 0) continue;
        // Longest prefix wins; a matched query breaks the tie.
        const score = len * 10 + (query.size > 0 ? 1 : 0);
        if (!best || score > best.score) best = { area, tab, score };
      }
    }
  }
  return best;
}

/**
 * Which area (and tab) a URL belongs to. Static routes beat dynamic ones,
 * as in Next's router: a static detail page (/connectors/new), then a tab
 * page itself (/mailbox/queue), then a dynamic detail page
 * (/mailbox/[id]), then the tab with the longest matching prefix. A tab
 * whose href carries a query (Today's Overview) only matches when the
 * query does, and then beats its plain sibling. Null for pages outside
 * the app areas ("/").
 */
export function resolveNavLocation(
  pathname: string,
  search: URLSearchParams | string = '',
): NavLocation | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;

  const staticDetail = STATIC_DETAILS.find((m) => m.pattern === path);
  if (staticDetail) return detailLocation(staticDetail);

  const exactTab = bestTab(path, params, true);
  if (exactTab) return { ...exactTab, detail: null };

  const dynamicDetail = DYNAMIC_DETAILS.find((m) => m.re.test(path));
  if (dynamicDetail) return detailLocation(dynamicDetail);

  const prefixTab = bestTab(path, params, false);
  return prefixTab ? { ...prefixTab, detail: null } : null;
}

// ---- badges -------------------------------------------------------------

export interface ResolvedCount {
  value: number;
  /** What the badge prints: the number, capped at 99+. */
  text: string;
  tone: NavTone;
  /** Accessible label, e.g. "4 drafts and follow-ups awaiting approval". */
  label: string;
}

/**
 * Apply the count policy to one badge: no number for zero, unknown or a
 * hidden gate; the spec's tone only while its gate holds, otherwise
 * neutral.
 */
export function resolveNavCount(
  spec: NavCountSpec | undefined,
  values: NavCountValues | undefined,
): ResolvedCount | null {
  if (!spec || !values) return null;
  let gateMet = true;
  if (spec.gate?.kind === 'blocked') gateMet = false;
  if (spec.gate?.kind === 'signal') gateMet = (values[spec.gate.signal] ?? 0) > 0;
  if (!gateMet && spec.whenGateUnmet === 'hidden') return null;
  const value = values[spec.key];
  if (value === null || value === undefined || value <= 0) return null;
  return {
    value,
    text: value > 99 ? '99+' : String(value),
    tone: gateMet ? spec.tone : 'neutral',
    label: `${value} ${spec.noun}`,
  };
}

// ---- Cmd-K --------------------------------------------------------------

export interface PaletteRoute {
  id: string;
  label: string;
  /** Result group heading. */
  group: string;
  href: string;
  /** Secondary text (the purpose line). */
  sub: string;
  keywords: ReadonlyArray<string>;
}

/**
 * Every jump target for this viewer, in nav order: each area (labelled as
 * in the sidebar, pointing where the sidebar points), its other tabs,
 * the account-menu pages, then the actions. One entry per href.
 */
export function paletteRoutes(viewer: NavViewer): PaletteRoute[] {
  const out: PaletteRoute[] = [];
  const areas = orderedAreas(NAV_AREAS.filter((a) => canSeeArea(a, viewer)));
  for (const area of areas) {
    const tabs = visibleTabs(area, viewer);
    const [first, ...rest] = tabs;
    if (!first) continue;
    out.push({
      id: `area:${area.id}`,
      label: area.label,
      group: area.label,
      href: first.href,
      sub: first.label === area.label ? first.purpose : `${first.label}: ${first.purpose}`,
      keywords: [...(area.keywords ?? []), first.label, ...(first.keywords ?? [])],
    });
    for (const tab of rest) {
      out.push({
        id: `tab:${tab.id}`,
        label: tab.label,
        group: area.label,
        href: tab.href,
        sub: tab.purpose,
        keywords: tab.keywords ?? [],
      });
    }
  }
  for (const action of visibleActions(viewer)) {
    out.push({
      id: action.id,
      label: action.label,
      group: 'Actions',
      href: action.href,
      sub: action.purpose,
      keywords: action.keywords ?? [],
    });
  }
  return out;
}

/**
 * Cmd-K ranking: label exact > prefix > substring > keyword > purpose >
 * group > fuzzy (every needle character in order in the label). 0 = no
 * match.
 */
export function paletteScore(
  r: { label: string; group: string; sub?: string; keywords?: ReadonlyArray<string> },
  needle: string,
): number {
  const label = r.label.toLowerCase();
  if (label === needle) return 100;
  if (label.startsWith(needle)) return 80;
  if (label.includes(needle)) return 60;
  if ((r.keywords ?? []).some((k) => k.toLowerCase().includes(needle))) return 50;
  if (r.sub && r.sub.toLowerCase().includes(needle)) return 40;
  if (r.group.toLowerCase().includes(needle)) return 20;
  let li = 0;
  for (const ch of needle) {
    const found = label.indexOf(ch, li);
    if (found < 0) return 0;
    li = found + 1;
  }
  return 10;
}
