'use client';

// Chrome for the standalone platform console (/admin/*). Deliberately
// DISTINCT from the workspace AppShell: super-admins should always know
// at a glance whether they're inside a tenant (sidebar app) or operating
// the platform (amber console topbar). Rendered by src/app/admin/layout.tsx.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ArrowLeft,
  Crown,
  KeyRound,
  LayoutDashboard,
  LifeBuoy,
  Package,
  ShieldCheck,
  Users,
} from 'lucide-react';

const NAV = [
  { href: '/admin', label: 'Overview', icon: LayoutDashboard, exact: true },
  { href: '/admin/workspaces', label: 'Workspaces', icon: Package },
  { href: '/admin/users', label: 'Users', icon: Users },
  { href: '/admin/providers', label: 'Providers', icon: KeyRound },
  { href: '/admin/support', label: 'Support', icon: LifeBuoy, badgeKey: 'support' as const },
  { href: '/admin/audit', label: 'Audit', icon: ShieldCheck },
];

export function AdminShell({
  children,
  supportUnread = 0,
}: Readonly<{ children: React.ReactNode; supportUnread?: number }>) {
  const pathname = usePathname() ?? '';
  return (
    <div className="admin-shell">
      <div className="admin-topbar">
        <span className="admin-topbar-brand">
          <Crown className="lucide" aria-hidden="true" /> Platform console
        </span>
        <nav>
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = item.exact
              ? pathname === item.href
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
            const badge =
              item.badgeKey === 'support' && supportUnread > 0
                ? supportUnread
                : null;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={active ? 'admin-nav-link active' : 'admin-nav-link'}
              >
                <Icon className="lucide" aria-hidden="true" />
                {item.label}
                {badge !== null ? (
                  <span className="admin-nav-badge">{badge > 99 ? '99+' : badge}</span>
                ) : null}
              </Link>
            );
          })}
        </nav>
        <Link href="/dashboard" className="admin-topbar-exit">
          <ArrowLeft className="lucide" aria-hidden="true" /> Back to app
        </Link>
      </div>
      <main className="admin-main">{children}</main>
    </div>
  );
}
