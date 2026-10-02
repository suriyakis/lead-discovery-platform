// The navigation registry (DS-05; absorbs AP-03 and ia:F-10).
//
// ONE description of where everything in the app lives. The Sidebar, the
// area tabs and the Settings sub-nav (AreaNav), the Cmd-K palette, the
// Platform console's nav, the mobile tab bar definition, the legacy
// redirects and the generated route table (printed by the assistant
// handbook and docs/USER_GUIDE.md) all read it. A page added here shows
// up everywhere at once; a page.tsx that is neither here nor in
// UNLISTED_ROUTES fails src/tests/nav-registry.test.ts.
//
// The IA the owner decided (docs/design/IA.md): Today at /today, then 8
// areas — Work (Review, Pipeline, Outreach, Conversations), Build
// (Discovery, Products), Workspace (Settings) and, for super-admins only,
// the Platform console. Areas point at today's URLs; when a later wave
// moves a page, its tab's href changes here and a redirect row is added
// in redirects.ts.
//
// Pure data, no React and no database: client components import it.
// Icons are Lucide names; src/components/NavIcon.tsx maps them.
// Behaviour over this data lives in ./resolve.ts.

import type { CountTone } from '@/lib/ui/tone';

/** The signed-in home. Every "go home" producer uses this, not a literal. */
export const HOME_PATH = '/today';

// ---- vocabulary -------------------------------------------------------

export type NavGroupId = 'today' | 'work' | 'build' | 'workspace' | 'platform';

export interface NavGroup {
  id: NavGroupId;
  /** Static sidebar heading; null = no heading (Today sits on its own). */
  heading: string | null;
}

/** Sidebar order of the groups. Headings are labels, not accordions. */
export const NAV_GROUPS: ReadonlyArray<NavGroup> = [
  { id: 'today', heading: null },
  { id: 'work', heading: 'Work' },
  { id: 'build', heading: 'Build' },
  { id: 'workspace', heading: 'Workspace' },
  { id: 'platform', heading: 'Platform' },
];

/** Lucide icon names the registry may use (NavIcon.tsx maps each one). */
export type NavIconName =
  | 'House'
  | 'ListChecks'
  | 'KanbanSquare'
  | 'Send'
  | 'MessagesSquare'
  | 'Radar'
  | 'BookOpen'
  | 'Settings'
  | 'Crown'
  | 'LifeBuoy'
  | 'OctagonAlert'
  | 'UserPlus'
  | 'PackagePlus'
  | 'CirclePlus';

/**
 * Who may see an entry, by workspace role (services/context.ts):
 * read = every member incl. viewers, write = members and up,
 * admin = owners and admins. Super-admins pass every check.
 */
export type NavCapability = 'read' | 'write' | 'admin';

// ---- counts -------------------------------------------------------------

/** Numbers a nav badge can show (services/nav-counts.ts computes them). */
export type NavCountKey =
  | 'reviewPending'
  | 'outreachPending'
  | 'repliesUnhandled'
  | 'supportUnread'
  | 'adminSupportUnread';

/** Facts a count gate can test; never shown as a number themselves. */
export type NavSignalKey = 'reviewNeedsReview';

export type NavCountValues = Partial<Record<NavCountKey | NavSignalKey, number | null>>;

/** A count's tone: neutral, or attention when a decision waits (src/lib/ui/tone.ts). */
export type NavTone = CountTone;

/**
 * A gate decides whether a count earns its tone. `signal`: holds while
 * that signal is above 0. `blocked`: never holds until the named
 * deliverable or issue lands (then the gate is replaced by real data).
 */
export type NavCountGate =
  | { kind: 'signal'; signal: NavSignalKey; reason: string }
  | { kind: 'blocked'; until: string; reason: string };

/**
 * Count policy as data (docs/design/IA.md, "Count policy"). A count whose
 * gate is unmet renders in the neutral tone, or not at all.
 */
export interface NavCountSpec {
  key: NavCountKey;
  /** Tone while the gate holds (or always, without a gate). */
  tone: NavTone;
  gate?: NavCountGate;
  /** What an unmet gate does to the badge. */
  whenGateUnmet?: 'neutral' | 'hidden';
  /** Screen-reader noun: "4 drafts and follow-ups awaiting approval". */
  noun: string;
}

// ---- entries ------------------------------------------------------------

export interface NavTab {
  /** Stable id: "<area>.<tab>". */
  id: string;
  label: string;
  /** Shorter label for cramped navs (the console top bar). */
  shortLabel?: string;
  /** Click target. A query string makes it a view of a shared page. */
  href: string;
  /**
   * Path prefixes this tab owns (exact or followed by "/"). Defaults to
   * the pathname of `href`. The longest matching prefix wins overall.
   */
  match?: ReadonlyArray<string>;
  /** One line: what the page is for (Cmd-K, the handbook, the docs). */
  purpose: string;
  keywords?: ReadonlyArray<string>;
  capability?: NavCapability;
  /** Settings sub-nav heading this tab sits under. */
  section?: string;
  count?: NavCountSpec;
}

export interface NavArea {
  id: string;
  label: string;
  icon: NavIconName;
  group: NavGroupId;
  /** Order inside its group. */
  order: number;
  scope: 'tenant' | 'platform';
  /** 'sidebar' = an area item; 'menu' = reached from the account menu. */
  placement: 'sidebar' | 'menu';
  superAdminOnly?: boolean;
  purpose: string;
  keywords?: ReadonlyArray<string>;
  /** 'tabs' = a tab strip; 'subnav' = the grouped Settings sub-nav. */
  navStyle: 'tabs' | 'subnav';
  /** The first tab is the area's click target. */
  tabs: ReadonlyArray<NavTab>;
  count?: NavCountSpec;
  /** Position in the 5-item mobile tab bar (MOB / visual Phase 2). */
  mobileTab?: number;
}

/** A page reached from inside an area: entity pages and create flows. */
export interface DetailRoute {
  area: string;
  /** Tab to highlight; defaults to the area tab whose prefix matches. */
  tab?: string;
  label: string;
  kind: 'detail' | 'create' | 'flow';
  purpose: string;
  /** Where to open it from, for the handbook ("opened from [/pipeline]"). */
  openedFrom?: string;
}

const COUNT_REVIEW: NavCountSpec = {
  key: 'reviewPending',
  tone: 'attention',
  gate: {
    kind: 'signal',
    signal: 'reviewNeedsReview',
    reason:
      'Only needs_review items wait on a person; records still "new" are neutral, so a queue of 310 untouched records is not an alarm.',
  },
  whenGateUnmet: 'neutral',
  noun: 'records waiting for review',
};

const COUNT_OUTREACH: NavCountSpec = {
  key: 'outreachPending',
  tone: 'attention',
  noun: 'drafts and follow-ups awaiting approval',
};

const COUNT_REPLIES: NavCountSpec = {
  key: 'repliesUnhandled',
  tone: 'attention',
  gate: {
    kind: 'blocked',
    until: 'I084',
    reason:
      'Until reply triage is trusted (I084) a reply count would count newsletters and auto-replies, so Conversations shows none.',
  },
  whenGateUnmet: 'hidden',
  noun: 'unhandled replies',
};

const COUNT_SUPPORT: NavCountSpec = {
  key: 'supportUnread',
  tone: 'neutral',
  noun: 'unread support replies',
};

const COUNT_ADMIN_SUPPORT: NavCountSpec = {
  key: 'adminSupportUnread',
  tone: 'neutral',
  noun: 'unread support threads',
};

// ---- the areas ----------------------------------------------------------

export const NAV_AREAS: ReadonlyArray<NavArea> = [
  {
    id: 'today',
    label: 'Today',
    icon: 'House',
    group: 'today',
    order: 1,
    scope: 'tenant',
    placement: 'sidebar',
    purpose: 'What needs you now, and how the workspace is doing.',
    keywords: ['home', 'start'],
    navStyle: 'tabs',
    mobileTab: 1,
    tabs: [
      {
        id: 'today.needs',
        label: 'Needs you',
        href: '/today',
        purpose: 'Review picks, drafts, replies and follow-ups waiting for a person.',
        keywords: ['inbox', 'approvals', 'daily loop'],
      },
      {
        id: 'today.overview',
        label: 'Overview',
        href: '/today?view=overview',
        purpose: 'Send queue, pipeline funnel and recent replies at a glance.',
        keywords: ['dashboard', 'signals', 'funnel'],
      },
      {
        id: 'today.activity',
        label: 'Activity',
        href: '/notifications',
        purpose: 'The event feed: failures, mentions, assignments and support replies.',
        keywords: ['notifications', 'bell', 'events'],
      },
    ],
  },
  {
    id: 'review',
    label: 'Review',
    icon: 'ListChecks',
    group: 'work',
    order: 1,
    scope: 'tenant',
    placement: 'sidebar',
    purpose: 'Decide on what discovery found.',
    navStyle: 'tabs',
    count: COUNT_REVIEW,
    mobileTab: 2,
    tabs: [
      {
        id: 'review.queue',
        label: 'Queue',
        href: '/review',
        purpose: 'Company records waiting for a verdict: approve, reject or comment.',
        keywords: ['review queue', 'records', 'triage', 'approve', 'reject'],
      },
      {
        id: 'review.byProduct',
        label: 'By product',
        href: '/leads',
        purpose: 'Relevant matches per product; promote one to the pipeline.',
        keywords: ['leads', 'matches', 'promote'],
      },
    ],
  },
  {
    id: 'pipeline',
    label: 'Pipeline',
    icon: 'KanbanSquare',
    group: 'work',
    order: 2,
    scope: 'tenant',
    placement: 'sidebar',
    purpose: 'The leads you work, from relevant to handed over.',
    navStyle: 'tabs',
    tabs: [
      {
        id: 'pipeline.leads',
        label: 'Leads',
        href: '/pipeline',
        purpose: 'Pipeline leads by status: contact email, owner, notes and stage.',
        keywords: ['kanban', 'board', 'qualified leads'],
      },
      {
        id: 'pipeline.contacts',
        label: 'Contacts',
        href: '/contacts',
        purpose: 'The people behind your leads and mail threads.',
        keywords: ['people'],
      },
    ],
  },
  {
    id: 'outreach',
    label: 'Outreach',
    icon: 'Send',
    group: 'work',
    order: 3,
    scope: 'tenant',
    placement: 'sidebar',
    purpose: 'Emails to approve and the queue that sends them.',
    navStyle: 'tabs',
    count: COUNT_OUTREACH,
    mobileTab: 3,
    tabs: [
      {
        id: 'outreach.drafts',
        label: 'Drafts',
        href: '/drafts',
        purpose: 'AI-written emails waiting for approval.',
        keywords: ['outreach drafts', 'approve'],
      },
      {
        id: 'outreach.followUps',
        label: 'Follow-ups',
        href: '/communication/follow-ups',
        purpose: 'Follow-up emails that are due or awaiting approval.',
      },
      {
        id: 'outreach.queue',
        label: 'Send queue',
        href: '/mailbox/queue',
        purpose: 'Queued emails, why each one is held, and the workspace send limits.',
        keywords: ['queue', 'daily limit', 'cooldown', 'pause all automation'],
      },
      {
        id: 'outreach.deliverability',
        label: 'Deliverability',
        href: '/mailbox/deliverability',
        purpose: 'Sent, bounced and replied counts, and replies per class.',
        keywords: ['bounces', 'reply classes'],
      },
    ],
  },
  {
    id: 'conversations',
    label: 'Conversations',
    icon: 'MessagesSquare',
    group: 'work',
    order: 4,
    scope: 'tenant',
    placement: 'sidebar',
    purpose: 'Your mail threads with prospects.',
    navStyle: 'tabs',
    count: COUNT_REPLIES,
    mobileTab: 4,
    tabs: [
      {
        id: 'conversations.threads',
        label: 'Threads',
        href: '/communication',
        purpose: 'Every mail thread with its full history; reply from the thread.',
        keywords: ['communication', 'mail', 'replies', 'inbox'],
      },
    ],
  },
  {
    id: 'discovery',
    label: 'Discovery',
    icon: 'Radar',
    group: 'build',
    order: 1,
    scope: 'tenant',
    placement: 'sidebar',
    purpose: 'Where and how new companies are found.',
    navStyle: 'tabs',
    tabs: [
      {
        id: 'discovery.searches',
        label: 'Searches',
        href: '/connectors',
        purpose: 'Search sources and their searches; open one to run it or read its runs.',
        keywords: ['connectors', 'recipes', 'sources', 'runs', 'crawl'],
      },
      {
        id: 'discovery.schedules',
        label: 'Schedules',
        href: '/connectors/engine',
        purpose: 'When searches run, for which products, and the quiet hours.',
        keywords: ['crawl engine', 'crawl plans', 'schedule'],
      },
    ],
  },
  {
    id: 'products',
    label: 'Products',
    icon: 'BookOpen',
    group: 'build',
    order: 2,
    scope: 'tenant',
    placement: 'sidebar',
    purpose: 'What you sell and what the AI knows about it.',
    navStyle: 'tabs',
    tabs: [
      {
        id: 'products.list',
        label: 'Products',
        href: '/products',
        purpose: 'Product profiles that drive discovery, qualification and outreach.',
        keywords: ['product profiles'],
      },
      {
        id: 'products.knowledge',
        label: 'Knowledge',
        href: '/knowledge',
        purpose: 'Knowledge sources the AI grounds drafts and replies in.',
        keywords: ['knowledge sources'],
      },
      {
        id: 'products.documents',
        label: 'Documents',
        href: '/documents',
        purpose: 'Uploaded files, indexed for retrieval on upload.',
        keywords: ['files', 'upload', 'pdf'],
      },
      {
        id: 'products.lessons',
        label: 'Lessons',
        href: '/learning',
        purpose: 'Learning memory: rules learned from your decisions and replies.',
        keywords: ['learning memory', 'rules'],
      },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: 'Settings',
    group: 'workspace',
    order: 1,
    scope: 'tenant',
    placement: 'sidebar',
    purpose: 'How this workspace is set up.',
    keywords: ['configuration'],
    navStyle: 'subnav',
    tabs: [
      {
        id: 'settings.members',
        label: 'Members',
        href: '/settings/members',
        section: 'Workspace',
        purpose: 'Who is in this workspace and their roles.',
        keywords: ['team', 'roles', 'users'],
      },
      {
        id: 'settings.billing',
        label: 'Plan & billing',
        href: '/settings/billing',
        section: 'Workspace',
        purpose: 'Plan, token wallet, top-up packs and invoices.',
        keywords: ['billing', 'subscription', 'tokens', 'wallet'],
      },
      {
        id: 'settings.usage',
        label: 'Usage',
        href: '/settings/usage',
        section: 'Workspace',
        purpose: 'Usage per kind of work and provider over a date range.',
        keywords: ['costs'],
      },
      {
        id: 'settings.audit',
        label: 'Audit log',
        href: '/settings/audit',
        section: 'Workspace',
        capability: 'admin',
        purpose: 'Who changed what in this workspace.',
        keywords: ['workspace audit log', 'history'],
      },
      {
        id: 'settings.mailboxes',
        label: 'Mailboxes',
        href: '/mailbox',
        section: 'Mail & sending',
        purpose: 'Connected SMTP/IMAP accounts: add, test, or fix a failing one.',
        keywords: ['mailbox', 'smtp', 'imap'],
      },
      {
        id: 'settings.signatures',
        label: 'Signatures',
        href: '/mailbox/signatures',
        section: 'Mail & sending',
        purpose: 'Email signatures for your mailboxes.',
      },
      {
        id: 'settings.suppression',
        label: 'Suppression',
        href: '/mailbox/suppression',
        section: 'Mail & sending',
        purpose: 'Addresses that are never emailed, and where each one came from.',
        keywords: ['unsubscribe', 'blocklist'],
      },
      {
        id: 'settings.outreach',
        label: 'Replies & follow-ups',
        href: '/settings/outreach',
        section: 'Mail & sending',
        purpose: 'Languages, reply auto-actions, follow-up steps and mailbox auto-sync.',
        keywords: ['outreach config', 'language', 'auto-actions'],
      },
      {
        id: 'settings.autopilot',
        label: 'Autopilot',
        href: '/autopilot',
        section: 'Automation',
        purpose: 'Automation steps, thresholds and the pause for all automation.',
        keywords: ['autopilot control', 'pause all automation', 'kill switch'],
      },
      {
        id: 'settings.health',
        label: 'Health checks',
        href: '/health',
        section: 'Automation',
        purpose: 'The weekly workspace health report; admins can run it now.',
        keywords: ['health report'],
      },
      {
        id: 'settings.integrations',
        label: 'AI & search',
        href: '/settings/integrations',
        section: 'Connections',
        purpose: 'AI provider, web search, embeddings and your own API keys.',
        keywords: ['integrations', 'api keys', 'byok', 'providers'],
      },
      {
        id: 'settings.crm',
        label: 'CRM & export',
        href: '/settings/crm',
        section: 'Connections',
        purpose: 'CRM connections and the CSV export of pipeline leads.',
        keywords: ['hubspot', 'csv'],
      },
      {
        id: 'settings.account',
        label: 'My account',
        href: '/settings/account',
        section: 'You',
        purpose: 'Your name and password.',
        keywords: ['profile', 'password'],
      },
    ],
  },
  {
    id: 'support',
    label: 'Help & support',
    icon: 'LifeBuoy',
    group: 'workspace',
    order: 2,
    scope: 'tenant',
    placement: 'menu',
    purpose: 'Message the platform team.',
    navStyle: 'tabs',
    count: COUNT_SUPPORT,
    tabs: [
      {
        id: 'support.threads',
        label: 'Help & support',
        href: '/support',
        purpose: 'Message the platform team; replies arrive here and as a notification.',
        keywords: ['support', 'help', 'contact', 'bug'],
        count: COUNT_SUPPORT,
      },
    ],
  },
  {
    id: 'console',
    label: 'Platform console',
    icon: 'Crown',
    group: 'platform',
    order: 1,
    scope: 'platform',
    placement: 'sidebar',
    superAdminOnly: true,
    purpose: 'Run the platform: tenants, users, providers and support.',
    keywords: ['admin', 'super-admin'],
    navStyle: 'tabs',
    count: COUNT_ADMIN_SUPPORT,
    tabs: [
      {
        id: 'console.overview',
        label: 'Overview',
        href: '/admin',
        purpose: 'Platform totals, tenant usage and spend.',
        keywords: ['platform console'],
      },
      {
        id: 'console.workspaces',
        label: 'Workspaces',
        href: '/admin/workspaces',
        purpose: 'Every tenant: plan, wallet and members.',
        keywords: ['tenants'],
      },
      {
        id: 'console.users',
        label: 'Users',
        href: '/admin/users',
        purpose: 'Every user, pre-authorisations and platform roles.',
      },
      {
        id: 'console.providers',
        label: 'Providers',
        href: '/admin/providers',
        purpose: 'Platform AI and search provider keys, with live checks.',
        keywords: ['api keys', 'models'],
      },
      {
        id: 'console.support',
        label: 'Support inbox',
        shortLabel: 'Support',
        href: '/admin/support',
        purpose: 'Support threads from every workspace.',
        keywords: ['support'],
        count: COUNT_ADMIN_SUPPORT,
      },
      {
        id: 'console.audit',
        label: 'Platform audit log',
        shortLabel: 'Audit',
        href: '/admin/audit',
        purpose: 'Platform events and their effects on tenants.',
        keywords: ['audit'],
      },
      {
        id: 'console.operations',
        label: 'Operations',
        href: '/admin/operations',
        purpose: 'Background work in progress: who holds which work lease, and leases a dead holder left.',
        keywords: ['ops', 'work leases', 'stuck work', 'background jobs'],
      },
    ],
  },
];

// ---- pages reached from inside an area ------------------------------------

/** Entity pages and create flows, by src/app pattern. */
export const DETAIL_ROUTES: Readonly<Record<string, DetailRoute>> = {
  '/onboarding': {
    area: 'today',
    tab: 'today.needs',
    label: 'Setup checklist',
    kind: 'flow',
    purpose: 'The step-by-step workspace setup.',
  },
  '/review/[id]': {
    area: 'review',
    tab: 'review.queue',
    label: 'Record',
    kind: 'detail',
    purpose: 'One company record: its verdicts, evidence and comments.',
    openedFrom: '/review',
  },
  '/pipeline/[id]': {
    area: 'pipeline',
    tab: 'pipeline.leads',
    label: 'Lead',
    kind: 'detail',
    purpose: 'One lead: contact email, owner, language, stage and its conversation.',
    openedFrom: '/pipeline',
  },
  '/contacts/[id]': {
    area: 'pipeline',
    tab: 'pipeline.contacts',
    label: 'Contact',
    kind: 'detail',
    purpose: 'One person: their threads and leads.',
    openedFrom: '/contacts',
  },
  '/drafts/[id]': {
    area: 'outreach',
    tab: 'outreach.drafts',
    label: 'Draft',
    kind: 'detail',
    purpose: 'One draft: edit, translate, approve or reject it.',
    openedFrom: '/drafts',
  },
  '/communication/[threadId]': {
    area: 'conversations',
    tab: 'conversations.threads',
    label: 'Thread',
    kind: 'detail',
    purpose: 'One conversation with its full history and the reply box.',
    openedFrom: '/communication',
  },
  '/mailbox/[id]/compose': {
    area: 'conversations',
    tab: 'conversations.threads',
    label: 'Compose',
    kind: 'create',
    purpose: 'Write a new email from one mailbox.',
    openedFrom: '/mailbox',
  },
  '/connectors/new': {
    area: 'discovery',
    tab: 'discovery.searches',
    label: 'New search source',
    kind: 'create',
    purpose: 'Add a source to search; then add its searches.',
  },
  '/connectors/[id]': {
    area: 'discovery',
    tab: 'discovery.searches',
    label: 'Search source',
    kind: 'detail',
    purpose: 'One source: its searches and recent runs.',
    openedFrom: '/connectors',
  },
  '/connectors/[id]/recipes/new': {
    area: 'discovery',
    tab: 'discovery.searches',
    label: 'New search',
    kind: 'create',
    purpose: 'Add a search (queries, target country, language) to a source.',
    openedFrom: '/connectors',
  },
  '/connectors/[id]/recipes/[recipeId]': {
    area: 'discovery',
    tab: 'discovery.searches',
    label: 'Search',
    kind: 'detail',
    purpose: 'One search: its queries, target country and language.',
    openedFrom: '/connectors',
  },
  '/connectors/[id]/runs/[runId]': {
    area: 'discovery',
    tab: 'discovery.searches',
    label: 'Run',
    kind: 'detail',
    purpose: 'One run of a search and its log.',
    openedFrom: '/connectors',
  },
  '/products/new': {
    area: 'products',
    tab: 'products.list',
    label: 'New product',
    kind: 'create',
    purpose: 'Create a product profile by hand.',
  },
  '/products/autofill': {
    area: 'products',
    tab: 'products.list',
    label: 'Draft a product with AI',
    kind: 'create',
    purpose: 'Let the AI draft a product profile from a page URL or spec PDFs.',
  },
  '/products/[id]': {
    area: 'products',
    tab: 'products.list',
    label: 'Product',
    kind: 'detail',
    purpose: 'One product profile and its knowledge.',
    openedFrom: '/products',
  },
  '/knowledge/new': {
    area: 'products',
    tab: 'products.knowledge',
    label: 'New knowledge source',
    kind: 'create',
    purpose: 'Add a URL, a note or an uploaded document as knowledge.',
  },
  '/knowledge/[id]': {
    area: 'products',
    tab: 'products.knowledge',
    label: 'Knowledge source',
    kind: 'detail',
    purpose: 'One knowledge source; re-index it after an edit.',
    openedFrom: '/knowledge',
  },
  '/documents/[id]': {
    area: 'products',
    tab: 'products.documents',
    label: 'Document',
    kind: 'detail',
    purpose: 'One uploaded file: download it or re-index it.',
    openedFrom: '/documents',
  },
  '/learning/new': {
    area: 'products',
    tab: 'products.lessons',
    label: 'New lesson',
    kind: 'create',
    purpose: 'Write a rule for qualification or outreach yourself.',
  },
  '/learning/[id]': {
    area: 'products',
    tab: 'products.lessons',
    label: 'Lesson',
    kind: 'detail',
    purpose: 'One learned rule: its evidence, confidence and switch.',
    openedFrom: '/learning',
  },
  '/mailbox/new': {
    area: 'settings',
    tab: 'settings.mailboxes',
    label: 'New mailbox',
    kind: 'create',
    purpose: 'Connect a mailbox: SMTP for sending, IMAP for receiving.',
  },
  '/mailbox/[id]': {
    area: 'settings',
    tab: 'settings.mailboxes',
    label: 'Mailbox',
    kind: 'detail',
    purpose: 'One mailbox: its status, what broke, and its messages.',
    openedFrom: '/mailbox',
  },
  '/mailbox/[id]/edit': {
    area: 'settings',
    tab: 'settings.mailboxes',
    label: 'Edit mailbox',
    kind: 'detail',
    purpose: "A mailbox's servers, limits, business window and status.",
    openedFrom: '/mailbox',
  },
  '/mailbox/[id]/test': {
    area: 'settings',
    tab: 'settings.mailboxes',
    label: 'Test mailbox',
    kind: 'detail',
    purpose: 'Send a test email from a mailbox.',
    openedFrom: '/mailbox',
  },
  '/settings/crm/new': {
    area: 'settings',
    tab: 'settings.crm',
    label: 'New CRM connection',
    kind: 'create',
    purpose: 'Connect a CRM.',
  },
  '/settings/crm/[id]': {
    area: 'settings',
    tab: 'settings.crm',
    label: 'CRM connection',
    kind: 'detail',
    purpose: 'One CRM connection: test, edit or archive it.',
    openedFrom: '/settings/crm',
  },
  '/support/[id]': {
    area: 'support',
    tab: 'support.threads',
    label: 'Support thread',
    kind: 'detail',
    purpose: 'One conversation with the platform team.',
    openedFrom: '/support',
  },
  '/admin/workspaces/new': {
    area: 'console',
    tab: 'console.workspaces',
    label: 'New workspace',
    kind: 'create',
    purpose: 'Create a tenant workspace.',
  },
  '/admin/workspaces/[id]': {
    area: 'console',
    tab: 'console.workspaces',
    label: 'Workspace',
    kind: 'detail',
    purpose: 'One tenant: plan, wallet, members and its audit trail.',
    openedFrom: '/admin/workspaces',
  },
  '/admin/users/[id]': {
    area: 'console',
    tab: 'console.users',
    label: 'User',
    kind: 'detail',
    purpose: 'One user: status, platform role and memberships.',
    openedFrom: '/admin/users',
  },
  '/admin/support/[id]': {
    area: 'console',
    tab: 'console.support',
    label: 'Support thread',
    kind: 'detail',
    purpose: 'One support conversation with a workspace.',
    openedFrom: '/admin/support',
  },
};

/**
 * Page files that are deliberately in no area, each with the reason. A
 * new page must go into an area, DETAIL_ROUTES or here.
 */
export const UNLISTED_ROUTES: Readonly<Record<string, string>> = {
  '/': 'Public landing and sign-in page; a signed-in visit goes to Today.',
  '/pending': 'Shown while an account waits for approval, outside the app chrome.',
  '/dashboard': 'Legacy URL: a permanent redirect to the Overview tab of Today (redirects.ts).',
  '/inbox': 'Legacy URL: a permanent redirect to Today that keeps ?tab (redirects.ts).',
  '/settings': 'Redirect stub to the first Settings page.',
  '/mailbox/threads/[id]': 'Legacy URL: a permanent redirect to /communication/[threadId].',
  '/test-only/error-boundary':
    'Test probe that throws on purpose; 404 unless ENABLE_TEST_ROUTES=1.',
  '/dev/gallery':
    'Design-system component gallery (DS-06) for design review; 404 unless ENABLE_TEST_ROUTES=1.',
};

// ---- actions, the interim stop, the account menu, the mobile tab bar ----

export interface NavAction {
  id: string;
  label: string;
  href: string;
  purpose: string;
  keywords?: ReadonlyArray<string>;
  capability: NavCapability;
  icon: NavIconName;
  /** Interim entries carry the deliverable that removes them. */
  removedBy?: string;
}

/**
 * Interim 'Emergency stop' (ia:F-10). Until the Pause pill (ia:F-18) ships,
 * this pinned entry opens the one workspace pause (PC-05, "Pause all
 * automation" on the send queue page): anyone who can edit may pause, so
 * it shows for every write role. It says what keeps running. Delete it
 * with ia:F-18.
 */
export const INTERIM_EMERGENCY_STOP: NavAction = {
  id: 'action.emergencyStop',
  label: 'Emergency stop',
  href: '/mailbox/queue#pause',
  purpose:
    'Pauses all automation: sending, follow-ups, autopilot, crawls and background AI wait. Inbox sync keeps reading.',
  keywords: ['pause', 'pause all outbound', 'pause all automation', 'kill switch', 'stop sending'],
  capability: 'write',
  icon: 'OctagonAlert',
  removedBy: 'ia:F-18',
};

/**
 * Cmd-K actions. The fourth decided action, 'Pause all outbound', is the
 * interim Emergency stop until ia:F-18 replaces it.
 */
export const NAV_ACTIONS: ReadonlyArray<NavAction> = [
  INTERIM_EMERGENCY_STOP,
  {
    id: 'action.addTeammate',
    label: 'Add a teammate',
    href: '/settings/members#add-member',
    purpose: 'Add someone to this workspace and pick their role.',
    keywords: ['invite', 'invite a teammate', 'new member'],
    capability: 'admin',
    icon: 'UserPlus',
  },
  {
    id: 'action.newProduct',
    label: 'New product',
    href: '/products/new',
    purpose: 'Create a product profile.',
    keywords: ['add product', 'product profile'],
    capability: 'write',
    icon: 'PackagePlus',
  },
  {
    id: 'action.newSearch',
    label: 'New search source',
    href: '/connectors/new',
    purpose: 'Add a source to search; then add its searches.',
    keywords: ['new search', 'new connector', 'discovery'],
    capability: 'write',
    icon: 'CirclePlus',
  },
];

/** The account (avatar) menu: tab ids, rendered in this order. */
export const ACCOUNT_MENU: ReadonlyArray<string> = ['settings.account', 'support.threads'];

export type MobileTabItem = { kind: 'area'; area: string } | { kind: 'more'; label: string };

/**
 * The phone tab bar (ia §6): Today · Review · Outreach · Conversations ·
 * More. Defined here, rendered by visual Phase 2; Pipeline lives in the
 * drawer behind More because it is a desktop board.
 */
export const MOBILE_TAB_BAR: ReadonlyArray<MobileTabItem> = [
  ...NAV_AREAS.filter((a) => a.mobileTab !== undefined)
    .sort((a, b) => a.mobileTab! - b.mobileTab!)
    .map((a): MobileTabItem => ({ kind: 'area', area: a.id })),
  { kind: 'more', label: 'More' },
];
