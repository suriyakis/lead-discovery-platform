// Shared route catalog — consumed by Sidebar (for navigation) and the
// Cmd-K palette (for jump targets). Single source of truth so a route
// added here automatically shows up in both places.

export interface NavRoute {
  href: string;
  label: string;
  /** Section label used to group results in Cmd-K. */
  group: string;
  /** Lucide icon name (looked up by Sidebar). */
  icon: string;
  /** Hidden from the sidebar (still searchable in Cmd-K). */
  hidden?: boolean;
  /** Super-admin only. */
  superAdminOnly?: boolean;
}

export const NAV_ROUTES: ReadonlyArray<NavRoute> = [
  // Pinned
  { href: '/inbox', label: 'Inbox', group: 'Pinned', icon: 'Bell' },
  { href: '/dashboard', label: 'Dashboard', group: 'Pinned', icon: 'LayoutDashboard' },

  // Discovery
  { href: '/products', label: 'Products', group: 'Discovery', icon: 'ShoppingBag' },
  { href: '/connectors', label: 'Connectors', group: 'Discovery', icon: 'Network' },
  { href: '/review', label: 'Review queue', group: 'Discovery', icon: 'ListChecks' },
  { href: '/leads', label: 'Leads', group: 'Discovery', icon: 'Sparkles' },
  { href: '/knowledge', label: 'Knowledge', group: 'Discovery', icon: 'BookOpen' },
  { href: '/documents', label: 'Documents', group: 'Discovery', icon: 'FileText' },
  { href: '/learning', label: 'Learning memory', group: 'Discovery', icon: 'Lightbulb' },

  // Pipeline
  { href: '/pipeline', label: 'Pipeline', group: 'Pipeline', icon: 'KanbanSquare' },
  { href: '/contacts', label: 'Contacts', group: 'Pipeline', icon: 'Users2' },

  // Outreach
  { href: '/drafts', label: 'Drafts', group: 'Outreach', icon: 'PencilLine' },
  { href: '/communication', label: 'Communication', group: 'Outreach', icon: 'MessagesSquare' },
  { href: '/communication/follow-ups', label: 'Follow-ups', group: 'Outreach', icon: 'Timer', hidden: true },
  { href: '/mailbox', label: 'Mailbox', group: 'Outreach', icon: 'Inbox' },
  { href: '/mailbox/queue', label: 'Send queue', group: 'Outreach', icon: 'Send' },
  { href: '/mailbox/signatures', label: 'Signatures', group: 'Outreach', icon: 'AtSign' },
  { href: '/mailbox/suppression', label: 'Suppression', group: 'Outreach', icon: 'MailWarning' },
  { href: '/mailbox/deliverability', label: 'Deliverability', group: 'Outreach', icon: 'Mail' },
  { href: '/settings/outreach', label: 'Outreach config', group: 'Outreach', icon: 'SlidersHorizontal' },

  // Workspace
  { href: '/settings/members', label: 'Members', group: 'Workspace', icon: 'Users' },
  { href: '/settings/integrations', label: 'Integrations', group: 'Workspace', icon: 'Key' },
  { href: '/settings/crm', label: 'CRM & Export', group: 'Workspace', icon: 'Workflow' },
  { href: '/settings/usage', label: 'Usage', group: 'Workspace', icon: 'Receipt' },
  { href: '/settings/billing', label: 'Billing', group: 'Workspace', icon: 'CreditCard' },
  { href: '/settings/audit', label: 'Audit log', group: 'Workspace', icon: 'ShieldCheck' },

  // Account
  { href: '/settings/account', label: 'My account', group: 'Account', icon: 'UserCircle' },

  // Emergency
  { href: '/autopilot', label: 'Autopilot control', group: 'Emergency', icon: 'AlertOctagon' },

  // Platform (super-admin)
  { href: '/admin', label: 'God mode', group: 'Platform', icon: 'Crown', superAdminOnly: true },
  { href: '/admin/workspaces', label: 'Workspaces', group: 'Platform', icon: 'Package', superAdminOnly: true },
  { href: '/admin/users', label: 'Users', group: 'Platform', icon: 'Users', superAdminOnly: true },
  { href: '/admin/audit', label: 'Audit log', group: 'Platform', icon: 'ShieldCheck', superAdminOnly: true },
];
