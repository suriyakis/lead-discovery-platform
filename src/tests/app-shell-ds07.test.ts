// DS-07 (absorbs ia:F-09, MOB-03 and AP-05a): the workspace frame is
// mounted ONCE, by src/app/(app)/layout.tsx, for every workspace page.
//
// Covered here (the browser half — the conversation surviving navigation,
// the sidebar count dropping after an approval without a reload, the frame
// rendering once per full load — is e2e/app-shell.spec.ts):
//   - the move: every shelled page sits in the (app) route group with its
//     URL unchanged; /admin, the landing page, /pending and the redirect
//     stubs stay outside; no file but the layout imports AppShell;
//   - the codemod: it moves, rewrites and unwraps on a scratch tree, a
//     second run is a no-op, and the repository has nothing left for it;
//   - the frame's states: signed out, waiting for approval, no workspace
//     (a bare frame; /review, /drafts and /settings/members show
//     NoWorkspaceState), a workspace (assistant and palette keyed by it, so
//     a switch or god mode starts them afresh);
//   - refreshChrome(): guarded decisions re-render the frame, value-only
//     actions and refusals do not, and it is safe outside a request;
//   - the freshness rules: an idle return refreshes once, a moved
//     automation state refreshes once, another workspace never silently;
//   - the in-frame error and not-found pages, and the render probe.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from 'cheerio';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { reviewItems } from '@/lib/db/schema/review';
import type { AttentionSummary } from '@/lib/attention/types';
import { setActiveWorkspace } from '@/lib/services/workspace';
import { appRouteFiles, appRoutePatterns } from '../../e2e/routes';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { expectRedirect, renderToHtml } from './helpers/next-render';
import { claimedForm } from './helpers/workspace-guard';

// ---- the request ----------------------------------------------------------------

type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: 'member' | 'super_admin';
  accountStatus: 'pending' | 'active' | 'suspended' | 'rejected';
};
const req = vi.hoisted(() => ({
  user: null as null | SessionUser,
  probe: null as string | null,
}));
vi.mock('@/lib/auth', () => ({ auth: async () => (req.user ? { user: req.user } : null) }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'leadsonar-e2e-shell-probe' && req.probe ? { name, value: req.probe } : undefined,
  }),
  headers: async () => new Headers({ 'user-agent': 'Vitest browser' }),
}));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock('next/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/cache')>()),
  revalidatePath: cache.revalidatePath,
}));
const nav = vi.hoisted(() => ({ pathname: '/today' }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
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
const { AssistantPanel } = await import('@/components/AssistantPanel');
const { CommandPalette } = await import('@/components/CommandPalette');
const { default: AppLayout } = await import('@/app/(app)/layout');
const { default: WorkspacePageError } = await import('@/app/(app)/error');
const { default: WorkspacePageNotFound } = await import('@/app/(app)/not-found');
const { default: ShellErrorProbe } = await import('@/app/(app)/test-only/shell-error/page');
const { default: ReviewPage } = await import('@/app/(app)/review/page');
const { default: DraftsPage } = await import('@/app/(app)/drafts/page');
const { default: MembersPage } = await import('@/app/(app)/settings/members/page');
const { withWorkspaceGuard } = await import('@/lib/workspace-guard/server');
const { GUARDED_ACTION_CHROME, GUARDED_ACTION_IDS } =
  await import('@/lib/workspace-guard/registry');
const { refreshChrome } = await import('@/lib/shell/refresh');
const freshness = await import('@/lib/shell/freshness');
const probe = await import('@/lib/shell/render-probe');
const { GET: shellRendersGET } = await import('@/app/api/test-only/shell-renders/route');
const { bellView, accountMenuCounts } = await import('@/components/ShellHeaderCounts');
const { redirect } = await import('next/navigation');

const ROOT = process.cwd();
const APP = path.join(ROOT, 'src', 'app');
const CODEMOD = path.join(ROOT, 'scripts', 'codemods', 'app-route-group.mjs');

function signIn(
  id: string,
  role: SessionUser['role'] = 'member',
  status: SessionUser['accountStatus'] = 'active',
) {
  req.user = { id, email: `${id}@test.local`, name: 'Pat Doe', role, accountStatus: status };
}

/** Every element in a server-rendered tree, without running components. */
function* elements(node: ReactNode): Generator<ReactElement> {
  if (Array.isArray(node)) {
    for (const child of node) yield* elements(child as ReactNode);
    return;
  }
  if (!isValidElement(node)) return;
  yield node;
  yield* elements((node.props as { children?: ReactNode }).children);
}

async function shellTree(children: ReactNode = createElement('h1', { id: 'page' }, 'Page')) {
  return (await AppShell({ children })) as ReactNode;
}

function keyOf(tree: ReactNode, type: unknown): string | null {
  const found = [...elements(tree)].filter((e) => e.type === type);
  expect(found).toHaveLength(1);
  return found[0]!.key;
}

beforeEach(async () => {
  await truncateAll();
  req.user = null;
  req.probe = null;
  nav.pathname = '/today';
  cache.revalidatePath.mockReset();
});

afterEach(() => {
  delete process.env.ENABLE_TEST_ROUTES;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- the move ---------------------------------------------------------------------

/** The page routes before the move (git HEAD of phase1/integration). */
const ROUTES_BEFORE = [
  '/',
  '/admin',
  '/admin/audit',
  '/admin/providers',
  '/admin/support',
  '/admin/support/[id]',
  '/admin/users',
  '/admin/users/[id]',
  '/admin/workspaces',
  '/admin/workspaces/[id]',
  '/admin/workspaces/new',
  '/autopilot',
  '/communication',
  '/communication/[threadId]',
  '/communication/follow-ups',
  '/connectors',
  '/connectors/[id]',
  '/connectors/[id]/recipes/[recipeId]',
  '/connectors/[id]/recipes/new',
  '/connectors/[id]/runs/[runId]',
  '/connectors/engine',
  '/connectors/new',
  '/contacts',
  '/contacts/[id]',
  '/dashboard',
  '/dev/gallery',
  '/documents',
  '/documents/[id]',
  '/drafts',
  '/drafts/[id]',
  '/health',
  '/inbox',
  '/knowledge',
  '/knowledge/[id]',
  '/knowledge/new',
  '/leads',
  '/learning',
  '/learning/[id]',
  '/learning/new',
  '/mailbox',
  '/mailbox/[id]',
  '/mailbox/[id]/compose',
  '/mailbox/[id]/edit',
  '/mailbox/[id]/test',
  '/mailbox/deliverability',
  '/mailbox/new',
  '/mailbox/queue',
  '/mailbox/signatures',
  '/mailbox/suppression',
  '/mailbox/threads/[id]',
  '/notifications',
  '/onboarding',
  '/pending',
  '/pipeline',
  '/pipeline/[id]',
  '/products',
  '/products/[id]',
  '/products/autofill',
  '/products/new',
  '/review',
  '/review/[id]',
  '/settings',
  '/settings/account',
  '/settings/audit',
  '/settings/billing',
  '/settings/crm',
  '/settings/crm/[id]',
  '/settings/crm/new',
  '/settings/integrations',
  '/settings/members',
  '/settings/outreach',
  '/settings/usage',
  '/support',
  '/support/[id]',
  '/test-only/error-boundary',
  '/today',
  '/workspace-changed',
];

/** Routes that stay outside the workspace frame, and why. */
const OUTSIDE_THE_FRAME = new Set([
  '/', // the signed-out landing page
  '/pending', // the approval wall
  '/dashboard', // redirect stub (308 → Today)
  '/inbox', // redirect stub (308 → Today)
  '/dev/gallery', // the dev-only component gallery
  '/test-only/error-boundary', // the root error.tsx probe
]);

const relToApp = (file: string) => path.relative(APP, file).split(path.sep).join('/');

describe('the (app) route group (DS-07)', () => {
  it('every URL is unchanged: the same routes as before the move, plus the in-frame error probe', () => {
    expect(appRoutePatterns()).toEqual([...ROUTES_BEFORE, '/test-only/shell-error'].sort());
  });

  it('every workspace page is in the group; /admin, the landing page, /pending and the stubs stay outside', () => {
    const misplaced: string[] = [];
    for (const [pattern, file] of appRouteFiles()) {
      const rel = relToApp(file);
      const inGroup = rel.startsWith('(app)/');
      const shouldBe = !pattern.startsWith('/admin') && !OUTSIDE_THE_FRAME.has(pattern);
      if (inGroup !== shouldBe) misplaced.push(`${pattern} → src/app/${rel}`);
    }
    expect(misplaced).toEqual([]);
    expect(readFileSync(path.join(APP, 'admin', 'layout.tsx'), 'utf8')).toContain('<AdminShell');
  });

  it('the group has its layout, error and not-found boundaries; the layout renders AppShell', async () => {
    for (const f of ['layout.tsx', 'error.tsx', 'not-found.tsx']) {
      expect(readdirSync(path.join(APP, '(app)'))).toContain(f);
    }
    const tree = AppLayout({ children: 'x' });
    expect(tree.type).toBe(AppShell);
  });

  it('no file under src/app imports AppShell except (app)/layout.tsx (no page.tsx does)', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(tsx?|mjs)$/.test(entry.name)) {
          const src = readFileSync(full, 'utf8');
          if (/from '@\/components\/AppShell'|<AppShell\b/.test(src))
            offenders.push(relToApp(full));
        }
      }
    };
    walk(APP);
    expect(offenders).toEqual(['(app)/layout.tsx']);
  });
});

// ---- the codemod ------------------------------------------------------------------

function runCodemod(args: string[]) {
  const r = spawnSync(process.execPath, [CODEMOD, ...args], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const full = path.join(dir, f);
    try {
      out[f.split(path.sep).join('/')] = readFileSync(full, 'utf8');
    } catch {
      // a directory
    }
  }
  return out;
}

// Pre-move paths are spelled in pieces: written out whole, the codemod's
// own rewrite (run on this repository by the last test) would move them.
const OLD = (rest: string) => ['src', 'app', rest].join('/');
const ALIAS = (rest: string) => ['@', 'app', rest].join('/');
const BARE = (rest: string) => ['app', rest].join('/');

function scratchTree(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ds07-codemod-'));
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  put(
    OLD('review/page.tsx'),
    [
      "import { AppShell } from '@/components/AppShell';",
      `import { IndexStatusBadge } from '${ALIAS('knowledge/index-status')}';`,
      '',
      'export default function Page() {',
      '  return (',
      '    <AppShell',
      '      isSuperAdmin={true}',
      '    >',
      '      <h1>Review</h1>',
      '    </AppShell>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );
  put(OLD('knowledge/index-status.tsx'), 'export const IndexStatusBadge = () => null;\n');
  put('src/app/admin/page.tsx', 'export default function Admin() { return null; }\n');
  put(
    'src/tests/x.test.ts',
    `import Page from '${ALIAS('review/page')}';\nconst f = '${OLD('settings/members/page.tsx')}';\nconst g = '${BARE('leads/page.tsx')}';\nconst h = 'src/app/admin/page.tsx';\n`,
  );
  put('docs/notes.md', `See ${OLD('review/page.tsx')} and /review (a URL).\n`);
  put('TODO.md', `${OLD('review/page.tsx')} stays as written here.\n`);
  return dir;
}

describe('scripts/codemods/app-route-group.mjs (DS-07)', () => {
  it('moves the folders, rewrites path references, unwraps AppShell — and a second run changes nothing', () => {
    const dir = scratchTree();
    try {
      const first = runCodemod(['--root', dir]);
      expect(first.status, first.out).toBe(0);
      const after = snapshotTree(dir);
      expect(Object.keys(after)).toContain('src/app/(app)/review/page.tsx');
      expect(Object.keys(after)).toContain('src/app/(app)/knowledge/index-status.tsx');
      expect(Object.keys(after)).toContain('src/app/admin/page.tsx');
      expect(Object.keys(after).some((f) => f.startsWith(OLD('review')))).toBe(false);
      const page = after['src/app/(app)/review/page.tsx']!;
      expect(page).not.toMatch(/AppShell/);
      expect(page).toContain("from '@/app/(app)/knowledge/index-status'");
      expect(page).toContain('    <>\n      <h1>Review</h1>\n    </>');
      const test = after['src/tests/x.test.ts']!;
      expect(test).toContain("from '@/app/(app)/review/page'");
      expect(test).toContain("'src/app/(app)/settings/members/page.tsx'");
      expect(test).toContain("'app/(app)/leads/page.tsx'");
      expect(test).toContain("'src/app/admin/page.tsx'");
      expect(after['docs/notes.md']).toBe(
        'See src/app/(app)/review/page.tsx and /review (a URL).\n',
      );
      expect(after['TODO.md']).toBe(`${OLD('review/page.tsx')} stays as written here.\n`);

      const second = runCodemod(['--root', dir]);
      expect(second.status).toBe(0);
      expect(second.out).toContain('nothing to do');
      expect(snapshotTree(dir)).toEqual(after);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a branch that added a page in the old place after the move gets it moved; a clash stops for a hand merge', () => {
    const dir = scratchTree();
    try {
      expect(runCodemod(['--root', dir]).status).toBe(0);
      mkdirSync(path.join(dir, OLD('review/[id]')), { recursive: true });
      writeFileSync(path.join(dir, OLD('review/[id]/page.tsx')), 'export default () => null;\n');
      expect(runCodemod(['--root', dir, '--check']).status).toBe(1);
      expect(runCodemod(['--root', dir]).status).toBe(0);
      expect(snapshotTree(dir)['src/app/(app)/review/[id]/page.tsx']).toBe(
        'export default () => null;\n',
      );
      writeFileSync(path.join(dir, 'src/app/(app)/review/page.tsx'), 'moved\n');
      mkdirSync(path.join(dir, OLD('review')), { recursive: true });
      writeFileSync(path.join(dir, OLD('review/page.tsx')), 'still here\n');
      const clash = runCodemod(['--root', dir]);
      expect(clash.status).toBe(1);
      expect(clash.out).toContain(OLD('review/page.tsx'));
      expect(readFileSync(path.join(dir, OLD('review/page.tsx')), 'utf8')).toBe('still here\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('inside a git work tree it moves with git mv (history follows the files)', () => {
    const dir = scratchTree();
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      git('init', '-q');
      git('add', '-A');
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
      expect(runCodemod(['--root', dir]).status).toBe(0);
      const staged = git('status', '--porcelain');
      expect(staged).toMatch(
        /^R. src\/app\/review\/page\.tsx -> "?src\/app\/\(app\)\/review\/page\.tsx/m,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('this repository has nothing left for it (running it again is a no-op)', () => {
    const r = runCodemod(['--check']);
    expect(r.out).toContain('nothing to do');
    expect(r.status).toBe(0);
  });
});

// ---- the frame's states -------------------------------------------------------------

describe('AppShell, rendered once by the (app) layout', () => {
  it('signed out → the sign-in page; an account waiting for approval → /pending', async () => {
    expect(await expectRedirect(() => shellTree())).toBe('/');
    const pending = await seedUser({ email: 'wait@test.local', accountStatus: 'pending' });
    signIn(pending, 'member', 'pending');
    expect(await expectRedirect(() => shellTree())).toBe('/pending');
  });

  it('no workspace: a bare frame (brand header, Sign out) with no sidebar, palette or assistant', async () => {
    const loner = await seedUser({ email: 'loner@test.local' });
    signIn(loner);
    const $ = load(await renderToHtml(await shellTree()));
    expect($('main[data-shell-frame="no-workspace"] #page').text()).toBe('Page');
    expect($('[data-brand-wordmark]')).toHaveLength(1);
    expect($('header.brand-header').text()).toContain(`${loner}@test.local`);
    expect($('header.brand-header button').text()).toBe('Sign out');
    expect($('aside.sidebar')).toHaveLength(0);
    expect($('[data-command-palette-trigger]')).toHaveLength(0);
    expect($.html()).not.toContain('Ask the platform');
  });

  it.each([
    ['/review', () => ReviewPage({ searchParams: Promise.resolve({}) })],
    ['/drafts', () => DraftsPage({ searchParams: Promise.resolve({}) })],
    ['/settings/members', () => MembersPage({ searchParams: Promise.resolve({}) })],
  ] as const)('a user without a workspace sees NoWorkspaceState on %s', async (route, page) => {
    const loner = await seedUser({ email: 'loner@test.local' });
    signIn(loner);
    nav.pathname = route;
    const html = await renderToHtml(await shellTree((await page()) as ReactNode));
    const $ = load(html.replaceAll('<!-- -->', ''));
    expect($('main[data-shell-frame="no-workspace"] [data-no-workspace-state]')).toHaveLength(1);
    expect($('h2:contains("Create your workspace")')).toHaveLength(1);
    expect($('input[name="name"]')).toHaveLength(1);
    expect(html).toContain(`<code>${loner}</code>`);
    expect($('aside.sidebar')).toHaveLength(0);
  });

  it('a workspace: the full frame, the assistant and Cmd-K keyed by the workspace', async () => {
    const owner = await seedUser({ email: 'owner@test.local' });
    const ws = await seedWorkspace({ name: 'Acme', ownerUserId: owner });
    signIn(owner);
    const tree = await shellTree();
    expect(keyOf(tree, AssistantPanel)).toBe(ws.toString());
    expect(keyOf(tree, CommandPalette)).toBe(`palette:${ws}`);
    const $ = load(await renderToHtml(tree));
    expect($('[data-shell-workspace]').attr('data-shell-workspace')).toBe(ws.toString());
    expect($('aside.sidebar a[data-area]').length).toBeGreaterThan(0);
    expect($('.app-main #page').text()).toBe('Page');
  });

  it('switching workspace, or entering god mode, gives the assistant a new key (a fresh conversation)', async () => {
    const owner = await seedUser({ email: 'root@test.local', role: 'super_admin' });
    const one = await seedWorkspace({ name: 'One', ownerUserId: owner });
    const two = await seedWorkspace({ name: 'Two', ownerUserId: owner });
    const tenantOwner = await seedUser({ email: 'tenant@test.local' });
    const tenant = await seedWorkspace({ name: 'Tenant Co', ownerUserId: tenantOwner });
    signIn(owner, 'super_admin');
    await setActiveWorkspace(owner, one);
    expect(keyOf(await shellTree(), AssistantPanel)).toBe(one.toString());
    await setActiveWorkspace(owner, two);
    expect(keyOf(await shellTree(), AssistantPanel)).toBe(two.toString());
    await setActiveWorkspace(owner, tenant, { allowAnyAsSuperAdmin: true });
    const god = await shellTree();
    expect(keyOf(god, AssistantPanel)).toBe(tenant.toString());
    expect(keyOf(god, CommandPalette)).toBe(`palette:${tenant}`);
    expect(load(await renderToHtml(god))('[data-god-mode]').text()).toContain('Tenant Co');
  });

  it('the bell and the account menu are client islands over the frame’s summary', async () => {
    const owner = await seedUser({ email: 'owner@test.local' });
    await seedWorkspace({ name: 'Acme', ownerUserId: owner });
    signIn(owner);
    const $ = load(await renderToHtml(await shellTree()));
    expect($('a.header-bell').attr('aria-label')).toBe('Notifications');
    expect(
      $('.header-account-links a')
        .toArray()
        .map((a) => $(a).attr('href')),
    ).toEqual(['/settings/account', '/support']);
  });
});

// ---- the frame's numbers and its freshness -----------------------------------------

function summary(
  workspaceId: string,
  counts: Partial<AttentionSummary['counts']> = {},
  outreach: Partial<NonNullable<AttentionSummary['outreach']>> = {},
): AttentionSummary {
  return {
    version: 1,
    workspaceId,
    generatedAt: '2026-10-02T10:00:00.000Z',
    counts: {
      'review.open': 0,
      'review.needsReview': 0,
      'review.mine': 0,
      'drafts.approve': 0,
      'followUps.approve': 0,
      'replies.awaiting': 0,
      'replies.overdue': 0,
      'notifications.unread': 0,
      'support.unread': 0,
      problems: 0,
      ...counts,
    },
    failed: [],
    degraded: false,
    findings: [],
    outreach: {
      state: 'manual',
      label: 'Manual',
      paused: false,
      live: true,
      partlyPaused: false,
      degraded: false,
      queued: 0,
      failed24h: 0,
      ...outreach,
    },
    wallet: null,
    health: null,
    platform: null,
  };
}

describe('the header numbers (DS-07, MOB-03)', () => {
  it('the bell: nothing at 0, the number, 99+, and "—" when it failed to load', () => {
    expect(bellView(0)).toEqual({ text: null, label: 'Notifications' });
    expect(bellView(3)).toEqual({ text: '3', label: 'Notifications, 3 unread' });
    expect(bellView(120).text).toBe('99+');
    expect(bellView(null)).toEqual({ text: '—', label: 'Notifications, unread count unavailable' });
  });

  it('the account menu: unread support replies on the item and on the closed menu', () => {
    const counts = accountMenuCounts(summary('1', { 'support.unread': 2 }));
    expect(counts.items['support.threads']?.text).toBe('2');
    expect(counts.menu?.text).toBe('2');
    expect(accountMenuCounts(summary('1')).menu).toBeNull();
    expect(accountMenuCounts(null).menu).toBeNull();
  });
});

class FakeTarget extends EventTarget {
  fire(type: string) {
    this.dispatchEvent(new Event(type));
  }
}

function freshnessWorld() {
  const clock = { now: 0, visible: true };
  const win = new FakeTarget();
  const doc = new FakeTarget();
  const refreshed: string[] = [];
  const f = freshness.createShellFreshness({
    now: () => clock.now,
    isVisible: () => clock.visible,
    window: win,
    document: doc,
    refresh: (reason) => refreshed.push(reason),
  });
  f.start();
  return { clock, win, doc, refreshed, f };
}

describe('keeping the persistent frame fresh (ia:F-09, DS-07)', () => {
  it('back on the tab after 5 idle minutes: one router.refresh(); sooner: none', () => {
    const w = freshnessWorld();
    w.win.fire('blur');
    w.clock.now = freshness.SHELL_IDLE_REFRESH_MS - 1;
    w.win.fire('focus');
    expect(w.refreshed).toEqual([]);
    w.win.fire('blur');
    w.clock.now += freshness.SHELL_IDLE_REFRESH_MS;
    w.win.fire('focus');
    expect(w.refreshed).toEqual(['idle-return']);
  });

  it('a hidden tab that comes back counts too, and focus + visibilitychange refresh once', () => {
    const w = freshnessWorld();
    w.clock.visible = false;
    w.doc.fire('visibilitychange');
    w.clock.now = 6 * 60_000;
    w.clock.visible = true;
    w.doc.fire('visibilitychange');
    w.win.fire('focus');
    expect(w.refreshed).toEqual(['idle-return']);
    w.f.stop();
    w.win.fire('blur');
    w.clock.now += 10 * 60_000;
    w.win.fire('focus');
    expect(w.refreshed).toEqual(['idle-return']);
  });

  it('a moved automation state refreshes the frame once per new state', () => {
    const rendered = freshness.chromeSignature(summary('7'));
    const paused = summary('7', {}, { state: 'paused', paused: true, label: 'Paused' });
    expect(freshness.needsChromeRefresh({ rendered, latest: summary('7'), requested: null })).toBe(
      false,
    );
    expect(freshness.needsChromeRefresh({ rendered, latest: paused, requested: null })).toBe(true);
    const requested = freshness.chromeSignature(paused);
    expect(freshness.needsChromeRefresh({ rendered, latest: paused, requested })).toBe(false);
    // Counts alone never refresh the frame: the islands render them.
    const busier = summary('7', { 'review.open': 40 });
    expect(freshness.needsChromeRefresh({ rendered, latest: busier, requested: null })).toBe(false);
    expect(freshness.needsChromeRefresh({ rendered: null, latest: paused, requested: null })).toBe(
      false,
    );
  });

  it('a summary for another workspace is drift (a notice), never a silent refresh', () => {
    expect(freshness.workspaceDrifted('7', summary('8'))).toBe(true);
    expect(freshness.workspaceDrifted('7', summary('7'))).toBe(false);
    expect(freshness.workspaceDrifted('7', null)).toBe(false);
    expect(freshness.workspaceDrifted(null, summary('8'))).toBe(false);
  });
});

// ---- refreshChrome ------------------------------------------------------------------

describe('refreshChrome(): decisions re-render the frame (DS-07)', () => {
  async function member() {
    const owner = await seedUser({ email: 'owner@test.local' });
    const ws = await seedWorkspace({ name: 'Acme', ownerUserId: owner });
    signIn(owner);
    return { owner, ws };
  }

  it('every guarded action is classified', () => {
    expect(Object.keys(GUARDED_ACTION_CHROME).sort()).toEqual([...GUARDED_ACTION_IDS].sort());
    for (const id of [
      'review.approve',
      'draft.approve',
      'follow_up.approve',
      'automation.pause',
    ] as const) {
      expect(GUARDED_ACTION_CHROME[id]).toBe('refresh');
    }
    expect(GUARDED_ACTION_CHROME['draft.translate']).toBe('none');
  });

  it('a guarded decision that returns, or redirects, revalidates the layout', async () => {
    const { ws } = await member();
    const returns = withWorkspaceGuard('review.approve', async (_fd: FormData) => 'ok');
    expect(await returns(claimedForm(ws))).toBe('ok');
    expect(cache.revalidatePath).toHaveBeenCalledWith('/', 'layout');
    cache.revalidatePath.mockClear();
    const redirects = withWorkspaceGuard('draft.approve', async (_fd: FormData) => {
      redirect('/drafts/1?message=Approved');
    });
    expect(await expectRedirect(() => redirects(claimedForm(ws)))).toBe(
      '/drafts/1?message=Approved',
    );
    expect(cache.revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('a value-only action, a failure and a refused claim do not', async () => {
    const { ws } = await member();
    const translate = withWorkspaceGuard('draft.translate', async (_fd: FormData) => 'texte');
    expect(await translate(claimedForm(ws))).toBe('texte');
    const fails = withWorkspaceGuard('review.approve', async (_fd: FormData) => {
      throw new Error('boom');
    });
    await expect(fails(claimedForm(ws))).rejects.toThrow('boom');
    const stale = withWorkspaceGuard('review.approve', async (_fd: FormData) => 'ran');
    const to = await expectRedirect(() => stale(claimedForm(ws + 1000n)));
    expect(to).toMatch(/^\/workspace-changed/);
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it('the review approve action refreshes the frame and the open count drops', async () => {
    const { ws } = await member();
    const { approveReviewItemAction } = await import('@/app/(app)/review/[id]/actions');
    const { sourceRecords } = await import('@/lib/db/schema/connectors');
    const [record] = await db
      .insert(sourceRecords)
      .values({
        workspaceId: ws,
        sourceSystem: 'mock',
        sourceId: 'r1',
        rawData: {},
        normalizedData: { name: 'Co' },
      })
      .returning({ id: sourceRecords.id });
    const [item] = await db
      .insert(reviewItems)
      .values({ workspaceId: ws, sourceRecordId: record!.id, state: 'needs_review' })
      .returning({ id: reviewItems.id });
    const { getAttentionSummary } = await import('@/lib/attention/service');
    const { getWorkspaceContext } = await import('@/lib/services/auth-context');
    const before = await getAttentionSummary(await getWorkspaceContext(), { freshFindings: true });
    expect(before.counts['review.open']).toBe(1);
    expect(
      await expectRedirect(() =>
        approveReviewItemAction(item!.id.toString(), claimedForm(ws, { reason: 'fits' })),
      ),
    ).toBe(`/review/${item!.id}`);
    const [row] = await db.select().from(reviewItems).where(eq(reviewItems.id, item!.id));
    expect(row?.state).toBe('approved');
    expect(cache.revalidatePath).toHaveBeenCalledWith('/', 'layout');
    const after = await getAttentionSummary(await getWorkspaceContext(), { freshFindings: true });
    expect(after.counts['review.open']).toBe(0);
  });

  it('outside a request it is a no-op; any other failure is rethrown', () => {
    cache.revalidatePath.mockImplementationOnce(() => {
      throw new Error('Invariant: static generation store missing in revalidatePath /');
    });
    expect(() => refreshChrome()).not.toThrow();
    cache.revalidatePath.mockImplementationOnce(() => {
      throw new Error('Route /x used "revalidatePath /" during render which is unsupported.');
    });
    expect(() => refreshChrome()).toThrow(/during render/);
  });
});

// ---- inside the frame: error, not found, the render probe ------------------------------

describe('a workspace page that fails stays inside the frame (MOB-03, I078)', () => {
  it('(app)/error.tsx renders the error card without a second brand header', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspacePageError, {
        error: Object.assign(new Error('relation "x" does not exist'), { digest: '42' }),
        reset: () => {},
      }),
    );
    expect(html).toContain('data-shell-error');
    expect(html).toContain('Something went wrong');
    expect(html).toContain('<code>42</code>');
    expect(html).not.toContain('brand-header');
    expect(html).not.toContain('relation');
  });

  it('(app)/not-found.tsx renders the 404 card without a second brand header', () => {
    const html = renderToStaticMarkup(createElement(WorkspacePageNotFound));
    expect(html).toContain('data-shell-not-found');
    expect(html).toContain('find that page');
    expect(html).not.toContain('brand-header');
  });

  it('the in-frame error probe is a 404 unless ENABLE_TEST_ROUTES=1, and throws when enabled', () => {
    expect(() => ShellErrorProbe()).toThrow();
    try {
      ShellErrorProbe();
    } catch (err) {
      expect((err as { digest?: string }).digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
    }
    process.env.ENABLE_TEST_ROUTES = '1';
    expect(() => ShellErrorProbe()).toThrow('test-only shell error probe');
  });
});

describe('the frame-render probe (e2e only)', () => {
  it('counts nothing and answers 404 unless ENABLE_TEST_ROUTES=1', async () => {
    req.probe = 'probe-off-0001';
    await probe.noteShellRender();
    expect(probe.shellRenderCount('probe-off-0001')).toBe(0);
    const res = await shellRendersGET(
      new Request('http://x/api/test-only/shell-renders?probe=probe-off-0001'),
    );
    expect(res.status).toBe(404);
  });

  it('counts each frame render for the probe cookie of the request', async () => {
    process.env.ENABLE_TEST_ROUTES = '1';
    const owner = await seedUser({ email: 'owner@test.local' });
    await seedWorkspace({ name: 'Acme', ownerUserId: owner });
    signIn(owner);
    req.probe = 'probe-on-00000001';
    await shellTree();
    await shellTree();
    const res = await shellRendersGET(
      new Request('http://x/api/test-only/shell-renders?probe=probe-on-00000001'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ probe: 'probe-on-00000001', renders: 2 });
    expect(probe.shellRenderCount('another-probe-1')).toBe(0);
  });
});
