// Step B (app flow): unified approval inbox. One place for the
// operator's daily loop — Review · Drafts · Replies · Follow-ups —
// so they stop tab-hopping across four URLs. Each tab reuses the
// existing service-layer list/count functions; the underlying
// pages (/review, /drafts, /communication, /communication/follow-ups)
// remain canonical for deep links + bookmarks.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  ListChecks,
  MessageSquare,
  PencilLine,
  Timer,
} from 'lucide-react';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { db } from '@/lib/db/client';
import { mailMessages } from '@/lib/db/schema/mailing';
import { outreachThreadState } from '@/lib/db/schema/outreach';
import { listReviewItems } from '@/lib/services/review';
import { listOutreachDrafts } from '@/lib/services/outreach';
import {
  countFollowUpsByStatus,
  listFollowUps,
} from '@/lib/services/follow-up';
import { reviewItems } from '@/lib/db/schema/review';
import { outreachDrafts } from '@/lib/db/schema/outreach';
import { isNextRedirectError } from '@/lib/server-redirect';

type InboxTab = 'review' | 'drafts' | 'replies' | 'followups';
const VALID_TABS: ReadonlySet<InboxTab> = new Set([
  'review',
  'drafts',
  'replies',
  'followups',
]);

const ITEMS_PER_TAB = 50;

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) redirect('/');
    throw err;
  }

  const sp = await searchParams;
  const requested = sp.tab as InboxTab | undefined;
  const tab: InboxTab = requested && VALID_TABS.has(requested) ? requested : 'review';
  const ws = ctx.workspaceId;

  // Counts for all four tab badges, in parallel — small queries each.
  const [reviewCountRow, draftsCountRow, replyCountRow, followUpCounts] =
    await Promise.all([
      db
        .select({ n: sql<number>`count(*)::int` })
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

  return (
    <AppShell>
      <div className="page-intro">
        <p className="page-eyebrow">Daily loop</p>
        <h1 className="page-title">Inbox</h1>
        <p className="page-lede">
          Everything that needs your attention right now — review picks,
          drafts ready to approve, fresh replies, follow-ups awaiting send.
        </p>
      </div>

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
    </AppShell>
  );
}

function TabLink({
  tab,
  active,
  count,
  icon: Icon,
  children,
}: {
  tab: InboxTab;
  active: InboxTab;
  count: number;
  icon: typeof ListChecks;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={`/inbox?tab=${tab}`}
      className={active === tab ? 'active' : ''}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
        <Icon className="lucide" aria-hidden="true" />
        {children}
        {count > 0 ? (
          <span
            style={{
              padding: '0.05rem 0.45rem',
              borderRadius: '999px',
              background: 'var(--brand-accent-amber)',
              color: 'oklch(0.18 0.025 250)',
              fontSize: '0.72rem',
              fontWeight: 700,
              minWidth: '1.5rem',
              textAlign: 'center',
            }}
          >
            {count > 99 ? '99+' : count}
          </span>
        ) : null}
      </span>
    </Link>
  );
}

async function ReviewTab({
  ctx,
}: {
  ctx: Awaited<ReturnType<typeof getWorkspaceContext>>;
}) {
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
              <span className="badge">{item.state}</span>
            </div>
            <div className="meta">
              <span>{sourceRecord.sourceSystem}</span>
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

async function DraftsTab({
  ctx,
}: {
  ctx: Awaited<ReturnType<typeof getWorkspaceContext>>;
}) {
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
            <span className="badge">{draft.stage}</span>
            <span className="badge">{draft.status}</span>
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

async function RepliesTab({
  ctx,
}: {
  ctx: Awaited<ReturnType<typeof getWorkspaceContext>>;
}) {
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
            {m.intent ? <span className="badge">{m.intent}</span> : null}
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

async function FollowUpsTab({
  ctx,
}: {
  ctx: Awaited<ReturnType<typeof getWorkspaceContext>>;
}) {
  const rows = await listFollowUps(ctx, {
    status: 'awaiting_approval',
    limit: ITEMS_PER_TAB,
  });
  if (rows.length === 0) {
    return (
      <EmptyState
        label="No follow-ups awaiting approval"
        sub="When 'require approval' is on in Outreach config, staged follow-up drafts land here for review."
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
            <span className="badge">step {r.stepNumber}/{r.totalSteps}</span>
            <span className="badge">{r.status}</span>
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
    <div
      style={{
        padding: '1.75rem 1.5rem',
        border: '1px dashed var(--brand-border)',
        borderRadius: '0.7rem',
        textAlign: 'center',
        background: 'oklch(0.21 0.025 250 / 0.3)',
        marginTop: '0.5rem',
      }}
    >
      <p style={{ margin: 0, fontWeight: 600 }}>{label}</p>
      <p className="muted" style={{ margin: '0.4rem 0 0', fontSize: '0.85rem' }}>
        {sub}
      </p>
      {cta ? (
        <p style={{ marginTop: '0.85rem' }}>
          <Link href={cta.href} className="ghost-btn">
            {cta.label}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
