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
import {
  AlertOctagon,
  AtSign,
  BookOpen,
  CreditCard,
  Crown,
  FileText,
  Inbox,
  KanbanSquare,
  Key,
  LayoutDashboard,
  ListChecks,
  Lightbulb,
  type LucideIcon,
  Mail,
  MailWarning,
  Network,
  Package,
  PencilLine,
  Receipt,
  Send,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  UserCircle,
  Users,
  Users2,
  Workflow,
} from 'lucide-react';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
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
      { href: '/connectors', label: 'Connectors', icon: Network },
      { href: '/review', label: 'Review queue', icon: ListChecks },
      { href: '/leads', label: 'Leads', icon: Sparkles },
      { href: '/knowledge', label: 'Knowledge', icon: BookOpen },
      { href: '/documents', label: 'Documents', icon: FileText },
      { href: '/learning', label: 'Learning memory', icon: Lightbulb },
    ],
  },
  {
    title: 'Pipeline',
    defaultOpen: true,
    items: [
      { href: '/pipeline', label: 'Pipeline', icon: KanbanSquare },
      { href: '/contacts', label: 'Contacts', icon: Users2 },
    ],
  },
  {
    title: 'Outreach',
    defaultOpen: true,
    items: [
      { href: '/drafts', label: 'Drafts', icon: PencilLine },
      { href: '/mailbox', label: 'Mailbox', icon: Inbox, match: ['/mailbox'] },
      { href: '/mailbox/queue', label: 'Send queue', icon: Send },
      { href: '/mailbox/signatures', label: 'Signatures', icon: AtSign },
      { href: '/mailbox/suppression', label: 'Suppression', icon: MailWarning },
      { href: '/mailbox/deliverability', label: 'Deliverability', icon: Mail },
    ],
  },
  {
    title: 'Administration',
    defaultOpen: false,
    items: [
      { href: '/settings/account', label: 'My account', icon: UserCircle },
      { href: '/products', label: 'Products', icon: ShoppingBag },
      { href: '/settings/members', label: 'Members', icon: Users },
      { href: '/settings/integrations', label: 'Integrations', icon: Key },
      { href: '/settings/crm', label: 'CRM & Export', icon: Workflow },
      { href: '/settings/usage', label: 'Usage', icon: Receipt },
      { href: '/settings/billing', label: 'Billing', icon: CreditCard },
      { href: '/settings/audit', label: 'Audit log', icon: ShieldCheck },
    ],
  },
  {
    title: 'Emergency',
    defaultOpen: true,
    emphasize: true,
    items: [{ href: '/autopilot', label: 'Autopilot control', icon: AlertOctagon }],
  },
  {
    title: 'Platform',
    defaultOpen: false,
    superAdminOnly: true,
    items: [
      { href: '/admin', label: 'God mode', icon: Crown },
      { href: '/admin/workspaces', label: 'Workspaces', icon: Package },
      { href: '/admin/users', label: 'Users', icon: Users },
      { href: '/admin/audit', label: 'Audit log', icon: ShieldCheck },
    ],
  },
];

const PINNED: ReadonlyArray<NavItem> = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
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
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <li key={it.href}>
            <Link
              href={it.href}
              className={
                activeHref === it.href ? 'sidebar-link active' : 'sidebar-link'
              }
            >
              <Icon className="sidebar-link-icon" aria-hidden="true" />
              <span>{it.label}</span>
            </Link>
          </li>
        );
      })}
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
