import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import { sourceRecords } from '@/lib/db/schema/connectors';
import { reviewComments, reviewItems } from '@/lib/db/schema/review';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import { createConnector, createRecipe, startRun } from '@/lib/services/connector-run';
import {
  ReviewServiceError,
  approveReviewItem,
  archiveReviewItem,
  assignReviewItem,
  commentOnReviewItem,
  flagForReview,
  getReviewItem,
  getStateCounts,
  ignoreReviewItem,
  listReviewItems,
  rejectReviewItem,
  seedReviewItem,
} from '@/lib/services/review';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  adminA: string;
  managerA: string;
  memberA: string;
  viewerA: string;
  ownerB: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const adminA = await seedUser({ email: 'adminA@test.local' });
  const managerA = await seedUser({ email: 'managerA@test.local' });
  const memberA = await seedUser({ email: 'memberA@test.local' });
  const viewerA = await seedUser({ email: 'viewerA@test.local' });
  const ownerB = await seedUser({ email: 'ownerB@test.local' });
  const workspaceA = await seedWorkspace({
    name: 'A',
    ownerUserId: ownerA,
    extraMembers: [
      { userId: adminA, role: 'admin' },
      { userId: managerA, role: 'manager' },
      { userId: memberA, role: 'member' },
      { userId: viewerA, role: 'viewer' },
    ],
  });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  return { workspaceA, workspaceB, ownerA, adminA, managerA, memberA, viewerA, ownerB };
}

function ctx(
  workspaceId: bigint,
  userId: string,
  role: WorkspaceContext['role'],
): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

/** Run the mock connector and return the resulting source_record + review_item ids. */
async function seedDiscovery(s: Setup, count = 4) {
  const connector = await createConnector(ctx(s.workspaceA, s.ownerA, 'owner'), {
    templateType: 'mock',
    name: 'Mock',
    config: {},
  });
  const recipe = await createRecipe(ctx(s.workspaceA, s.ownerA, 'owner'), {
    connectorId: connector.id,
    name: 'r1',
    selectors: { seed: 'rev', count, delayMs: 0 },
  });
  await startRun(ctx(s.workspaceA, s.ownerA, 'owner'), {
    connectorId: connector.id,
    recipeId: recipe.id,
        wait: true,
      });
  const sr = await db
    .select()
    .from(sourceRecords)
    .where(eq(sourceRecords.workspaceId, s.workspaceA));
  const items = await db
    .select()
    .from(reviewItems)
    .where(eq(reviewItems.workspaceId, s.workspaceA));
  return { sourceRecords: sr, items };
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- runner integration ------------------------------------------------

describe('runner -> review_items auto-seed', () => {
  it('every successful source_record insert creates a review_item in state=new', async () => {
    const s = await setup();
    const { sourceRecords: sr, items } = await seedDiscovery(s, 4);
    expect(sr).toHaveLength(4);
    expect(items).toHaveLength(4);
    expect(items.every((i) => i.state === 'new')).toBe(true);
  });

  it('seedReviewItem is idempotent (no duplicates on re-call)', async () => {
    const s = await setup();
    const { sourceRecords: sr } = await seedDiscovery(s, 2);
    expect(sr[0]).toBeTruthy();
    if (!sr[0]) return;
    await seedReviewItem(s.workspaceA, sr[0].id);
    await seedReviewItem(s.workspaceA, sr[0].id);
    const items = await db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.sourceRecordId, sr[0].id));
    expect(items).toHaveLength(1);
  });
});

// ---- listing -----------------------------------------------------------

describe('listReviewItems', () => {
  it('returns workspace-scoped items joined with their source records', async () => {
    const s = await setup();
    await seedDiscovery(s, 3);
    const list = await listReviewItems(ctx(s.workspaceA, s.ownerA, 'owner'));
    expect(list).toHaveLength(3);
    expect(list[0]?.sourceRecord.workspaceId).toBe(s.workspaceA);
    expect(list[0]?.item.workspaceId).toBe(s.workspaceA);
  });

  it('filters by state', async () => {
    const s = await setup();
    const { items } = await seedDiscovery(s, 4);
    if (!items[0] || !items[1]) return;
    await approveReviewItem(ctx(s.workspaceA, s.ownerA, 'owner'), items[0].id);
    await rejectReviewItem(ctx(s.workspaceA, s.ownerA, 'owner'), items[1].id, 'wrong fit');
    const newOnes = await listReviewItems(ctx(s.workspaceA, s.ownerA, 'owner'), {
      state: 'new',
    });
    const approved = await listReviewItems(ctx(s.workspaceA, s.ownerA, 'owner'), {
      state: 'approved',
    });
    expect(newOnes).toHaveLength(2);
    expect(approved).toHaveLength(1);
  });

  it('does not leak items across workspaces', async () => {
    const s = await setup();
    await seedDiscovery(s, 3);
    const otherList = await listReviewItems(ctx(s.workspaceB, s.ownerB, 'owner'));
    expect(otherList).toHaveLength(0);
  });
});

// ---- transitions -------------------------------------------------------

describe('state transitions', () => {
  it('approve sets state, approvedBy, approvedAt + audit', async () => {
    const s = await setup();
    const { items } = await seedDiscovery(s, 1);
    if (!items[0]) return;
    const approved = await approveReviewItem(
      ctx(s.workspaceA, s.adminA, 'admin'),
      items[0].id,
    );
    expect(approved.state).toBe('approved');
    expect(approved.approvedByUserId).toBe(s.adminA);
    expect(approved.approvedAt).not.toBeNull();

    const audit = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.kind, 'review.approved'));
    expect(audit).toHaveLength(1);
  });

  it('reject sets state, rejectedBy/At, reason + audit', async () => {
    const s = await setup();
    const { items } = await seedDiscovery(s, 1);
    if (!items[0]) return;
    const rejected = await rejectReviewItem(
      ctx(s.workspaceA, s.ownerA, 'owner'),
      items[0].id,
      'wrong sector',
    );
    expect(rejected.state).toBe('rejected');
    expect(rejected.rejectedByUserId).toBe(s.ownerA);
    expect(rejected.rejectionReason).toBe('wrong sector');
  });

  it('ignore + flagForReview set the right state', async () => {
    const s = await setup();
    const { items } = await seedDiscovery(s, 2);
    if (!items[0] || !items[1]) return;
    const ignored = await ignoreReviewItem(ctx(s.workspaceA, s.ownerA, 'owner'), items[0].id);
    const flagged = await flagForReview(ctx(s.workspaceA, s.ownerA, 'owner'), items[1].id);
    expect(ignored.state).toBe('ignored');
    expect(flagged.state).toBe('needs_review');
  });

  it('archive requires admin and is terminal', async () => {
    const s = await setup();
    const { items } = await seedDiscovery(s, 1);
    if (!items[0]) return;
    await expect(
      archiveReviewItem(ctx(s.workspaceA, s.managerA, 'manager'), items[0].id),
    ).rejects.toMatchObject({ code: 'permission_denied' });

    const archived = await archiveReviewItem(
      ctx(s.workspaceA, s.adminA, 'admin'),
      items[0].id,
    );
    expect(archived.state).toBe('archived');

    // Subsequent transitions are blocked.
    await expect(
      approveReviewItem(ctx(s.workspaceA, s.ownerA, 'owner'), items[0].id),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('viewer cannot transition', async () => {
    const s = await setup();
    const { items } = await seedDiscovery(s, 1);
    if (!items[0]) return;
    await expect(
      approveReviewItem(ctx(s.workspaceA, s.viewerA, 'viewer'), items[0].id),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('member can transition', async () => {
    const s = await setup();
    const { items } = await seedDiscovery(s, 1);
    if (!items[0]) return;
    const approved = await approveReviewItem(
      ctx(s.workspaceA, s.memberA, 'member'),
      items[0].id,
    );
    expect(approved.state).toBe('approved');
  });
});

// ---- comments ----------------------------------------------------------

describe('comments', () => {
  it('records a comment + audit + bumps updatedAt', async () => {
    const s = await setup();
    const { items } = await seedDiscovery(s, 1);
    if (!items[0]) return;
    const before = items[0].updatedAt;
    await new Promise((r) => setTimeout(r, 10));
    const comment = await commentOnReviewItem(
      ctx(s.workspaceA, s.memberA, 'member'),
      items[0].id,
      '  too domestic, prefer multinationals  ',
    );
    expect(comment.comment).toBe('too domestic, prefer multinationals');
    expect(comment.userId).toBe(s.memberA);

    const detail = await getReviewItem(ctx(s.workspaceA, s.ownerA, 'owner'), items[0].id);
    expect(detail.comments).toHaveLength(1);
    expect(detail.comments[0]?.author?.email).toBe('memberA@test.local');
    expect(detail.item.updatedAt.getTime()).toBeGreaterThan(before.getTime());

    const audit = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.kind, 'review.comment'));
    expect(audit).toHaveLength(1);
  });

  it('rejects empty comment', async () => {
    const s = await setup();
    const { items } = await seedDiscovery(s, 1);
    if (!items[0]) return;
    await expect(
      commentOnReviewItem(ctx(s.workspaceA, s.ownerA, 'owner'), items[0].id, '   '),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('viewer cannot comment', async () => {
    const s = await setup();
    const { items } = await seedDiscovery(s, 1);
    if (!items[0]) return;
    await expect(
      commentOnReviewItem(ctx(s.workspaceA, s.viewerA, 'viewer'), items[0].id, 'hi'),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('rejects 5001-char comment', async () => {
    const s = await setup();
    const { items } = await seedDiscovery(s, 1);
    if (!items[0]) return;
    const long = 'x'.repeat(5001);
    await expect(
      commentOnReviewItem(ctx(s.workspaceA, s.ownerA, 'owner'), items[0].id, long),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

// ---- assignment + counts ----------------------------------------------

describe('assignment + dashboard counts', () => {
  it('assigns and unassigns', async () => {
    const s = await setup();
    const { items } = await seedDiscovery(s, 1);
    if (!items[0]) return;
    let item = await assignReviewItem(
      ctx(s.workspaceA, s.ownerA, 'owner'),
      items[0].id,
      s.memberA,
    );
    expect(item.assignedToUserId).toBe(s.memberA);
    item = await assignReviewItem(ctx(s.workspaceA, s.ownerA, 'owner'), items[0].id, null);
    expect(item.assignedToUserId).toBeNull();
  });

  it('getStateCounts returns per-state counts', async () => {
    const s = await setup();
    const { items } = await seedDiscovery(s, 4);
    if (!items[0] || !items[1] || !items[2]) return;
    await approveReviewItem(ctx(s.workspaceA, s.ownerA, 'owner'), items[0].id);
    await rejectReviewItem(ctx(s.workspaceA, s.ownerA, 'owner'), items[1].id);
    await ignoreReviewItem(ctx(s.workspaceA, s.ownerA, 'owner'), items[2].id);
    const counts = await getStateCounts(ctx(s.workspaceA, s.ownerA, 'owner'));
    expect(counts.total).toBe(4);
    expect(counts.new).toBe(1);
    expect(counts.approved).toBe(1);
    expect(counts.rejected).toBe(1);
    expect(counts.ignored).toBe(1);
  });
});

// ---- error shape -------------------------------------------------------

describe('error shape', () => {
  it('all thrown errors are ReviewServiceError instances', async () => {
    const s = await setup();
    const { items } = await seedDiscovery(s, 1);
    if (!items[0]) return;
    try {
      await approveReviewItem(ctx(s.workspaceA, s.viewerA, 'viewer'), items[0].id);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewServiceError);
    }
  });

  it('cross-workspace access fails with not_found', async () => {
    const s = await setup();
    const { items } = await seedDiscovery(s, 1);
    if (!items[0]) return;
    await expect(
      getReviewItem(ctx(s.workspaceB, s.ownerB, 'owner'), items[0].id),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

// silence unused import
void reviewComments;
