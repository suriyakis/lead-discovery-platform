// Persistent left sidebar — pinned at the top, expandable
// "More" / "Settings" sections below. Active route highlighting via the
// `current` prop (the page passes `pathname`-shaped key).

import Link from 'next/link';

interface NavItem {
  href: string;
  label: string;
  /** Stable key so pages can mark exactly one item active. */
  key: string;
}

const PINNED: ReadonlyArray<NavItem> = [
  { href: '/dashboard', label: 'Dashboard', key: 'dashboard' },
  { href: '/pipeline', label: 'Pipeline', key: 'pipeline' },
  { href: '/leads', label: 'Leads', key: 'leads' },
  { href: '/drafts', label: 'Drafts', key: 'drafts' },
  { href: '/mailbox', label: 'Mailbox', key: 'mailbox' },
  { href: '/contacts', label: 'Contacts', key: 'contacts' },
];

const SECONDARY: ReadonlyArray<NavItem> = [
  { href: '/review', label: 'Review queue', key: 'review' },
  { href: '/products', label: 'Products', key: 'products' },
  { href: '/connectors', label: 'Connectors', key: 'connectors' },
  { href: '/documents', label: 'Documents', key: 'documents' },
  { href: '/knowledge', label: 'Knowledge', key: 'knowledge' },
  { href: '/learning', label: 'Learning', key: 'learning' },
];

const SETTINGS: ReadonlyArray<NavItem> = [
  { href: '/settings/integrations', label: 'Integrations', key: 'settings.integrations' },
  { href: '/settings/usage', label: 'Usage', key: 'settings.usage' },
  { href: '/settings/crm', label: 'CRM & Export', key: 'settings.crm' },
];

export interface SidebarProps {
  /** Active item key — see each NavItem.key. */
  active?: string;
  /** Pass true to render the Admin (god mode) link. */
  isSuperAdmin?: boolean;
}

export function Sidebar({ active, isSuperAdmin = false }: Readonly<SidebarProps>) {
  return (
    <aside className="sidebar">
      <SidebarBrand />

      <SidebarSection items={PINNED} active={active} />

      <SidebarSection
        title="More"
        items={SECONDARY}
        active={active}
        defaultOpen={false}
      />

      <SidebarSection
        title="Settings"
        items={SETTINGS}
        active={active}
        defaultOpen={false}
      />

      {isSuperAdmin ? (
        <SidebarSection
          title="Admin"
          items={[
            { href: '/admin', label: 'God mode', key: 'admin' },
            { href: '/admin/users', label: 'Users', key: 'admin.users' },
          ]}
          active={active}
          defaultOpen
        />
      ) : null}
    </aside>
  );
}

function SidebarBrand() {
  return (
    <div className="sidebar-brand">
      <Link href="/dashboard">
        <span className="sw-mark">signal</span>
        <span className="sw-mark sw-mark-accent">/works</span>
      </Link>
    </div>
  );
}

function SidebarSection({
  title,
  items,
  active,
  defaultOpen = true,
}: Readonly<{
  title?: string;
  items: ReadonlyArray<NavItem>;
  active?: string;
  defaultOpen?: boolean;
}>) {
  // Use <details>/<summary> so it works without client JS — pages stay
  // server-rendered.
  const body = (
    <ul className="sidebar-list">
      {items.map((it) => (
        <li key={it.key}>
          <Link
            href={it.href}
            className={active === it.key ? 'sidebar-link active' : 'sidebar-link'}
          >
            {it.label}
          </Link>
        </li>
      ))}
    </ul>
  );

  if (!title) return body;

  return (
    <details className="sidebar-group" open={defaultOpen}>
      <summary>{title}</summary>
      {body}
    </details>
  );
}
