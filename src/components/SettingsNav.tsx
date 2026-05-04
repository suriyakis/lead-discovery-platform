'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  { href: '/settings/integrations', label: 'Integrations' },
  { href: '/settings/members', label: 'Members' },
  { href: '/settings/usage', label: 'Usage' },
  { href: '/settings/crm', label: 'CRM & Export' },
] as const;

export function SettingsNav() {
  const pathname = usePathname() ?? '';
  return (
    <nav className="settings-nav">
      {ITEMS.map((it) => {
        const isActive = pathname === it.href || pathname.startsWith(`${it.href}/`);
        return (
          <Link
            key={it.href}
            href={it.href}
            className={isActive ? 'active' : ''}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
