// PC-12 review: the work leases are visible in the platform console. The
// spec chose leases over advisory locks "because they are visible in the
// ops console"; Platform console → Operations (/admin/operations) now
// lists the live ones and the expired ones a dead holder left behind.
// Renders the real page against the test database; only the session
// lookup (Auth.js) is replaced.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { db } from '@/lib/db/client';
import { workLeases } from '@/lib/db/schema/work-leases';
import AdminOperationsPage from '@/app/admin/operations/page';
import { areaById } from '@/lib/nav/resolve';
import { makeWorkspaceContext } from '@/lib/services/context';
import { acquireWorkLease, listWorkLeases, type WorkLease } from '@/lib/services/work-leases';
import { platformCtx } from './helpers/platform';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { renderToHtml } from './helpers/next-render';

const session = vi.hoisted(() => ({
  current: null as null | {
    user: { id: string; role: 'member' | 'super_admin'; accountStatus: 'active' };
  },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));

async function render(tree: ReactNode): Promise<string> {
  return (await renderToHtml(tree)).replaceAll('<!-- -->', '');
}

const taken: WorkLease[] = [];

beforeEach(async () => {
  await truncateAll();
  session.current = null;
});

afterEach(async () => {
  for (const l of taken.splice(0)) await l.release();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

async function world() {
  const superAdmin = await seedUser({ email: 'super@ops.test', role: 'super_admin' });
  const owner = await seedUser({ email: 'owner@ops.test' });
  const ws = await seedWorkspace({ name: 'Northwind Insulation', ownerUserId: owner });
  const ctx = makeWorkspaceContext({ workspaceId: ws, userId: owner, role: 'owner' });
  // A live lease: a sync in progress.
  const got = await acquireWorkLease(ctx, { kind: 'mailbox.sync', resource: 7n, purpose: 'manual sync' });
  if (!got.acquired) throw new Error('expected the lease');
  taken.push(got.lease);
  // An expired one: a follow-up pass whose worker died.
  const now = Date.now();
  await db.insert(workLeases).values({
    workspaceId: ws,
    kind: 'outreach.follow_up',
    resourceKey: '',
    holder: 'dead-token',
    holderLabel: 'worker pid 9 on worker-1, boot deadbeef',
    purpose: 'automatic',
    acquiredAt: new Date(now - 40 * 60_000),
    renewedAt: new Date(now - 35 * 60_000),
    expiresAt: new Date(now - 33 * 60_000),
  });
  return { superAdmin, owner, ws };
}

describe('Platform console → Operations: work leases (PC-12)', () => {
  it('lists live leases first, then the expired ones a dead holder left, with workspace, holder and times', async () => {
    const w = await world();
    session.current = { user: { id: w.superAdmin, role: 'super_admin', accountStatus: 'active' } };
    const html = await render(await AdminOperationsPage());

    expect(html).toContain('<h1>Operations</h1>');
    expect(html).toContain('Work leases (1 live, 1 expired)');
    const live = html.indexOf('Mailbox #7');
    const expired = html.indexOf('Follow-up pass');
    expect(live).toBeGreaterThan(0);
    expect(expired).toBeGreaterThan(live);
    expect(html).toMatch(/data-tone="live"[^>]*>.*Live/);
    expect(html).toMatch(/data-tone="danger"[^>]*>.*Expired/);
    expect(html).toContain(`href="/admin/workspaces/${w.ws}"`);
    expect(html).toContain('Northwind Insulation');
    expect(html).toContain('manual sync');
    expect(html).toContain('worker pid 9 on worker-1, boot deadbeef');
    expect(html).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    // No inline colours.
    expect(html).not.toMatch(/style="[^"]*color/i);
  });

  it('says so when nothing holds a lease', async () => {
    const superAdmin = await seedUser({ email: 'super@ops.test', role: 'super_admin' });
    session.current = { user: { id: superAdmin, role: 'super_admin', accountStatus: 'active' } };
    const html = await render(await AdminOperationsPage());
    expect(html).toContain('Work leases (0 live, 0 expired)');
    expect(html).toContain('No work leases');
  });

  it('is for super-admins only: a member is sent away before anything is read', async () => {
    const member = await seedUser({ email: 'member@ops.test' });
    session.current = { user: { id: member, role: 'member', accountStatus: 'active' } };
    await expect(AdminOperationsPage()).rejects.toMatchObject({
      digest: expect.stringContaining('NEXT_REDIRECT'),
    });
  });

  it('the read model names the workspace', async () => {
    const w = await world();
    const rows = await listWorkLeases(platformCtx(w.superAdmin));
    expect(rows.map((r) => [r.kind, r.live, r.workspaceName])).toEqual([
      ['mailbox.sync', true, 'Northwind Insulation'],
      ['outreach.follow_up', false, 'Northwind Insulation'],
    ]);
  });

  it('is a tab of the Platform console', () => {
    const tab = areaById('console').tabs.find((t) => t.href === '/admin/operations');
    expect(tab).toMatchObject({ id: 'console.operations', label: 'Operations' });
  });
});
