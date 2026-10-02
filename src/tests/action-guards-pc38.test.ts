// PC-38 (I184, I028) — single-flight and rate limits for the AI buttons,
// and "Re-classify all" as a background job with progress.
//
// Acceptance covered here:
//   (2) a double-click on Re-classify all runs once, and the second click
//       gets a friendly "already running";
//   (3) an empty wallet refuses before any AI call (Re-classify all,
//       Synthesize now, product autofill).
// ((1) and (4), the shared limiter and the API thresholds, are in
// rate-limits-pc38.test.ts.)
//
// Plus: the guard helpers (singleFlight on work leases with purpose
// 'action:<name>', withRateLimit, guardAction), the job (batches of 50 with
// progress saved, stops at zero tokens and under a hold, admins only,
// abandoned runs, a payload for another workspace), the estimate and the
// confirmation, the Crawl Engine page, and the wiring of every guarded
// button (Synthesize now, Compact now, autofill, Run check now, plan / recipe
// / autopilot Run now).
//
// The actions run for real against the test database; only the session
// lookup (getWorkspaceContext → next-auth) is replaced, and the AI is a stub.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/connectors/mock';
import { and, count, eq, sql } from 'drizzle-orm';
import type { ZodSchema } from 'zod';
import { db } from '@/lib/db/client';
import {
  _setAIProviderForTests,
  type AIGenInput,
  type AIGenResult,
  type IAIProvider,
} from '@/lib/ai';
import { auditLog, usageLog } from '@/lib/db/schema/audit';
import { sourceRecords } from '@/lib/db/schema/connectors';
import { productProfiles } from '@/lib/db/schema/products';
import { qualificationRuns, type QualificationRun } from '@/lib/db/schema/qualification-runs';
import { rateLimitBuckets } from '@/lib/db/schema/rate-limits';
import { workLeases } from '@/lib/db/schema/work-leases';
import { workspaces } from '@/lib/db/schema/workspaces';
import { getJobQueue, NonRetryableJobError } from '@/lib/jobs';
import { registerJobHandlers } from '@/lib/jobs/bootstrap';
import { describeActionError } from '@/lib/action-errors';
import { reclassifyAllConfirm } from '@/lib/confirm-copy';
import { _resetRateLimitsForTests, rateLimitCheck } from '@/lib/rate-limit';
import { isNextRedirectError } from '@/lib/server-redirect';
import {
  ActionGuardError,
  GUARDED_ACTIONS,
  actionLeaseResource,
  actionRateLimitKey,
  guardAction,
  singleFlight,
  withRateLimit,
  type GuardedAction,
} from '@/lib/services/action-guards';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import { createConnector, createRecipe, startRun } from '@/lib/services/connector-run';
import { placeTenantHold } from '@/lib/services/holds';
import { createProductProfile } from '@/lib/services/product-profile';
import {
  RECLASSIFY_ACTION,
  RECLASSIFY_BATCH_SIZE,
  RECLASSIFY_JOB,
  RECLASSIFY_QUEUE_GRACE_MS,
  estimateReclassification,
  requestReclassification,
  runReclassificationJob,
} from '@/lib/services/qualification-runs';
import { acquireWorkLease, type WorkLease } from '@/lib/services/work-leases';
import { describeReclassifyStatus } from '@/app/connectors/engine/reclassify-status';
import * as engineActions from '@/app/connectors/engine/actions';
import * as learningActions from '@/app/learning/actions';
import * as autofillActions from '@/app/products/autofill/actions';
import * as healthActions from '@/app/health/actions';
import * as autopilotActions from '@/app/autopilot/actions';
import * as recipeActions from '@/app/connectors/[id]/recipes/[recipeId]/actions';
import CrawlEnginePage from '@/app/connectors/engine/page';
import { renderToHtml } from './helpers/next-render';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

// ---- session stub ----------------------------------------------------------

const session = vi.hoisted(() => ({
  ctx: null as null | { workspaceId: bigint; userId: string; role: string },
}));

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
vi.mock('@/lib/auth', () => ({
  auth: async () => (session.ctx ? { user: { id: session.ctx.userId } } : null),
}));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children?: unknown }) => children,
}));

// ---- helpers ---------------------------------------------------------------

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The AI: a valid qualification verdict for every classification, an
 *  empty proposal list for anything else. Counts calls; can wait on a gate
 *  and run a hook per call. */
class StubAI implements IAIProvider {
  public readonly id = 'stub';
  public readonly model = 'stub-1';
  public calls = 0;
  public gate: Promise<void> | null = null;
  public onCall: ((n: number) => Promise<void> | void) | null = null;
  async generateText(_input: AIGenInput): Promise<AIGenResult> {
    this.calls += 1;
    return { text: 'ok', model: this.model, usage: { inputTokens: 1, outputTokens: 1 } };
  }
  async generateJson<T>(_input: AIGenInput, schema: ZodSchema<T>): Promise<T> {
    this.calls += 1;
    const n = this.calls;
    if (this.onCall) await this.onCall(n);
    if (this.gate) await this.gate;
    const verdict = schema.safeParse({
      isRelevant: true,
      relevanceScore: 70,
      confidence: 80,
      matchedKeywords: [],
      disqualifyingSignals: [],
      reason: 'stub verdict',
      detectedCountry: null,
    });
    if (verdict.success) return verdict.data;
    return schema.parse({ proposals: [] });
  }
  estimateCost(): number {
    return 0;
  }
  async healthCheck() {
    return { ok: true };
  }
}

let ai: StubAI;

function ctx(
  workspaceId: bigint,
  userId: string,
  role: WorkspaceContext['role'],
): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

function actAs(c: WorkspaceContext | null): void {
  session.ctx = c;
}

/** Run an action and return where it redirected. */
async function redirectOf(run: Promise<unknown>): Promise<URL> {
  try {
    await run;
  } catch (err) {
    if (!isNextRedirectError(err)) throw err;
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

async function runsOf(workspaceId: bigint): Promise<QualificationRun[]> {
  return db
    .select()
    .from(qualificationRuns)
    .where(eq(qualificationRuns.workspaceId, workspaceId))
    .orderBy(qualificationRuns.id);
}

async function runById(id: bigint): Promise<QualificationRun> {
  const [row] = await db.select().from(qualificationRuns).where(eq(qualificationRuns.id, id));
  if (!row) throw new Error(`run ${id} missing`);
  return row;
}

async function waitFor(check: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const drain = () => getJobQueue().drain?.() ?? Promise.resolve();

interface Setup {
  ws: bigint;
  owner: WorkspaceContext;
  admin: WorkspaceContext;
  member: WorkspaceContext;
  viewer: WorkspaceContext;
  recordIds: bigint[];
  productId: bigint;
  connectorId: bigint;
  recipeId: bigint;
}

let seq = 0;
/** A workspace with one active product and `records` discovered records
 *  (classified once by their discovery run; the AI counter starts at 0
 *  afterwards). */
async function setup(records = 3): Promise<Setup> {
  seq += 1;
  const ownerId = await seedUser({ email: `owner-${seq}@pc38.test` });
  const adminId = await seedUser({ email: `admin-${seq}@pc38.test` });
  const memberId = await seedUser({ email: `member-${seq}@pc38.test` });
  const viewerId = await seedUser({ email: `viewer-${seq}@pc38.test` });
  const ws = await seedWorkspace({
    name: `PC38 ${seq}`,
    ownerUserId: ownerId,
    extraMembers: [
      { userId: adminId, role: 'admin' },
      { userId: memberId, role: 'member' },
      { userId: viewerId, role: 'viewer' },
    ],
  });
  const owner = ctx(ws, ownerId, 'owner');
  const product = await createProductProfile(owner, { name: 'Glass' });
  const connector = await createConnector(owner, {
    templateType: 'mock',
    name: 'Mock',
    config: {},
  });
  const recipe = await createRecipe(owner, {
    connectorId: connector.id,
    name: 'r1',
    selectors: { seed: `pc38-${seq}`, count: records, delayMs: 0 },
  });
  if (records > 0) {
    await startRun(owner, { connectorId: connector.id, recipeId: recipe.id, wait: true });
  }
  const rows = await db
    .select({ id: sourceRecords.id })
    .from(sourceRecords)
    .where(eq(sourceRecords.workspaceId, ws))
    .orderBy(sourceRecords.id);
  ai.calls = 0;
  return {
    ws,
    owner,
    admin: ctx(ws, adminId, 'admin'),
    member: ctx(ws, memberId, 'member'),
    viewer: ctx(ws, viewerId, 'viewer'),
    recordIds: rows.map((r) => r.id),
    productId: product.id,
    connectorId: connector.id,
    recipeId: recipe.id,
  };
}

/** Leases a test took by hand; released after it. */
const held: WorkLease[] = [];
async function holdAction(
  workspaceId: bigint,
  action: GuardedAction,
  resource?: bigint | string,
): Promise<WorkLease> {
  const got = await acquireWorkLease(
    { workspaceId },
    {
      kind: 'action',
      resource: actionLeaseResource(action, resource),
      purpose: `action:${action}`,
    },
  );
  if (!got.acquired) throw new Error('expected the lease');
  held.push(got.lease);
  return got.lease;
}

async function fillLimit(workspaceId: bigint, action: GuardedAction): Promise<void> {
  const p = GUARDED_ACTIONS[action];
  for (let i = 0; i < p.limit; i++) {
    await rateLimitCheck(actionRateLimitKey({ workspaceId }, action), p.limit, p.windowMs);
  }
}

beforeAll(() => {
  registerJobHandlers();
});

beforeEach(async () => {
  ai = new StubAI();
  _setAIProviderForTests(ai);
  await truncateAll();
  await _resetRateLimitsForTests();
  actAs(null);
});

afterEach(async () => {
  ai.gate = null;
  ai.onCall = null;
  for (const l of held.splice(0)) await l.release();
  await drain();
  _setAIProviderForTests(null);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- the guard helpers -----------------------------------------------------

describe('singleFlight / withRateLimit / guardAction', () => {
  it('single-flight on a work lease: a second caller gets already_running and its work never runs', async () => {
    const s = await setup(0);
    const gate = deferred();
    let runs = 0;
    const first = singleFlight(s.owner, 'learning.synthesize', async () => {
      runs += 1;
      await gate.promise;
      return 'first';
    });
    await waitFor(async () => runs === 1, 'the first caller to start');

    const [lease] = await db.select().from(workLeases).where(eq(workLeases.workspaceId, s.ws));
    expect(lease).toMatchObject({
      kind: 'action',
      resourceKey: 'learning.synthesize',
      purpose: 'action:learning.synthesize',
    });

    const second = await singleFlight(s.owner, 'learning.synthesize', async () => {
      runs += 1;
      return 'second';
    }).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(ActionGuardError);
    expect((second as ActionGuardError).code).toBe('already_running');
    expect((second as ActionGuardError).message).toMatch(
      /^Synthesize now is already running in this workspace \(started \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\)\. This click started nothing/,
    );

    gate.resolve();
    expect(await first).toBe('first');
    expect(runs).toBe(1);
    // Released afterwards: the next caller runs.
    expect(await db.select().from(workLeases).where(eq(workLeases.workspaceId, s.ws))).toEqual([]);
    expect(await singleFlight(s.owner, 'learning.synthesize', async () => 'third')).toBe('third');
  });

  it('single-flight per resource: two plans run side by side, one plan once', async () => {
    const s = await setup(0);
    await holdAction(s.ws, 'crawl_plan.run_now', 7n);
    expect(
      await singleFlight(s.owner, 'crawl_plan.run_now', async () => 'plan 8', { resource: 8n }),
    ).toBe('plan 8');
    await expect(
      singleFlight(s.owner, 'crawl_plan.run_now', async () => 'plan 7', { resource: 7n }),
    ).rejects.toMatchObject({ code: 'already_running' });
    // Workspaces are independent.
    const other = await setup(0);
    expect(
      await singleFlight(other.owner, 'crawl_plan.run_now', async () => 'x', { resource: 7n }),
    ).toBe('x');
  });

  it('withRateLimit: the limit per workspace, then rate_limited with when to try again', async () => {
    const s = await setup(0);
    const limit = GUARDED_ACTIONS['health.check_now'].limit;
    let runs = 0;
    for (let i = 0; i < limit; i++) {
      await withRateLimit(s.owner, 'health.check_now', async () => {
        runs += 1;
      });
    }
    const err = await withRateLimit(s.owner, 'health.check_now', async () => {
      runs += 1;
    }).catch((e: unknown) => e);
    expect(runs).toBe(limit);
    expect(err).toBeInstanceOf(ActionGuardError);
    expect((err as ActionGuardError).code).toBe('rate_limited');
    expect((err as ActionGuardError).message).toBe(
      `Run check now was used ${limit} times in the last hour in this workspace. Try again in 60 minutes.`,
    );
    expect((err as ActionGuardError).retryAfterMs).toBeGreaterThan(59 * 60_000);
    // Kept in the shared table under the action's key.
    const [row] = await db
      .select()
      .from(rateLimitBuckets)
      .where(eq(rateLimitBuckets.key, `action:health.check_now:ws:${s.ws}`));
    expect(row?.count).toBe(limit);
  });

  it('guardAction: a click refused as already running does not use up the limit', async () => {
    const s = await setup(0);
    await holdAction(s.ws, 'knowledge.compact');
    for (let i = 0; i < 10; i++) {
      await expect(
        guardAction(s.owner, 'knowledge.compact', async () => 'x'),
      ).rejects.toMatchObject({
        code: 'already_running',
      });
    }
    expect(
      await db
        .select()
        .from(rateLimitBuckets)
        .where(eq(rateLimitBuckets.key, `action:knowledge.compact:ws:${s.ws}`)),
    ).toEqual([]);
  });

  it('the action error helper shows the guard sentences as they are', () => {
    const e = new ActionGuardError('Compact now is already running in this workspace.', {
      code: 'already_running',
      action: 'knowledge.compact',
    });
    expect(describeActionError(e, [ActionGuardError])).toEqual({
      code: 'already_running',
      message: 'Compact now is already running in this workspace.',
    });
  });

  it('action lease resources are names (or name:id); the CHECK constraint agrees', async () => {
    expect(actionLeaseResource('crawl_plan.run_now', 7n)).toBe('crawl_plan.run_now:7');
    expect(() => actionLeaseResource('crawl_plan.run_now', 'x; drop')).toThrow();
    const s = await setup(0);
    const insert = (resourceKey: string) =>
      db.execute(
        sql`INSERT INTO work_leases (workspace_id, kind, resource_key, holder, holder_label, acquired_at, renewed_at, expires_at)
            VALUES (${s.ws}, 'action', ${resourceKey}, 't', 'l', now(), now(), now() + interval '1 minute')`,
      );
    await expect(insert('')).rejects.toThrow(/work_leases_resource_key_check/);
    await expect(insert('Bad Name')).rejects.toThrow(/work_leases_resource_key_check/);
    await insert('qualification.reclassify_all');
    await insert('crawl_plan.run_now:12');
  });
});

// ---- Re-classify all (I028) ------------------------------------------------

describe(
  'Re-classify all runs in the background, once at a time (PC-38 (2), I028)',
  { timeout: 60_000 },
  () => {
    it('returns at once with a queued run; the job classifies every record × product once', async () => {
      const s = await setup(3);
      await createProductProfile(s.owner, { name: 'Steel' });
      actAs(s.admin);
      const url = await redirectOf(engineActions.reclassifyAll(form()));
      expect(url.pathname).toBe('/connectors/engine');
      expect(url.searchParams.get('message')).toBe(
        'Re-classification started: 3 record(s) against 2 active product(s). It runs in the background; progress shows below.',
      );
      const [queued] = await runsOf(s.ws);
      expect(queued).toMatchObject({
        totalRecords: 3,
        productCount: 2,
        requestedBy: s.admin.userId,
      });
      expect(queued!.jobId).toBeTruthy();

      await drain();
      const done = await runById(queued!.id);
      expect(done).toMatchObject({
        status: 'succeeded',
        processedRecords: 3,
        qualificationCount: 6,
        failedRecords: 0,
        lastRecordId: s.recordIds[2],
        stopReason: null,
      });
      expect(done.finishedAt).not.toBeNull();
      expect(ai.calls).toBe(6);
      const audits = await db
        .select({ kind: auditLog.kind, payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.workspaceId, s.ws),
            sql`${auditLog.kind} LIKE 'qualification.reclassify%'`,
          ),
        )
        .orderBy(auditLog.id);
      expect(audits.map((a) => a.kind)).toEqual([
        'qualification.reclassify_requested',
        'qualification.reclassify_workspace',
      ]);
      expect(audits[1]!.payload).toMatchObject({
        status: 'succeeded',
        recordCount: 3,
        qualificationCount: 6,
      });
    });

    it('a double-click starts one run; the second click is told it is already running', async () => {
      const s = await setup(3);
      actAs(s.admin);
      const urls = await Promise.all([
        redirectOf(engineActions.reclassifyAll(form())),
        redirectOf(engineActions.reclassifyAll(form())),
      ]);
      const started = urls.filter((u) =>
        u.searchParams.get('message')?.startsWith('Re-classification started'),
      );
      const refused = urls.filter((u) => u.searchParams.get('error'));
      expect(started).toHaveLength(1);
      expect(refused).toHaveLength(1);
      // Whether the second click met the first one's lease or its queued run,
      // it is told the same thing in its own words.
      expect(refused[0]!.searchParams.get('error')).toMatch(
        /^Re-classify all is already running in this workspace \(.*\)\. This click started nothing/,
      );
      expect(await runsOf(s.ws)).toHaveLength(1);

      await drain();
      // It ran once: one classification per record (one product).
      expect(ai.calls).toBe(3);
      expect((await runsOf(s.ws))[0]).toMatchObject({ status: 'succeeded', processedRecords: 3 });
    });

    it('a click while the job works is refused with its progress; after it finishes a new one starts', async () => {
      const s = await setup(3);
      const gate = deferred();
      ai.gate = gate.promise;
      actAs(s.admin);
      await redirectOf(engineActions.reclassifyAll(form()));
      const [run] = await runsOf(s.ws);
      await waitFor(
        async () => (await runById(run!.id)).status === 'running' && ai.calls === 1,
        'the job to start',
      );

      const second = await redirectOf(engineActions.reclassifyAll(form()));
      expect(second.searchParams.get('error')).toMatch(
        /^Re-classify all is already running in this workspace \(running since .* UTC, 0 of 3 records done\)\./,
      );
      // The job holds the action's lease for the whole run.
      const [lease] = await db.select().from(workLeases).where(eq(workLeases.workspaceId, s.ws));
      expect(lease).toMatchObject({ kind: 'action', resourceKey: RECLASSIFY_ACTION });

      gate.resolve();
      ai.gate = null;
      await drain();
      expect(await runsOf(s.ws)).toHaveLength(1);
      expect(ai.calls).toBe(3);

      const third = await redirectOf(engineActions.reclassifyAll(form()));
      expect(third.searchParams.get('message')).toMatch(/^Re-classification started/);
      expect(await runsOf(s.ws)).toHaveLength(2);
    });

    it('workspace admins only: members and viewers are refused, nothing runs', async () => {
      const s = await setup(2);
      for (const who of [s.member, s.viewer]) {
        actAs(who);
        const url = await redirectOf(engineActions.reclassifyAll(form()));
        expect(url.searchParams.get('error')).toBe(
          'Only workspace admins can re-classify every record. Ask an admin if it needs doing.',
        );
      }
      expect(await runsOf(s.ws)).toEqual([]);
      expect(ai.calls).toBe(0);
    });

    it('nothing to classify against, or nothing to classify: said plainly, no run', async () => {
      const s = await setup(0);
      actAs(s.owner);
      let url = await redirectOf(engineActions.reclassifyAll(form()));
      expect(url.searchParams.get('error')).toBe(
        'There are no discovered records to re-classify yet.',
      );
      await db
        .update(productProfiles)
        .set({ active: false })
        .where(eq(productProfiles.workspaceId, s.ws));
      url = await redirectOf(engineActions.reclassifyAll(form()));
      expect(url.searchParams.get('error')).toBe(
        'There is no active product profile to classify against. Activate one first.',
      );
      expect(await runsOf(s.ws)).toEqual([]);
    });

    it('works in batches of 50 and saves its progress after each', async () => {
      const s = await setup(RECLASSIFY_BATCH_SIZE + 10);
      let seenAtSecondBatch: QualificationRun | null = null;
      ai.onCall = async (n) => {
        if (n === RECLASSIFY_BATCH_SIZE + 1) {
          const [row] = await db
            .select()
            .from(qualificationRuns)
            .where(eq(qualificationRuns.workspaceId, s.ws));
          seenAtSecondBatch = row ?? null;
        }
      };
      const run = await requestReclassification(s.admin);
      await drain();
      expect(seenAtSecondBatch).toMatchObject({
        status: 'running',
        processedRecords: RECLASSIFY_BATCH_SIZE,
        lastRecordId: s.recordIds[RECLASSIFY_BATCH_SIZE - 1],
      });
      expect(await runById(run.id)).toMatchObject({
        status: 'succeeded',
        processedRecords: RECLASSIFY_BATCH_SIZE + 10,
        qualificationCount: RECLASSIFY_BATCH_SIZE + 10,
      });
    });

    it('stops cleanly when the wallet runs dry mid-run, with its progress saved', async () => {
      const s = await setup(5);
      ai.onCall = async (n) => {
        // The second classification spends the last tokens.
        if (n === 2) await setBalance(s.ws, 0n);
      };
      const run = await requestReclassification(s.admin);
      await drain();
      const stopped = await runById(run.id);
      expect(stopped).toMatchObject({
        status: 'stopped',
        stopReason: 'no_tokens',
        processedRecords: 2,
        qualificationCount: 2,
        lastRecordId: s.recordIds[1],
      });
      expect(ai.calls).toBe(2);
      expect(describeReclassifyStatus(stopped, false)).toMatchObject({
        tone: 'error',
        active: false,
        text: 'Last re-classification stopped at 2 of 5 records (2 qualification(s) written): no tokens left. A workspace admin can buy a token pack in Settings → Billing, then run it again.',
      });
    });

    it('a Background AI hold placed mid-run stops it at the next batch', async () => {
      const s = await setup(RECLASSIFY_BATCH_SIZE + 5);
      ai.onCall = async (n) => {
        if (n === 10) {
          await placeTenantHold(s.owner, {
            scope: 'capabilities',
            capabilities: ['background_ai'],
            reason: 'checking the AI bill',
          });
        }
      };
      const run = await requestReclassification(s.admin);
      await drain();
      expect(await runById(run.id)).toMatchObject({
        status: 'stopped',
        stopReason: 'held',
        processedRecords: RECLASSIFY_BATCH_SIZE,
      });
    });

    it('a hold in place refuses the click itself', async () => {
      const s = await setup(2);
      await placeTenantHold(s.owner, {
        scope: 'capabilities',
        capabilities: ['background_ai'],
        reason: 'audit',
      });
      actAs(s.admin);
      const url = await redirectOf(engineActions.reclassifyAll(form()));
      expect(url.searchParams.get('error')).toMatch(/hold/i);
      expect(await runsOf(s.ws)).toEqual([]);
    });

    it('the action is rate-limited per workspace', async () => {
      const s = await setup(1);
      await fillLimit(s.ws, RECLASSIFY_ACTION);
      actAs(s.admin);
      const url = await redirectOf(engineActions.reclassifyAll(form()));
      expect(url.searchParams.get('error')).toMatch(
        /^Re-classify all was used 6 times in the last hour/,
      );
      expect(await runsOf(s.ws)).toEqual([]);
    });

    it('a run whose worker died is failed as interrupted, and a new run starts', async () => {
      const s = await setup(2);
      const [dead] = await db
        .insert(qualificationRuns)
        .values({
          workspaceId: s.ws,
          status: 'running',
          upToRecordId: s.recordIds[1]!,
          totalRecords: 2,
          productCount: 1,
          processedRecords: 1,
          startedAt: new Date(Date.now() - 60 * 60_000),
          heartbeatAt: new Date(Date.now() - 60 * 60_000),
        })
        .returning();
      // Its lease expired with it: the page says it stopped making progress.
      expect(describeReclassifyStatus(dead!, false)?.text).toMatch(
        /^Re-classification stopped making progress at 1 of 2 records/,
      );

      const fresh = await requestReclassification(s.admin);
      expect(fresh.id).not.toBe(dead!.id);
      expect(await runById(dead!.id)).toMatchObject({
        status: 'failed',
        error:
          'Interrupted: the worker stopped before it finished (1 of 2 records done). Start it again.',
      });
      await drain();
      expect(await runById(fresh.id)).toMatchObject({ status: 'succeeded', processedRecords: 2 });
    });

    it('a queued run whose job was lost is settled after the grace period; a young one is not', async () => {
      const s = await setup(1);
      const insertQueued = (ageMs: number) =>
        db
          .insert(qualificationRuns)
          .values({
            workspaceId: s.ws,
            status: 'queued',
            upToRecordId: s.recordIds[0]!,
            totalRecords: 1,
            productCount: 1,
            createdAt: new Date(Date.now() - ageMs),
          })
          .returning();

      const [young] = await insertQueued(10_000);
      await expect(requestReclassification(s.admin)).rejects.toMatchObject({
        code: 'already_running',
        message: expect.stringMatching(/queued since .* UTC, waiting for a worker/),
      });
      await db.delete(qualificationRuns).where(eq(qualificationRuns.id, young!.id));

      const [lost] = await insertQueued(RECLASSIFY_QUEUE_GRACE_MS + 60_000);
      const fresh = await requestReclassification(s.admin);
      expect(await runById(lost!.id)).toMatchObject({
        status: 'failed',
        error:
          'Interrupted: its background job was lost before it started (0 of 1 records done). Start it again.',
      });
      await drain();
      expect(await runById(fresh.id)).toMatchObject({ status: 'succeeded' });
    });

    it('one queued or running run per workspace, enforced by the database too', async () => {
      const s = await setup(1);
      const row = {
        workspaceId: s.ws,
        status: 'queued',
        upToRecordId: s.recordIds[0]!,
        totalRecords: 1,
        productCount: 1,
      };
      await db.insert(qualificationRuns).values(row);
      await expect(
        db.insert(qualificationRuns).values({ ...row, status: 'running' }),
      ).rejects.toThrow();
      // Finished runs do not count.
      await db.insert(qualificationRuns).values({ ...row, status: 'succeeded' });
      await expect(
        db
          .insert(qualificationRuns)
          .values({ ...row, status: 'succeeded', stopReason: 'no_tokens' }),
      ).rejects.toThrow();
      await expect(
        db.insert(qualificationRuns).values({ ...row, status: 'cancelled' }),
      ).rejects.toThrow();
    });

    it('the job validates its payload: another workspace is refused, a run not queued is skipped', async () => {
      const s = await setup(1);
      const other = await setup(1);
      const run = await requestReclassification(s.admin);
      await drain();
      const payload = {
        runId: run.id.toString(),
        workspaceId: other.ws.toString(),
        userId: other.owner.userId,
        role: 'owner',
      };
      await expect(runReclassificationJob(payload)).rejects.toBeInstanceOf(NonRetryableJobError);
      await expect(runReclassificationJob({ ...payload, runId: 'x' })).rejects.toThrow();
      // Its own workspace, but the run already finished: nothing happens.
      expect(
        await runReclassificationJob({
          ...payload,
          workspaceId: s.ws.toString(),
          userId: s.owner.userId,
        }),
      ).toEqual({ status: 'skipped', reason: 'not_queued', runId: run.id.toString() });
      expect(RECLASSIFY_JOB).toBe('qualification.reclassify');
    });

    it('a queue that cannot take the job fails the run and says so', async () => {
      const s = await setup(1);
      vi.spyOn(getJobQueue(), 'enqueue').mockRejectedValueOnce(
        new Error('connect ECONNREFUSED redis'),
      );
      vi.spyOn(console, 'error').mockImplementation(() => {});
      actAs(s.admin);
      const url = await redirectOf(engineActions.reclassifyAll(form()));
      expect(url.searchParams.get('error')).toBe(
        'The background queue is unavailable right now, so nothing was started. Try again in a few minutes.',
      );
      const [run] = await runsOf(s.ws);
      expect(run).toMatchObject({
        status: 'failed',
        error:
          'The background queue was unavailable, so nothing was classified. Try again in a few minutes.',
      });
      // Not active any more: the next click starts a run.
      const next = await redirectOf(engineActions.reclassifyAll(form()));
      expect(next.searchParams.get('message')).toMatch(/^Re-classification started/);
    });
  },
);

// ---- (3) an empty wallet refuses before any AI call -------------------------

describe('an empty wallet refuses before any AI call (PC-38 (3))', { timeout: 60_000 }, () => {
  it('Re-classify all', async () => {
    const s = await setup(3);
    await setBalance(s.ws, 0n);
    actAs(s.admin);
    const url = await redirectOf(engineActions.reclassifyAll(form()));
    expect(url.searchParams.get('error')).toBe(
      'No tokens left — a workspace admin can buy a token pack in Settings → Billing.',
    );
    await drain();
    expect(await runsOf(s.ws)).toEqual([]);
    expect(ai.calls).toBe(0);
  });

  it('Re-classify all on a billing-exempt workspace needs no balance', async () => {
    const s = await setup(1);
    await db
      .update(workspaces)
      .set({ tokenBalance: 0n, billingExempt: true })
      .where(eq(workspaces.id, s.ws));
    const run = await requestReclassification(s.admin);
    await drain();
    expect(await runById(run.id)).toMatchObject({ status: 'succeeded' });
  });

  it('Synthesize now', async () => {
    const s = await setup(0);
    await setBalance(s.ws, 0n);
    actAs(s.owner);
    const url = await redirectOf(learningActions.synthesizeNowAction());
    expect(url.pathname).toBe('/learning');
    expect(url.searchParams.get('error')).toBe(
      'No tokens left — a workspace admin can buy a token pack in Settings → Billing.',
    );
    expect(ai.calls).toBe(0);
  });

  it('product autofill', async () => {
    const s = await setup(0);
    await setBalance(s.ws, 0n);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    actAs(s.owner);
    const url = await redirectOf(
      autofillActions.autofillAction(form({ url: 'https://example.com/products/glass' })),
    );
    expect(url.pathname).toBe('/products/autofill');
    expect(url.searchParams.get('error')).toBe(
      'No tokens left — a workspace admin can buy a token pack in Settings → Billing.',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ai.calls).toBe(0);
    const [n] = await db
      .select({ n: count() })
      .from(productProfiles)
      .where(eq(productProfiles.workspaceId, s.ws));
    expect(n!.n).toBe(1); // only setup's product
  });
});

// ---- every guarded button ----------------------------------------------------

describe('every AI button is guarded', { timeout: 60_000 }, () => {
  it('Synthesize now: single-flight', async () => {
    const s = await setup(0);
    await holdAction(s.ws, 'learning.synthesize');
    actAs(s.owner);
    const url = await redirectOf(learningActions.synthesizeNowAction());
    expect(url.searchParams.get('error')).toMatch(
      /^Synthesize now is already running in this workspace/,
    );
    expect(ai.calls).toBe(0);
  });

  it('Synthesize now: rate-limited', async () => {
    const s = await setup(0);
    await fillLimit(s.ws, 'learning.synthesize');
    actAs(s.owner);
    const url = await redirectOf(learningActions.synthesizeNowAction());
    expect(url.searchParams.get('error')).toMatch(
      /^Synthesize now was used 6 times in the last hour/,
    );
  });

  it('Compact now: single-flight', async () => {
    const s = await setup(0);
    await holdAction(s.ws, 'knowledge.compact');
    actAs(s.owner);
    const url = await redirectOf(learningActions.compactNowAction());
    expect(url.searchParams.get('error')).toMatch(
      /^Compact now is already running in this workspace/,
    );
  });

  it('product autofill: single-flight, nothing fetched or created', async () => {
    const s = await setup(0);
    await holdAction(s.ws, 'product.autofill');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    actAs(s.owner);
    const url = await redirectOf(
      autofillActions.autofillAction(form({ url: 'https://example.com/products/glass' })),
    );
    expect(url.searchParams.get('error')).toMatch(/^Generate product profile is already running/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('Run check now: single-flight', async () => {
    const s = await setup(0);
    await holdAction(s.ws, 'health.check_now');
    actAs(s.owner);
    const url = await redirectOf(healthActions.runHealthCheckNowAction());
    expect(url.pathname).toBe('/health');
    expect(url.searchParams.get('err')).toMatch(/^Run check now is already running/);
  });

  it('a crawl plan’s Run now: single-flight per plan', async () => {
    const s = await setup(0);
    await holdAction(s.ws, 'crawl_plan.run_now', 42n);
    actAs(s.owner);
    const url = await redirectOf(engineActions.runPlanAction(form({ id: '42' })));
    expect(url.searchParams.get('error')).toMatch(/^Crawl plan Run now is already running/);
  });

  it('autopilot Run now: rate-limited (its lease already makes it single-flight)', async () => {
    const s = await setup(0);
    await fillLimit(s.ws, 'autopilot.run_now');
    actAs(s.owner);
    const url = await redirectOf(autopilotActions.runAutopilotNowAction());
    expect(url.pathname).toBe('/autopilot');
    expect(url.searchParams.get('error')).toMatch(
      /^Autopilot Run now was used 30 times in the last hour/,
    );
  });

  it('autopilot Run now still runs within the limit', async () => {
    const s = await setup(0);
    actAs(s.owner);
    const url = await redirectOf(autopilotActions.runAutopilotNowAction());
    expect(url.searchParams.get('message')).toBeTruthy();
    expect(url.searchParams.get('error')).toBeNull();
  });

  it('a recipe’s Run now: rate-limited, no run started', async () => {
    const s = await setup(0);
    await fillLimit(s.ws, 'connector.recipe_run_now');
    actAs(s.owner);
    const url = await redirectOf(
      recipeActions.runRecipeNowAction(s.connectorId.toString(), s.recipeId.toString()),
    );
    expect(url.searchParams.get('error')).toMatch(
      /^Recipe Run now was used 60 times in the last hour/,
    );
  });
});

// ---- the estimate, the confirmation and the page ------------------------------

describe('the confirmation and the Crawl Engine page (I028)', { timeout: 60_000 }, () => {
  it('estimates tokens from recent qualification usage, billed like the real debits', async () => {
    const s = await setup(2);
    await createProductProfile(s.owner, { name: 'Steel' });
    const usage = (keySource: string, cents: number) => ({
      workspaceId: s.ws,
      kind: 'ai.qualification',
      provider: 'anthropic',
      units: 100n,
      costEstimateCents: cents,
      payload: { keySource },
    });
    // 4 platform-key calls of 1 cent (3 tokens each at the default markup)
    // and 1 on the workspace's own key (0 tokens).
    await db
      .insert(usageLog)
      .values([
        usage('platform', 1),
        usage('platform', 1),
        usage('platform', 1),
        usage('platform', 1),
        usage('workspace', 1),
      ]);
    const e = await estimateReclassification(s.owner);
    expect(e).toMatchObject({
      records: 2,
      products: 2,
      classifications: 4,
      sampleSize: 5,
      tokensPerClassification: 2.4,
      estimatedTokens: 10,
      billingExempt: false,
    });
    expect(reclassifyAllConfirm(e)).toBe(
      'Re-classify all 2 records against 2 active products?\n\nThat is up to 4 AI classifications. Estimated cost: about 10 tokens, going by your last 5 classifications.\n\nIt runs in the background in batches of 50, stops by itself if the wallet runs out, and shows its progress on this page. Your own review decisions are kept.',
    );
  });

  it('says so when there is no history, or the workspace is billing-exempt', () => {
    const base = {
      records: 1234,
      products: 1,
      classifications: 1234,
      sampleSize: 0,
      estimatedTokens: null,
    };
    expect(reclassifyAllConfirm({ ...base, billingExempt: false })).toContain(
      'Re-classify all 1,234 records against 1 active product?\n\nThat is up to 1,234 AI classifications. No token estimate yet',
    );
    expect(reclassifyAllConfirm({ ...base, billingExempt: true })).toContain(
      'This workspace is billing-exempt, so no tokens are charged.',
    );
  });

  it('admins get the confirmed button; the progress line shows while a run works', async () => {
    const s = await setup(2);
    actAs(s.admin);
    let html = (
      await renderToHtml(await CrawlEnginePage({ searchParams: Promise.resolve({}) }))
    ).replaceAll('<!-- -->', '');
    expect(html).toContain('Re-classify all</button>');
    expect(html).not.toContain('data-auto-refresh="reclassify"');

    const gate = deferred();
    ai.gate = gate.promise;
    const run = await requestReclassification(s.admin);
    await waitFor(async () => (await runById(run.id)).status === 'running', 'the job to start');
    html = (
      await renderToHtml(await CrawlEnginePage({ searchParams: Promise.resolve({}) }))
    ).replaceAll('<!-- -->', '');
    expect(html).toMatch(/Re-classifying: 0 of 2 records \(0%\), 0 qualification\(s\) written\./);
    expect(html).toContain('data-auto-refresh="reclassify"');
    expect(html).toMatch(/<progress[^>]*value="0"[^>]*max="2"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Re-classify all<\/button>/);
    gate.resolve();
    ai.gate = null;
    await drain();

    // Members see the progress line but no button.
    actAs(s.member);
    html = (
      await renderToHtml(await CrawlEnginePage({ searchParams: Promise.resolve({}) }))
    ).replaceAll('<!-- -->', '');
    expect(html).not.toContain('Re-classify all</button>');
    expect(html).toMatch(
      /Last re-classification finished .* UTC: 2 of 2 records, 2 qualification\(s\) written\./,
    );
  });

  it('the status line for every outcome', () => {
    const at = new Date('2026-10-02T09:14:00Z');
    const run = (over: Partial<QualificationRun>): QualificationRun => ({
      id: 1n,
      workspaceId: 1n,
      status: 'queued',
      stopReason: null,
      error: null,
      requestedBy: null,
      upToRecordId: 10n,
      totalRecords: 1200,
      productCount: 3,
      processedRecords: 0,
      qualificationCount: 0,
      failedRecords: 0,
      lastRecordId: null,
      jobId: '1',
      createdAt: at,
      startedAt: null,
      heartbeatAt: null,
      finishedAt: null,
      ...over,
    });
    expect(describeReclassifyStatus(null, false)).toBeNull();
    expect(describeReclassifyStatus(run({}), false)).toMatchObject({
      active: true,
      text: 'Re-classification queued at 2026-10-02 09:14 UTC: 1,200 records against 3 product(s), waiting for a worker.',
    });
    expect(
      describeReclassifyStatus(
        run({
          status: 'running',
          startedAt: at,
          processedRecords: 450,
          qualificationCount: 1350,
          failedRecords: 2,
        }),
        true,
      ),
    ).toMatchObject({
      active: true,
      tone: 'info',
      processed: 450,
      total: 1200,
      text: 'Re-classifying: 450 of 1,200 records (37%), 1,350 qualification(s) written, 2 record(s) failed and were skipped. Started 2026-10-02 09:14 UTC.',
    });
    expect(
      describeReclassifyStatus(
        run({
          status: 'stopped',
          stopReason: 'held',
          processedRecords: 50,
          qualificationCount: 150,
        }),
        false,
      )?.text,
    ).toBe(
      'Last re-classification stopped at 50 of 1,200 records (150 qualification(s) written): Background AI is on hold for this workspace.',
    );
    expect(
      describeReclassifyStatus(
        run({
          status: 'failed',
          error:
            'Interrupted: the worker stopped before it finished (1 of 2 records done). Start it again.',
        }),
        false,
      )?.text,
    ).toBe(
      'Last re-classification failed: Interrupted: the worker stopped before it finished (1 of 2 records done). Start it again.',
    );
  });
});
