'use client';

// The current area's own navigation, above or beside the page (ia:F-10):
// a tab strip for areas with several pages (Review: Queue · By product),
// or the grouped Settings sub-nav (Workspace · Mail & sending ·
// Automation · Connections · You) for every Settings page. It reads the
// navigation registry and the URL, so it works on today's URLs: the
// Settings sub-nav shows on /settings/*, /mailbox, /autopilot and /health
// alike, with the right item marked. It replaces the per-page
// SettingsNav copies.
//
// AppShell wraps every page in <AreaFrame>. Pages outside any area, or
// in an area with a single page, render untouched.
//
// Styles in AreaNav.module.css (the Settings sub-nav is a strip above the
// page below 1200px, a column beside it from there). The plain class
// names (area-tabs, area-subnav, …) stay on the elements as stable hooks
// for tests.

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import type { NavArea, NavCountValues, NavTab } from '@/lib/nav/registry';
import {
  resolveNavCount,
  resolveNavLocation,
  visibleTabs,
  type NavViewer,
} from '@/lib/nav/resolve';
import { cx } from '@/lib/ui/cx';
import styles from './AreaNav.module.css';
import { NavCountBadge } from './NavCountBadge';

export interface AreaFrameProps {
  viewer: NavViewer;
  navCounts?: NavCountValues;
  children?: React.ReactNode;
}

interface NavLinksProps {
  area: NavArea;
  tabs: NavTab[];
  pathname: string;
  navCounts?: NavCountValues;
}

/**
 * The frame around the page. The area — and so the layout — follows from
 * the pathname; the query only decides which tab is current when tabs
 * are views of one page (Today › Overview is /today?view=overview).
 *
 * useSearchParams without a Suspense boundary is safe here: AppShell reads
 * the session, so every page that renders this frame is dynamic and never
 * prerendered (the case that needs the boundary). A boundary would cost
 * more than it saves: React may stream its fallback first and the real
 * nav after it, so the sub-nav would reach the browser twice.
 */
export function AreaFrame(props: Readonly<AreaFrameProps>) {
  const search = useSearchParams();
  return <AreaFrameView {...props} search={search?.toString() ?? ''} />;
}

/** AreaFrame with the query given explicitly (tests, static renders). */
export function AreaFrameView({
  viewer,
  navCounts,
  children,
  search,
}: Readonly<AreaFrameProps & { search: string }>) {
  const pathname = usePathname() ?? '';
  const location = resolveNavLocation(pathname);
  if (!location) return <>{children}</>;
  const tabs = visibleTabs(location.area, viewer);
  const layout = location.area.navStyle === 'subnav' ? 'subnav' : tabs.length >= 2 ? 'tabs' : null;
  if (!layout) return <>{children}</>;
  return (
    <div
      className={cx('area-frame', styles.frame)}
      data-layout={layout}
      data-area={location.area.id}
    >
      <AreaNavLinks
        area={location.area}
        tabs={tabs}
        pathname={pathname}
        navCounts={navCounts}
        search={search}
      />
      <div className={cx('area-frame-content', styles.content)}>{children}</div>
    </div>
  );
}

function AreaNavLinks({
  area,
  tabs,
  pathname,
  navCounts,
  search,
}: Readonly<NavLinksProps & { search: string }>) {
  const current = resolveNavLocation(pathname, search)?.tab?.id ?? null;
  if (area.navStyle === 'subnav') {
    return <SubNav area={area} tabs={tabs} current={current} navCounts={navCounts} />;
  }
  return (
    <nav className={cx('area-tabs', styles.tabs)} aria-label={`${area.label} pages`}>
      {tabs.map((tab) => (
        <AreaLink
          key={tab.id}
          tab={tab}
          current={tab.id === current}
          className={cx('area-tab', styles.tab)}
          navCounts={navCounts}
        />
      ))}
    </nav>
  );
}

function SubNav({
  area,
  tabs,
  current,
  navCounts,
}: Readonly<{
  area: NavArea;
  tabs: NavTab[];
  current: string | null;
  navCounts?: NavCountValues;
}>) {
  const sections: Array<{ heading: string; tabs: NavTab[] }> = [];
  for (const tab of tabs) {
    const heading = tab.section ?? area.label;
    const last = sections.at(-1);
    if (last && last.heading === heading) last.tabs.push(tab);
    else sections.push({ heading, tabs: [tab] });
  }
  return (
    <nav className={cx('area-subnav', styles.subnav)} aria-label={area.label}>
      {sections.map((section) => (
        <div key={section.heading} className={cx('area-subnav-section', styles.section)}>
          <p className={cx('area-subnav-heading', styles.heading)}>{section.heading}</p>
          <ul className={cx('area-subnav-list', styles.list)}>
            {section.tabs.map((tab) => (
              <li key={tab.id}>
                <AreaLink
                  tab={tab}
                  current={tab.id === current}
                  className={cx('area-subnav-link', styles.subnavLink)}
                  navCounts={navCounts}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function AreaLink({
  tab,
  current,
  className,
  navCounts,
}: Readonly<{ tab: NavTab; current: boolean; className: string; navCounts?: NavCountValues }>) {
  const count = resolveNavCount(tab.count, navCounts);
  return (
    <Link
      href={tab.href}
      className={cx(className, current && 'active')}
      aria-current={current ? 'page' : undefined}
      data-tab={tab.id}
    >
      {tab.label}
      {count ? <NavCountBadge count={count} /> : null}
    </Link>
  );
}
