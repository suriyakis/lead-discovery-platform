// ia:F-03 (I088, X1): reply auto-action switches — admin-only, audited
// updates; the 30-day impact count; migration 0062 (defaults off, every
// row switched off, autopilot auto-approve off); the settings card.
//
// The "switch off → no suppression" behaviour of the two auto paths is
// covered in reply-classifier.test.ts next to the other analyseReply tests.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import { autopilotSettings } from '@/lib/db/schema/autopilot';
import {
  replyAutoActions,
  suppressionList,
  type SuppressionSource,
} from '@/lib/db/schema/mailing';
import { pipelineEvents, qualifiedLeads } from '@/lib/db/schema/pipeline';
import { sourceRecords } from '@/lib/db/schema/connectors';
import { reviewItems } from '@/lib/db/schema/review';
import { productProfiles } from '@/lib/db/schema/products';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import {
  REPLY_AUTO_ACTION_KEYS,
  ReplyAutoActionsError,
  autoClosePayload,
  getReplyAutoActions,
  getReplyAutoActionsImpact,
  switchesOf,
  updateReplyAutoActions,
  type ReplyAutoActionsImpact,
} from '@/lib/services/reply-auto-actions';
import { ReplyAutoActionsCard } from '@/app/settings/outreach/ReplyAutoActionsCard';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  adminA: string;
  managerA: string;
  memberA: string;
  ownerB: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const adminA = await seedUser({ email: 'adminA@test.local' });
  const managerA = await seedUser({ email: 'managerA@test.local' });
  const memberA = await seedUser({ email: 'memberA@test.local' });
  const ownerB = await seedUser({ email: 'ownerB@test.local' });
  const workspaceA = await seedWorkspace({
    name: 'A',
    ownerUserId: ownerA,
    extraMembers: [
      { userId: adminA, role: 'admin' },
      { userId: managerA, role: 'manager' },
      { userId: memberA, role: 'member' },
    ],
  });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  return { workspaceA, workspaceB, ownerA, adminA, managerA, memberA, ownerB };
}

function ctx(
  workspaceId: bigint,
  userId: string,
  role: WorkspaceContext['role'],
): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

async function changedEvents(workspaceId: bigint) {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.workspaceId, workspaceId),
        eq(auditLog.kind, 'reply_auto_actions.changed'),
      ),
    )
    .orderBy(asc(auditLog.id));
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ============ settings: defaults, authz, audit ======================

describe('reply auto-action settings', () => {
  it('lazy-creates a row with suppression and close switches OFF', async () => {
    const s = await setup();
    const row = await getReplyAutoActions(ctx(s.workspaceA, s.memberA, 'member'));
    expect(switchesOf(row)).toEqual({
      autoSuppressUnsubscribe: false,
      autoSuppressBounce: false,
      autoCloseNegative: false,
      autoExtractRedirects: true,
    });
  });

  it.each(['member', 'manager', 'viewer'] as const)(
    "denies a %s's update and changes nothing",
    async (role) => {
      const s = await setup();
      const user = role === 'manager' ? s.managerA : s.memberA;
      await expect(
        updateReplyAutoActions(ctx(s.workspaceA, user, role), {
          autoSuppressUnsubscribe: true,
        }),
      ).rejects.toMatchObject({
        name: 'ReplyAutoActionsError',
        code: 'permission_denied',
      });
      const row = await getReplyAutoActions(ctx(s.workspaceA, s.ownerA, 'owner'));
      expect(row.autoSuppressUnsubscribe).toBe(false);
      expect(await changedEvents(s.workspaceA)).toHaveLength(0);
    },
  );

  it("persists an admin's update and writes one reply_auto_actions.changed audit row", async () => {
    const s = await setup();
    const updated = await updateReplyAutoActions(ctx(s.workspaceA, s.adminA, 'admin'), {
      autoSuppressUnsubscribe: true,
      autoSuppressBounce: false, // unchanged: not listed in the audit
      autoExtractRedirects: false,
    });
    expect(updated.autoSuppressUnsubscribe).toBe(true);
    expect(updated.autoExtractRedirects).toBe(false);
    expect(updated.updatedBy).toBe(s.adminA);

    const reloaded = await getReplyAutoActions(ctx(s.workspaceA, s.memberA, 'member'));
    expect(switchesOf(reloaded)).toEqual(switchesOf(updated));

    const events = await changedEvents(s.workspaceA);
    expect(events).toHaveLength(1);
    expect(events[0]!.userId).toBe(s.adminA);
    expect(events[0]!.entityType).toBe('workspace');
    expect(events[0]!.entityId).toBe(s.workspaceA.toString());
    expect(events[0]!.payload).toEqual({
      changes: {
        autoSuppressUnsubscribe: { from: false, to: true },
        autoExtractRedirects: { from: true, to: false },
      },
      after: {
        autoSuppressUnsubscribe: true,
        autoSuppressBounce: false,
        autoCloseNegative: false,
        autoExtractRedirects: false,
      },
    });
  });

  it('owners and super admins may update too', async () => {
    const s = await setup();
    await updateReplyAutoActions(ctx(s.workspaceA, s.ownerA, 'owner'), {
      autoCloseNegative: true,
    });
    const superAdmin = await seedUser({ email: 'root@test.local', role: 'super_admin' });
    const row = await updateReplyAutoActions(
      ctx(s.workspaceA, superAdmin, 'super_admin'),
      { autoCloseNegative: false },
    );
    expect(row.autoCloseNegative).toBe(false);
    expect(await changedEvents(s.workspaceA)).toHaveLength(2);
  });

  it('a save that changes nothing writes no audit row', async () => {
    const s = await setup();
    const row = await updateReplyAutoActions(ctx(s.workspaceA, s.adminA, 'admin'), {
      autoSuppressUnsubscribe: false,
      autoSuppressBounce: false,
      autoCloseNegative: false,
      autoExtractRedirects: true,
    });
    expect(row.updatedBy).toBeNull();
    expect(await changedEvents(s.workspaceA)).toHaveLength(0);
  });

  it('rejects unknown keys and non-boolean values at the boundary', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.adminA, 'admin');
    await expect(
      updateReplyAutoActions(c, { autoSuppressBounce: 'yes' } as never),
    ).rejects.toBeInstanceOf(ReplyAutoActionsError);
    await expect(
      updateReplyAutoActions(c, { autoArchiveEverything: true } as never),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('is workspace-scoped: an update in A leaves B alone', async () => {
    const s = await setup();
    await updateReplyAutoActions(ctx(s.workspaceA, s.ownerA, 'owner'), {
      autoSuppressBounce: true,
    });
    const b = await getReplyAutoActions(ctx(s.workspaceB, s.ownerB, 'owner'));
    expect(b.autoSuppressBounce).toBe(false);
    expect(await changedEvents(s.workspaceB)).toHaveLength(0);
  });
});

// ============ impact (last 30 days) ==================================

const NOW = new Date('2026-10-01T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

async function seedLead(workspaceId: bigint, n: number): Promise<bigint> {
  const [sr] = await db
    .insert(sourceRecords)
    .values({
      workspaceId,
      sourceSystem: 'mock',
      sourceId: `impact-${n}`,
      rawData: {},
      normalizedData: {},
      sourceUrl: 'https://example.com',
    })
    .returning();
  const [ri] = await db
    .insert(reviewItems)
    .values({ workspaceId, sourceRecordId: sr!.id, state: 'new' })
    .returning();
  const [product] = await db
    .insert(productProfiles)
    .values({ workspaceId, name: `P${n}` })
    .returning();
  const [lead] = await db
    .insert(qualifiedLeads)
    .values({
      workspaceId,
      reviewItemId: ri!.id,
      productProfileId: product!.id,
      state: 'closed',
    })
    .returning();
  return lead!.id;
}

describe('getReplyAutoActionsImpact', () => {
  it('counts automatic suppressions and closes in the window, per workspace', async () => {
    const s = await setup();
    const A = s.workspaceA;
    const row = (
      value: string,
      source: SuppressionSource,
      createdAt: Date,
      extra: Partial<typeof suppressionList.$inferInsert> = {},
    ) => ({
      workspaceId: A,
      kind: 'email' as const,
      address: value,
      value,
      reason: 'unsubscribe' as const,
      source,
      createdAt,
      ...extra,
    });
    const inserted = await db
      .insert(suppressionList)
      .values([
        row('reply-new@x.com', 'reply', daysAgo(1)), // counted, active
        row('legacy-recent@x.com', 'legacy_auto', daysAgo(10)), // counted, active
        row('reply-revoked@x.com', 'reply', daysAgo(5), {
          revokedAt: daysAgo(2),
          revokeReason: 'newsletter footer',
        }), // counted, no longer active
        row('legacy-old@x.com', 'legacy_auto', daysAgo(40)), // outside the window
        row('manual@x.com', 'manual', daysAgo(1)), // not automatic
        row('link@x.com', 'unsubscribe_link', daysAgo(1)), // not automatic
        // Old row the classifier re-activated inside the window (audit below).
        row('reactivated@x.com', 'reply', daysAgo(90)),
        // Old row a 'reply' add only looked at (outcome unchanged).
        row('untouched@x.com', 'manual', daysAgo(90)),
      ])
      .returning();
    const id = (v: string) => inserted.find((r) => r.value === v)!.id.toString();
    await db.insert(auditLog).values([
      {
        workspaceId: A,
        kind: 'suppression.add',
        entityType: 'suppression_entry',
        entityId: id('reactivated@x.com'),
        payload: { source: 'reply', outcome: 'reactivated' },
        createdAt: daysAgo(3),
      },
      {
        workspaceId: A,
        kind: 'suppression.add',
        entityType: 'suppression_entry',
        entityId: id('untouched@x.com'),
        payload: { source: 'reply', outcome: 'unchanged' },
        createdAt: daysAgo(3),
      },
      {
        // Same entry as a row-based hit: counted once.
        workspaceId: A,
        kind: 'suppression.add',
        entityType: 'suppression_entry',
        entityId: id('reply-new@x.com'),
        payload: { source: 'reply', outcome: 'created' },
        createdAt: daysAgo(1),
      },
    ]);
    // Workspace B's automatic suppression never leaks into A's count.
    await db.insert(suppressionList).values({
      ...row('b@x.com', 'reply', daysAgo(1)),
      workspaceId: s.workspaceB,
    });

    const autoClosed = await seedLead(A, 1);
    const manualClosed = await seedLead(A, 2);
    const oldAutoClosed = await seedLead(A, 3);
    await db.insert(pipelineEvents).values([
      {
        workspaceId: A,
        qualifiedLeadId: autoClosed,
        fromState: 'relevant',
        toState: 'closed',
        payload: { ...autoClosePayload('bounce', 7n), forced: true },
        createdAt: daysAgo(4),
      },
      {
        workspaceId: A,
        qualifiedLeadId: manualClosed,
        fromState: 'relevant',
        toState: 'closed',
        payload: { forced: false, closeReason: 'lost' },
        createdAt: daysAgo(4),
      },
      {
        workspaceId: A,
        qualifiedLeadId: oldAutoClosed,
        fromState: 'relevant',
        toState: 'closed',
        payload: autoClosePayload('unsubscribe', 8n),
        createdAt: daysAgo(45),
      },
    ]);

    const impact = await getReplyAutoActionsImpact(
      ctx(A, s.memberA, 'member'),
      { now: NOW },
    );
    expect(impact).toEqual({
      windowDays: 30,
      since: daysAgo(30),
      suppressedAddresses: 4, // reply-new, legacy-recent, reply-revoked, reactivated
      stillSuppressed: 3,
      closedLeads: 1,
    });

    const b = await getReplyAutoActionsImpact(ctx(s.workspaceB, s.ownerB, 'owner'), {
      now: NOW,
    });
    expect(b).toMatchObject({ suppressedAddresses: 1, stillSuppressed: 1, closedLeads: 0 });
  });

  it('is all zeros for a quiet workspace', async () => {
    const s = await setup();
    const impact = await getReplyAutoActionsImpact(ctx(s.workspaceA, s.ownerA, 'owner'));
    expect(impact).toMatchObject({ suppressedAddresses: 0, stillSuppressed: 0, closedLeads: 0 });
  });
});

// ============ migration 0062 ==========================================

/** The data statements (INSERT/UPDATE) of the ia:F-03 migration. */
function migrationDataStatements(): string[] {
  const dir = path.resolve(process.cwd(), 'drizzle');
  const body = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(path.join(dir, f), 'utf8'))
    .find((b) => b.includes("'reply_auto_actions.changed'"));
  if (!body) throw new Error('ia:F-03 migration not found');
  const stmts = body
    .split('--> statement-breakpoint')
    .filter((st) => !/ALTER TABLE/.test(st) && st.trim().length > 0);
  expect(stmts).toHaveLength(4);
  return stmts;
}

describe('migration 0062 (reply auto-actions off, auto-approve off)', () => {
  it('sets the column defaults to false', async () => {
    const s = await setup();
    await db.insert(replyAutoActions).values({ workspaceId: s.workspaceA });
    const [row] = await db
      .select()
      .from(replyAutoActions)
      .where(eq(replyAutoActions.workspaceId, s.workspaceA));
    expect(row).toMatchObject({
      autoSuppressUnsubscribe: false,
      autoSuppressBounce: false,
      autoCloseNegative: false,
    });
    const defaults = await db.execute<{ column_name: string; column_default: string }>(
      sql.raw(
        `SELECT column_name, column_default FROM information_schema.columns
         WHERE table_name = 'reply_auto_actions'
           AND column_name IN ('auto_suppress_unsubscribe', 'auto_suppress_bounce', 'auto_close_negative')
         ORDER BY column_name`,
      ),
    );
    expect([...defaults].map((r) => r.column_default)).toEqual(['false', 'false', 'false']);
  });

  it('switches every row off, audits each changed workspace, and is idempotent', async () => {
    const s = await setup();
    // Simulate pre-migration rows written with the old defaults (on).
    await db.insert(replyAutoActions).values([
      {
        workspaceId: s.workspaceA,
        autoSuppressUnsubscribe: true,
        autoSuppressBounce: true,
        autoCloseNegative: true,
        autoExtractRedirects: true,
        updatedBy: s.ownerA,
      },
      {
        workspaceId: s.workspaceB,
        autoSuppressUnsubscribe: false,
        autoSuppressBounce: false,
        autoCloseNegative: false,
        autoExtractRedirects: false,
        updatedBy: s.ownerB,
      },
    ]);
    await db.insert(autopilotSettings).values([
      { workspaceId: s.workspaceA, enableAutoApproveProjects: true, autopilotEnabled: false },
      { workspaceId: s.workspaceB, enableAutoApproveProjects: false },
    ]);

    const run = async () => {
      for (const st of migrationDataStatements()) await db.execute(sql.raw(st));
    };
    await run();
    await run(); // idempotent

    const rows = await db.select().from(replyAutoActions);
    const a = rows.find((r) => r.workspaceId === s.workspaceA)!;
    const b = rows.find((r) => r.workspaceId === s.workspaceB)!;
    expect(switchesOf(a)).toEqual({
      autoSuppressUnsubscribe: false,
      autoSuppressBounce: false,
      autoCloseNegative: false,
      autoExtractRedirects: true, // untouched
    });
    expect(a.updatedBy).toBeNull();
    expect(b.updatedBy).toBe(s.ownerB); // nothing to change → row untouched

    const eventsA = await changedEvents(s.workspaceA);
    expect(eventsA).toHaveLength(1);
    expect(eventsA[0]!.userId).toBeNull();
    expect(eventsA[0]!.entityId).toBe(s.workspaceA.toString());
    expect(eventsA[0]!.payload).toMatchObject({
      source: 'migration:0062',
      changes: {
        autoSuppressUnsubscribe: { from: true, to: false },
        autoSuppressBounce: { from: true, to: false },
        autoCloseNegative: { from: true, to: false },
      },
      after: {
        autoSuppressUnsubscribe: false,
        autoSuppressBounce: false,
        autoCloseNegative: false,
        autoExtractRedirects: true,
      },
    });
    expect(String((eventsA[0]!.payload as { reason?: unknown }).reason)).toContain('X1');
    expect(await changedEvents(s.workspaceB)).toHaveLength(0);

    const ap = await db.select().from(autopilotSettings);
    expect(ap.every((r) => r.enableAutoApproveProjects === false)).toBe(true);
    const apA = ap.find((r) => r.workspaceId === s.workspaceA)!;
    expect(apA.updatedBy).toBeNull();
    const apEvents = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.kind, 'autopilot.settings.update'));
    expect(apEvents).toHaveLength(1);
    expect(apEvents[0]!.workspaceId).toBe(s.workspaceA);
    expect(apEvents[0]!.payload).toMatchObject({
      source: 'migration:0062',
      enableAutoApproveProjects: false,
    });
  });
});

// ============ settings card ===========================================

const quiet: ReplyAutoActionsImpact = {
  windowDays: 30,
  since: daysAgo(30),
  suppressedAddresses: 0,
  stillSuppressed: 0,
  closedLeads: 0,
};

function render(props: Parameters<typeof ReplyAutoActionsCard>[0]): string {
  return renderToStaticMarkup(createElement(ReplyAutoActionsCard, props));
}

describe('ReplyAutoActionsCard', () => {
  const allOff = {
    autoSuppressUnsubscribe: false,
    autoSuppressBounce: false,
    autoCloseNegative: false,
    autoExtractRedirects: false,
  };
  const save = async (_fd: FormData) => {};

  it('shows the four switches with their state, and a save button for admins', () => {
    const html = render({
      switches: { ...allOff, autoCloseNegative: true },
      impact: quiet,
      action: save,
    });
    for (const key of REPLY_AUTO_ACTION_KEYS) {
      expect(html).toContain(`name="${key}"`);
    }
    expect(html.match(/type="checkbox"/g)).toHaveLength(4);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).not.toContain('disabled');
    expect(html).toContain('Save reply auto-actions');
    expect(html).toContain('<form');
  });

  it('renders read-only without an action (managers and below)', () => {
    const html = render({ switches: allOff, impact: quiet });
    expect(html.match(/disabled=""/g)).toHaveLength(4);
    expect(html).not.toContain('<form');
    expect(html).not.toContain('Save reply auto-actions');
    expect(html).toContain('Only workspace admins can change these.');
  });

  it('warns while unsubscribe auto-suppress is on, with the 30-day count', () => {
    const html = render({
      switches: { ...allOff, autoSuppressUnsubscribe: true },
      impact: { ...quiet, suppressedAddresses: 2, stillSuppressed: 1, closedLeads: 1 },
    });
    expect(html).toContain('Automatic suppression is on');
    // flow:F-01: the warning no longer claims it acts on every synced email.
    expect(html).toContain('It acts only on replies to emails you sent');
    expect(html).not.toContain('every synced email');
    expect(html).toContain('<strong>2 addresses were</strong>');
    expect(html).toContain('in the last 30 days (1 still suppressed).');
    expect(html).toContain('1 lead was closed automatically.');
    expect(html).toContain('href="/mailbox/suppression"');
  });

  it('the bounce switch alone shows no suppression warning (inert until F-32) and says so', () => {
    const html = render({
      switches: { ...allOff, autoSuppressBounce: true },
      impact: quiet,
      action: save,
    });
    expect(html).not.toContain('data-testid="reply-auto-actions-warning"');
    expect(html).toContain('Not active yet: bounce reports are recorded');
  });

  it('with suppression off, reports recent activity neutrally and shows no warning', () => {
    const html = render({
      switches: allOff,
      impact: { ...quiet, suppressedAddresses: 1, stillSuppressed: 1 },
      action: save,
    });
    expect(html).not.toContain('data-testid="reply-auto-actions-warning"');
    expect(html).toContain('reply auto-actions suppressed 1 address (1 still suppressed)');
  });

  it('shows neither banner when nothing is on and nothing happened', () => {
    const html = render({ switches: allOff, impact: quiet, action: save });
    expect(html).not.toContain('data-testid="reply-auto-actions-warning"');
    expect(html).not.toContain('data-testid="reply-auto-actions-impact"');
  });
});
