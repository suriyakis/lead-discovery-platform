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
  MessageSquare,
  Network,
  PencilLine,
  Send,
  ShoppingBag,
  Sparkles,
  TrendingUp,
  Workflow,
} from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db/client';
import { workspaceMembers, workspaces } from '@/lib/db/schema/workspaces';
import { users } from '@/lib/db/schema/auth';
import { getDashboardSignals } from '@/lib/services/dashboard-signals';
import type { PipelineState } from '@/lib/db/schema/pipeline';

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

  // Phase 47: bounce to /onboarding when the active workspace hasn't
  // been set up yet. The wizard itself sets `in_progress` on first
  // visit so a stuck-pending workspace doesn't loop on every reload.
  // Workspaces created before P47 default to `completed` so legacy
  // setups are unaffected.
  const primaryForOnboarding = memberships[0];
  if (
    primaryForOnboarding &&
    primaryForOnboarding.workspace.onboardingStatus !== 'completed'
  ) {
    redirect('/onboarding');
  }

  // Pick the user's active workspace (matches AppShell logic). Used to
  // scope the cockpit widgets.
  const userRows = await db
    .select({ activeWorkspaceId: users.activeWorkspaceId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const activeWsId = userRows[0]?.activeWorkspaceId ?? null;
  const activeMembership =
    (activeWsId !== null
      ? memberships.find((m) => m.workspace.id === BigInt(activeWsId))
      : null) ?? memberships[0];

  const signals = activeMembership
    ? await getDashboardSignals({ workspaceId: activeMembership.workspace.id })
    : null;

  const primary = memberships[0];
  const visibleModules = MODULES.filter((m) => !m.superAdminOnly || isSuperAdmin);

  return (
    <AppShell>
      <div className="dashboard-wrap">
        <header className="page-intro">
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

        {signals ? <CockpitGrid signals={signals} /> : null}

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

// ─── Cockpit widgets ──────────────────────────────────────────────────

function CockpitGrid({
  signals,
}: {
  signals: Awaited<ReturnType<typeof getDashboardSignals>>;
}) {
  return (
    <section className="cockpit-grid">
      <h2 className="section-title">Today&apos;s signals</h2>
      <p className="section-sub">
        What needs your attention right now.
      </p>
      <div className="cockpit-grid-inner">
        <SignalCard
          icon={ListChecks}
          label="Pending review"
          value={signals.reviewPending}
          href="/inbox?tab=review"
          tone={signals.reviewPending > 0 ? 'amber' : 'neutral'}
        />
        <SignalCard
          icon={PencilLine}
          label="Drafts awaiting approval"
          value={signals.drafts.total}
          href="/inbox?tab=drafts"
          tone={signals.drafts.total > 0 ? 'amber' : 'neutral'}
          sub={`${signals.drafts.discovery} disc · ${signals.drafts.engagement} eng · ${signals.drafts.pitch} pitch · ${signals.drafts.closing} close`}
        />
        <SignalCard
          icon={MessageSquare}
          label="Inbound replies (7d)"
          value={signals.replies7d}
          href="/inbox?tab=replies"
          tone={signals.replies7d > 0 ? 'teal' : 'neutral'}
        />
        <SignalCard
          icon={Send}
          label="Send queue"
          value={signals.sendQueue.queued}
          href="/mailbox/queue"
          tone={signals.sendQueue.paused ? 'bad' : 'neutral'}
          sub={`${signals.sendQueue.sentToday}/${signals.sendQueue.dailyCap} today${
            signals.sendQueue.nextSendAt
              ? ` · next ${signals.sendQueue.nextSendAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
              : ''
          }${signals.sendQueue.paused ? ' · PAUSED' : ''}`}
        />
        <FunnelCard funnel={signals.funnel} />
        {signals.recentInbound.length > 0 ? (
          <RecentRepliesCard items={signals.recentInbound} />
        ) : null}
      </div>
    </section>
  );
}

function SignalCard({
  icon: Icon,
  label,
  value,
  href,
  tone,
  sub,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  href: string;
  tone: 'amber' | 'teal' | 'bad' | 'neutral';
  sub?: string;
}) {
  const isActive = tone !== 'neutral' && value > 0;
  return (
    <Link
      href={href}
      className={`cockpit-card cockpit-card-tone-${tone}${
        isActive ? ' cockpit-card-active' : ''
      }`}
    >
      <div className="cockpit-card-head">
        <Icon className="cockpit-card-icon" aria-hidden="true" />
        <span className="cockpit-card-label">{label}</span>
      </div>
      <div className="cockpit-card-value">{value}</div>
      {sub ? <div className="cockpit-card-sub">{sub}</div> : null}
    </Link>
  );
}

function FunnelCard({ funnel }: { funnel: Record<PipelineState, number> }) {
  const stages: Array<{ key: PipelineState; label: string }> = [
    { key: 'relevant', label: 'Relevant' },
    { key: 'contacted', label: 'Contacted' },
    { key: 'replied', label: 'Replied' },
    { key: 'contact_identified', label: 'Identified' },
    { key: 'qualified', label: 'Qualified' },
    { key: 'handed_over', label: 'Handed over' },
  ];
  const max = Math.max(1, ...stages.map((s) => funnel[s.key]));
  return (
    <Link
      href="/pipeline"
      className="cockpit-card cockpit-card-tone-good cockpit-card-wide"
    >
      <div className="cockpit-card-head">
        <TrendingUp className="cockpit-card-icon" aria-hidden="true" />
        <span className="cockpit-card-label">Pipeline funnel</span>
      </div>
      <div className="cockpit-funnel">
        {stages.map(({ key, label }) => {
          const n = funnel[key];
          const pct = Math.round((n / max) * 100);
          return (
            <div className="cockpit-funnel-row" key={key}>
              <span className="cockpit-funnel-row-label">{label}</span>
              <div className="cockpit-funnel-track">
                <div
                  className="cockpit-funnel-fill"
                  style={{
                    width: `${pct}%`,
                    ['--cockpit-stage-color' as string]: stageColorFor(key),
                  }}
                />
              </div>
              <span className="cockpit-funnel-row-count">{n}</span>
            </div>
          );
        })}
      </div>
    </Link>
  );
}

function stageColorFor(state: PipelineState): string {
  // Cold (blue) → warm (green) gradient. Higher chroma + slightly
  // higher lightness than before so each stripe pops against the dark
  // card background.
  if (state === 'relevant') return 'oklch(0.72 0.16 245)';
  if (state === 'contacted') return 'oklch(0.74 0.14 210)';
  if (state === 'replied') return 'oklch(0.76 0.14 185)';
  if (state === 'contact_identified') return 'oklch(0.78 0.15 160)';
  if (state === 'qualified') return 'oklch(0.78 0.17 140)';
  if (state === 'handed_over') return 'oklch(0.8 0.18 120)';
  return 'oklch(0.7 0 0)';
}

function RecentRepliesCard({
  items,
}: {
  items: Array<{
    id: string;
    fromName: string | null;
    fromAddress: string;
    subject: string;
    receivedAt: Date;
    intent: string | null;
  }>;
}) {
  return (
    <Link
      href="/mailbox"
      className="cockpit-card cockpit-card-tone-teal cockpit-card-wide"
    >
      <div className="cockpit-card-head">
        <MessageSquare className="cockpit-card-icon" aria-hidden="true" />
        <span className="cockpit-card-label">Recent replies</span>
      </div>
      <ul className="cockpit-replies-list">
        {items.map((m) => (
          <li key={m.id}>
            <div className="cockpit-reply-head">
              <span className="cockpit-reply-from">
                {m.fromName ?? m.fromAddress}
              </span>
              <span className="cockpit-reply-time">
                {m.receivedAt.toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>
            <div className="cockpit-reply-subject">
              {m.intent ? <span className="badge">{m.intent}</span> : null}
              {m.subject || '(no subject)'}
            </div>
          </li>
        ))}
      </ul>
    </Link>
  );
}
