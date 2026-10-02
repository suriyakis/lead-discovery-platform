// PC-33 / I070: Today's Overview numbers. A failed load comes back
// `degraded` and renders "—" with a warning — never a zero that reads as a
// real count (and never "not paused" because the load failed). The cap
// numbers themselves are pinned against the drain in diagnostics.test.ts.
// MOB-02: the decision tiles (Pending review, Drafts awaiting approval)
// come from the attention summary; its own failures render "—" too.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db/client';
import { reviewItems } from '@/lib/db/schema/review';
import { sourceRecords } from '@/lib/db/schema/connectors';
import { getAttentionSummary } from '@/lib/attention/service';
import type { AttentionSummary } from '@/lib/attention/types';
import { makeWorkspaceContext } from '@/lib/services/context';
import { getDashboardSignals } from '@/lib/services/dashboard-signals';
import { getActiveWorkspaceSummary } from '@/lib/services/workspace';
import { TodayOverview } from '@/app/today/_overview';
import { renderToHtml } from './helpers/next-render';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

// One query of the load fails on demand (a lost table, a timeout).
const failing = vi.hoisted(() => ({ on: false }));
vi.mock('@/lib/services/outreach-queue', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/services/outreach-queue')>();
  return {
    ...real,
    getSendCapUsage: async (...args: Parameters<typeof real.getSendCapUsage>) => {
      if (failing.on) throw new Error('relation "mail_messages" does not exist');
      return real.getSendCapUsage(...args);
    },
  };
});

beforeEach(async () => {
  await truncateAll();
  failing.on = false;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

async function workspaceWithReviews(n: number) {
  const owner = await seedUser({ email: 'signals@test.local' });
  const workspaceId = await seedWorkspace({ name: 'signals', ownerUserId: owner });
  for (let i = 0; i < n; i += 1) {
    const [sr] = await db
      .insert(sourceRecords)
      .values({ workspaceId, sourceSystem: 'mock', sourceId: `s-${i}`, rawData: {}, normalizedData: {} })
      .returning();
    await db.insert(reviewItems).values({ workspaceId, sourceRecordId: sr!.id, state: 'new' });
  }
  return makeWorkspaceContext({ workspaceId, userId: owner, role: 'owner' });
}

async function renderOverview(
  ctx: ReturnType<typeof makeWorkspaceContext>,
  attentionOverride?: AttentionSummary | null,
) {
  const signals = await getDashboardSignals(ctx);
  const attention =
    attentionOverride === undefined ? await getAttentionSummary(ctx) : attentionOverride;
  const html = await renderToHtml(
    TodayOverview({
      user: { name: 'Owner', email: 'signals@test.local', role: 'member' },
      active: await getActiveWorkspaceSummary(ctx),
      signals,
      attention,
      showSetupLink: false,
      viewer: { role: ctx.role, isSuperAdmin: false },
    }),
  );
  return { signals, html: html.replaceAll('<!-- -->', '') };
}

const cardValue = (html: string, label: string) =>
  new RegExp(
    `cockpit-card-label">${label.replace(/[()]/g, '\\$&')}</span></div><div class="cockpit-card-value">([^<]*)<`,
  ).exec(html)?.[1];

describe('Today › Overview signals', () => {
  it('shows the counts and the cap usage when the load works', async () => {
    const ctx = await workspaceWithReviews(2);
    const { signals, html } = await renderOverview(ctx);
    expect(signals.degraded).toBe(false);
    expect(cardValue(html, 'Pending review')).toBe('2');
    expect(html).toContain('0/50 sent in 24 h');
    expect(html).not.toContain('Some numbers could not be loaded');
  });

  it('a failed query renders "—" with a warning, never 0', async () => {
    const ctx = await workspaceWithReviews(2);
    failing.on = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { signals, html } = await renderOverview(ctx);
    expect(signals.degraded).toBe(true);
    expect(html).toContain('Some numbers could not be loaded');
    for (const label of ['Inbound mail (7d)', 'Send queue']) {
      expect(cardValue(html, label), label).toBe('—');
    }
    // The decision tiles are the attention summary's, which still loaded.
    expect(cardValue(html, 'Pending review')).toBe('2');
    expect(html).toContain('— sent in 24 h');
    expect(html).not.toContain('PAUSED');
    // No funnel of empty bars either.
    expect(html).not.toContain('Pipeline funnel');
  });

  it('a degraded attention summary renders its tiles as "—" with the warning (MOB-02)', async () => {
    const ctx = await workspaceWithReviews(2);
    const real = await getAttentionSummary(ctx);
    const degraded: AttentionSummary = {
      ...real,
      counts: { ...real.counts, 'review.open': null, 'drafts.approve': null },
      failed: ['review.open', 'drafts.approve'],
      degraded: true,
    };
    const { signals, html } = await renderOverview(ctx, degraded);
    expect(signals.degraded).toBe(false);
    expect(html).toContain('Some numbers could not be loaded');
    expect(cardValue(html, 'Pending review')).toBe('—');
    expect(cardValue(html, 'Drafts awaiting approval')).toBe('—');
    expect(cardValue(html, 'Send queue')).toBe('0');
    // No summary at all: unknown, not zero.
    const none = await renderOverview(ctx, null);
    expect(cardValue(none.html, 'Pending review')).toBe('—');
  });
});
