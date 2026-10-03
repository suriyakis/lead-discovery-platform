// Who sees money on /settings/usage and Stripe ids on /settings/billing
// (audit I173, deliverable ia:F-02).
//
// Before the fix every member saw the workspace's estimated provider
// cost in dollars on /settings/usage (the platform's cost basis behind
// the € token price) and the raw Stripe customer and subscription ids on
// /settings/billing. Now:
//   - members see events and units only;
//   - admins see the tokens their wallet was charged;
//   - only super-admins see the dollar provider cost;
//   - Stripe ids sit in an admin-only "Details" toggle.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { workspaces, type WorkspaceMemberRole } from '@/lib/db/schema/workspaces';
import { costCentsToTokens } from '@/lib/billing/tokens';
import { recordUsage, summarizeTokenDebits } from '@/lib/services/usage';
import UsagePage from '@/app/(app)/settings/usage/page';
import BillingPage from '@/app/(app)/settings/billing/page';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { renderToHtml } from './helpers/next-render';

const session = vi.hoisted(() => ({
  current: null as null | {
    user: { id: string; role: 'member' | 'super_admin'; accountStatus: 'active' };
  },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => children,
}));

type Who = 'owner' | Exclude<WorkspaceMemberRole, 'owner'> | 'superAdmin';

interface Fixture {
  workspaceId: bigint;
  users: Record<Who, string>;
}

function signInAs(f: Fixture, who: Who): void {
  session.current = {
    user: {
      id: f.users[who],
      role: who === 'superAdmin' ? 'super_admin' : 'member',
      accountStatus: 'active',
    },
  };
}

// Provider cost in cents per event.
const QUALIFY_CENTS = 7;
const SEARCH_CENTS = 2;
const BYOK_CENTS = 5;
const QUALIFY_TOKENS = BigInt(costCentsToTokens(QUALIFY_CENTS));
const SEARCH_TOKENS = BigInt(costCentsToTokens(SEARCH_CENTS));

async function setup(): Promise<Fixture> {
  const owner = await seedUser({ email: 'owner@test.local' });
  const admin = await seedUser({ email: 'admin@test.local' });
  const manager = await seedUser({ email: 'manager@test.local' });
  const member = await seedUser({ email: 'member@test.local' });
  const viewer = await seedUser({ email: 'viewer@test.local' });
  const superAdmin = await seedUser({ email: 'root@test.local', role: 'super_admin' });
  const workspaceId = await seedWorkspace({
    name: 'Costs',
    ownerUserId: owner,
    extraMembers: [
      { userId: admin, role: 'admin' },
      { userId: manager, role: 'manager' },
      { userId: member, role: 'member' },
      { userId: viewer, role: 'viewer' },
      // A super-admin's context role is super_admin whatever the row says.
      { userId: superAdmin, role: 'member' },
    ],
  });
  // Plenty of tokens, so the debits stay clear of the low-balance nudge.
  await db
    .update(workspaces)
    .set({
      tokenBalance: 10_000n,
      stripeCustomerId: 'cus_TESTcustomer123',
      stripeSubscriptionId: 'sub_TESTsubscription456',
    })
    .where(eq(workspaces.id, workspaceId));

  const ctx = { workspaceId };
  // Platform key: debited.
  await recordUsage(ctx, {
    kind: 'ai.qualification',
    provider: 'openai',
    units: 1200,
    costEstimateCents: QUALIFY_CENTS,
    payload: { keySource: 'platform' },
  });
  await recordUsage(ctx, {
    kind: 'search.query',
    provider: 'serpapi',
    units: 1,
    costEstimateCents: SEARCH_CENTS,
    payload: { keySource: 'platform' },
  });
  // The workspace's own key: costs money at the vendor, no tokens.
  await recordUsage(ctx, {
    kind: 'ai.qualification',
    provider: 'openai',
    units: 800,
    costEstimateCents: BYOK_CENTS,
    payload: { keySource: 'workspace' },
  });
  // Mock provider: never debited.
  await recordUsage(ctx, { kind: 'ai.generate', provider: 'mock', units: 10 });

  return {
    workspaceId,
    users: { owner, admin, manager, member, viewer, superAdmin },
  };
}

async function renderUsage(): Promise<string> {
  const tree = await UsagePage({ searchParams: Promise.resolve({}) });
  return (await renderToHtml(tree)).replaceAll('<!-- -->', '');
}

async function renderBilling(): Promise<string> {
  const tree = await BillingPage({ searchParams: Promise.resolve({}) });
  return (await renderToHtml(tree)).replaceAll('<!-- -->', '');
}

/** Dollar amounts such as "$0.14" (React's "<!--$-->" markers don't match). */
const DOLLARS = /\$\d/;

beforeEach(async () => {
  await truncateAll();
  session.current = null;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('summarizeTokenDebits', () => {
  it('sums the tokens charged per kind, provider and key source', async () => {
    const f = await setup();

    const rows = await summarizeTokenDebits({ workspaceId: f.workspaceId });

    const sorted = [...rows].sort((a, b) => a.kind.localeCompare(b.kind));
    expect(sorted).toEqual([
      { kind: 'ai.qualification', provider: 'openai', keySource: 'platform', tokens: QUALIFY_TOKENS },
      { kind: 'search.query', provider: 'serpapi', keySource: 'platform', tokens: SEARCH_TOKENS },
    ]);
  });

  it('only counts the requested workspace', async () => {
    const f = await setup();
    const otherOwner = await seedUser({ email: 'other@test.local' });
    const other = await seedWorkspace({ name: 'Other', ownerUserId: otherOwner });
    await db.update(workspaces).set({ tokenBalance: 10_000n }).where(eq(workspaces.id, other));
    await recordUsage(
      { workspaceId: other },
      {
        kind: 'ai.qualification',
        provider: 'openai',
        units: 1,
        costEstimateCents: 50,
        payload: { keySource: 'platform' },
      },
    );

    const mine = await summarizeTokenDebits({ workspaceId: f.workspaceId });
    const theirs = await summarizeTokenDebits({ workspaceId: other });

    expect(mine.reduce((acc, r) => acc + r.tokens, 0n)).toBe(QUALIFY_TOKENS + SEARCH_TOKENS);
    expect(theirs).toEqual([
      {
        kind: 'ai.qualification',
        provider: 'openai',
        keySource: 'platform',
        tokens: BigInt(costCentsToTokens(50)),
      },
    ]);
  });

  it('filters on the usage event time', async () => {
    const f = await setup();

    const future = await summarizeTokenDebits(
      { workspaceId: f.workspaceId },
      { since: new Date(Date.now() + 60_000) },
    );
    const past = await summarizeTokenDebits(
      { workspaceId: f.workspaceId },
      { until: new Date(Date.now() - 60 * 60_000) },
    );

    expect(future).toEqual([]);
    expect(past).toEqual([]);
  });
});

describe('/settings/usage', () => {
  it.each(['manager', 'member', 'viewer'] as const)(
    'shows a %s events and units but no cost or token column',
    async (who) => {
      const f = await setup();
      signInAs(f, who);

      const html = await renderUsage();

      expect(html).toContain('ai.qualification');
      // DS-09 / ia:F-11: the kind reads as its label; the code is only a tooltip.
      expect(html).toContain('>Record qualification<');
      expect(html).not.toContain('<code>ai.qualification</code>');
      expect(html).toContain('Total events');
      expect(html).not.toMatch(DOLLARS);
      expect(html).not.toContain('Est. provider cost');
      expect(html).not.toContain('Tokens charged');
      expect(html).toContain('Token charges are visible to workspace admins');
    },
  );

  it.each(['owner', 'admin'] as const)(
    'shows an %s the tokens charged but not the provider cost',
    async (who) => {
      const f = await setup();
      signInAs(f, who);

      const html = await renderUsage();

      expect(html).toContain('Tokens charged');
      expect(html).toContain(`<dd>${(QUALIFY_TOKENS + SEARCH_TOKENS).toLocaleString()}</dd>`);
      expect(html).toContain(`<td class="num">${QUALIFY_TOKENS.toLocaleString()}</td>`);
      expect(html).not.toMatch(DOLLARS);
      expect(html).not.toContain('Est. provider cost');
    },
  );

  it('shows a super-admin the provider cost as well', async () => {
    const f = await setup();
    signInAs(f, 'superAdmin');

    const html = await renderUsage();

    const totalCents = QUALIFY_CENTS + SEARCH_CENTS + BYOK_CENTS;
    expect(html).toContain('Tokens charged');
    expect(html).toContain('Est. provider cost');
    expect(html).toContain(`$${(totalCents / 100).toFixed(2)}`);
  });

  it('describes key sources in customer terms', async () => {
    const f = await setup();
    signInAs(f, 'member');

    const html = await renderUsage();

    expect(html).toContain('the provider bills you directly and no tokens are charged');
    expect(html).not.toContain('platform owner');
  });
});

describe('/settings/billing', () => {
  it.each(['manager', 'member', 'viewer'] as const)('hides the Stripe ids from a %s', async (who) => {
    const f = await setup();
    signInAs(f, who);

    const html = await renderBilling();

    expect(html).toContain('Current plan');
    expect(html).not.toContain('cus_TESTcustomer123');
    expect(html).not.toContain('sub_TESTsubscription456');
    expect(html).not.toContain('Stripe customer');
  });

  it.each(['owner', 'admin'] as const)(
    'gives an %s the Stripe ids behind a Details toggle',
    async (who) => {
      const f = await setup();
      signInAs(f, who);

      const html = await renderBilling();

      const details = html.match(/<details[^>]*><summary>Details<\/summary>[\s\S]*?<\/details>/);
      expect(details).not.toBeNull();
      expect(details![0]).toContain('<code>cus_TESTcustomer123</code>');
      expect(details![0]).toContain('<code>sub_TESTsubscription456</code>');
      // Nowhere else on the page.
      expect(html.split('cus_TESTcustomer123')).toHaveLength(2);
    },
  );
});
