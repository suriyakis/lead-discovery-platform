// AP-06 (I069, ia:F-16): /health renders the live findings, the scheduled
// check's switch and interval for owners and admins only, Run now, and the
// saved reports — whatever release wrote them. The page is rendered for
// seeded users with the real workspace resolution; only the session and
// the shell are stubbed.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/auth';
import { workspaceHealthReports } from '@/lib/db/schema/health';
import { mailboxes } from '@/lib/db/schema/mailing';
import { workspaceMembers } from '@/lib/db/schema/workspaces';
import { setPlatformOutboundStop } from '@/lib/services/holds';
import HealthPage from '@/app/(app)/health/page';
import { renderToHtml } from './helpers/next-render';
import { platformCtx } from './helpers/platform';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

const session = vi.hoisted(() => ({
  current: null as null | {
    user: { id: string; name: string; email: string; role: 'member'; accountStatus: 'active' };
  },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => children,
}));

async function signInAs(userId: string): Promise<void> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  session.current = {
    user: { id: userId, name: u!.name ?? 'Test', email: u!.email, role: 'member', accountStatus: 'active' },
  };
}

async function render(): Promise<string> {
  const tree = await HealthPage({ searchParams: Promise.resolve({}) });
  return (await renderToHtml(tree)).replaceAll('<!-- -->', '');
}

beforeEach(async () => {
  await truncateAll();
  session.current = null;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('/health', () => {
  it('shows live findings with fix links, the schedule controls for an owner, and a pre-AP-06 report', async () => {
    const owner = await seedUser({ email: 'owner@health.test' });
    const workspaceId = await seedWorkspace({ name: 'H', ownerUserId: owner });
    const [mb] = await db
      .insert(mailboxes)
      .values({
        workspaceId,
        name: 'Sales',
        fromAddress: 'sales@health.test',
        smtpHost: 'smtp.test',
        smtpUser: 'sales',
        smtpPasswordSecretKey: 'k.sales',
        imapFolder: 'INBOX',
        status: 'failing',
        lastError: 'IMAP: Socket timed out',
      })
      .returning({ id: mailboxes.id });
    const root = await seedUser({ email: 'root@health.test', role: 'super_admin' });
    await setPlatformOutboundStop(platformCtx(root), 'provider incident');
    // A report saved before AP-06: the one-sentence shape.
    await db.insert(workspaceHealthReports).values({
      workspaceId,
      score: 78,
      findings: [
        { severity: 'warning', code: 'runs.failed', message: '2 discovery runs failed.', href: '/connectors' },
      ],
      commReview: [],
      advice: ['Fix the runs.'],
    });
    await signInAs(owner);
    const html = await render();

    expect(html).toContain('Right now');
    expect(html).toContain('data-code="mailbox.failing"');
    expect(html).toContain('Mailbox &quot;Sales&quot; is failing');
    expect(html).toContain(`href="/mailbox/${mb!.id}"`);
    // Nothing to change in the workspace: the link says who acts.
    expect(html).toMatch(/data-code="automation.platform_stop".*?Contact support/s);
    // The schedule: switch, interval and Run now for an owner.
    expect(html).toContain('name="enabled"');
    expect(html).toContain('name="intervalDays"');
    expect(html).toContain('Run check now');
    // The saved report, old shape included.
    expect(html).toContain('2 discovery runs failed.');
    expect(html).toMatch(/Latest report.*?78/s);
  });

  it('a member sees the findings and the schedule, but no controls', async () => {
    const owner = await seedUser({ email: 'owner2@health.test' });
    const member = await seedUser({ email: 'member@health.test' });
    const workspaceId = await seedWorkspace({ name: 'M', ownerUserId: owner });
    await db.insert(workspaceMembers).values({ workspaceId, userId: member, role: 'member' });
    await signInAs(member);
    const html = await render();
    expect(html).toContain('data-code="mailbox.none"');
    expect(html).toContain('On: every 7 days');
    expect(html).not.toContain('name="enabled"');
    expect(html).not.toContain('Run check now');
    expect(html).toContain('Owners and admins change the schedule');
  });
});
