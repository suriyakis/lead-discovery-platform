// Today › Needs you (was /inbox): the operator's daily loop in one place —
// Review · Drafts · Replies · Follow-ups — so they stop tab-hopping
// across four URLs. Each section reuses the existing service-layer
// list/count functions; the underlying pages (/review, /drafts,
// /communication, /communication/follow-ups) remain canonical for deep
// links and bookmarks. /inbox?tab=X redirects to /today?tab=X.
//
// MOB-02: the tab counts are the attention summary's keys (review.open,
// drafts.approve, replies.awaiting, followUps.approve) — the same object
// the sidebar badges and /api/attention carry — and each tab lists exactly
// the rows its key counts. The registry's count policy applies here too:
// Review is amber only while needs_review > 0, and Replies shows no
// number until reply triage is trusted (I084). A count that failed to load
// prints "—", never 0.

import Link from 'next/link';
import {
  ListChecks,
  MessageSquare,
  PencilLine,
  Timer,
} from 'lucide-react';
import { navCountsFromAttention } from '@/lib/attention/project';
import {
  DRAFT_APPROVAL_STATUSES,
  OPEN_REVIEW_STATES,
  listAwaitingReplies,
} from '@/lib/attention/service';
import type { AttentionSummary } from '@/lib/attention/types';
import { HOME_PATH } from '@/lib/nav/registry';
import { areaById, resolveNavCount } from '@/lib/nav/resolve';
import type { WorkspaceContext } from '@/lib/services/context';
import { listReviewItems } from '@/lib/services/review';
import { listOutreachDrafts } from '@/lib/services/outreach';
import { listFollowUps } from '@/lib/services/follow-up';
import { Badge, BadgeGroup, CountBadge, StatusBadge } from '@/components/Badge';
import { cx } from '@/lib/ui/cx';
import type { CountTone } from '@/lib/ui/tone';
import styles from './today.module.css';

export type NeedsYouTab = 'review' | 'drafts' | 'replies' | 'followups';
const VALID_TABS: ReadonlySet<NeedsYouTab> = new Set([
  'review',
  'drafts',
  'replies',
  'followups',
]);

/** ?tab= → a section, defaulting to Review. */
export function parseNeedsYouTab(raw: string | undefined): NeedsYouTab {
  return raw && VALID_TABS.has(raw as NeedsYouTab) ? (raw as NeedsYouTab) : 'review';
}

const ITEMS_PER_TAB = 50;

/** One tab's badge: the number (null = unknown, "—") and its tone; a tab
 *  whose count the policy hides has none. */
interface TabCount {
  value: number | null;
  tone: CountTone;
}

/** The four tabs' badges from the attention summary, by the registry's
 *  count policy. */
export function needsYouCounts(
  attention: AttentionSummary | null,
): Record<NeedsYouTab, TabCount | null> {
  if (!attention) {
    const unknown: TabCount = { value: null, tone: 'neutral' };
    return { review: unknown, drafts: unknown, replies: null, followups: unknown };
  }
  const nav = navCountsFromAttention(attention);
  const policy = (areaId: string): TabCount | null => {
    const r = resolveNavCount(areaById(areaId).count, nav.values, { unknown: nav.unknown });
    return r ? { value: r.value, tone: r.tone } : null;
  };
  const plain = (value: number | null): TabCount | null =>
    value === null ? { value: null, tone: 'neutral' } : value > 0 ? { value, tone: 'attention' } : null;
  return {
    // Amber only while a needs_review item waits; 'new' alone is neutral.
    review: policy('review'),
    drafts: plain(attention.counts['drafts.approve']),
    // The Conversations count is gated until I084: no number here either.
    replies: policy('conversations'),
    followups: plain(attention.counts['followUps.approve']),
  };
}

export async function NeedsYou({
  ctx,
  tab,
  attention,
}: Readonly<{ ctx: WorkspaceContext; tab: NeedsYouTab; attention: AttentionSummary | null }>) {
  const counts = needsYouCounts(attention);
  return (
    <>
      <div className="scope-tabs">
        <TabLink tab="review" active={tab} count={counts.review} icon={ListChecks}>
          Review
        </TabLink>
        <TabLink tab="drafts" active={tab} count={counts.drafts} icon={PencilLine}>
          Drafts
        </TabLink>
        <TabLink tab="replies" active={tab} count={counts.replies} icon={MessageSquare}>
          Replies
        </TabLink>
        <TabLink tab="followups" active={tab} count={counts.followups} icon={Timer}>
          Follow-ups
        </TabLink>
      </div>

      {tab === 'review' ? <ReviewTab ctx={ctx} /> : null}
      {tab === 'drafts' ? <DraftsTab ctx={ctx} /> : null}
      {tab === 'replies' ? <RepliesTab ctx={ctx} /> : null}
      {tab === 'followups' ? <FollowUpsTab ctx={ctx} /> : null}
    </>
  );
}

function TabLink({
  tab,
  active,
  count,
  icon: Icon,
  children,
}: {
  tab: NeedsYouTab;
  active: NeedsYouTab;
  count: TabCount | null;
  icon: typeof ListChecks;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={`${HOME_PATH}?tab=${tab}`}
      className={active === tab ? 'active' : ''}
      aria-current={active === tab ? 'page' : undefined}
      data-needs-tab={tab}
    >
      <span className={styles.tabLabel}>
        <Icon className="lucide" aria-hidden="true" />
        {children}
        {count ? <CountBadge count={count.value} tone={count.tone} /> : null}
      </span>
    </Link>
  );
}

async function ReviewTab({ ctx }: { ctx: WorkspaceContext }) {
  const items = await listReviewItems(ctx, {
    state: [...OPEN_REVIEW_STATES],
    limit: ITEMS_PER_TAB,
  });
  if (items.length === 0) {
    return (
      <EmptyState
        label="No review queue items"
        sub="Connector runs produce records that need a quick human verdict — nothing waiting right now."
      />
    );
  }
  return (
    <ul className="profile-list">
      {items.map(({ item, sourceRecord }) => {
        const title = sourceRecordLabel(sourceRecord);
        return (
          <li key={item.id.toString()}>
            <div className="lead-row">
              <Link href={`/review/${item.id}`}>{title}</Link>
              <StatusBadge set="review_item_state" value={item.state} />
            </div>
            <div className="meta">
              {sourceRecord.sourceUrl ? (
                <span>{sourceRecord.sourceUrl}</span>
              ) : null}
              <span>{item.createdAt.toLocaleString()}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function sourceRecordLabel(s: {
  sourceUrl: string | null;
  normalizedData: unknown;
  sourceSystem: string;
  sourceId: string;
}): string {
  // Best-effort title from the normalized payload (most connectors put
  // a 'name' or 'title' field there); fall back to sourceUrl or the
  // source id so the row always has something readable.
  if (s.normalizedData && typeof s.normalizedData === 'object') {
    const obj = s.normalizedData as Record<string, unknown>;
    const candidate = obj.name ?? obj.title ?? obj.companyName;
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return s.sourceUrl ?? `${s.sourceSystem}/${s.sourceId}`;
}

async function DraftsTab({ ctx }: { ctx: WorkspaceContext }) {
  const rows = await listOutreachDrafts(ctx, {
    status: [...DRAFT_APPROVAL_STATUSES],
    limit: ITEMS_PER_TAB,
  });
  if (rows.length === 0) {
    return (
      <EmptyState
        label="No drafts awaiting approval"
        sub="When discovery / engagement / pitch composers produce a draft, it lands here for your sign-off."
      />
    );
  }
  return (
    <ul className="profile-list">
      {rows.map(({ draft, product, sourceRecord }) => (
        <li key={draft.id.toString()}>
          <div className="lead-row">
            <Link href={`/drafts/${draft.id}`}>
              {draft.subject || '(no subject)'}
            </Link>
            <BadgeGroup>
              <StatusBadge set="outreach_draft_status" value={draft.status} />
              <StatusBadge set="outreach_stage" value={draft.stage} />
            </BadgeGroup>
          </div>
          <div className="meta">
            <span>{product.name}</span>
            <span>{sourceRecordLabel(sourceRecord)}</span>
            <span>{draft.createdAt.toLocaleString()}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

async function RepliesTab({ ctx }: { ctx: WorkspaceContext }) {
  // replies.awaiting: prospect replies nobody has answered yet (trash and
  // spam left out; newsletters and auto-replies are not prospect replies).
  const rows = await listAwaitingReplies(ctx, { limit: ITEMS_PER_TAB });

  if (rows.length === 0) {
    return (
      <EmptyState
        label="No prospect replies waiting for an answer"
        sub="A reply from a prospect shows here until someone answers it from the thread. Other inbox mail stays on /communication."
      />
    );
  }
  return (
    <ul className="profile-list">
      {rows.map((m) => (
        <li key={m.threadId.toString()}>
          <div className="lead-row">
            <Link href={`/communication/${m.threadId}`}>{m.subject || '(no subject)'}</Link>
            {m.classification ? <StatusBadge set="reply_class" value={m.classification} /> : null}
          </div>
          <div className="meta">
            <span>from {m.fromName ?? m.fromAddress}</span>
            <span>{m.receivedAt.toLocaleString()}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

async function FollowUpsTab({ ctx }: { ctx: WorkspaceContext }) {
  const rows = await listFollowUps(ctx, {
    status: 'awaiting_approval',
    limit: ITEMS_PER_TAB,
  });
  if (rows.length === 0) {
    return (
      <EmptyState
        label="No follow-ups awaiting approval"
        sub="When 'require approval' is on under Settings › Replies & follow-ups, staged follow-up drafts land here for review."
        cta={{ href: '/settings/outreach', label: 'Open follow-up settings' }}
      />
    );
  }
  return (
    <ul className="profile-list">
      {rows.map((r) => (
        <li key={r.id.toString()}>
          <div className="lead-row">
            <Link href={`/communication/${r.threadId.toString()}`}>
              {r.threadSubject || '(no subject)'}
            </Link>
            <BadgeGroup>
              <Badge>
                Step {r.stepNumber} of {r.totalSteps}
              </Badge>
              <StatusBadge set="follow_up_status" value={r.status} />
            </BadgeGroup>
          </div>
          <div className="meta">
            <span>{r.productName ?? '—'}</span>
            <span>→ {r.contactName ?? r.contactEmail ?? '—'}</span>
            <span>scheduled {r.scheduledFor.toLocaleString()}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({
  label,
  sub,
  cta,
}: {
  label: string;
  sub: string;
  cta?: { href: string; label: string };
}) {
  return (
    <div className={styles.empty}>
      <p className={styles.emptyTitle}>{label}</p>
      <p className={cx('muted', styles.emptySub)}>{sub}</p>
      {cta ? (
        <p className={styles.emptyCta}>
          <Link href={cta.href} className="ghost-btn">
            {cta.label}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
