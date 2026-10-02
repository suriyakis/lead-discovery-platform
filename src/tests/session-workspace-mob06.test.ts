// MOB-06 — tenant-safe sessions and workspace-carrying links.
//
// Each browser session keeps its own workspace (sessions.activeWorkspaceId),
// a new sign-in starts in the last-used one (users.activeWorkspaceId), the
// membership fallback is deterministic, and /go?ws=&to= switches only this
// session, only into a membership, only to a safe in-app path.
//
// "Two browser contexts" are two real sessions rows of one user; the request
// cookie that names the session is stubbed (next/headers), as is next-auth's
// session lookup. Everything else — the resolver, the switch action, /go,
// /api/attention, notifications — runs for real against the test database.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { sessions, users } from '@/lib/db/schema/auth';
import { workspaceMembers, workspaces } from '@/lib/db/schema/workspaces';
import { createSessionForUser } from '@/lib/session-helpers';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import { notificationHref, notify } from '@/lib/services/notifications';
import { setActiveWorkspace } from '@/lib/services/workspace';
import {
  SESSION_TOUCH_INTERVAL_MS,
  resolveWorkspaceSelection,
} from '@/lib/services/workspace-resolution';
import { setActiveWorkspaceAction } from '@/lib/workspace-actions';
import {
  assistantLink,
  goHref,
  goLandingPath,
  safeInAppPath,
  switchNotice,
  workspaceChangedHref,
} from '@/lib/workspace-guard/shared';
import { GET as goGET } from '@/app/go/route';
import { GET as attentionGET } from '@/app/api/attention/route';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

// ---- the request: who is signed in, and which session cookie is sent ------

type Role = 'member' | 'super_admin';
const req = vi.hoisted(() => ({
  user: null as null | { id: string; role: 'member' | 'super_admin' },
  token: null as string | null,
  userAgent: null as string | null,
}));

vi.mock('@/lib/auth', () => ({
  auth: async () =>
    req.user
      ? {
          user: {
            id: req.user.id,
            email: `${req.user.id}@test.local`,
            name: null,
            role: req.user.role,
            accountStatus: 'active',
          },
        }
      : null,
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'authjs.session-token' && req.token ? { name, value: req.token } : undefined,
  }),
  headers: async () => new Headers(req.userAgent ? { 'user-agent': req.userAgent } : {}),
}));
// The switcher action revalidates the layout; there is no render cache here.
vi.mock('next/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/cache')>()),
  revalidatePath: () => undefined,
}));

interface Browser {
  token: string;
  userAgent: string;
}

/** Sign `userId` in on a new browser (a new sessions row). */
async function signInBrowser(userId: string, userAgent: string): Promise<Browser> {
  const minted = await createSessionForUser(userId);
  return { token: minted.sessionToken, userAgent };
}

/** Make the next calls come from `browser`, signed in as `userId`. */
function from(browser: Browser | null, userId: string | null, role: Role = 'member'): void {
  req.user = userId ? { id: userId, role } : null;
  req.token = browser?.token ?? null;
  req.userAgent = browser?.userAgent ?? null;
}

async function sessionRow(token: string) {
  const [row] = await db.select().from(sessions).where(eq(sessions.sessionToken, token));
  return row!;
}

async function lastUsed(userId: string): Promise<bigint | null> {
  const [row] = await db
    .select({ id: users.activeWorkspaceId })
    .from(users)
    .where(eq(users.id, userId));
  return row?.id ?? null;
}

async function addMember(workspaceId: bigint, userId: string, createdAt?: Date) {
  await db
    .insert(workspaceMembers)
    .values({ workspaceId, userId, role: 'member', ...(createdAt ? { createdAt } : {}) });
}

function go(query: Record<string, string>): Promise<Response> {
  const qs = new URLSearchParams(query).toString();
  return goGET(new Request(`http://app.test/go?${qs}`));
}

/** A user in two workspaces ("One" joined first, "Two" later). */
async function twoWorkspaces() {
  const user = await seedUser({ email: 'pat@mob06.test' });
  const one = await seedWorkspace({ name: 'One', ownerUserId: user });
  const two = await seedWorkspace({ name: 'Two', ownerUserId: user });
  // Make the join order explicit (seedWorkspace stamps "now").
  await db
    .update(workspaceMembers)
    .set({ createdAt: new Date('2026-01-01T00:00:00Z') })
    .where(and(eq(workspaceMembers.workspaceId, one), eq(workspaceMembers.userId, user)));
  await db
    .update(workspaceMembers)
    .set({ createdAt: new Date('2026-02-01T00:00:00Z') })
    .where(and(eq(workspaceMembers.workspaceId, two), eq(workspaceMembers.userId, user)));
  return { user, one, two };
}

beforeEach(async () => {
  await truncateAll();
  from(null, null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- per-session workspace -----------------------------------------------

describe('each browser session keeps its own workspace (MOB-06)', () => {
  it('switching in browser A leaves browser B — its pages and /api/attention — on its workspace', async () => {
    const { user, one, two } = await twoWorkspaces();
    const a = await signInBrowser(user, 'Laptop');
    const b = await signInBrowser(user, 'Phone');

    // Both start in the oldest membership and are pinned there.
    from(a, user);
    expect((await getWorkspaceContext()).workspaceId).toBe(one);
    from(b, user);
    expect((await getWorkspaceContext()).workspaceId).toBe(one);
    expect((await sessionRow(b.token)).activeWorkspaceId).toBe(one);

    // A switches with the header switcher.
    from(a, user);
    await setActiveWorkspaceAction(two.toString());

    from(a, user);
    expect((await getWorkspaceContext()).workspaceId).toBe(two);
    const fromA = await (await attentionGET()).json();
    expect(fromA.workspaceId).toBe(two.toString());

    from(b, user);
    expect((await getWorkspaceContext()).workspaceId).toBe(one);
    const fromB = await (await attentionGET()).json();
    expect(fromB.workspaceId).toBe(one.toString());

    // The switch wrote A's session pointer and the last-used value only.
    expect((await sessionRow(a.token)).activeWorkspaceId).toBe(two);
    expect((await sessionRow(b.token)).activeWorkspaceId).toBe(one);
    expect(await lastUsed(user)).toBe(two);
  });

  it('a new sign-in starts in the last-used workspace, and is pinned there', async () => {
    const { user, two } = await twoWorkspaces();
    const a = await signInBrowser(user, 'Laptop');
    await setActiveWorkspace(user, two, { sessionToken: a.token });

    const c = await signInBrowser(user, 'Tablet');
    expect((await sessionRow(c.token)).activeWorkspaceId).toBeNull();
    const picked = await resolveWorkspaceSelection(user, false, { sessionToken: c.token });
    expect(picked).toMatchObject({ source: 'last_used' });
    expect(picked.ctx.workspaceId).toBe(two);
    expect((await sessionRow(c.token)).activeWorkspaceId).toBe(two);

    // From now on it is this session's own choice.
    const again = await resolveWorkspaceSelection(user, false, { sessionToken: c.token });
    expect(again.source).toBe('session');
  });

  it('the membership fallback is deterministic: oldest membership first, then the lowest id', async () => {
    const owner = await seedUser({ email: 'owner@mob06.test' });
    const user = await seedUser({ email: 'new@mob06.test' });
    const late = await seedWorkspace({ name: 'Late', ownerUserId: owner });
    const early = await seedWorkspace({ name: 'Early', ownerUserId: owner });
    await addMember(late, user, new Date('2026-03-01T00:00:00Z'));
    await addMember(early, user, new Date('2026-01-01T00:00:00Z'));

    for (let i = 0; i < 5; i++) {
      const s = await signInBrowser(user, `Browser ${i}`);
      const picked = await resolveWorkspaceSelection(user, false, { sessionToken: s.token });
      expect(picked.source).toBe('first_membership');
      expect(picked.ctx.workspaceId).toBe(early);
    }

    // Same join time: the lower membership id wins, every time.
    const tieUser = await seedUser({ email: 'tie@mob06.test' });
    const at = new Date('2026-04-01T00:00:00Z');
    await addMember(late, tieUser, at);
    await addMember(early, tieUser, at);
    const [firstRow] = await db
      .select({ ws: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, tieUser))
      .orderBy(workspaceMembers.id)
      .limit(1);
    for (let i = 0; i < 3; i++) {
      const picked = await resolveWorkspaceSelection(tieUser, false);
      expect(picked.ctx.workspaceId).toBe(firstRow!.ws);
    }
  });

  it('a session pinned to a workspace the user has left falls back and re-pins', async () => {
    const { user, one, two } = await twoWorkspaces();
    const a = await signInBrowser(user, 'Laptop');
    await setActiveWorkspace(user, two, { sessionToken: a.token });
    await setActiveWorkspace(user, one); // last-used: One (another session switched)
    await db
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, two), eq(workspaceMembers.userId, user)));

    const picked = await resolveWorkspaceSelection(user, false, { sessionToken: a.token });
    expect(picked).toMatchObject({ source: 'last_used' });
    expect(picked.ctx.workspaceId).toBe(one);
    expect((await sessionRow(a.token)).activeWorkspaceId).toBe(one);
  });

  it("a member's session pointer at a foreign workspace is ignored; a super-admin's is god mode", async () => {
    const { user, one } = await twoWorkspaces();
    const stranger = await seedUser({ email: 'stranger@mob06.test' });
    const foreign = await seedWorkspace({ name: 'Foreign', ownerUserId: stranger });
    const a = await signInBrowser(user, 'Laptop');
    await db
      .update(sessions)
      .set({ activeWorkspaceId: foreign })
      .where(eq(sessions.sessionToken, a.token));
    const picked = await resolveWorkspaceSelection(user, false, { sessionToken: a.token });
    expect(picked.ctx.workspaceId).toBe(one);

    const admin = await seedUser({ email: 'root@mob06.test', role: 'super_admin' });
    await seedWorkspace({ name: 'Home', ownerUserId: admin });
    const s = await signInBrowser(admin, 'Console');
    await db
      .update(sessions)
      .set({ activeWorkspaceId: foreign })
      .where(eq(sessions.sessionToken, s.token));
    const god = await resolveWorkspaceSelection(admin, true, { sessionToken: s.token });
    expect(god).toMatchObject({ source: 'session' });
    expect(god.ctx).toMatchObject({ workspaceId: foreign, role: 'super_admin' });
  });

  it('a session row records when it was last seen and its browser, at most every 5 minutes', async () => {
    const { user } = await twoWorkspaces();
    const a = await signInBrowser(user, 'Laptop');
    const t0 = new Date('2026-10-02T10:00:00Z');
    await resolveWorkspaceSelection(user, false, {
      sessionToken: a.token,
      userAgent: 'Firefox',
      now: t0,
    });
    let row = await sessionRow(a.token);
    expect(row.lastSeenAt?.toISOString()).toBe(t0.toISOString());
    expect(row.userAgent).toBe('Firefox');
    expect(row.createdAt).toBeInstanceOf(Date);

    await resolveWorkspaceSelection(user, false, {
      sessionToken: a.token,
      userAgent: 'Firefox',
      now: new Date(t0.getTime() + 60_000),
    });
    row = await sessionRow(a.token);
    expect(row.lastSeenAt?.toISOString()).toBe(t0.toISOString());

    const later = new Date(t0.getTime() + SESSION_TOUCH_INTERVAL_MS);
    await resolveWorkspaceSelection(user, false, { sessionToken: a.token, now: later });
    expect((await sessionRow(a.token)).lastSeenAt?.toISOString()).toBe(later.toISOString());
  });

  it("another user's session token never moves or reads someone else's pointer", async () => {
    const { user, two } = await twoWorkspaces();
    const other = await seedUser({ email: 'other@mob06.test' });
    const otherWs = await seedWorkspace({ name: 'Other', ownerUserId: other });
    const theirs = await signInBrowser(other, 'Theirs');
    await setActiveWorkspace(user, two, { sessionToken: theirs.token });
    expect((await sessionRow(theirs.token)).activeWorkspaceId).toBeNull();
    const picked = await resolveWorkspaceSelection(other, false, { sessionToken: theirs.token });
    expect(picked.ctx.workspaceId).toBe(otherWs);
  });

  it('a password sign-in records its browser on the new session row', async () => {
    const { user } = await twoWorkspaces();
    const minted = await createSessionForUser(user, { userAgent: `  Safari ${'x'.repeat(400)}` });
    const row = await sessionRow(minted.sessionToken);
    expect(row.userAgent).toMatch(/^Safari x+$/);
    expect(row.userAgent).toHaveLength(300);
    expect(row.activeWorkspaceId).toBeNull();
  });

  it('a deleted workspace clears the session pointer (FK ON DELETE SET NULL)', async () => {
    const { user, two } = await twoWorkspaces();
    const a = await signInBrowser(user, 'Laptop');
    await setActiveWorkspace(user, two, { sessionToken: a.token });
    await db.delete(workspaces).where(eq(workspaces.id, two));
    expect((await sessionRow(a.token)).activeWorkspaceId).toBeNull();
  });
});

// ---- /go -------------------------------------------------------------------

describe('GET /go?ws=&to= (MOB-06)', () => {
  it('switches this session only, and lands on the path with the switched flag', async () => {
    const { user, one, two } = await twoWorkspaces();
    const a = await signInBrowser(user, 'Laptop');
    const b = await signInBrowser(user, 'Phone');
    from(b, user);
    await getWorkspaceContext(); // B pinned to One
    from(a, user);
    await getWorkspaceContext(); // A pinned to One

    const res = await go({ ws: two.toString(), to: '/review/5?state=new#top' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/review/5?state=new&switched=${two}#top`);
    expect((await sessionRow(a.token)).activeWorkspaceId).toBe(two);
    // Only this session: not the other browser, not the last-used value.
    expect((await sessionRow(b.token)).activeWorkspaceId).toBe(one);
    expect(await lastUsed(user)).toBeNull();
  });

  it('a link into the workspace the session is already in redirects without the flag', async () => {
    const { user, one } = await twoWorkspaces();
    const a = await signInBrowser(user, 'Laptop');
    from(a, user);
    const res = await go({ ws: one.toString(), to: '/drafts' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/drafts');
  });

  it('a workspace the user is not a member of is 403 and nothing switches — super-admins included', async () => {
    const { user, one } = await twoWorkspaces();
    const stranger = await seedUser({ email: 'stranger@mob06.test' });
    const foreign = await seedWorkspace({ name: 'Foreign', ownerUserId: stranger });
    const a = await signInBrowser(user, 'Laptop');
    from(a, user);
    await getWorkspaceContext();
    const res = await go({ ws: foreign.toString(), to: '/review' });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/not a member/);
    expect((await sessionRow(a.token)).activeWorkspaceId).toBe(one);

    // No god mode through a link.
    const admin = await seedUser({ email: 'root@mob06.test', role: 'super_admin' });
    const home = await seedWorkspace({ name: 'Home', ownerUserId: admin });
    const s = await signInBrowser(admin, 'Console');
    from(s, admin, 'super_admin');
    await getWorkspaceContext();
    const denied = await go({ ws: foreign.toString(), to: '/review' });
    expect(denied.status).toBe(403);
    expect((await sessionRow(s.token)).activeWorkspaceId).toBe(home);
  });

  it('an archived workspace is refused for a normal member', async () => {
    const { user, one, two } = await twoWorkspaces();
    await db.update(workspaces).set({ status: 'archived' }).where(eq(workspaces.id, two));
    const a = await signInBrowser(user, 'Laptop');
    from(a, user);
    await getWorkspaceContext();
    const res = await go({ ws: two.toString(), to: '/review' });
    expect(res.status).toBe(403);
    expect((await sessionRow(a.token)).activeWorkspaceId).toBe(one);
  });

  it.each([
    ['protocol-relative', '//evil.example/phish'],
    ['absolute https', 'https://evil.example/phish'],
    ['absolute http', 'http://app.test/review'],
    ['backslash host', '/\\evil.example'],
    ['javascript:', 'javascript:alert(1)'],
    ['no leading slash', 'review/5'],
    ['empty', ''],
    ['tab in the host', '/\t/evil.example'],
    ['a /go loop', '/go?ws=1&to=/review'],
  ])('refuses a %s target with 400 and switches nothing', async (_label, to) => {
    const { user, one, two } = await twoWorkspaces();
    const a = await signInBrowser(user, 'Laptop');
    from(a, user);
    await getWorkspaceContext();
    const res = await go({ ws: two.toString(), to });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect((await sessionRow(a.token)).activeWorkspaceId).toBe(one);
  });

  it('a malformed workspace id is 400', async () => {
    const { user } = await twoWorkspaces();
    from(await signInBrowser(user, 'Laptop'), user);
    for (const ws of ['', 'abc', '0', '-1', '1e3', '99999999999999999999']) {
      expect((await go({ ws, to: '/review' })).status).toBe(400);
    }
  });

  it('a signed-out visitor is sent to the sign-in page', async () => {
    const { two } = await twoWorkspaces();
    from(null, null);
    const res = await go({ ws: two.toString(), to: '/review' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
  });

  it('a notification link opened in a browser on another workspace lands on the right tenant with the notice', async () => {
    const { user, one, two } = await twoWorkspaces();
    const row = await notify(two, {
      kind: 'lead.replied',
      title: 'Anna replied',
      href: '/communication/7',
    });
    const href = notificationHref(row!);
    expect(href).toBe(`/go?ws=${two}&to=%2Fcommunication%2F7`);

    const b = await signInBrowser(user, 'Phone');
    from(b, user);
    expect((await getWorkspaceContext()).workspaceId).toBe(one);

    const res = await goGET(new Request(`http://app.test${href}`));
    expect(res.status).toBe(303);
    const landing = res.headers.get('location')!;
    expect(landing).toBe(`/communication/7?switched=${two}`);
    expect((await getWorkspaceContext()).workspaceId).toBe(two);

    // The shell's notice on the landing page (WorkspaceSwitchNotice).
    expect(switchNotice(landing, { id: two.toString(), name: 'Two' })).toEqual({
      message: 'Switched to Two',
      cleanHref: '/communication/7',
    });
  });
});

// ---- pure helpers ----------------------------------------------------------

describe('workspace-carrying links (pure)', () => {
  it('safeInAppPath keeps in-app paths and drops everything that leaves the app', () => {
    expect(safeInAppPath('/review/5?state=new#x')).toBe('/review/5?state=new#x');
    expect(safeInAppPath('/communication/7')).toBe('/communication/7');
    for (const bad of [
      '//evil.example',
      '/\\evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      'review',
      '/\nfoo',
      '/go?ws=1&to=/x',
      '/go',
      null,
      undefined,
      `/${'a'.repeat(2100)}`,
    ]) {
      expect(safeInAppPath(bad), String(bad)).toBeNull();
    }
  });

  it('goHref builds a /go link, is idempotent, and drops unsafe targets', () => {
    expect(goHref(12n, '/review/5')).toBe('/go?ws=12&to=%2Freview%2F5');
    expect(goHref(12n, goHref(12n, '/review/5'))).toBe('/go?ws=12&to=%2Freview%2F5');
    expect(goHref(12n, null)).toBeNull();
    expect(goHref(12n, '//evil.example')).toBeNull();
    expect(goHref('abc', '/review')).toBeNull();
  });

  it('goLandingPath flags only a real switch and keeps query and hash', () => {
    expect(goLandingPath('/review?state=new#x', 4n, true)).toBe('/review?state=new&switched=4#x');
    expect(goLandingPath('/review?state=new#x', 4n, false)).toBe('/review?state=new#x');
  });

  it('switchNotice speaks only for the page’s own workspace, and always cleans the flag', () => {
    expect(switchNotice('/review?switched=4', { id: '5', name: 'Five' })).toEqual({
      message: '',
      cleanHref: '/review',
    });
    expect(switchNotice('/review', { id: '5', name: 'Five' })).toBeNull();
  });

  it('workspaceChangedHref carries the expected workspace and a safe return path', () => {
    expect(workspaceChangedHref(3n, '/review/9')).toBe('/workspace-changed?ws=3&to=%2Freview%2F9');
    expect(workspaceChangedHref(null, '//evil.example')).toBe('/workspace-changed');
  });

  it('assistantLink: same workspace stays a client link, another one goes through /go', () => {
    expect(assistantLink('/drafts/12', '4', '4')).toEqual({ href: '/drafts/12', viaGo: false });
    expect(assistantLink('/drafts/12', '4', '5')).toEqual({
      href: '/go?ws=4&to=%2Fdrafts%2F12',
      viaGo: true,
    });
    expect(assistantLink('/drafts/12', null, '5')).toEqual({ href: '/drafts/12', viaGo: false });
    expect(assistantLink('//evil.example', '4', '5')).toBeNull();
  });
});
