// Today › Needs you (was /inbox): the operator's daily loop in one place —
// Review · Drafts · Replies · Follow-ups — so they stop tab-hopping
// across four URLs. Each section reuses the existing service-layer
// list/count functions; the underlying pages (/review, /drafts,
// /communication, /communication/follow-ups) remain canonical for deep
// links and bookmarks. /inbox?tab=X redirects to /today?tab=X.

import Link from 'next/link';
import {
  ListChecks,
  MessageSquare,
  PencilLine,
  Timer,
} from 'lucide-react';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { mailMessages } from '@/lib/db/schema/mailing';
import { outreachThreadState } from '@/lib/db/schema/outreach';
import { HOME_PATH } from '@/lib/nav/registry';
import type { WorkspaceContext } from '@/lib/services/context';
import { listReviewItems } from '@/lib/services/review';
import { listOutreachDrafts } from '@/lib/services/outreach';
import {
  countFollowUpsByStatus,
  listFollowUps,
} from '@/lib/services/follow-up';
import { reviewItems } from '@/lib/db/schema/review';
import { outreachDrafts } from '@/lib/db/schema/outreach';
import { Badge, BadgeGroup, CountBadge, StatusBadge } from '@/components/Badge';
import type { CountTone } from '@/lib/ui/tone';

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

export async function NeedsYou({
  ctx,
  tab,
}: Readonly<{ ctx: WorkspaceContext; tab: NeedsYouTab }>) {
  const ws = ctx.workspaceId;

  // Counts for all four tab badges, in parallel — small queries each.
  const [reviewCountRow, draftsCountRow, replyCountRow, followUpCounts] =
    await Promise.all([
      db
        .select({
          n: sql<number>`count(*)::int`,
          needsReview: sql<number>`(count(*) filter (where ${reviewItems.state} = 'needs_review'))::int`,
        })
        .from(reviewItems)
        .where(
          and(
            eq(reviewItems.workspaceId, ws),
            inArray(reviewItems.state, ['new', 'needs_review']),
          ),
        ),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(outreachDrafts)
        .where(
          and(
            eq(outreachDrafts.workspaceId, ws),
            inArray(outreachDrafts.status, ['draft', 'needs_edit']),
          ),
        ),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(mailMessages)
        .innerJoin(
          outreachThreadState,
          and(
            eq(outreachThreadState.threadId, mailMessages.threadId),
            eq(outreachThreadState.workspaceId, mailMessages.workspaceId),
          ),
        )
        .where(
          and(
            eq(mailMessages.workspaceId, ws),
            eq(mailMessages.direction, 'inbound'),
          ),
        ),
      countFollowUpsByStatus(ctx),
    ]);

  const counts = {
    review: reviewCountRow[0]?.n ?? 0,
    drafts: draftsCountRow[0]?.n ?? 0,
    replies: replyCountRow[0]?.n ?? 0,
    followups: followUpCounts.awaiting_approval,
  };
  // The nav count policy (docs/design/IA.md): amber only while a decision
  // waits on this user. Untouched 'new' records alone stay neutral, and
  // replies stay neutral until reply triage can be trusted (I084).
  const tones: Record<NeedsYouTab, CountTone> = {
    review: (reviewCountRow[0]?.needsReview ?? 0) > 0 ? 'attention' : 'neutral',
    drafts: 'attention',
    replies: 'neutral',
    followups: 'attention',
  };

  return (
    <>
      <div className="scope-tabs">
        <TabLink tab="review" active={tab} count={counts.review} tone={tones.review} icon={ListChecks}>
          Review
        </TabLink>
        <TabLink tab="drafts" active={tab} count={counts.drafts} tone={tones.drafts} icon={PencilLine}>
          Drafts
        </TabLink>
        <TabLink tab="replies" active={tab} count={counts.replies} tone={tones.replies} icon={MessageSquare}>
          Replies
        </TabLink>
        <TabLink tab="followups" active={tab} count={counts.followups} tone={tones.followups} icon={Timer}>
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
  tone,
  icon: Icon,
  children,
}: {
  tab: NeedsYouTab;
  active: NeedsYouTab;
  count: number;
  tone: CountTone;
  icon: typeof ListChecks;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={`${HOME_PATH}?tab=${tab}`}
      className={active === tab ? 'active' : ''}
      aria-current={active === tab ? 'page' : undefined}
    >
      <span className="today-tab-label">
        <Icon className="lucide" aria-hidden="true" />
        {children}
        {count > 0 ? <CountBadge count={count} tone={tone} /> : null}
      </span>
    </Link>
  );
}

async function ReviewTab({ ctx }: { ctx: WorkspaceContext }) {
  const items = await listReviewItems(ctx, {
    state: ['new', 'needs_review'],
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
    status: ['draft', 'needs_edit'],
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
  // Inbound messages on outreach threads only — non-outreach inbox
  // mail lives on /mailbox. The join filters by membership in
  // outreach_thread_state.
  const rows = await db
    .select({
      id: mailMessages.id,
      threadId: mailMessages.threadId,
      fromName: mailMessages.fromName,
      fromAddress: mailMessages.fromAddress,
      subject: mailMessages.subject,
      receivedAt: mailMessages.receivedAt,
      createdAt: mailMessages.createdAt,
      intent: mailMessages.replyClassification,
    })
    .from(mailMessages)
    .innerJoin(
      outreachThreadState,
      and(
        eq(outreachThreadState.threadId, mailMessages.threadId),
        eq(outreachThreadState.workspaceId, mailMessages.workspaceId),
      ),
    )
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        eq(mailMessages.direction, 'inbound'),
      ),
    )
    .orderBy(desc(mailMessages.id))
    .limit(ITEMS_PER_TAB);

  if (rows.length === 0) {
    return (
      <EmptyState
        label="No recent replies on outreach threads"
        sub="Inbound messages on tracked outreach threads will appear here. Cold inbox mail goes to /mailbox."
      />
    );
  }
  return (
    <ul className="profile-list">
      {rows.map((m) => (
        <li key={m.id.toString()}>
          <div className="lead-row">
            <Link href={`/communication/${m.threadId ?? ''}`}>
              {m.subject || '(no subject)'}
            </Link>
            {m.intent ? <StatusBadge set="reply_class" value={m.intent} /> : null}
          </div>
          <div className="meta">
            <span>from {m.fromName ?? m.fromAddress}</span>
            <span>{(m.receivedAt ?? m.createdAt).toLocaleString()}</span>
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
    <div className="today-empty">
      <p className="today-empty-title">{label}</p>
      <p className="muted today-empty-sub">{sub}</p>
      {cta ? (
        <p className="today-empty-cta">
          <Link href={cta.href} className="ghost-btn">
            {cta.label}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
