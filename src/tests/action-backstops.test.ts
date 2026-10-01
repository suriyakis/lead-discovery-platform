// DS-04 backstops (I078): the form actions the audit saw crash into Next's
// error page now answer every expected service error with a readable
// flash. The actions run for real against the test DB; only the session
// lookup (getWorkspaceContext → next-auth) is replaced.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/connectors/mock';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { preauthorizedEmails } from '@/lib/db/schema/auth';
import { connectorRuns, connectors } from '@/lib/db/schema/connectors';
import { outreachDrafts } from '@/lib/db/schema/outreach';
import { reviewComments, reviewItems } from '@/lib/db/schema/review';
import { workspaces } from '@/lib/db/schema/workspaces';
import { describeActionError } from '@/lib/action-errors';
import { isNextRedirectError } from '@/lib/server-redirect';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import { createConnector, createRecipe, startRun } from '@/lib/services/connector-run';
import { archiveReviewItem } from '@/lib/services/review';
import {
  UserServiceError,
  preauthorizeEmail,
  revokePreauthorize,
} from '@/lib/services/users';
import * as reviewActions from '@/app/review/[id]/actions';
import * as recipeActions from '@/app/connectors/[id]/recipes/[recipeId]/actions';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

// ---- session stub ----------------------------------------------------------

const session = vi.hoisted(() => ({ ctx: null as null | { workspaceId: bigint; userId: string; role: string } }));

vi.mock('@/lib/services/auth-context', () => {
  class AuthRequiredError extends Error {}
  class AccountInactiveError extends Error {}
  class NoWorkspaceError extends Error {}
  return {
    AuthRequiredError,
    AccountInactiveError,
    NoWorkspaceError,
    getWorkspaceContext: async () => {
      if (!session.ctx) throw new AuthRequiredError('Authentication required');
      return session.ctx;
    },
  };
});

// ---- helpers ---------------------------------------------------------------

function ctx(workspaceId: bigint, userId: string, role: WorkspaceContext['role']): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

function actAs(c: WorkspaceContext | null): void {
  session.ctx = c;
}

/** Run an action and return where it redirected, as a URL. */
async function redirectOf(run: Promise<unknown>): Promise<URL> {
  try {
    await run;
  } catch (err) {
    if (!isNextRedirectError(err)) throw err;
    // digest: NEXT_REDIRECT;<type>;<url>;<status>;
    const digest = (err as { digest: string }).digest;
    return new URL(digest.split(';').slice(2, -2).join(';'), 'http://app.test');
  }
  throw new Error('expected the action to redirect');
}

function form(fields: Record<string, string> = {}): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function setBalance(workspaceId: bigint, balance: bigint): Promise<void> {
  await db.update(workspaces).set({ tokenBalance: balance }).where(eq(workspaces.id, workspaceId));
}

interface Setup {
  ws: bigint;
  owner: WorkspaceContext;
  admin: WorkspaceContext;
  member: WorkspaceContext;
  viewer: WorkspaceContext;
  connectorId: bigint;
  recipeId: bigint;
  itemId: bigint;
}

async function setup(): Promise<Setup> {
  const ownerId = await seedUser({ email: 'owner@backstop.test' });
  const adminId = await seedUser({ email: 'admin@backstop.test' });
  const memberId = await seedUser({ email: 'member@backstop.test' });
  const viewerId = await seedUser({ email: 'viewer@backstop.test' });
  const ws = await seedWorkspace({
    name: 'Backstops',
    ownerUserId: ownerId,
    extraMembers: [
      { userId: adminId, role: 'admin' },
      { userId: memberId, role: 'member' },
      { userId: viewerId, role: 'viewer' },
    ],
  });
  const owner = ctx(ws, ownerId, 'owner');
  const connector = await createConnector(owner, { templateType: 'mock', name: 'Mock', config: {} });
  const recipe = await createRecipe(owner, {
    connectorId: connector.id,
    name: 'r1',
    selectors: { seed: 'backstop', count: 1, delayMs: 0 },
  });
  await startRun(owner, { connectorId: connector.id, recipeId: recipe.id, wait: true });
  const [item] = await db.select().from(reviewItems).where(eq(reviewItems.workspaceId, ws));
  if (!item) throw new Error('mock run produced no review item');
  return {
    ws,
    owner,
    admin: ctx(ws, adminId, 'admin'),
    member: ctx(ws, memberId, 'member'),
    viewer: ctx(ws, viewerId, 'viewer'),
    connectorId: connector.id,
    recipeId: recipe.id,
    itemId: item.id,
  };
}

async function itemState(id: bigint): Promise<string | undefined> {
  const [row] = await db.select().from(reviewItems).where(eq(reviewItems.id, id));
  return row?.state;
}

beforeEach(async () => {
  await truncateAll();
  actAs(null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- review detail ---------------------------------------------------------

describe('review detail actions', () => {
  it('a viewer forcing Approve gets a permission flash, not a crash, and nothing changes', async () => {
    const s = await setup();
    actAs(s.viewer);
    const to = await redirectOf(
      reviewActions.approveReviewItemAction(s.itemId.toString(), form({ reason: 'fits' })),
    );
    expect(to.pathname).toBe(`/review/${s.itemId}`);
    expect(to.searchParams.get('error')).toMatch(/read-only/i);
    expect(to.searchParams.get('error')).not.toMatch(/permission_denied/);
    expect(await itemState(s.itemId)).toBe('new');
  });

  it('every write action answers a viewer with a flash', async () => {
    const s = await setup();
    actAs(s.viewer);
    const id = s.itemId.toString();
    for (const run of [
      () => reviewActions.rejectReviewItemAction(id, form({ reason: 'no' })),
      () => reviewActions.ignoreReviewItemAction(id),
      () => reviewActions.flagReviewItemAction(id),
      () => reviewActions.commentOnReviewItemAction(id, form({ comment: 'hello' })),
      () => reviewActions.generateDraftAction(id, form({ productId: '1', method: 'rules' })),
      () => reviewActions.archiveReviewItemAction(id),
    ]) {
      const to = await redirectOf(run());
      expect(to.pathname).toBe(`/review/${id}`);
      expect(to.searchParams.get('error')).toBeTruthy();
    }
    expect(await itemState(s.itemId)).toBe('new');
    const comments = await db.select().from(reviewComments).where(eq(reviewComments.reviewItemId, s.itemId));
    expect(comments).toHaveLength(0);
  });

  it('approving an item archived in another tab shows an explanatory flash', async () => {
    const s = await setup();
    await archiveReviewItem(s.admin, s.itemId);
    actAs(s.member);
    const to = await redirectOf(
      reviewActions.approveReviewItemAction(s.itemId.toString(), form()),
    );
    expect(to.pathname).toBe(`/review/${s.itemId}`);
    expect(to.searchParams.get('error')).toBeNull();
    expect(to.searchParams.get('message')).toMatch(/archived in the meantime.*approved/i);
    expect(await itemState(s.itemId)).toBe('archived');
  });

  it('acting on an item that no longer exists lands on the queue with a notice', async () => {
    const s = await setup();
    actAs(s.member);
    const to = await redirectOf(reviewActions.ignoreReviewItemAction('987654'));
    expect(to.pathname).toBe('/review');
    expect(to.searchParams.get('message')).toMatch(/no longer exists/);
  });

  it('the happy path still transitions and returns to the item', async () => {
    const s = await setup();
    actAs(s.member);
    const to = await redirectOf(
      reviewActions.approveReviewItemAction(s.itemId.toString(), form({ reason: 'exact ICP' })),
    );
    expect(to.pathname).toBe(`/review/${s.itemId}`);
    expect(to.search).toBe('');
    const [row] = await db.select().from(reviewItems).where(eq(reviewItems.id, s.itemId));
    expect(row?.state).toBe('approved');
    expect(row?.approvalReason).toBe('exact ICP');
  });

  it('Generate draft on an empty wallet explains how to top up instead of crashing', async () => {
    const s = await setup();
    await setBalance(s.ws, 0n);
    actAs(s.member);
    const to = await redirectOf(
      reviewActions.generateDraftAction(s.itemId.toString(), form({ productId: '1', method: 'rules' })),
    );
    expect(to.pathname).toBe(`/review/${s.itemId}`);
    expect(to.searchParams.get('error')).toMatch(/No tokens left.*token pack/);
    expect(await db.select().from(outreachDrafts)).toHaveLength(0);
  });

  it('Generate draft for a product that does not exist stays on the item with a notice', async () => {
    const s = await setup();
    actAs(s.member);
    const to = await redirectOf(
      reviewActions.generateDraftAction(s.itemId.toString(), form({ productId: '424242' })),
    );
    expect(to.pathname).toBe(`/review/${s.itemId}`);
    expect(to.searchParams.get('message')).toMatch(/no longer exists/);
  });

  it('archive is admin-only and says so', async () => {
    const s = await setup();
    actAs(s.member);
    const to = await redirectOf(reviewActions.archiveReviewItemAction(s.itemId.toString()));
    expect(to.searchParams.get('error')).toMatch(/Only workspace admins/);
    actAs(s.admin);
    const ok = await redirectOf(reviewActions.archiveReviewItemAction(s.itemId.toString()));
    expect(ok.pathname).toBe('/review');
    expect(await itemState(s.itemId)).toBe('archived');
  });

  it('validates input before touching the service', async () => {
    const s = await setup();
    actAs(s.member);
    const empty = await redirectOf(
      reviewActions.commentOnReviewItemAction(s.itemId.toString(), form({ comment: '   ' })),
    );
    expect(empty.searchParams.get('error')).toMatch(/Write a comment/);
    const noProduct = await redirectOf(
      reviewActions.generateDraftAction(s.itemId.toString(), form({ productId: 'abc' })),
    );
    expect(noProduct.searchParams.get('error')).toMatch(/Pick a product/);
    const badId = await redirectOf(reviewActions.flagReviewItemAction('1; drop table'));
    expect(badId.pathname).toBe('/review');
  });

  it('a stale form after sign-out goes to the sign-in page', async () => {
    const s = await setup();
    actAs(null);
    const to = await redirectOf(reviewActions.flagReviewItemAction(s.itemId.toString()));
    expect(to.pathname).toBe('/');
  });
});

// ---- recipe "Run now" ------------------------------------------------------

describe('recipe Run now', () => {
  async function runCount(ws: bigint): Promise<number> {
    return (await db.select().from(connectorRuns).where(eq(connectorRuns.workspaceId, ws))).length;
  }

  it('an empty wallet shows the top-up message instead of the Next error page', async () => {
    const s = await setup();
    const before = await runCount(s.ws);
    await setBalance(s.ws, 0n);
    actAs(s.member);
    const to = await redirectOf(
      recipeActions.runRecipeNowAction(s.connectorId.toString(), s.recipeId.toString()),
    );
    expect(to.pathname).toBe(`/connectors/${s.connectorId}/recipes/${s.recipeId}`);
    expect(to.searchParams.get('error')).toMatch(/No tokens left.*token pack/);
    expect(await runCount(s.ws)).toBe(before);
  });

  it('a viewer, an inactive connector and a forged recipe id all get readable errors', async () => {
    const s = await setup();
    const id = [s.connectorId.toString(), s.recipeId.toString()] as const;

    actAs(s.viewer);
    const viewer = await redirectOf(recipeActions.runRecipeNowAction(...id));
    expect(viewer.searchParams.get('error')).toMatch(/read-only/);

    actAs(s.member);
    const other = await createConnector(s.owner, { templateType: 'mock', name: 'Other', config: {} });
    const forged = await redirectOf(
      recipeActions.runRecipeNowAction(other.id.toString(), s.recipeId.toString()),
    );
    expect(forged.searchParams.get('error')).toBe('Recipe does not belong to the requested connector.');

    await db.update(connectors).set({ active: false }).where(eq(connectors.id, s.connectorId));
    const inactive = await redirectOf(recipeActions.runRecipeNowAction(...id));
    expect(inactive.searchParams.get('error')).toMatch(/connector is inactive/);
  });

  it('starts the run and opens it on success', async () => {
    const s = await setup();
    const before = await runCount(s.ws);
    actAs(s.member);
    const to = await redirectOf(
      recipeActions.runRecipeNowAction(s.connectorId.toString(), s.recipeId.toString()),
    );
    expect(to.pathname).toMatch(new RegExp(`^/connectors/${s.connectorId}/runs/\\d+$`));
    expect(await runCount(s.ws)).toBe(before + 1);
  });
});

// ---- admin double submits ---------------------------------------------------

describe('admin pre-authorisation revoke (double submit)', () => {
  it('classifies a repeated revoke as not_found and a used invite as conflict', async () => {
    const superId = await seedUser({ email: 'root@backstop.test', role: 'super_admin' });
    const ws = await seedWorkspace({ name: 'Root', ownerUserId: superId });
    const root = ctx(ws, superId, 'super_admin');

    const entry = await preauthorizeEmail(root, { email: 'new@backstop.test', workspaceId: ws, role: 'member' });
    await revokePreauthorize(root, entry.id);
    const again = await revokePreauthorize(root, entry.id).catch((e: unknown) => e);
    expect(describeActionError(again, [UserServiceError]).code).toBe('not_found');

    const used = await preauthorizeEmail(root, { email: 'used@backstop.test', workspaceId: ws, role: 'member' });
    await db
      .update(preauthorizedEmails)
      .set({ consumedAt: new Date() })
      .where(eq(preauthorizedEmails.id, used.id));
    const consumed = await revokePreauthorize(root, used.id).catch((e: unknown) => e);
    expect(describeActionError(consumed, [UserServiceError]).code).toBe('conflict');
  });
});
