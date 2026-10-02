'use client';

// Chrome for the standalone platform console (/admin/*). Deliberately
// DISTINCT from the workspace AppShell: super-admins should always know
// at a glance whether they're inside a tenant (sidebar app) or operating
// the platform (amber console topbar). Rendered by src/app/admin/layout.tsx.
//
// Its nav is the Platform console area of the navigation registry
// (src/lib/nav/registry.ts) — the same entries, names and badge policy
// Cmd-K and the workspace sidebar use — and it mounts the Cmd-K palette
// with its visible Search button, so the console has keyboard jump too
// (I171).

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { CommandPalette, type CommandPaletteProps } from './CommandPalette';
import { CommandPaletteTrigger } from './CommandPaletteTrigger';
import { NavCountBadge } from './NavCountBadge';
import { NavIcon } from './NavIcon';
import { HOME_PATH } from '@/lib/nav/registry';
import {
  areaById,
  resolveNavCount,
  resolveNavLocation,
  visibleTabs,
} from '@/lib/nav/resolve';

const CONSOLE = areaById('console');
const SUPER_ADMIN = { role: 'super_admin', isSuperAdmin: true } as const;

export function AdminShell({
  children,
  supportUnread = 0,
  fetchEntities,
}: Readonly<{
  children: React.ReactNode;
  supportUnread?: number;
  /** Cmd-K's entity index (the same server action AppShell passes). */
  fetchEntities?: CommandPaletteProps['fetchEntities'];
}>) {
  const pathname = usePathname() ?? '';
  const location = resolveNavLocation(pathname);
  const counts = { adminSupportUnread: supportUnread };
  return (
    <div className="admin-shell">
      <div className="admin-topbar">
        <span className="admin-topbar-brand">
          <NavIcon name={CONSOLE.icon} className="lucide" /> {CONSOLE.label}
        </span>
        <nav aria-label={CONSOLE.label}>
          {visibleTabs(CONSOLE, SUPER_ADMIN).map((tab) => {
            const active = location?.area.id === CONSOLE.id && location.tab?.id === tab.id;
            const count = resolveNavCount(tab.count, counts);
            return (
              <Link
                key={tab.id}
                href={tab.href}
                className={active ? 'admin-nav-link active' : 'admin-nav-link'}
                aria-current={active ? 'page' : undefined}
                data-tab={tab.id}
              >
                {tab.shortLabel ?? tab.label}
                {count ? <NavCountBadge count={count} /> : null}
              </Link>
            );
          })}
        </nav>
        <CommandPaletteTrigger />
        <Link href={HOME_PATH} className="admin-topbar-exit">
          <ArrowLeft className="lucide" aria-hidden="true" /> Back to app
        </Link>
      </div>
      <main className="admin-main">{children}</main>
      <CommandPalette fetchEntities={fetchEntities ?? noEntities} isSuperAdmin role="super_admin" />
    </div>
  );
}

async function noEntities() {
  return [];
}
