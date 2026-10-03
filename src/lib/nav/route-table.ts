// The generated route table (DS-05 / AP-03 / ia:F-10): every page the
// registry knows, one row each, in navigation order. The assistant
// handbook's "Where things are" block and docs/USER_GUIDE.md print it, so
// the guide links exactly the pages the sidebar and Cmd-K offer.

import {
  DETAIL_ROUTES,
  NAV_AREAS,
  NAV_GROUPS,
  type DetailRoute,
  type NavArea,
  type NavCapability,
  type NavTab,
} from './registry';
import { orderedAreas, splitHref } from './resolve';

export interface RouteTableRow {
  /** The src/app pattern the row stands for ("/review/[id]"). */
  pattern: string;
  /** A linkable href, or null for a dynamic page (opened from a list). */
  href: string | null;
  /** Query-string view of a shared page ("view=overview"), if any. */
  view: string | null;
  areaId: string;
  areaLabel: string;
  /** Static sidebar heading of the area's group, if it has one. */
  groupHeading: string | null;
  /** Where the area is reached: a sidebar item or the account menu. */
  placement: NavArea['placement'];
  label: string;
  kind: 'tab' | DetailRoute['kind'];
  purpose: string;
  scope: NavArea['scope'];
  superAdminOnly: boolean;
  capability: NavCapability;
  /** Settings sub-nav section, for Settings tabs. */
  section: string | null;
  /** For dynamic pages: the list they are opened from. */
  openedFrom: string | null;
}

function tabRow(area: NavArea, tab: NavTab): RouteTableRow {
  const { pathname, query } = splitHref(tab.href);
  return {
    pattern: pathname,
    href: tab.href,
    view: query.size > 0 ? query.toString() : null,
    areaId: area.id,
    areaLabel: area.label,
    groupHeading: NAV_GROUPS.find((g) => g.id === area.group)?.heading ?? null,
    placement: area.placement,
    label: tab.label,
    kind: 'tab',
    purpose: tab.purpose,
    scope: area.scope,
    superAdminOnly: Boolean(area.superAdminOnly),
    capability: tab.capability ?? 'read',
    section: tab.section ?? null,
    openedFrom: null,
  };
}

function detailRow(area: NavArea, pattern: string, d: DetailRoute): RouteTableRow {
  const dynamic = pattern.includes('[');
  return {
    pattern,
    href: dynamic ? null : pattern,
    view: null,
    areaId: area.id,
    areaLabel: area.label,
    groupHeading: NAV_GROUPS.find((g) => g.id === area.group)?.heading ?? null,
    placement: area.placement,
    label: d.label,
    kind: d.kind,
    purpose: d.purpose,
    scope: area.scope,
    superAdminOnly: Boolean(area.superAdminOnly),
    capability: 'read',
    section: null,
    openedFrom: d.openedFrom ?? null,
  };
}

/** Every registered page: per area its tabs, then its detail routes. */
export function routeTable(): RouteTableRow[] {
  const rows: RouteTableRow[] = [];
  for (const area of orderedAreas(NAV_AREAS)) {
    for (const tab of area.tabs) rows.push(tabRow(area, tab));
    for (const [pattern, d] of Object.entries(DETAIL_ROUTES)) {
      if (d.area === area.id) rows.push(detailRow(area, pattern, d));
    }
  }
  return rows;
}
