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
// Every write role gets the interim Emergency stop pinned at the foot (it
// opens the workspace pause, PC-05) until the Pause pill ships (ia:F-18).
//
// At 800px and below Sidebar.module.css turns the sidebar into one
// horizontally scrolling strip above the page; the item for the current
// page is scrolled into view. The drawer comes with the visual Phase 2
// shell. The plain class names (sidebar-nav, sidebar-heading, …) stay on
// the elements as stable hooks for tests and the legacy link styles; the
// new styles are the module's.

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NavCountBadge } from './NavCountBadge';
import { NavIcon } from './NavIcon';
import { useFrameAttention } from './ShellAttention';
import styles from './Sidebar.module.css';
import { cx } from '@/lib/ui/cx';
import { navCountsFromAttention } from '@/lib/attention/project';
import type { AttentionSummary } from '@/lib/attention/types';
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
  /**
   * MOB-02: the attention summary AppShell rendered with. The badges are
   * its projection, kept current in the browser by useAttention() (the
   * poll, focus, reconnects, refreshAttention() after a mutation). Inside
   * the workspace frame the frame's ShellAttention provider supplies it
   * (DS-07: the sidebar lives in the (app) layout, not in each page).
   */
  attention?: AttentionSummary | null;
  /** Badge numbers used while there is no summary (no workspace yet: a
   *  super-admin's console count; tests). */
  navCounts?: NavCountValues;
  /** Keys of `navCounts` that failed to load ("—"). */
  unknownCounts?: ReadonlyArray<string>;
}

/**
 * Matches the breakpoint where Sidebar.module.css turns the sidebar into a
 * strip (an interim width: the legacy app shell collapses there too).
 */
export const COMPACT_SIDEBAR_QUERY = '(max-width: 800px)';

export function Sidebar({
  isSuperAdmin = false,
  role = null,
  attention,
  navCounts,
  unknownCounts,
}: Readonly<SidebarProps>) {
  const pathname = usePathname() ?? '';
  const viewer: NavViewer = { role, isSuperAdmin };
  const areas = sidebarAreas(viewer);
  // Inside the workspace frame: the frame's summary (DS-07). Outside it,
  // its own seed kept live; no summary (fixed numbers, tests): no poll.
  const live = useFrameAttention(attention);
  const projected = live ? navCountsFromAttention(live) : null;
  const counts: SidebarCounts = projected
    ? { values: projected.values, unknown: projected.unknown }
    : { values: navCounts, unknown: unknownCounts ? new Set(unknownCounts) : undefined };
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
    <aside className={cx('sidebar', styles.sidebar)}>
      <nav className={cx('sidebar-nav', styles.nav)} aria-label="Main">
        {NAV_GROUPS.map((group) => {
          const items = areas.filter((a) => a.group === group.id);
          if (items.length === 0) return null;
          return (
            <div key={group.id} className={cx('sidebar-group', styles.group)} data-group={group.id}>
              {group.heading ? (
                <p className={cx('sidebar-heading', styles.heading)}>{group.heading}</p>
              ) : null}
              <ul className={cx('sidebar-list', styles.list)}>
                {items.map((area) => (
                  <li key={area.id}>
                    <SidebarLink
                      area={area}
                      active={area.id === activeArea}
                      activeRef={area.id === activeArea ? activeRef : undefined}
                      counts={counts}
                    />
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
      {showStop ? (
        <div className={cx('sidebar-foot', styles.foot)}>
          <Link
            href={INTERIM_EMERGENCY_STOP.href}
            className={cx('sidebar-stop', styles.stop)}
            data-interim={INTERIM_EMERGENCY_STOP.removedBy}
          >
            <NavIcon
              name={INTERIM_EMERGENCY_STOP.icon}
              className={cx('sidebar-link-icon', styles.stopIcon)}
            />
            <span className={cx('sidebar-stop-text', styles.stopText)}>
              <span className="sidebar-stop-label">{INTERIM_EMERGENCY_STOP.label}</span>
              <span className={cx('sidebar-stop-note', styles.stopNote)}>
                Pauses all automation
              </span>
            </span>
          </Link>
        </div>
      ) : null}
    </aside>
  );
}

interface SidebarCounts {
  values?: NavCountValues;
  /** Keys whose number failed to load: the badge prints "—". */
  unknown?: ReadonlySet<string>;
}

function SidebarLink({
  area,
  active,
  activeRef,
  counts,
}: Readonly<{
  area: NavArea;
  active: boolean;
  activeRef?: React.Ref<HTMLAnchorElement>;
  counts: SidebarCounts;
}>) {
  const count = resolveNavCount(area.count, counts.values, { unknown: counts.unknown });
  return (
    <Link
      ref={activeRef}
      href={areaHref(area)}
      className={cx('sidebar-link', active && 'active', styles.link)}
      aria-current={active ? 'page' : undefined}
      data-area={area.id}
    >
      <NavIcon name={area.icon} className="sidebar-link-icon" />
      <span className="sidebar-link-label">{area.label}</span>
      {count ? <NavCountBadge count={count} className={styles.count} /> : null}
    </Link>
  );
}
