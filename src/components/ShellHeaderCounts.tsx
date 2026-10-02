'use client';

// DS-07 (MOB-03): the header's numbers — the notifications bell and the
// account menu's badges — as client islands reading the frame's attention
// summary (ShellAttention), because the header now lives in the (app)
// layout and is not re-rendered on client navigation. The markup around
// them (the menu itself, Sign out) stays server-rendered in AppShell.

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell } from 'lucide-react';
import styles from './AppShell.module.css';
import { NavCountBadge } from './NavCountBadge';
import { useShellAttention } from './ShellAttention';
import { navCountsFromAttention } from '@/lib/attention/project';
import type { AttentionSummary } from '@/lib/attention/types';
import { ACCOUNT_MENU } from '@/lib/nav/registry';
import { resolveNavCount, tabById, type ResolvedCount } from '@/lib/nav/resolve';
import { cx } from '@/lib/ui/cx';

/** The bell's text and label for an unread count (null: failed to load). */
export function bellView(unread: number | null): { text: string | null; label: string } {
  if (unread === null) return { text: '—', label: 'Notifications, unread count unavailable' };
  if (unread > 99) return { text: '99+', label: `Notifications, ${unread} unread` };
  if (unread > 0) return { text: String(unread), label: `Notifications, ${unread} unread` };
  return { text: null, label: 'Notifications' };
}

/** The account menu's badges: one per item, and the first for the closed menu. */
export function accountMenuCounts(summary: AttentionSummary | null): {
  items: Record<string, ResolvedCount | null>;
  menu: ResolvedCount | null;
} {
  const items: Record<string, ResolvedCount | null> = {};
  if (!summary) {
    for (const id of ACCOUNT_MENU) items[id] = null;
    return { items, menu: null };
  }
  const nav = navCountsFromAttention(summary);
  for (const id of ACCOUNT_MENU) {
    items[id] = resolveNavCount(tabById(id).tab.count, nav.values, { unknown: nav.unknown });
  }
  // Unread support replies also show on the closed menu, so they are not
  // hidden behind it.
  const menu = ACCOUNT_MENU.map((id) => items[id] ?? null).find((c) => c !== null) ?? null;
  return { items, menu };
}

/** The bell: it counts events, so its count is neutral (DS-00 count policy). */
export function NotificationBell() {
  const summary = useShellAttention()?.summary ?? null;
  // No summary at all: no number (not a "—" — nothing failed to count).
  const unread = summary ? summary.counts['notifications.unread'] : 0;
  const view = bellView(unread);
  return (
    <Link href="/notifications" className={cx('header-bell', styles.bell)} aria-label={view.label}>
      <Bell className="lucide" aria-hidden="true" />
      {view.text ? (
        <span className={cx('header-bell-count', styles.bellCount)} aria-hidden="true">
          {view.text}
        </span>
      ) : null}
    </Link>
  );
}

/** The badge on the closed account menu. */
export function AccountMenuBadge() {
  const { menu } = accountMenuCounts(useShellAttention()?.summary ?? null);
  return menu ? <NavCountBadge count={menu} /> : null;
}

/** The badge on one account-menu item (a registry tab id). */
export function AccountMenuItemBadge({ tabId }: Readonly<{ tabId: string }>) {
  const { items } = accountMenuCounts(useShellAttention()?.summary ?? null);
  const count = items[tabId] ?? null;
  return count ? <NavCountBadge count={count} /> : null;
}

/**
 * The account menu is a plain <details> in the persistent frame: it would
 * stay open on the page its own link opened. Close it on every client
 * navigation (the frame is no longer re-mounted per page).
 */
export function CloseMenusOnNavigate() {
  const pathname = usePathname();
  useEffect(() => {
    for (const menu of document.querySelectorAll<HTMLDetailsElement>(
      'details.header-account-menu[open]',
    )) {
      menu.open = false;
    }
  }, [pathname]);
  return null;
}
