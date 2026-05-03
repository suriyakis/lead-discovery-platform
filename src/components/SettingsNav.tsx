import Link from 'next/link';

const ITEMS = [
  { href: '/settings/integrations', label: 'Integrations', key: 'integrations' },
  { href: '/settings/members', label: 'Members', key: 'members' },
  { href: '/settings/usage', label: 'Usage', key: 'usage' },
  { href: '/settings/crm', label: 'CRM & Export', key: 'crm' },
] as const;

export function SettingsNav({ active }: Readonly<{ active: string }>) {
  return (
    <nav className="settings-nav">
      {ITEMS.map((it) => (
        <Link
          key={it.href}
          href={it.href}
          className={active === it.key || active === it.href ? 'active' : ''}
        >
          {it.label}
        </Link>
      ))}
    </nav>
  );
}
