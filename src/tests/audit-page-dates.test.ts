// The two audit-log pages with Since / Until filters: /admin/audit
// (platform-wide, super-admin) and /settings/audit (one workspace).
//
// /admin/audit used to return a server error whenever Since or Until was
// set, because its service bound a JS Date inside a raw sql`` template
// (audit finding I050, deliverable PC-01). Both pages also read the
// datetime-local values in the server's time zone instead of the
// viewer's. These tests render the real pages for a Warsaw viewer and
// check which events land inside the window.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import PlatformAuditPage from '@/app/admin/audit/page';
import WorkspaceAuditPage from '@/app/settings/audit/page';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { renderToHtml } from './helpers/next-render';

// The pages read the signed-in user through Auth.js; tests drive them
// with a plain session object. getWorkspaceContext() stays real.
const session = vi.hoisted(() => ({
  current: null as null | {
    user: { id: string; role: 'member' | 'super_admin'; accountStatus: 'active' };
  },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => children,
}));
// The real field calls Next's useRouter(), which needs the app router
// mounted. Its server-rendered output is just this hidden input.
vi.mock('@/components/ViewerTimeZoneField', async () => {
  const { createElement } = await import('react');
  return {
    ViewerTimeZoneField: ({ current }: { current: string | null }) =>
      createElement('input', { type: 'hidden', name: 'tz', value: current ?? '', readOnly: true }),
  };
});

type SearchParams = Record<string, string>;

/** Drop React's `<!-- -->` text separators so assertions match what the user reads. */
async function render(tree: ReactNode): Promise<string> {
  return (await renderToHtml(tree)).replaceAll('<!-- -->', '');
}

function renderPlatformPage(sp: SearchParams): Promise<string> {
  return PlatformAuditPage({ searchParams: Promise.resolve(sp) }).then(render);
}

function renderWorkspacePage(sp: SearchParams): Promise<string> {
  return WorkspaceAuditPage({ searchParams: Promise.resolve(sp) }).then(render);
}

/**
 * One event on each side of each bound of 10:00Z..12:00Z, which is
 * 11:00..13:00 for a viewer in Warsaw (CET, UTC+1, on 10 March). The
 * entity id names the event, so it shows in the timeline as
 * `probe#<name>` (kinds would also match the Kind dropdown).
 */
async function seedProbes(workspaceId: bigint, userId: string): Promise<void> {
  const probes: Array<[string, string]> = [
    ['before-since', '2026-03-10T09:59:59Z'],
    ['at-since', '2026-03-10T10:00:00Z'],
    ['inside', '2026-03-10T11:30:00Z'],
    ['at-until', '2026-03-10T12:00:00Z'],
    ['after-until', '2026-03-10T12:00:01Z'],
  ];
  await db.insert(auditLog).values(
    probes.map(([name, at]) => ({
      workspaceId,
      userId,
      kind: 'probe.event',
      entityType: 'probe',
      entityId: name,
      payload: {},
      createdAt: new Date(at),
    })),
  );
}

const WARSAW_WINDOW = { since: '2026-03-10T11:00', until: '2026-03-10T13:00' };

function expectWarsawWindow(html: string): void {
  expect(html).toContain('probe#at-since');
  expect(html).toContain('probe#inside');
  expect(html).toContain('probe#at-until');
  expect(html).not.toContain('probe#before-since');
  expect(html).not.toContain('probe#after-until');
  // Timestamps, the echoed inputs and the hidden field all use the
  // viewer's zone, so re-submitting reads the inputs the same way.
  expect(html).toContain('2026-03-10 11:00:00');
  expect(html).toContain('2026-03-10 13:00:00');
  expect(html).toContain('value="2026-03-10T11:00"');
  expect(html).toContain('value="2026-03-10T13:00"');
  expect(html).toContain('name="tz" value="Europe/Warsaw"');
  expect(html).toContain('Times are in Europe/Warsaw.');
}

beforeEach(async () => {
  await truncateAll();
  session.current = null;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('/admin/audit date filters', () => {
  async function seedPlatform() {
    const superAdmin = await seedUser({ email: 'super@test.local', role: 'super_admin' });
    const workspaceId = await seedWorkspace({ name: 'Ops', ownerUserId: superAdmin });
    await seedProbes(workspaceId, superAdmin);
    session.current = {
      user: { id: superAdmin, role: 'super_admin', accountStatus: 'active' },
    };
  }

  it('renders the events inside Since..Until, read in the viewer time zone', async () => {
    await seedPlatform();
    const html = await renderPlatformPage({ ...WARSAW_WINDOW, tz: 'Europe/Warsaw' });
    expectWarsawWindow(html);
  });

  it('falls back to UTC, and says so, without a usable time zone', async () => {
    await seedPlatform();
    for (const tz of [{}, { tz: 'Not/AZone' }] as SearchParams[]) {
      const html = await renderPlatformPage({ ...WARSAW_WINDOW, ...tz });
      // The same inputs now mean 11:00Z..13:00Z.
      expect(html).not.toContain('probe#at-since');
      expect(html).toContain('probe#inside');
      expect(html).toContain('probe#after-until');
      expect(html).toContain('Times are in UTC.');
      expect(html).toContain('name="tz" value=""');
    }
  });
});

describe('/settings/audit date filters', () => {
  it('renders the events inside Since..Until, read in the viewer time zone', async () => {
    const owner = await seedUser({ email: 'owner@test.local' });
    const workspaceId = await seedWorkspace({ name: 'Acme', ownerUserId: owner });
    await seedProbes(workspaceId, owner);
    session.current = { user: { id: owner, role: 'member', accountStatus: 'active' } };

    const html = await renderWorkspacePage({ ...WARSAW_WINDOW, tz: 'Europe/Warsaw' });
    expectWarsawWindow(html);
  });
});
