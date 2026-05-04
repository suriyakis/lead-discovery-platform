'use client';

// Persistent left sidebar. Sections (per Phase 23 spec):
//   Discovery       — connectors, review queue, leads, knowledge, documents, learning
//   Pipeline        — pipeline, contacts
//   Outreach        — drafts, mailbox, send queue, signatures, suppression
//   Administration  — workspace settings (members, products, integrations, CRM, usage)
//   Emergency       — autopilot (with emergency-pause toggle there)
//   Platform        — super-admin only: god mode, workspaces, users
//
// Active route is auto-detected via usePathname(), so pages don't need
// to pass an `active` prop.

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface NavItem {
  href: string;
  label: string;
  /** Match-prefix list. The first href is also the click target. */
  match?: ReadonlyArray<string>;
}

interface NavSection {
  title: string;
  items: ReadonlyArray<NavItem>;
  defaultOpen?: boolean;
  /** True = only render when the viewer is super_admin. */
  superAdminOnly?: boolean;
  /** Visual emphasis for the Emergency block. */
  emphasize?: boolean;
}

const SECTIONS: ReadonlyArray<NavSection> = [
  {
    title: 'Discovery',
    defaultOpen: true,
    items: [
      { href: '/connectors', label: 'Connectors' },
      { href: '/review', label: 'Review queue' },
      { href: '/leads', label: 'Leads' },
      { href: '/knowledge', label: 'Knowledge' },
      { href: '/documents', label: 'Documents' },
      { href: '/learning', label: 'Learning memory' },
    ],
  },
  {
    title: 'Pipeline',
    defaultOpen: true,
    items: [
      { href: '/pipeline', label: 'Pipeline' },
      { href: '/contacts', label: 'Contacts' },
    ],
  },
  {
    title: 'Outreach',
    defaultOpen: true,
    items: [
      { href: '/drafts', label: 'Drafts' },
      { href: '/mailbox', label: 'Mailbox', match: ['/mailbox'] },
      { href: '/mailbox/queue', label: 'Send queue' },
      { href: '/mailbox/signatures', label: 'Signatures' },
      { href: '/mailbox/suppression', label: 'Suppression' },
    ],
  },
  {
    title: 'Administration',
    defaultOpen: false,
    items: [
      { href: '/products', label: 'Products' },
      { href: '/settings/members', label: 'Members' },
      { href: '/settings/integrations', label: 'Integrations' },
      { href: '/settings/crm', label: 'CRM & Export' },
      { href: '/settings/usage', label: 'Usage' },
    ],
  },
  {
    title: 'Emergency',
    defaultOpen: true,
    emphasize: true,
    items: [{ href: '/autopilot', label: 'Autopilot control' }],
  },
  {
    title: 'Platform',
    defaultOpen: false,
    superAdminOnly: true,
    items: [
      { href: '/admin', label: 'God mode' },
      { href: '/admin/workspaces', label: 'Workspaces' },
      { href: '/admin/users', label: 'Users' },
    ],
  },
];

const PINNED: ReadonlyArray<NavItem> = [
  { href: '/dashboard', label: 'Dashboard' },
];

export interface SidebarProps {
  /** Pass true to render the Platform (super-admin) section. */
  isSuperAdmin?: boolean;
}

export function Sidebar({ isSuperAdmin = false }: Readonly<SidebarProps>) {
  const pathname = usePathname() ?? '';
  const visibleSections = SECTIONS.filter(
    (s) => !s.superAdminOnly || isSuperAdmin,
  );
  // Pick the single best-matching href across the whole nav so that
  // /mailbox/queue lights up "Send queue", not "Mailbox".
  const allItems = [PINNED, ...visibleSections.map((s) => s.items)].flat();
  const activeHref = bestMatch(allItems, pathname);

  return (
    <aside className="sidebar">
      <SidebarBrand />

      <SidebarList items={PINNED} activeHref={activeHref} />

      {visibleSections.map((s) => (
        <SidebarSection
          key={s.title}
          section={s}
          activeHref={activeHref}
          hasActiveChild={s.items.some((it) => it.href === activeHref)}
        />
      ))}
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
  section,
  activeHref,
  hasActiveChild,
}: Readonly<{
  section: NavSection;
  activeHref: string | null;
  hasActiveChild: boolean;
}>) {
  return (
    <details
      className={
        section.emphasize ? 'sidebar-group sidebar-group-emphasize' : 'sidebar-group'
      }
      open={section.defaultOpen || hasActiveChild}
    >
      <summary>{section.title}</summary>
      <SidebarList items={section.items} activeHref={activeHref} />
    </details>
  );
}

function SidebarList({
  items,
  activeHref,
}: Readonly<{ items: ReadonlyArray<NavItem>; activeHref: string | null }>) {
  return (
    <ul className="sidebar-list">
      {items.map((it) => (
        <li key={it.href}>
          <Link
            href={it.href}
            className={
              activeHref === it.href ? 'sidebar-link active' : 'sidebar-link'
            }
          >
            {it.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Pick the single nav item whose href best matches the current pathname.
 * Longest matching href wins, so `/mailbox/queue` beats `/mailbox` when
 * the user is on `/mailbox/queue`.
 */
function bestMatch(
  items: ReadonlyArray<NavItem>,
  pathname: string,
): string | null {
  let bestHref: string | null = null;
  let bestLength = -1;
  for (const it of items) {
    const candidates = it.match ?? [it.href];
    for (const c of candidates) {
      if (c === '/') continue;
      const isMatch = pathname === c || pathname.startsWith(`${c}/`);
      if (isMatch && c.length > bestLength) {
        bestLength = c.length;
        bestHref = it.href;
      }
    }
  }
  return bestHref;
}
