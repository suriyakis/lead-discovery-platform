// MOB-02: the attention summary — one count source for the sidebar badges,
// Today's tiles and tabs, the bell, the assistant and GET /api/attention.
//
//   - every key on the prod-shaped and happy-path fixtures, each against
//     the default list of the page it opens;
//   - trashed and spam messages are never a reply waiting for an answer;
//   - a forced query error: degraded, the key null, and every surface
//     prints "—", never 0;
//   - badges = Today tiles = Needs-you tabs = /api/attention (one object);
//   - a failing mailbox reads the same on /health, in the assistant's
//     snapshot and in /api/attention; the snapshot names every finding;
//   - the route: 401 signed out, the pages' workspace resolution, no-store;
//   - p95 under 150 ms on the prod-shaped fixture scaled 10x.
//
// The session and next/navigation are stubbed; everything below them runs
// for real against the lane's test database.

import { createElement } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/connectors/mock';
import { load } from 'cheerio';
import { and, eq, inArray } from 'drizzle-orm';
import type { ZodSchema } from 'zod';
import { db } from '@/lib/db/client';
import {
  _setAIProviderForTests,
  type AIGenInput,
  type AIGenOptions,
  type AIGenResult,
  type IAIProvider,
} from '@/lib/ai';
import { users } from '@/lib/db/schema/auth';
import { connectorRecipes, connectors } from '@/lib/db/schema/connectors';
import { mailMessages, mailboxes } from '@/lib/db/schema/mailing';
import { outreachQueue } from '@/lib/db/schema/outreach';
import { reviewItems } from '@/lib/db/schema/review';
import { navCountsFromAttention } from '@/lib/attention/project';
import { getAttentionSummary } from '@/lib/attention/service';
import {
  ATTENTION_COUNT_KEYS,
  ATTENTION_KEY_DEFINITIONS,
  isAttentionSummary,
  type AttentionSummary,
} from '@/lib/attention/types';
import { getWorkspaceDiagnostics } from '@/lib/diagnostics/engine';
import { isProblem } from '@/lib/diagnostics/types';
import { askAssistant, STATE_MAX_FINDINGS } from '@/lib/services/assistant';
import { pauseAutomation } from '@/lib/services/automation-pause';
import { placeTenantHold } from '@/lib/services/holds';
import { getNavCounts } from '@/lib/services/nav-counts';
import { setActiveWorkspace } from '@/lib/services/workspace';
import { happyPath, prodShaped, type AttentionFixture } from './helpers/attention-fixtures';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { renderToHtml } from './helpers/next-render';

type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: 'member' | 'super_admin';
  accountStatus: 'pending' | 'active' | 'suspended' | 'rejected';
};
const session = vi.hoisted(() => ({ current: null as null | { user: SessionUser } }));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));

const nav = vi.hoisted(() => ({ pathname: '/today', search: '' }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({
    push() {},
    replace() {},
    refresh() {},
    prefetch() {},
    back() {},
    forward() {},
  }),
}));

const { AppShell } = await import('@/components/AppShell');
const { default: TodayPage } = await import('@/app/(app)/today/page');
const { NeedsYou } = await import('@/app/(app)/today/_needs-you');
const { default: DraftsPage } = await import('@/app/(app)/drafts/page');
const { default: HealthPage } = await import('@/app/(app)/health/page');
const { GET: attentionGET } = await import('@/app/api/attention/route');

// ---- helpers ------------------------------------------------------------------

function signIn(
  userId: string,
  role: SessionUser['role'] = 'member',
  accountStatus: SessionUser['accountStatus'] = 'active',
) {
  session.current = {
    user: { id: userId, email: `${userId}@test.local`, name: 'Pat Doe', role, accountStatus },
  };
}

async function api(): Promise<{ status: number; cache: string | null; body: unknown }> {
  const res = await attentionGET();
  return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() };
}

async function apiSummary(): Promise<AttentionSummary> {
  const r = await api();
  expect(r.status).toBe(200);
  expect(isAttentionSummary(r.body)).toBe(true);
  return r.body as AttentionSummary;
}

async function shell(pathname = '/today') {
  nav.pathname = pathname;
  nav.search = '';
  const tree = await AppShell({ children: createElement('h1', { id: 'page' }, 'Page') });
  return load((await renderToHtml(tree)).replaceAll('<!-- -->', ''));
}

/** The visible text of a sidebar area's badge ('' = no badge). */
function badge($: ReturnType<typeof load>, area: string) {
  const el = $(`aside.sidebar a[data-area="${area}"] .nav-count`);
  return { text: el.find('[aria-hidden="true"]').text(), tone: el.attr('data-tone') ?? null };
}

async function needsYou(f: AttentionFixture, tab: 'review' | 'drafts' | 'replies' | 'followups') {
  const attention = await getAttentionSummary(f.ctx);
  const html = await renderToHtml(await NeedsYou({ ctx: f.ctx, tab, attention }));
  return load(html.replaceAll('<!-- -->', ''));
}

/** The visible number on a Needs-you tab ('' = none). */
function tabCount($: ReturnType<typeof load>, tab: string): string {
  const el = $(`a[data-needs-tab="${tab}"] [data-tone]`);
  const shown = el.find('[aria-hidden="true"]');
  return (shown.length > 0 ? shown.text() : el.text()).trim();
}

async function today(view: 'needs' | 'overview', tab?: string) {
  nav.pathname = '/today';
  nav.search = view === 'overview' ? 'view=overview' : tab ? `tab=${tab}` : '';
  const tree = await TodayPage({
    searchParams: Promise.resolve(view === 'overview' ? { view: 'overview' } : { tab }),
  });
  return load((await renderToHtml(tree)).replaceAll('<!-- -->', ''));
}

function tile($: ReturnType<typeof load>, label: string): string | undefined {
  return $('.cockpit-card')
    .filter((_, el) => $(el).find('.cockpit-card-label').text() === label)
    .find('.cockpit-card-value')
    .text();
}

/**
 * Make every query that reads `table` fail the way a lost table does
 * ('relation … does not exist'), for the duration of a test.
 */
function failQueriesOn(table: unknown, message: string) {
  const realSelect = db.select.bind(db);
  return vi.spyOn(db, 'select').mockImplementation(((...args: unknown[]) => {
    const builder = (realSelect as (...a: unknown[]) => { from: (...a: unknown[]) => unknown })(
      ...args,
    );
    const realFrom = builder.from.bind(builder);
    builder.from = (t: unknown, ...rest: unknown[]) => {
      if (t === table) throw new Error(message);
      return realFrom(t, ...rest);
    };
    return builder;
  }) as unknown as typeof db.select);
}

/** Records the guide's prompt; answers with fixed text. */
class PromptSpy implements IAIProvider {
  public readonly id = 'stub';
  public readonly model = 'stub-1';
  public prompt = '';
  async generateText(input: AIGenInput, _o?: AIGenOptions): Promise<AIGenResult> {
    this.prompt = input.prompt;
    return { text: 'An answer.', model: this.model, usage: { inputTokens: 0, outputTokens: 0 } };
  }
  async generateJson<T>(_i: AIGenInput, schema: ZodSchema<T>): Promise<T> {
    return schema.parse({});
  }
  estimateCost(): number {
    return 0;
  }
  async healthCheck() {
    return { ok: true, detail: 'stub' };
  }
}

beforeEach(async () => {
  await truncateAll();
  session.current = null;
});

afterEach(() => {
  _setAIProviderForTests(null);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- the keys ------------------------------------------------------------------

describe('every key on the fixtures', () => {
  it('has one definition and one destination per key', () => {
    expect(Object.keys(ATTENTION_KEY_DEFINITIONS).sort()).toEqual([...ATTENTION_COUNT_KEYS].sort());
    for (const key of ATTENTION_COUNT_KEYS) {
      expect(ATTENTION_KEY_DEFINITIONS[key].destination, key).toMatch(/^\//);
    }
  });

  it('happy path: each key has the number the fixture says', async () => {
    const f = await happyPath();
    const s = await getAttentionSummary(f.ctx);
    expect(s.degraded).toBe(false);
    expect(s.failed).toEqual([]);
    expect(s.workspaceId).toBe(f.workspaceId.toString());
    expect(s.counts).toMatchObject(f.expected);
    // problems = the engine's problems, and the summary carries them.
    const problems = (await getWorkspaceDiagnostics(f.ctx, { fresh: true })).findings.filter(
      isProblem,
    );
    expect(s.counts.problems).toBe(problems.length);
    expect(s.findings.map((x) => x.code)).toEqual(problems.map((x) => x.code));
    expect(s.outreach).toMatchObject({ queued: 1, paused: false, live: true });
    expect(s.wallet).toMatchObject({ billingExempt: false });
    expect(s.health?.score).toBeGreaterThan(0);
    expect(s.platform).toBeNull();
  });

  it('per user: review.mine and notifications.unread differ by viewer', async () => {
    const f = await happyPath();
    const owner = await getAttentionSummary(f.ctx);
    const member = await getAttentionSummary(f.memberCtx);
    expect(owner.counts['review.mine']).toBe(1);
    expect(member.counts['review.mine']).toBe(1);
    expect(owner.counts['notifications.unread']).toBe(2);
    expect(member.counts['notifications.unread']).toBe(1);
    // Workspace keys are the same for everyone.
    expect(member.counts['review.open']).toBe(owner.counts['review.open']);
    expect(member.counts['support.unread']).toBe(owner.counts['support.unread']);
  });

  it('each number equals the default list of the page it opens', async () => {
    const f = await happyPath();
    const s = await getAttentionSummary(f.ctx);
    signIn(f.ownerId);

    // review.open -> Today › Review
    let $ = await needsYou(f, 'review');
    expect($('.profile-list > li')).toHaveLength(s.counts['review.open']!);
    // drafts.approve -> /drafts (default view) and Today › Drafts
    nav.pathname = '/drafts';
    const drafts = load(
      (await renderToHtml(await DraftsPage({ searchParams: Promise.resolve({}) }))).replaceAll(
        '<!-- -->',
        '',
      ),
    );
    expect(drafts('ul.lead-list > li')).toHaveLength(s.counts['drafts.approve']!);
    expect(drafts('select[name="status"] option[selected]').attr('value')).toBe('awaiting');
    $ = await needsYou(f, 'drafts');
    expect($('.profile-list > li')).toHaveLength(s.counts['drafts.approve']!);
    // followUps.approve -> Today › Follow-ups
    $ = await needsYou(f, 'followups');
    expect($('.profile-list > li')).toHaveLength(s.counts['followUps.approve']!);
    // replies.awaiting -> Today › Replies: exactly the unanswered threads
    $ = await needsYou(f, 'replies');
    const links = $('.profile-list > li a')
      .toArray()
      .map((el) => $(el).attr('href'));
    expect(links).toHaveLength(s.counts['replies.awaiting']!);
    expect(new Set(links)).toEqual(
      new Set(
        [f.threads.waitingNew, f.threads.answerFailed, f.threads.waitingOld].map(
          (id) => `/communication/${id}`,
        ),
      ),
    );
    // Newest reply first.
    expect(links[0]).toBe(`/communication/${f.threads.waitingNew}`);
  });

  it('prod-shaped: 310 untouched records, a newsletter-only inbox (X1) and a failing mailbox', async () => {
    const f = await prodShaped();
    const s = await getAttentionSummary(f.ctx);
    expect(s.degraded).toBe(false);
    expect(s.counts).toMatchObject(f.expected);
    // The newsletters are not replies waiting for anyone.
    expect(s.counts['replies.awaiting']).toBe(0);
    const codes = s.findings.map((x) => x.code);
    expect(codes).toContain('mailbox.failing');
    expect(s.findings.find((x) => x.code === 'mailbox.failing')).toMatchObject({
      severity: 'critical',
      href: `/mailbox/${f.failingMailboxId}`,
    });
    expect(s.outreach).toMatchObject({ live: false, queued: 0 });
    // The Review badge stays neutral: nothing is needs_review.
    const nav2 = navCountsFromAttention(s);
    expect(nav2.values).toMatchObject({ reviewPending: 310, reviewNeedsReview: 0 });
  });

  it('trashed and spam messages are excluded from the replies waiting', async () => {
    const f = await happyPath();
    const awaiting = async () => (await getAttentionSummary(f.ctx)).counts['replies.awaiting'];
    expect(await awaiting()).toBe(3);
    const inbound = (threadId: bigint) =>
      and(eq(mailMessages.threadId, threadId), eq(mailMessages.direction, 'inbound'));
    await db
      .update(mailMessages)
      .set({ trashedAt: new Date() })
      .where(inbound(f.threads.waitingNew!));
    expect(await awaiting()).toBe(2);
    await db
      .update(mailMessages)
      .set({ spamAt: new Date(), spamReason: 'manual' })
      .where(inbound(f.threads.answerFailed!));
    expect(await awaiting()).toBe(1);
    // Restored from the trash and from spam: waiting again.
    await db
      .update(mailMessages)
      .set({ trashedAt: null, spamAt: null })
      .where(
        inArray(mailMessages.threadId, [
          f.threads.waitingNew!,
          f.threads.answerFailed!,
          f.threads.trashed!,
          f.threads.spam!,
        ]),
      );
    expect(await awaiting()).toBe(5);
    // Answering a thread takes it off the list.
    await db.insert(mailMessages).values({
      workspaceId: f.workspaceId,
      mailboxId: f.activeMailboxId,
      threadId: f.threads.waitingOld!,
      direction: 'outbound',
      status: 'sent',
      messageId: '<answer@test>',
      fromAddress: 'sales@test.local',
      toAddresses: ['anna@prospect.test'],
      subject: 'Re: answer',
      sentAt: new Date(),
    });
    expect(await awaiting()).toBe(4);
  });
});

// ---- degraded ------------------------------------------------------------------

describe('a forced query error', () => {
  it('returns degraded with the key null, and every surface prints "—", never 0', async () => {
    const f = await happyPath();
    signIn(f.ownerId);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    failQueriesOn(reviewItems, 'relation "review_items" does not exist');

    const s = await getAttentionSummary(f.ctx);
    expect(s.degraded).toBe(true);
    expect(s.failed).toEqual(
      expect.arrayContaining(['review.open', 'review.needsReview', 'review.mine']),
    );
    expect(s.counts['review.open']).toBeNull();
    expect(s.counts['review.needsReview']).toBeNull();
    // The other keys still report.
    expect(s.counts['drafts.approve']).toBe(2);
    expect(s.counts['replies.awaiting']).toBe(3);

    // The route: 200, degraded, null — never 0.
    const body = await apiSummary();
    expect(body.degraded).toBe(true);
    expect(body.counts['review.open']).toBeNull();

    // The sidebar: "—" in the neutral tone.
    const $ = await shell();
    expect(badge($, 'review')).toEqual({ text: '—', tone: 'neutral' });
    expect($('aside.sidebar a[data-area="review"] .sr-only').text()).toContain('unavailable');
    expect(badge($, 'outreach').text).toBe('4');

    // Today › Needs you: the Review tab prints "—".
    const needs = await today('needs', 'drafts');
    expect(tabCount(needs, 'review')).toBe('—');
    expect(tabCount(needs, 'drafts')).toBe('2');
    // Today › Overview: the Pending review tile prints "—", with the warning.
    const overview = await today('overview');
    expect(tile(overview, 'Pending review')).toBe('—');
    expect(tile(overview, 'Drafts awaiting approval')).toBe('2');
    expect(overview.html()).toContain('Some numbers could not be loaded');
  });

  it('a failed bell count prints "—" on the bell, not nothing', async () => {
    const f = await happyPath();
    signIn(f.ownerId);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { notifications } = await import('@/lib/db/schema/notifications');
    failQueriesOn(notifications, 'relation "notifications" does not exist');
    const $ = await shell();
    expect($('.header-bell').attr('aria-label')).toBe('Notifications, unread count unavailable');
    expect($('.header-bell-count').text()).toBe('—');
  });
});

// ---- one object --------------------------------------------------------------------

describe('one count source: badges, Today and /api/attention agree', () => {
  it('sidebar badges, the bell, Today tiles and tabs equal /api/attention', async () => {
    const f = await happyPath();
    signIn(f.ownerId);
    const body = await apiSummary();
    const c = body.counts;

    const $ = await shell();
    // Review: open records, amber because one needs review.
    expect(badge($, 'review')).toEqual({ text: String(c['review.open']), tone: 'attention' });
    // Outreach: drafts + follow-ups awaiting approval.
    expect(badge($, 'outreach').text).toBe(String(c['drafts.approve']! + c['followUps.approve']!));
    // Conversations: gated until I084 — no number although replies wait.
    expect(c['replies.awaiting']).toBeGreaterThan(0);
    expect(badge($, 'conversations').text).toBe('');
    // The bell and the account menu's support count.
    expect($('.header-bell-count').text()).toBe(String(c['notifications.unread']));
    expect(
      $('.header-account-links a[href="/support"] .nav-count [aria-hidden="true"]').text(),
    ).toBe(String(c['support.unread']));
    // The projection the Sidebar makes in the browser is the same numbers.
    expect(navCountsFromAttention(body).values).toEqual((await getNavCounts(f.ctx)).values);

    // Today › Needs you tabs.
    const needs = await today('needs');
    expect(tabCount(needs, 'review')).toBe(String(c['review.open']));
    expect(tabCount(needs, 'drafts')).toBe(String(c['drafts.approve']));
    expect(tabCount(needs, 'followups')).toBe(String(c['followUps.approve']));
    expect(tabCount(needs, 'replies')).toBe('');
    // Today › Overview tiles.
    const overview = await today('overview');
    expect(tile(overview, 'Pending review')).toBe(String(c['review.open']));
    expect(tile(overview, 'Drafts awaiting approval')).toBe(String(c['drafts.approve']));
  });

  it('a decision moves the badge, the tile and the API together', async () => {
    const f = await happyPath();
    signIn(f.ownerId);
    const before = (await apiSummary()).counts['review.open']!;
    const [one] = await db
      .select({ id: reviewItems.id })
      .from(reviewItems)
      .where(and(eq(reviewItems.workspaceId, f.workspaceId), eq(reviewItems.state, 'new')))
      .limit(1);
    await db.update(reviewItems).set({ state: 'approved' }).where(eq(reviewItems.id, one!.id));
    const after = (await apiSummary()).counts['review.open']!;
    expect(after).toBe(before - 1);
    expect(badge(await shell(), 'review').text).toBe(String(after));
    expect(tile(await today('overview'), 'Pending review')).toBe(String(after));
  });
});

// ---- findings ------------------------------------------------------------------------

describe('one findings engine: /health, the assistant snapshot and /api/attention', () => {
  it('a failing mailbox reads the same on all three', async () => {
    const f = await prodShaped();
    signIn(f.ownerId);

    const body = await apiSummary();
    const fromApi = body.findings.find((x) => x.code === 'mailbox.failing')!;
    expect(fromApi).toMatchObject({ href: `/mailbox/${f.failingMailboxId}` });

    // /health
    nav.pathname = '/health';
    const health = load(
      (await renderToHtml(await HealthPage({ searchParams: Promise.resolve({}) }))).replaceAll(
        '<!-- -->',
        '',
      ),
    );
    const row = health('li[data-code="mailbox.failing"]').first();
    expect(row.find('p').first().text()).toBe(fromApi.title);
    expect(row.find('a').attr('href')).toBe(fromApi.href);

    // The assistant's snapshot
    const ai = new PromptSpy();
    _setAIProviderForTests(ai);
    await askAssistant(f.ctx, 'why are replies missing?');
    expect(ai.prompt).toContain(`] mailbox.failing: ${fromApi.title}.`);
    expect(ai.prompt).toContain(`Fix: [${fromApi.href}]`);
    // ... and its counts are the summary's.
    expect(ai.prompt).toContain(`open review items ${body.counts['review.open']} (0 need review)`);
    expect(ai.prompt).toContain(`drafts awaiting approval ${body.counts['drafts.approve']}`);
    expect(ai.prompt).toContain('prospect replies waiting for an answer 0');
  });

  it('the snapshot contains every finding code, past the ones listed in full', async () => {
    const f = await prodShaped();
    // More problems than the snapshot lists in full.
    await pauseAutomation(f.ctx, { source: 'api' });
    await placeTenantHold(f.ctx, {
      scope: 'capabilities',
      capabilities: ['sending'],
      reason: 'Under review',
    });
    await db.insert(outreachQueue).values({
      workspaceId: f.workspaceId,
      mailboxId: f.activeMailboxId,
      toAddresses: ['x@prospect.test'],
      subject: 'Failed',
      bodyText: 'Hi',
      status: 'failed',
      lastError: 'SMTP 421',
    });
    await db.insert(mailboxes).values({
      workspaceId: f.workspaceId,
      name: 'old',
      fromAddress: 'old@test.local',
      smtpHost: 'smtp.test.local',
      smtpUser: 'old',
      smtpPasswordSecretKey: 'mailbox.smtp_old',
      imapFolder: 'INBOX',
      status: 'paused',
    });
    const [search] = await db
      .insert(connectors)
      .values({
        workspaceId: f.workspaceId,
        templateType: 'internet_search',
        name: 'Web',
        active: true,
      })
      .returning({ id: connectors.id });
    await db.insert(connectorRecipes).values({
      workspaceId: f.workspaceId,
      connectorId: search!.id,
      name: 'no country',
      templateType: 'internet_search',
      selectors: { queries: ['waterproofing contractor'] },
      active: true,
    });
    const report = await getWorkspaceDiagnostics(f.ctx, { fresh: true });
    expect(report.findings.length).toBeGreaterThan(STATE_MAX_FINDINGS);

    const ai = new PromptSpy();
    _setAIProviderForTests(ai);
    await askAssistant(f.ctx, 'what is wrong?');
    for (const finding of report.findings) {
      expect(ai.prompt, finding.code).toContain(finding.code);
    }
    expect(ai.prompt).toMatch(/… and \d+ more on \[\/health\]: /);
  });
});

// ---- the route ------------------------------------------------------------------------

describe('GET /api/attention', () => {
  it('401 when signed out; 403 when the account is not active; 400 with no workspace; never cached', async () => {
    let r = await api();
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'unauthorized' });
    expect(r.cache).toContain('no-store');

    const pending = await seedUser({ email: 'pending@attention.test', accountStatus: 'pending' });
    signIn(pending, 'member', 'pending');
    r = await api();
    expect(r.status).toBe(403);
    expect(r.cache).toContain('no-store');

    const lonely = await seedUser({ email: 'lonely@attention.test' });
    signIn(lonely);
    r = await api();
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'no_workspace' });

    const f = await happyPath();
    signIn(f.ownerId);
    r = await api();
    expect(r.status).toBe(200);
    expect(r.cache).toContain('no-store');
  });

  it('resolves the workspace as pages do: god mode for a super-admin, a foreign pointer ignored', async () => {
    const f = await happyPath();
    const otherOwner = await seedUser({ email: 'other@attention.test' });
    const other = await seedWorkspace({ name: 'Other', ownerUserId: otherOwner });

    // A member whose pointer names a workspace they do not belong to.
    await db.update(users).set({ activeWorkspaceId: other }).where(eq(users.id, f.memberId));
    signIn(f.memberId);
    expect((await apiSummary()).workspaceId).toBe(f.workspaceId.toString());

    // A super-admin in god mode sees the tenant they are inside, and the
    // console's support count.
    const root = await seedUser({ email: 'root2@attention.test', role: 'super_admin' });
    await seedWorkspace({ name: 'Root home', ownerUserId: root });
    await setActiveWorkspace(root, f.workspaceId, { allowAnyAsSuperAdmin: true });
    signIn(root, 'super_admin');
    const god = await apiSummary();
    expect(god.workspaceId).toBe(f.workspaceId.toString());
    expect(god.counts['review.open']).toBe(f.expected['review.open']);
    expect(god.platform).toEqual({ supportUnread: 2 });
  });

  it('answers in under 150 ms at p95 on the prod-shaped fixture scaled 10x', async () => {
    const f = await prodShaped({ scale: 10 });
    signIn(f.ownerId);
    // Warm-up: the first call evaluates the findings; later polls read them
    // from the engine's memo (stale-while-revalidate), as in production.
    await apiSummary();
    await apiSummary();
    const runs: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const started = performance.now();
      const r = await attentionGET();
      expect(r.status).toBe(200);
      runs.push(performance.now() - started);
    }
    runs.sort((a, b) => a - b);
    const p95 = runs[Math.ceil(runs.length * 0.95) - 1]!;
    console.info(
      `[attention perf] /api/attention p50 ${runs[Math.floor(runs.length / 2)]!.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms (prod-shaped x10)`,
    );
    expect(p95, `p95 ${p95.toFixed(1)} ms over ${runs.length} calls`).toBeLessThan(150);
    // The scaled numbers are right too.
    const s = await getAttentionSummary(f.ctx);
    expect(s.counts['review.open']).toBe(3100);
    expect(s.counts['replies.awaiting']).toBe(0);
  }, 180_000);
});
