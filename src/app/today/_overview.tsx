// Today › Overview (was /dashboard): who you are and which workspace you
// are in, the workspace signals (review, drafts, replies, send queue,
// pipeline funnel, recent replies), and the areas of the app. The area
// tiles come from the navigation registry, so they can no longer drift
// from the sidebar the way the old hand-written module list did (I082).
// /dashboard redirects to /today?view=overview.

import Link from 'next/link';
import {
  ArrowRight,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  PencilLine,
  Send,
  TrendingUp,
} from 'lucide-react';
import { NavIcon } from '@/components/NavIcon';
import { HOME_PATH } from '@/lib/nav/registry';
import { areaHref, sidebarAreas, type NavViewer } from '@/lib/nav/resolve';
import { getDashboardSignals } from '@/lib/services/dashboard-signals';
import type { getActiveWorkspaceSummary } from '@/lib/services/workspace';
import type { PipelineState } from '@/lib/db/schema/pipeline';

export interface TodayOverviewProps {
  user: { name: string | null; email: string | null; role: string };
  active: Awaited<ReturnType<typeof getActiveWorkspaceSummary>>;
  signals: Awaited<ReturnType<typeof getDashboardSignals>>;
  showSetupLink: boolean;
  viewer: NavViewer;
}

export function TodayOverview({
  user,
  active,
  signals,
  showSetupLink,
  viewer,
}: Readonly<TodayOverviewProps>) {
  // Every sidebar area except Today itself, in sidebar order.
  const areas = sidebarAreas(viewer).filter((a) => areaHref(a) !== HOME_PATH);
  return (
    <>
      <section className="profile-cards">
        <article className="profile-card">
          <div className="profile-card-header">
            <span className="profile-card-eyebrow">You</span>
            <span className={`role-pill role-pill-${user.role}`}>
              {user.role.replace('_', ' ')}
            </span>
          </div>
          <h2 className="profile-card-title">{user.name ?? '—'}</h2>
          <p className="profile-card-meta">{user.email}</p>
        </article>

        <article className="profile-card">
          <div className="profile-card-header">
            <span className="profile-card-eyebrow">Active workspace</span>
            {active.isGodMode ? (
              <span className="role-pill role-pill-super_admin">god mode</span>
            ) : (
              <span className={`role-pill role-pill-${active.memberRole}`}>
                {active.memberRole}
              </span>
            )}
          </div>
          <h2 className="profile-card-title">{active.workspace.name}</h2>
          <p className="profile-card-meta">
            <code>{active.workspace.slug}</code>
            {active.workspace.status === 'archived' ? ' · archived' : null}
            {active.membershipCount > 1 ? (
              <>
                {' · '}
                member of {active.membershipCount} workspaces
              </>
            ) : null}
          </p>
          {showSetupLink ? (
            <p className="profile-card-meta">
              <Link href="/onboarding">Continue workspace setup</Link>
            </p>
          ) : null}
        </article>
      </section>

      <CockpitGrid signals={signals} />

      <section className="dashboard-modules">
        <div className="section-header">
          <h2 className="section-title">Areas</h2>
          <p className="section-sub">Everything else is one click away in the sidebar.</p>
        </div>
        <div className="module-tile-grid">
          {areas.map((area) => (
            <Link key={area.id} href={areaHref(area)} className="module-tile">
              <div className="module-tile-icon">
                <NavIcon name={area.icon} />
              </div>
              <div className="module-tile-body">
                <h3>{area.label}</h3>
                <p>{area.purpose}</p>
              </div>
              <ArrowRight className="module-tile-arrow" aria-hidden="true" />
            </Link>
          ))}
        </div>
      </section>
    </>
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
          href={`${HOME_PATH}?tab=review`}
          tone={signals.reviewPending > 0 ? 'amber' : 'neutral'}
        />
        <SignalCard
          icon={PencilLine}
          label="Drafts awaiting approval"
          value={signals.drafts.total}
          href={`${HOME_PATH}?tab=drafts`}
          tone={signals.drafts.total > 0 ? 'amber' : 'neutral'}
          sub={`${signals.drafts.discovery} disc · ${signals.drafts.engagement} eng · ${signals.drafts.pitch} pitch · ${signals.drafts.closing} close`}
        />
        <SignalCard
          icon={MessageSquare}
          label="Inbound replies (7d)"
          value={signals.replies7d}
          href={`${HOME_PATH}?tab=replies`}
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
                {/* The stage colour comes from globals.css by data-stage;
                    only the bar length is data. */}
                <div
                  className="cockpit-funnel-fill"
                  data-stage={key}
                  style={{ width: `${pct}%` }}
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
      href="/communication"
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
