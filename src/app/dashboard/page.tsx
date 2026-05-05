import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import {
  AlertOctagon,
  ArrowRight,
  BookOpen,
  Crown,
  FileText,
  Inbox,
  KanbanSquare,
  Key,
  Lightbulb,
  ListChecks,
  type LucideIcon,
  Network,
  PencilLine,
  ShoppingBag,
  Sparkles,
  Workflow,
} from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db/client';
import { workspaceMembers, workspaces } from '@/lib/db/schema/workspaces';

interface ModuleTile {
  href: string;
  title: string;
  blurb: string;
  icon: LucideIcon;
  /** Visual accent — mapped to a CSS class. */
  tone?: 'primary' | 'teal' | 'amber' | 'violet';
  /** super_admin gate. */
  superAdminOnly?: boolean;
}

const MODULES: ReadonlyArray<ModuleTile> = [
  {
    href: '/products',
    title: 'Product Profiles',
    blurb: 'Define what you sell — drives discovery and outreach.',
    icon: ShoppingBag,
    tone: 'primary',
  },
  {
    href: '/connectors',
    title: 'Connectors',
    blurb: 'Discovery sources, recipes, and runs against your providers.',
    icon: Network,
    tone: 'primary',
  },
  {
    href: '/review',
    title: 'Review queue',
    blurb: 'Approve, reject, and comment on harvested records.',
    icon: ListChecks,
    tone: 'amber',
  },
  {
    href: '/leads',
    title: 'Leads',
    blurb: 'Records the qualification engine ranked as relevant.',
    icon: Sparkles,
    tone: 'teal',
  },
  {
    href: '/pipeline',
    title: 'Pipeline',
    blurb: 'Commercial pipeline: relevant → contacted → replied → qualified.',
    icon: KanbanSquare,
    tone: 'teal',
  },
  {
    href: '/drafts',
    title: 'Outreach drafts',
    blurb: 'Generated drafts awaiting human review and approval.',
    icon: PencilLine,
    tone: 'amber',
  },
  {
    href: '/mailbox',
    title: 'Mailbox',
    blurb: 'SMTP/IMAP accounts, threads, signatures, suppression.',
    icon: Inbox,
  },
  {
    href: '/documents',
    title: 'Documents',
    blurb: 'Uploaded files: pricing, specs, case studies.',
    icon: FileText,
  },
  {
    href: '/knowledge',
    title: 'Knowledge sources',
    blurb: 'Documents, URLs, and excerpts attached to products.',
    icon: BookOpen,
  },
  {
    href: '/learning',
    title: 'Learning memory',
    blurb: 'Lessons distilled from review feedback.',
    icon: Lightbulb,
    tone: 'violet',
  },
  {
    href: '/autopilot',
    title: 'Autopilot',
    blurb: 'Per-step automation toggles + emergency pause.',
    icon: AlertOctagon,
    tone: 'amber',
  },
  {
    href: '/settings/integrations',
    title: 'Integrations',
    blurb: 'API keys, BYOK for OpenAI / Anthropic / SerpAPI.',
    icon: Key,
  },
  {
    href: '/settings/crm',
    title: 'CRM & Export',
    blurb: 'HubSpot adapter, contact + deal push, sync log.',
    icon: Workflow,
  },
  {
    href: '/admin',
    title: 'God mode',
    blurb: 'Platform-wide views, impersonation, super-admin controls.',
    icon: Crown,
    tone: 'violet',
    superAdminOnly: true,
  },
];

export default async function Dashboard() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/');
  }
  // Phase 15: bounce non-active users to the pending wall.
  if (
    session.user.accountStatus !== 'active' &&
    session.user.role !== 'super_admin'
  ) {
    redirect('/pending');
  }

  const userId = session.user.id;
  const isSuperAdmin = session.user.role === 'super_admin';

  const memberships = await db
    .select({
      workspace: workspaces,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId));

  const primary = memberships[0];
  const visibleModules = MODULES.filter((m) => !m.superAdminOnly || isSuperAdmin);

  return (
    <AppShell>
      <div className="dashboard-wrap">
        <header className="page-header">
          <p className="page-eyebrow">Workspace overview</p>
          <h1 className="page-title">
            Welcome back{session.user.name ? `, ${session.user.name.split(' ')[0]}` : ''}.
          </h1>
          <p className="page-lede">
            Jump back into discovery, qualification, and outreach. Every module
            is workspace-scoped and audit-logged.
          </p>
        </header>

        <section className="profile-cards">
          <article className="profile-card">
            <div className="profile-card-header">
              <span className="profile-card-eyebrow">You</span>
              <span className={`role-pill role-pill-${session.user.role}`}>
                {session.user.role.replace('_', ' ')}
              </span>
            </div>
            <h2 className="profile-card-title">{session.user.name ?? '—'}</h2>
            <p className="profile-card-meta">{session.user.email}</p>
          </article>

          {primary ? (
            <article className="profile-card">
              <div className="profile-card-header">
                <span className="profile-card-eyebrow">Active workspace</span>
                <span className={`role-pill role-pill-${primary.role}`}>
                  {primary.role}
                </span>
              </div>
              <h2 className="profile-card-title">{primary.workspace.name}</h2>
              <p className="profile-card-meta">
                <code>{primary.workspace.slug}</code>
                {memberships.length > 1 ? (
                  <>
                    {' · '}
                    member of {memberships.length} workspaces
                  </>
                ) : null}
              </p>
            </article>
          ) : (
            <article className="profile-card profile-card-empty">
              <h2 className="profile-card-title">No workspace yet</h2>
              <p className="profile-card-meta">
                If you expect to be the platform owner, check that your email
                matches <code>OWNER_EMAIL</code> in the server config.
              </p>
            </article>
          )}
        </section>

        {primary ? (
          <section className="dashboard-modules">
            <div className="section-header">
              <h2 className="section-title">Modules</h2>
              <p className="section-sub">Pick a workspace to dive in.</p>
            </div>
            <div className="module-tile-grid">
              {visibleModules.map((m) => {
                const Icon = m.icon;
                const toneClass = m.tone ? `module-tile-${m.tone}` : '';
                return (
                  <Link
                    key={m.href}
                    href={m.href}
                    className={`module-tile ${toneClass}`.trim()}
                  >
                    <div className="module-tile-icon">
                      <Icon aria-hidden="true" />
                    </div>
                    <div className="module-tile-body">
                      <h3>{m.title}</h3>
                      <p>{m.blurb}</p>
                    </div>
                    <ArrowRight className="module-tile-arrow" aria-hidden="true" />
                  </Link>
                );
              })}
            </div>
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}
