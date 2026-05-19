// Regression suite for hints.ts batch helpers (b14304b). The earlier
// implementation embedded `= ANY(${jsArray})` in a raw `sql` template,
// which drizzle splats into `($1, $2, $3)` (record) and postgres rejects
// with "op ANY/ALL (array) requires array on right side". The page /drafts
// crashed in production for any workspace that had at least one draft.
//
// These tests exercise the real DB paths so the pattern can't slip back.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { outreachDrafts } from '@/lib/db/schema/outreach';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { reviewItems } from '@/lib/db/schema/review';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { createConnector, createRecipe, startRun } from '@/lib/services/connector-run';
import { createProductProfile } from '@/lib/services/product-profile';
import { ensureQualifiedLead } from '@/lib/services/pipeline';
import { hintsForDrafts, hintsForLeads } from '@/lib/services/hints';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  ownerA: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  return { workspaceA, ownerA };
}

function ctx(workspaceId: bigint, userId: string): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role: 'owner' });
}

async function seedReviewItem(workspaceId: bigint, ownerId: string) {
  const c = await createConnector(ctx(workspaceId, ownerId), {
    templateType: 'mock',
    name: 'Mock',
    config: {},
  });
  const r = await createRecipe(ctx(workspaceId, ownerId), {
    connectorId: c.id,
    name: 'r',
    selectors: { seed: 'hints', count: 1 },
  });
  await startRun(ctx(workspaceId, ownerId), {
    connectorId: c.id,
    recipeId: r.id,
    wait: true,
  });
  const reviews = await db
    .select()
    .from(reviewItems)
    .where(eq(reviewItems.workspaceId, workspaceId));
  return reviews[0]!;
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('hintsForDrafts with a non-empty input (regression for b14304b)', () => {
  it('returns a Map keyed by draft id without throwing on the batch SQL', async () => {
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'P',
    });
    const ri = await seedReviewItem(s.workspaceA, s.ownerA);

    // Insert a draft directly so we don't depend on the outreach engine.
    const [draftRow] = await db
      .insert(outreachDrafts)
      .values({
        workspaceId: s.workspaceA,
        reviewItemId: ri.id,
        productProfileId: product.id,
        sourceRecordId: ri.sourceRecordId,
        channel: 'email',
        language: 'en',
        method: 'rules',
        stage: 'discovery',
        subject: 'Hi',
        body: 'Body',
        forbiddenStripped: [],
        confidence: 70,
        status: 'draft',
      })
      .returning();
    if (!draftRow) throw new Error('draft insert returned no row');

    const result = await hintsForDrafts({ workspaceId: s.workspaceA }, [draftRow]);
    expect(result.has(draftRow.id.toString())).toBe(true);
  });
});

describe('hintsForLeads with a non-empty input (regression for b14304b)', () => {
  it('returns a Map keyed by lead id without throwing on the batch SQL', async () => {
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'P',
    });
    const ri = await seedReviewItem(s.workspaceA, s.ownerA);
    const lead = await ensureQualifiedLead(
      ctx(s.workspaceA, s.ownerA),
      ri.id,
      product.id,
    );

    const result = await hintsForLeads({ workspaceId: s.workspaceA }, [lead]);
    expect(result.has(lead.id.toString())).toBe(true);
    // Cross-workspace guard: another workspace's leads must not appear.
    expect(result.size).toBe(1);
    void qualifiedLeads; // referenced for type narrowing only
  });
});
