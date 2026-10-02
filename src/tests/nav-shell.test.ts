// DS-05 in the real shell, against the test database: AppShell renders the
// registry's sidebar for the viewer's role with the badge numbers from
// nav-counts and the registry's count policy, one wordmark per page, the
// account menu and the Search button; Today carries the old dashboard and
// inbox content, and the retired URLs answer permanent redirects to it.
// Also pins the autopilot step order the handbook prints (AP-03).

import { createElement } from 'react';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { load } from 'cheerio';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { sourceRecords } from '@/lib/db/schema/connectors';
import { reviewItems } from '@/lib/db/schema/review';
import { supportThreads } from '@/lib/db/schema/support';
import { AUTOPILOT_STEPS } from '@/lib/autopilot/steps';
import { makeWorkspaceContext, type WorkspaceRole } from '@/lib/services/context';
import { runOnce, updateAutopilotSettings } from '@/lib/services/autopilot';
import { getNavCounts } from '@/lib/services/nav-counts';
import { setActiveWorkspace } from '@/lib/services/workspace';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { expectRedirect, redirectTarget, renderToHtml } from './helpers/next-render';

const session = vi.hoisted(() => ({
  current: null as null | {
    user: { id: string; email: string; name: string; role: string; accountStatus: string };
  },
}));
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
const { default: TodayPage } = await import('@/app/today/page');
const { default: DashboardRedirect } = await import('@/app/dashboard/page');
const { default: InboxRedirect } = await import('@/app/inbox/page');
const { default: Home } = await import('@/app/page');

async function signInAs(userId: string, role: 'member' | 'super_admin' = 'member') {
  session.current = {
    user: {
      id: userId,
      email: `${userId}@test.local`,
      name: 'Pat Doe',
      role,
      accountStatus: 'active',
    },
  };
}

async function shell(pathname = '/today', search = '') {
  nav.pathname = pathname;
  nav.search = search;
  const tree = await AppShell({ children: createElement('h1', { id: 'page' }, 'Page') });
  return load(await renderToHtml(tree));
}

/** A workspace whose only member is `role` (plus an owner when needed). */
async function workspaceWith(role: WorkspaceRole | 'owner') {
  const owner = await seedUser({ email: `owner-${role}@test.local` });
  const user = role === 'owner' ? owner : await seedUser({ email: `${role}@test.local` });
  const ws = await seedWorkspace({
    name: `WS ${role}`,
    ownerUserId: owner,
    extraMembers: role === 'owner' ? [] : [{ userId: user, role: role as never }],
  });
  return { ws, user, owner };
}

/** Prod-shaped review queue: `n` untouched records (prod: 310, all "new"). */
async function seedNewRecords(workspaceId: bigint, n: number): Promise<bigint[]> {
  const records = await db
    .insert(sourceRecords)
    .values(
      Array.from({ length: n }, (_, i) => ({
        workspaceId,
        sourceSystem: 'mock',
        sourceId: `prod-shaped-${i}`,
        rawData: {},
        normalizedData: { name: `Company ${i}` },
      })),
    )
    .returning({ id: sourceRecords.id });
  const items = await db
    .insert(reviewItems)
    .values(records.map((r) => ({ workspaceId, sourceRecordId: r.id, state: 'new' as const })))
    .returning({ id: reviewItems.id });
  return items.map((i) => i.id);
}

beforeEach(async () => {
  await truncateAll();
  session.current = null;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('AppShell renders the registry for the viewer', () => {
  it('a workspace member: 8 sidebar items, one wordmark, Search, the account menu, the Emergency stop (PC-05)', async () => {
    const { user } = await workspaceWith('member');
    await signInAs(user);
    const $ = await shell();
    expect($('aside.sidebar a[data-area]')).toHaveLength(8);
    expect($('aside.sidebar a[data-area]').first().attr('href')).toBe('/today');
    expect($('aside.sidebar a[aria-current="page"]').attr('data-area')).toBe('today');
    expect($('[data-brand-wordmark]')).toHaveLength(1);
    expect($('[data-brand-wordmark]').text()).toBe('lead/sonar');
    expect($('svg[data-brand-mark]')).toHaveLength(1);
    expect($('[data-command-palette-trigger]')).toHaveLength(1);
    expect(
      $('.header-account-links a')
        .toArray()
        .map((el) => $(el).attr('href')),
    ).toEqual(['/settings/account', '/support']);
    expect($('.sidebar-stop').attr('href')).toBe('/mailbox/queue#pause');
    expect($('#page').text()).toBe('Page');
  });

  it('a super-admin: 9 items, the Platform console last', async () => {
    const admin = await seedUser({ email: 'root@test.local', role: 'super_admin' });
    await seedWorkspace({ name: 'Home', ownerUserId: admin });
    await signInAs(admin, 'super_admin');
    const $ = await shell();
    const items = $('aside.sidebar a[data-area]');
    expect(items).toHaveLength(9);
    expect(items.last().attr('href')).toBe('/admin');
    expect(items.last().text()).toContain('Platform console');
    expect(items.last().find('svg.lucide-crown')).toHaveLength(1);
  });

  it('god mode: the banner and the switcher draw Lucide icons on tokens, no emoji (DS-08)', async () => {
    const admin = await seedUser({ email: 'root@test.local', role: 'super_admin' });
    await seedWorkspace({ name: 'Home', ownerUserId: admin });
    const tenantOwner = await seedUser({ email: 'tenant@test.local' });
    const tenant = await seedWorkspace({ name: 'Tenant Co', ownerUserId: tenantOwner });
    await setActiveWorkspace(admin, tenant, { allowAnyAsSuperAdmin: true });
    await signInAs(admin, 'super_admin');
    const $ = await shell();
    const banner = $('[data-god-mode]');
    expect(banner).toHaveLength(1);
    expect(banner.attr('role')).toBe('alert');
    expect(banner.text()).toContain('you are inside workspace “Tenant Co”');
    expect(banner.find('svg.lucide-crown')).toHaveLength(1);
    expect(banner.find('button').text()).toBe('Return to my workspace');
    // Colours come from AppShell.module.css, not inline literals.
    expect(banner.attr('style')).toBeUndefined();
    expect(banner.find('[style]')).toHaveLength(0);
    // The active seat is god mode: the switcher shows the eye, not the building.
    expect($('.workspace-switcher-god svg[data-icon="god-mode"]')).toHaveLength(1);
    expect($('.workspace-switcher svg[data-icon="workspace"]')).toHaveLength(0);
    expect($('header.brand-header').text() + banner.text()).not.toMatch(
      /\p{Extended_Pictographic}/u,
    );
    expect($('[data-brand-wordmark]')).toHaveLength(1);
  });

  it('an owner gets the interim Emergency stop; the page sits inside its area frame', async () => {
    const { user } = await workspaceWith('owner');
    await signInAs(user);
    const $ = await shell('/settings/members');
    expect($('.sidebar-stop').attr('href')).toBe('/mailbox/queue#pause');
    expect($('nav.area-subnav a[aria-current="page"]').attr('data-tab')).toBe('settings.members');
    // The page and its sub-nav are rendered once (no Suspense fallback copy).
    expect($('nav.area-subnav')).toHaveLength(1);
    expect($('#page')).toHaveLength(1);
    expect($('.area-frame-content #page').text()).toBe('Page');
  });

  it('unread support replies show in the account menu (neutral), not in the sidebar', async () => {
    const { ws, user } = await workspaceWith('member');
    await db
      .insert(supportThreads)
      .values({ workspaceId: ws, subject: 'Help', customerUnread: true });
    await signInAs(user);
    const $ = await shell();
    const badge = $('.header-account-links a[href="/support"] .nav-count');
    expect(badge.attr('data-tone')).toBe('neutral');
    expect(badge.text()).toContain('1 unread support replies');
    expect($('.header-account-menu > summary .nav-count')).toHaveLength(1);
    expect($('aside.sidebar a[href="/support"]')).toHaveLength(0);
  });
});

describe('count policy on a prod-shaped workspace (DS-05 acceptance)', () => {
  it('310 untouched records give a neutral Review count; one needs_review turns it amber', async () => {
    const { ws, user } = await workspaceWith('member');
    const ids = await seedNewRecords(ws, 310);
    await signInAs(user);

    const counts = await getNavCounts({ workspaceId: ws });
    expect(counts).toMatchObject({ reviewPending: 310, reviewNeedsReview: 0, outreachPending: 0 });
    let $ = await shell('/review');
    let badge = $('aside.sidebar a[data-area="review"] .nav-count');
    expect(badge.attr('data-tone')).toBe('neutral');
    expect(badge.text()).toContain('99+');
    expect(badge.text()).toContain('310 records waiting for review');
    // Nothing waits on Outreach, and Conversations never shows a number.
    expect($('aside.sidebar a[data-area="outreach"] .nav-count')).toHaveLength(0);
    expect($('aside.sidebar a[data-area="conversations"] .nav-count')).toHaveLength(0);

    await db.update(reviewItems).set({ state: 'needs_review' }).where(eq(reviewItems.id, ids[0]!));
    $ = await shell('/review');
    badge = $('aside.sidebar a[data-area="review"] .nav-count');
    expect(badge.attr('data-tone')).toBe('attention');
  });
});

describe('Today and the retired URLs', () => {
  it('/dashboard and /inbox answer permanent (308) redirects to Today, keeping the query', async () => {
    const digest = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        return { to: redirectTarget(err), digest: (err as { digest: string }).digest };
      }
      throw new Error('no redirect');
    };
    const dash = await digest(() => DashboardRedirect({ searchParams: Promise.resolve({}) }));
    expect(dash.to).toBe('/today?view=overview');
    expect(dash.digest).toMatch(/;308;$/);
    const inbox = await digest(() =>
      InboxRedirect({ searchParams: Promise.resolve({ tab: 'drafts' }) }),
    );
    expect(inbox.to).toBe('/today?tab=drafts');
    expect(inbox.digest).toMatch(/;308;$/);
  });

  it('a signed-in visit to / lands on Today', async () => {
    const { user } = await workspaceWith('member');
    await signInAs(user);
    expect(await expectRedirect(() => Home({ searchParams: Promise.resolve({}) }))).toBe('/today');
  });

  it('Today shows the old inbox (Needs you) by default and the old dashboard on ?view=overview', async () => {
    const { ws, user } = await workspaceWith('member');
    await seedNewRecords(ws, 2);
    await signInAs(user);

    nav.pathname = '/today';
    nav.search = '';
    let $ = load(await renderToHtml(await TodayPage({ searchParams: Promise.resolve({}) })));
    expect($('nav.area-tabs a[aria-current="page"]').attr('data-tab')).toBe('today.needs');
    expect($('.scope-tabs a[aria-current="page"]').attr('href')).toBe('/today?tab=review');
    expect($('.profile-list li')).toHaveLength(2);
    expect($('.cockpit-grid')).toHaveLength(0);

    nav.search = 'view=overview';
    $ = load(
      await renderToHtml(await TodayPage({ searchParams: Promise.resolve({ view: 'overview' }) })),
    );
    expect($('nav.area-tabs a[aria-current="page"]').attr('data-tab')).toBe('today.overview');
    expect($('nav.area-tabs')).toHaveLength(1);
    expect($('h1')).toHaveLength(1);
    expect($('.cockpit-grid')).toHaveLength(1);
    // The area tiles come from the registry: no "God mode", one per area.
    expect(
      $('.module-tile h3')
        .toArray()
        .map((el) => $(el).text()),
    ).toEqual([
      'Review',
      'Pipeline',
      'Outreach',
      'Conversations',
      'Discovery',
      'Products',
      'Settings',
    ]);
    expect($.html()).not.toMatch(/God mode/);
    // The funnel is the shared FunnelBars (DS-09): its colour is a ramp
    // step chosen by CSS, and the only inline style is the bar length as a
    // custom property.
    const fill = $('[data-funnel-row="relevant"] [data-step]');
    expect(fill.attr('data-step')).toBe('1');
    expect(fill.attr('style')).toMatch(/^--v:\s*\d+;?$/);
  });
});

describe('autopilot runs its steps in AUTOPILOT_STEPS order (AP-03)', () => {
  it('with every switch on, the run records the steps in the order the handbook lists them', async () => {
    const owner = await seedUser({ email: 'pilot@test.local' });
    const ws = await seedWorkspace({ name: 'Pilot', ownerUserId: owner });
    const ctx = makeWorkspaceContext({ workspaceId: ws, userId: owner, role: 'owner' });
    await updateAutopilotSettings(ctx, {
      autopilotEnabled: true,
      ...Object.fromEntries(AUTOPILOT_STEPS.map((s) => [s.setting, true])),
    });
    const run = await runOnce(ctx);
    expect(run.steps.map((s) => s.step)).toEqual(AUTOPILOT_STEPS.map((s) => s.id));
  });
});
