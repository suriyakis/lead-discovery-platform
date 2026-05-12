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
      <div
        style={{
          display: 'grid',
          gap: '0.75rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          marginBottom: '2rem',
        }}
      >
        <SignalCard
          icon={ListChecks}
          label="Pending review"
          value={signals.reviewPending}
          href="/review"
          tone={signals.reviewPending > 0 ? 'amber' : 'neutral'}
        />
        <SignalCard
          icon={PencilLine}
          label="Drafts awaiting approval"
          value={signals.drafts.total}
          href="/drafts"
          tone={signals.drafts.total > 0 ? 'amber' : 'neutral'}
          sub={`${signals.drafts.discovery} disc · ${signals.drafts.engagement} eng · ${signals.drafts.pitch} pitch · ${signals.drafts.closing} close`}
        />
        <SignalCard
          icon={MessageSquare}
          label="Inbound replies (7d)"
          value={signals.replies7d}
          href="/mailbox"
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
  const accent = {
    amber: 'oklch(0.85 0.16 75)',
    teal: 'oklch(0.78 0.12 195)',
    bad: 'oklch(0.7 0.18 25)',
    neutral: 'oklch(0.75 0 0)',
  }[tone];
  return (
    <Link
      href={href}
      style={{
        display: 'block',
        padding: '0.9rem 1rem',
        borderRadius: '0.6rem',
        border: '1px solid oklch(0.85 0 0 / 0.3)',
        borderLeft: `4px solid ${accent}`,
        background: 'oklch(0.99 0 0 / 0.5)',
        textDecoration: 'none',
        color: 'inherit',
        transition: 'transform 0.1s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.3rem' }}>
        <Icon size={16} aria-hidden="true" style={{ color: accent }} />
        <span style={{ fontSize: '0.85em', fontWeight: 500 }}>{label}</span>
      </div>
      <div style={{ fontSize: '2rem', fontWeight: 700, lineHeight: 1 }}>{value}</div>
      {sub ? (
        <div style={{ fontSize: '0.8em', opacity: 0.7, marginTop: '0.3rem' }}>{sub}</div>
      ) : null}
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
      style={{
        display: 'block',
        padding: '0.9rem 1rem',
        borderRadius: '0.6rem',
        border: '1px solid oklch(0.85 0 0 / 0.3)',
        borderLeft: '4px solid oklch(0.7 0.15 165)',
        gridColumn: 'span 2',
        background: 'oklch(0.99 0 0 / 0.5)',
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <TrendingUp size={16} aria-hidden="true" style={{ color: 'oklch(0.7 0.15 165)' }} />
        <span style={{ fontSize: '0.85em', fontWeight: 500 }}>Pipeline funnel</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        {stages.map(({ key, label }) => {
          const n = funnel[key];
          const pct = Math.round((n / max) * 100);
          return (
            <div key={key} style={{ display: 'grid', gridTemplateColumns: '6em 1fr 2em', gap: '0.5rem', alignItems: 'center' }}>
              <span style={{ fontSize: '0.78em', opacity: 0.8 }}>{label}</span>
              <div
                style={{
                  height: '0.55rem',
                  background: 'oklch(0.92 0 0)',
                  borderRadius: '0.3rem',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${pct}%`,
                    height: '100%',
                    background: stageColorFor(key),
                    borderRadius: '0.3rem',
                    transition: 'width 0.3s',
                  }}
                />
              </div>
              <span style={{ fontSize: '0.85em', fontWeight: 600, textAlign: 'right' }}>{n}</span>
            </div>
          );
        })}
      </div>
    </Link>
  );
}

function stageColorFor(state: PipelineState): string {
  // Cold → warm gradient, mirrors the per-stage outreach colors.
  if (state === 'relevant') return 'oklch(0.7 0.15 240)'; // cold blue
  if (state === 'contacted') return 'oklch(0.72 0.13 200)';
  if (state === 'replied') return 'oklch(0.74 0.13 175)';
  if (state === 'contact_identified') return 'oklch(0.76 0.13 150)';
  if (state === 'qualified') return 'oklch(0.78 0.16 130)'; // warm green
  if (state === 'handed_over') return 'oklch(0.78 0.18 110)';
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
      style={{
        display: 'block',
        padding: '0.9rem 1rem',
        borderRadius: '0.6rem',
        border: '1px solid oklch(0.85 0 0 / 0.3)',
        borderLeft: '4px solid oklch(0.78 0.12 195)',
        gridColumn: 'span 2',
        background: 'oklch(0.99 0 0 / 0.5)',
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <MessageSquare size={16} aria-hidden="true" style={{ color: 'oklch(0.78 0.12 195)' }} />
        <span style={{ fontSize: '0.85em', fontWeight: 500 }}>Recent replies</span>
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '0.85em' }}>
        {items.map((m) => (
          <li key={m.id} style={{ padding: '0.25rem 0', borderBottom: '1px dashed oklch(0.9 0 0)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
              <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.fromName ?? m.fromAddress}
              </span>
              <span style={{ opacity: 0.6, fontSize: '0.85em', whiteSpace: 'nowrap' }}>
                {m.receivedAt.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <div style={{ opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {m.intent ? <span className="badge" style={{ marginRight: '0.4rem', fontSize: '0.75em' }}>{m.intent}</span> : null}
              {m.subject || '(no subject)'}
            </div>
          </li>
        ))}
      </ul>
    </Link>
  );
}
