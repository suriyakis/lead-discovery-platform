// Regression tests for /settings/crm/[id] (deliverable ia:F-08, audit
// I115).
//
// The Test-connection <form> used to be nested inside the Save <form>.
// The HTML parser drops a nested form, so React failed to hydrate the page
// (error 418), "Test connection" did nothing once hydrated, and a click on
// Save before hydration ran the test and discarded the edits. Archive was
// one click with no confirmation and no way back, and a test silently
// un-archived the connection.
//
// These tests render the page and run its module-scope actions (./actions)
// against the database the way the page binds them.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { crmConnections } from '@/lib/db/schema/crm';
import { auditLog } from '@/lib/db/schema/audit';
import { workspaceMembers } from '@/lib/db/schema/workspaces';
import { makeWorkspaceContext } from '@/lib/services/context';
import { createCrmConnection } from '@/lib/services/crm';
import {
  archiveCrmConnectionAction,
  restoreCrmConnectionAction,
  saveCrmConnectionAction,
  testCrmConnectionAction,
} from '@/app/settings/crm/[id]/actions';
import CrmConnectionDetail from '@/app/settings/crm/[id]/page';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { expectRedirect, renderToHtml } from './helpers/next-render';

const session = vi.hoisted(() => ({
  current: null as null | {
    user: { id: string; role: 'member'; accountStatus: 'active' };
  },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => children,
}));

function signInAs(userId: string): void {
  session.current = { user: { id: userId, role: 'member', accountStatus: 'active' } };
}

function parseTarget(target: string): { path: string; query: Record<string, string> } {
  const url = new URL(target, 'http://app.test');
  return { path: url.pathname, query: Object.fromEntries(url.searchParams) };
}

function saveForm(fields: { name: string; credential?: string; baseUrl?: string }): FormData {
  const fd = new FormData();
  fd.set('name', fields.name);
  fd.set('credential', fields.credential ?? '');
  fd.set('baseUrl', fields.baseUrl ?? '');
  return fd;
}

async function loadConnection(id: bigint) {
  const [row] = await db.select().from(crmConnections).where(eq(crmConnections.id, id));
  return row!;
}

interface Fixture {
  owner: string;
  workspaceId: bigint;
  connectionId: bigint;
}

async function setup(): Promise<Fixture> {
  const owner = await seedUser({ email: 'owner@test.local' });
  const workspaceId = await seedWorkspace({ name: 'A', ownerUserId: owner });
  const conn = await createCrmConnection(
    makeWorkspaceContext({ workspaceId, userId: owner, role: 'owner' }),
    { system: 'csv', name: 'CSV exports', config: { baseUrl: 'https://crm.example.test', region: 'eu' } },
  );
  return { owner, workspaceId, connectionId: conn.id };
}

async function addMember(workspaceId: bigint, role: 'member' | 'viewer'): Promise<string> {
  const userId = await seedUser({ email: `${role}@test.local` });
  await db.insert(workspaceMembers).values({ workspaceId, userId, role });
  return userId;
}

async function renderDetail(id: bigint, sp: { message?: string; error?: string } = {}) {
  const tree = await CrmConnectionDetail({
    params: Promise.resolve({ id: id.toString() }),
    searchParams: Promise.resolve(sp),
  });
  return (await renderToHtml(tree)).replaceAll('<!-- -->', '');
}

/** Deepest <form> nesting in the markup. A browser drops any form nested
 *  inside another, so anything above 1 is broken markup. */
function maxFormDepth(html: string): number {
  let depth = 0;
  let max = 0;
  for (const m of html.matchAll(/<(\/?)form\b/g)) {
    depth += m[1] ? -1 : 1;
    max = Math.max(max, depth);
  }
  return max;
}

/** The markup of each top-level <form> on the page. */
function forms(html: string): string[] {
  return [...html.matchAll(/<form\b[\s\S]*?<\/form>/g)].map((m) => m[0]);
}

beforeEach(async () => {
  await truncateAll();
  session.current = null;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('/settings/crm/[id] page', () => {
  it('renders one settings form with Save and Test, and Archive behind a confirm', async () => {
    const f = await setup();
    signInAs(f.owner);

    const html = await renderDetail(f.connectionId);

    expect(maxFormDepth(html)).toBe(1);
    const settingsForm = forms(html).find((x) => x.includes('name="baseUrl"'));
    expect(settingsForm).toBeDefined();
    expect(settingsForm).toContain('>Save</button>');
    // Test is a second submit button of the same form, not a form of its own.
    expect(settingsForm).toMatch(/<button[^>]*formnovalidate=""[^>]*>Test connection<\/button>/i);
    expect(html).toContain('Archive connection');
    expect(html).not.toContain('Restore connection');
  });

  it('shows Restore instead of Archive and hides Test on an archived connection', async () => {
    const f = await setup();
    signInAs(f.owner);
    await expectRedirect(() => archiveCrmConnectionAction(f.connectionId.toString()));

    const html = await renderDetail(f.connectionId);

    expect(maxFormDepth(html)).toBe(1);
    expect(html).toContain('This connection is archived');
    expect(html).toContain('Restore connection');
    expect(html).not.toContain('Archive connection');
    expect(html).not.toContain('Test connection');
  });

  it('hides Test and the admin section from a viewer', async () => {
    const f = await setup();
    const viewer = await addMember(f.workspaceId, 'viewer');
    signInAs(viewer);

    const html = await renderDetail(f.connectionId);

    expect(html).not.toContain('Test connection');
    expect(html).not.toContain('Archive connection');
  });
});

describe('/settings/crm/[id] actions', () => {
  it('Save persists the edits, keeps other config keys and can clear the base URL', async () => {
    const f = await setup();
    signInAs(f.owner);
    const id = f.connectionId.toString();

    const saved = await expectRedirect(() =>
      saveCrmConnectionAction(id, saveForm({ name: '  HubSpot EU  ', baseUrl: 'https://eu.example.test' })),
    );
    expect(parseTarget(saved)).toEqual({ path: `/settings/crm/${id}`, query: { message: 'Saved.' } });
    let row = await loadConnection(f.connectionId);
    expect(row.name).toBe('HubSpot EU');
    expect(row.config).toEqual({ baseUrl: 'https://eu.example.test', region: 'eu' });

    await expectRedirect(() => saveCrmConnectionAction(id, saveForm({ name: 'HubSpot EU' })));
    row = await loadConnection(f.connectionId);
    expect(row.config).toEqual({ region: 'eu' });
  });

  it('Save refuses an empty name without touching the row', async () => {
    const f = await setup();
    signInAs(f.owner);

    const target = await expectRedirect(() =>
      saveCrmConnectionAction(f.connectionId.toString(), saveForm({ name: '   ' })),
    );

    expect(parseTarget(target).query.error).toBe('Display name is required.');
    expect((await loadConnection(f.connectionId)).name).toBe('CSV exports');
  });

  it('Test reports its result on the page and records the status', async () => {
    const f = await setup();
    signInAs(f.owner);
    await db
      .update(crmConnections)
      .set({ status: 'failing', lastError: 'old error' })
      .where(eq(crmConnections.id, f.connectionId));

    const target = await expectRedirect(() =>
      testCrmConnectionAction(f.connectionId.toString()),
    );

    expect(parseTarget(target)).toEqual({
      path: `/settings/crm/${f.connectionId}`,
      query: { message: 'Connection OK.' },
    });
    const row = await loadConnection(f.connectionId);
    expect(row.status).toBe('active');
    expect(row.lastError).toBeNull();
  });

  it('a failed test is shown as an error with the CRM’s reason', async () => {
    const f = await setup();
    signInAs(f.owner);
    const hubspot = await createCrmConnection(
      makeWorkspaceContext({ workspaceId: f.workspaceId, userId: f.owner, role: 'owner' }),
      { system: 'hubspot', name: 'HubSpot without a token' },
    );

    const target = await expectRedirect(() => testCrmConnectionAction(hubspot.id.toString()));

    expect(parseTarget(target).query).toEqual({
      error: 'Connection test failed: hubspot connector requires a token (workspace secret)',
    });
    expect((await loadConnection(hubspot.id)).status).toBe('failing');
  });

  it('Test on an archived connection is refused and the connection stays archived', async () => {
    const f = await setup();
    signInAs(f.owner);
    const id = f.connectionId.toString();
    await expectRedirect(() => archiveCrmConnectionAction(id));

    const target = await expectRedirect(() => testCrmConnectionAction(id));

    expect(parseTarget(target).query.error).toMatch(/archived/i);
    expect(parseTarget(target).query.message).toBeUndefined();
    expect((await loadConnection(f.connectionId)).status).toBe('archived');
  });

  it('Archive then Restore round-trips the connection back to active', async () => {
    const f = await setup();
    signInAs(f.owner);
    const id = f.connectionId.toString();

    const archived = await expectRedirect(() => archiveCrmConnectionAction(id));
    expect(parseTarget(archived).path).toBe(`/settings/crm/${id}`);
    expect(parseTarget(archived).query.message).toMatch(/archived/);
    expect((await loadConnection(f.connectionId)).status).toBe('archived');

    const restored = await expectRedirect(() => restoreCrmConnectionAction(id));
    expect(parseTarget(restored).query.message).toMatch(/restored/);
    expect((await loadConnection(f.connectionId)).status).toBe('active');

    const kinds = await db
      .select({ kind: auditLog.kind })
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, f.workspaceId), eq(auditLog.entityType, 'crm_connection')));
    expect(kinds.map((k) => k.kind)).toEqual(
      expect.arrayContaining(['crm.archive_connection', 'crm.restore_connection']),
    );
  });

  it('a member cannot archive or restore; they get a flash and nothing changes', async () => {
    const f = await setup();
    const member = await addMember(f.workspaceId, 'member');
    signInAs(member);

    const target = await expectRedirect(() =>
      archiveCrmConnectionAction(f.connectionId.toString()),
    );

    expect(parseTarget(target).query.error).toBe(
      'Only workspace admins can change CRM connections.',
    );
    expect((await loadConnection(f.connectionId)).status).toBe('active');
  });

  it('cannot act on another workspace’s connection', async () => {
    const f = await setup();
    const ownerB = await seedUser({ email: 'ownerB@test.local' });
    await seedWorkspace({ name: 'B', ownerUserId: ownerB });
    signInAs(ownerB);

    const target = await expectRedirect(() =>
      archiveCrmConnectionAction(f.connectionId.toString()),
    );

    expect(parseTarget(target).query.error).toBe('This CRM connection no longer exists.');
    expect((await loadConnection(f.connectionId)).status).toBe('active');
  });

  it('rejects a tampered connection id', async () => {
    const f = await setup();
    signInAs(f.owner);

    await expect(expectRedirect(() => testCrmConnectionAction('1 or 1=1'))).resolves.toBe(
      '/settings/crm',
    );
  });
});
