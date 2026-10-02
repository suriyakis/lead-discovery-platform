'use client';

// Persistent left sidebar, rendered from the navigation registry
// (src/lib/nav/registry.ts): Today, then the Work, Build and Workspace
// groups under static headings, then the Platform console for
// super-admins — 8 items for a workspace member, 9 for a super-admin.
// Each item lights up for every page of its area (resolveNavLocation), and
// its badge follows the registry's count policy (resolveNavCount).
//
// Not here on purpose: the brand mark and wordmark (BrandHeader shows them
// once per page), My account and Help & support (the header's account
// menu), and the area's own tabs (AreaNav, above the page).
//
// Admins get the interim Emergency stop pinned at the foot until the one
// Pause ships (ia:F-18).
//
// Below 800px globals.css turns the sidebar into one horizontally
// scrolling strip above the page; the item for the current page is
// scrolled into view. The drawer comes with the visual Phase 2 shell.

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NavCountBadge } from './NavCountBadge';
import { NavIcon } from './NavIcon';
import {
  INTERIM_EMERGENCY_STOP,
  NAV_GROUPS,
  type NavArea,
  type NavCountValues,
} from '@/lib/nav/registry';
import {
  areaHref,
  hasNavCapability,
  resolveNavCount,
  resolveNavLocation,
  sidebarAreas,
  type NavViewer,
} from '@/lib/nav/resolve';
import type { WorkspaceRole } from '@/lib/services/context';

export interface SidebarProps {
  /** Pass true to show the Platform console item. */
  isSuperAdmin?: boolean;
  /** The viewer's role in the active workspace (null: none yet). */
  role?: WorkspaceRole | null;
  /** Badge numbers from AppShell (services/nav-counts.ts). */
  navCounts?: NavCountValues;
}

/** Matches the breakpoint where globals.css turns the sidebar into a strip. */
export const COMPACT_SIDEBAR_QUERY = '(max-width: 800px)';

export function Sidebar({
  isSuperAdmin = false,
  role = null,
  navCounts,
}: Readonly<SidebarProps>) {
  const pathname = usePathname() ?? '';
  const viewer: NavViewer = { role, isSuperAdmin };
  const areas = sidebarAreas(viewer);
  const activeArea = resolveNavLocation(pathname)?.area.id ?? null;
  const showStop = hasNavCapability(INTERIM_EMERGENCY_STOP.capability, viewer);
  const activeRef = useRef<HTMLAnchorElement>(null);

  // On the phone strip, bring the current area into view (horizontally
  // only — block: 'nearest' never scrolls the page itself).
  useEffect(() => {
    if (!window.matchMedia(COMPACT_SIDEBAR_QUERY).matches) return;
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [activeArea]);

  return (
    <aside className="sidebar">
      <nav className="sidebar-nav" aria-label="Main">
        {NAV_GROUPS.map((group) => {
          const items = areas.filter((a) => a.group === group.id);
          if (items.length === 0) return null;
          return (
            <div key={group.id} className="sidebar-group" data-group={group.id}>
              {group.heading ? <p className="sidebar-heading">{group.heading}</p> : null}
              <ul className="sidebar-list">
                {items.map((area) => (
                  <li key={area.id}>
                    <SidebarLink
                      area={area}
                      active={area.id === activeArea}
                      activeRef={area.id === activeArea ? activeRef : undefined}
                      navCounts={navCounts}
                    />
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
      {showStop ? (
        <div className="sidebar-foot">
          <Link
            href={INTERIM_EMERGENCY_STOP.href}
            className="sidebar-stop"
            data-interim={INTERIM_EMERGENCY_STOP.removedBy}
          >
            <NavIcon name={INTERIM_EMERGENCY_STOP.icon} className="sidebar-link-icon" />
            <span className="sidebar-stop-text">
              <span className="sidebar-stop-label">{INTERIM_EMERGENCY_STOP.label}</span>
              <span className="sidebar-stop-note">Stops queued sending only</span>
            </span>
          </Link>
        </div>
      ) : null}
    </aside>
  );
}

function SidebarLink({
  area,
  active,
  activeRef,
  navCounts,
}: Readonly<{
  area: NavArea;
  active: boolean;
  activeRef?: React.Ref<HTMLAnchorElement>;
  navCounts?: NavCountValues;
}>) {
  const count = resolveNavCount(area.count, navCounts);
  return (
    <Link
      ref={activeRef}
      href={areaHref(area)}
      className={active ? 'sidebar-link active' : 'sidebar-link'}
      aria-current={active ? 'page' : undefined}
      data-area={area.id}
    >
      <NavIcon name={area.icon} className="sidebar-link-icon" />
      <span className="sidebar-link-label">{area.label}</span>
      {count ? <NavCountBadge count={count} /> : null}
    </Link>
  );
}
