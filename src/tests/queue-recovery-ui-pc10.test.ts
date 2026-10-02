// PC-10 — the recovery controls on the existing pages: Retry now / Requeue
// on /mailbox/queue rows (any write role, never a viewer), the failure
// kind and backoff on a row, and Cancel + auto-refresh on a run page.
// Pages render through React's server renderer with the session mocked;
// getWorkspaceContext() stays real, so roles come from workspace_members.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { connectorRuns } from '@/lib/db/schema/connectors';
import { outreachQueue } from '@/lib/db/schema/outreach';
import {
  markQueuedEmailDeliveredAction,
  requeueQueuedEmailAction,
  retryQueuedEmailAction,
} from '@/app/mailbox/queue/actions';
import { MARKED_DELIVERED_MESSAGE, REQUEUED_MESSAGE } from '@/app/mailbox/queue/forms';
import QueuePage from '@/app/mailbox/queue/page';
import { cancelRunAction } from '@/app/connectors/[id]/runs/[runId]/actions';
import RunDetailPage from '@/app/connectors/[id]/runs/[runId]/page';
import { createConnector } from '@/lib/services/connector-run';
import { drainQueue } from '@/lib/services/outreach-queue';
import { addSuppression } from '@/lib/services/suppression';
import { reapStuckSends } from '@/lib/services/stuck-work';
import { pauseAutomation } from '@/lib/services/automation-pause';
import { truncateAll } from './helpers/db';
import { expectRedirect, renderToHtml } from './helpers/next-render';
import {
  FlakyProvider,
  greylisted,
  queueCtx as ctx,
  queuedDraft,
  relayDenied,
  setupQueueWorkspace as setup,
  type QueueSetup as Setup,
} from './helpers/outreach-fixtures';

const session = vi.hoisted(() => ({
  current: null as null | {
    user: { id: string; role: 'member'; accountStatus: 'active' };
  },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => children,
}));
// The real component needs the App Router; a marker shows it was rendered.
vi.mock('@/components/AutoRefresh', async () => {
  const { createElement } = await import('react');
  return {
    AutoRefresh: () => createElement('span', { 'data-auto-refresh': 'on' }),
  };
});

function signInAs(userId: string): void {
  session.current = { user: { id: userId, role: 'member', accountStatus: 'active' } };
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

function flash(target: string): { path: string; message?: string; error?: string } {
  const url = new URL(target, 'http://app.test');
  return {
    path: url.pathname,
    message: url.searchParams.get('message') ?? undefined,
    error: url.searchParams.get('error') ?? undefined,
  };
}

async function renderQueue(status: string) {
  const tree = await QueuePage({ searchParams: Promise.resolve({ status }) });
  return (await renderToHtml(tree)).replaceAll('<!-- -->', '');
}

async function renderRun(connectorId: bigint, runId: bigint) {
  const tree = await RunDetailPage({
    params: Promise.resolve({ id: connectorId.toString(), runId: runId.toString() }),
    searchParams: Promise.resolve({}),
  });
  return (await renderToHtml(tree)).replaceAll('<!-- -->', '');
}

async function failedRow(s: Setup, to = 'anna@target.com') {
  const { entry } = await queuedDraft(s, to);
  await drainQueue(ctx(s), { providerOverride: new FlakyProvider(relayDenied) });
  return entry.id;
}

async function row(id: bigint) {
  const [r] = await db.select().from(outreachQueue).where(eq(outreachQueue.id, id));
  return r!;
}

beforeEach(async () => {
  await truncateAll();
  session.current = null;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('/mailbox/queue recovery controls', () => {
  it('[handbook H-34] temporary failures retry on their own; failed entries offer Retry now and Requeue to editors; a send stuck for 10 minutes ends "Interrupted: delivery unknown"', async () => {
    const s = await setup();

    // A temporary failure goes back to the queue by itself.
    const temp = await queuedDraft(s, 'temp@one.com');
    const r = await drainQueue(ctx(s), { providerOverride: new FlakyProvider(greylisted) });
    expect(r.retrying).toBe(1);
    expect((await row(temp.entry.id)).status).toBe('queued');

    // A permanent one fails and gets the two controls — for a member, not a viewer.
    const failedId = await failedRow(s, 'anna@target.com');
    signInAs(s.memberId);
    const html = await renderQueue('failed');
    expect(html).toContain('>Retry now</button>');
    expect(html).toContain('>Requeue</button>');
    expect(html).toContain(`name="id" value="${failedId}"`);
    expect(html).toContain('Refused'); // the failure kind
    signInAs(s.viewerId);
    const viewerHtml = await renderQueue('failed');
    expect(viewerHtml).toContain('Quick question');
    expect(viewerHtml).not.toContain('Retry now');
    expect(viewerHtml).not.toContain('Requeue');

    // A send cut off mid-flight is settled after 10 minutes.
    const stuck = await queuedDraft(s, 'stuck@two.com');
    await db
      .update(outreachQueue)
      .set({ status: 'sending', claimedAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(outreachQueue.id, stuck.entry.id));
    await reapStuckSends(ctx(s));
    const settled = await row(stuck.entry.id);
    expect(settled.status).toBe('failed');
    expect(settled.lastError).toMatch(/^Interrupted: delivery unknown/);
  });

  it('shows the backoff on a queued row and warns about a send stuck in "sending"', async () => {
    const s = await setup();
    const backing = await queuedDraft(s, 'temp@one.com');
    await drainQueue(ctx(s), { providerOverride: new FlakyProvider(greylisted) });
    const stuck = await queuedDraft(s, 'stuck@two.com');
    await db
      .update(outreachQueue)
      .set({ status: 'sending', claimedAt: new Date(Date.now() - 12 * 60_000) })
      .where(eq(outreachQueue.id, stuck.entry.id));
    signInAs(s.memberId);

    const html = await renderQueue('all');
    expect(html).toMatch(/next attempt \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \(after 1 of 5\)/);
    expect(html).toContain('Temporary failure');
    expect(html).toContain('This send has not finished for more than 10 minutes.');
    expect((await row(backing.entry.id)).nextAttemptAt).not.toBeNull();
  });

  it('Retry now reports what happened: held under the emergency pause, or not sent for a suppressed address', async () => {
    const s = await setup();
    const id = await failedRow(s);
    signInAs(s.memberId);

    await addSuppression(ctx(s), {
      address: 'anna@target.com',
      reason: 'manual',
      source: 'manual',
    });
    const skipped = flash(
      await expectRedirect(() =>
        retryQueuedEmailAction(form({ status: 'failed', id: String(id) })),
      ),
    );
    expect(skipped.path).toBe('/mailbox/queue');
    expect(skipped.message).toBe('Not sent now. suppressed: anna@target.com');
    expect((await row(id)).status).toBe('skipped');

    // PC-05: under the workspace pause Retry now without "send anyway"
    // only puts the email back.
    await pauseAutomation(ctx(s), { source: 'api' });
    const paused = flash(
      await expectRedirect(() =>
        retryQueuedEmailAction(form({ status: 'skipped', id: String(id) })),
      ),
    );
    expect(paused.message).toMatch(/^Put back in the queue\. Automation is paused/);
    expect((await row(id)).status).toBe('queued');
  });

  it('Requeue puts it back for an editor, refuses a viewer and an email already waiting', async () => {
    const s = await setup();
    const id = await failedRow(s);

    signInAs(s.viewerId);
    const refused = flash(
      await expectRedirect(() =>
        requeueQueuedEmailAction(form({ status: 'failed', id: String(id) })),
      ),
    );
    expect(refused.error).toBe('Your role can view the send queue but not change it.');
    expect((await row(id)).status).toBe('failed');

    signInAs(s.memberId);
    const ok = flash(
      await expectRedirect(() =>
        requeueQueuedEmailAction(form({ status: 'failed', id: String(id) })),
      ),
    );
    expect(ok.message).toBe(REQUEUED_MESSAGE);
    expect((await row(id)).status).toBe('queued');

    const again = flash(
      await expectRedirect(() =>
        requeueQueuedEmailAction(form({ status: 'failed', id: String(id) })),
      ),
    );
    expect(again.error).toBe('That email is already waiting in the queue.');
  });

  it('an interrupted entry offers Mark as delivered to an editor; the action records it sent', async () => {
    const s = await setup();
    const { entry } = await queuedDraft(s, 'stuck@two.com');
    await db
      .update(outreachQueue)
      .set({ status: 'sending', claimedAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(outreachQueue.id, entry.id));
    await reapStuckSends(ctx(s));
    const plain = await failedRow(s, 'anna@target.com');

    signInAs(s.memberId);
    const html = await renderQueue('failed');
    // Only on the interrupted row, not on the plainly failed one.
    expect(html.match(/>Mark as delivered</g)).toHaveLength(1);
    signInAs(s.viewerId);
    expect(await renderQueue('failed')).not.toContain('>Mark as delivered<');

    signInAs(s.memberId);
    const done = flash(
      await expectRedirect(() =>
        markQueuedEmailDeliveredAction(form({ status: 'failed', id: String(entry.id) })),
      ),
    );
    expect(done.message).toBe(MARKED_DELIVERED_MESSAGE);
    expect((await row(entry.id)).status).toBe('sent');

    const refused = flash(
      await expectRedirect(() =>
        markQueuedEmailDeliveredAction(form({ status: 'failed', id: String(plain) })),
      ),
    );
    expect(refused.error).toMatch(/^Only an email cut off/);
    expect((await row(plain)).status).toBe('failed');
  });
});

describe('run page: Cancel and auto-refresh (I074)', () => {
  async function run(s: Setup, set: Partial<typeof connectorRuns.$inferInsert>) {
    const c = await createConnector(ctx(s), { templateType: 'mock', name: 'Mock', config: {} });
    const [r] = await db
      .insert(connectorRuns)
      .values({ workspaceId: s.workspaceId, connectorId: c.id, status: 'running', ...set })
      .returning();
    return { connectorId: c.id, run: r! };
  }

  it('a running run refreshes itself and offers Cancel to an editor, not to a viewer', async () => {
    const s = await setup();
    const { connectorId, run: r } = await run(s, { status: 'running', lastProgressAt: new Date() });

    signInAs(s.memberId);
    const html = await renderRun(connectorId, r.id);
    expect(html).toContain('data-auto-refresh="on"');
    expect(html).toContain('This page refreshes every few seconds while the run is in progress.');
    expect(html).toContain('Cancel run');
    expect(html).toContain('Last progress');

    signInAs(s.viewerId);
    const viewerHtml = await renderRun(connectorId, r.id);
    expect(viewerHtml).toContain('data-auto-refresh="on"');
    expect(viewerHtml).not.toContain('Cancel run');
  });

  it('a finished run does not refresh; a partial run says so', async () => {
    const s = await setup();
    const { connectorId, run: r } = await run(s, {
      status: 'partial',
      recordCount: 3,
      completedAt: new Date(),
      errorPayload: { message: '1 step failed and the run went on without it; first: x' },
    });
    signInAs(s.memberId);
    const html = await renderRun(connectorId, r.id);
    expect(html).not.toContain('data-auto-refresh');
    expect(html).not.toContain('Cancel run');
    expect(html).toContain('partial — some steps failed');
    expect(html).toContain('badge badge-warn');
    expect(html).toContain('Problems');
  });

  it('Cancel asks a running run to stop and says nothing is left to cancel on a finished one', async () => {
    const s = await setup();
    const { connectorId, run: r } = await run(s, { status: 'running', lastProgressAt: new Date() });
    signInAs(s.memberId);

    const asked = flash(
      await expectRedirect(() =>
        cancelRunAction(form({ connectorId: String(connectorId), runId: String(r.id) })),
      ),
    );
    expect(asked.path).toBe(`/connectors/${connectorId}/runs/${r.id}`);
    expect(asked.message).toMatch(/^Cancel requested\./);
    const [after] = await db.select().from(connectorRuns).where(eq(connectorRuns.id, r.id));
    expect(after!.cancelRequestedAt).not.toBeNull();
    const html = await renderRun(connectorId, r.id);
    expect(html).toContain('Cancel requested');
    expect(html).not.toContain('Cancel run');

    await db.update(connectorRuns).set({ status: 'succeeded' }).where(eq(connectorRuns.id, r.id));
    const done = flash(
      await expectRedirect(() =>
        cancelRunAction(form({ connectorId: String(connectorId), runId: String(r.id) })),
      ),
    );
    expect(done.error).toBe('Nothing to cancel: the run has already finished.');

    signInAs(s.viewerId);
    const viewer = flash(
      await expectRedirect(() =>
        cancelRunAction(form({ connectorId: String(connectorId), runId: String(r.id) })),
      ),
    );
    expect(viewer.error).toMatch(/read-only/);
  });
});
