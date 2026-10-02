// Test DB helpers: truncate, seed users, seed workspaces.
//
// These import the production `db` client. Vitest's `env` block sets
// DATABASE_URL to lead_test before any import, so this is safe.

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/auth';
import {
  workspaceMembers,
  workspaces,
  workspaceSettings,
  type WorkspaceMemberRole,
} from '@/lib/db/schema/workspaces';

const TENANT_TABLES = [
  'audit_log',
  'platform_secrets',
  'platform_settings',
  'usage_log',
  'workspace_members',
  'workspace_settings',
  'workspaces',
  'sessions',
  'accounts',
  'verification_tokens',
  'preauthorized_emails',
  'users',
  // PC-07: not tenant-owned (no FK to workspaces), so list them explicitly.
  'job_heartbeats',
  'ops_events',
  // PC-08: owner-alert state and delivery log.
  'ops_alert_state',
  'ops_alert_deliveries',
  // PC-38: the shared rate limiter's windows (keys, no workspace FK).
  'rate_limit_buckets',
];

/**
 * Wipe every domain table and reset bigserial sequences. Call this from a
 * `beforeEach` in any DB-backed test suite.
 *
 * Refuses to run when DATABASE_URL doesn't look like the test DB.
 */
export async function truncateAll(): Promise<void> {
  if (!process.env.DATABASE_URL?.includes('lead_test')) {
    throw new Error('truncateAll() refused: DATABASE_URL is not the test DB');
  }
  // Drain any fire-and-forget in-process jobs left running by the previous
  // test (e.g. connector runs a crawl plan enqueued). Letting them settle
  // first stops their writes from racing — and deadlocking against — the
  // TRUNCATE below. Best-effort; only the in-memory dev queue buffers work.
  try {
    const { getJobQueue } = await import('@/lib/jobs');
    await getJobQueue().drain?.();
  } catch {
    // ignore — drain is a stability nicety, not a correctness requirement
  }
  // Same for detached hooks (src/lib/detached.ts), e.g. the reply
  // handler's learning hook: one still writing during TRUNCATE deadlocked
  // reply-classifier.test.ts in a full run. settleDetached never throws.
  const { settleDetached } = await import('@/lib/detached');
  await settleDetached();
  // RESTART IDENTITY resets sequences. CASCADE handles FKs.
  const ident = TENANT_TABLES.map((t) => `"${t}"`).join(', ');
  await db.execute(sql.raw(`TRUNCATE TABLE ${ident} RESTART IDENTITY CASCADE;`));
  // AP-06: workspace ids restart at 1, so a memoised diagnostics result of
  // the previous test's workspace 1 must not answer for the next one.
  const { _resetDiagnosticsMemoForTests } = await import('@/lib/diagnostics/engine');
  _resetDiagnosticsMemoForTests();
}

export async function seedUser(input: {
  email: string;
  name?: string;
  role?: 'member' | 'super_admin';
  accountStatus?: 'pending' | 'active' | 'suspended' | 'rejected';
}): Promise<string> {
  const inserted = await db
    .insert(users)
    .values({
      email: input.email,
      name: input.name ?? input.email.split('@')[0] ?? null,
      role: input.role ?? 'member',
      // Default to active so existing service tests don't have to know
      // about Phase 15. Tests that exercise the lifecycle pass an
      // explicit value.
      accountStatus: input.accountStatus ?? 'active',
    })
    .returning();
  if (!inserted[0]) throw new Error('user insert returned no row');
  return inserted[0].id;
}

/**
 * Seed a workspace with `ownerUserId` as the owner member. Optional extra
 * members can be passed; they get added with their declared role.
 */
export async function seedWorkspace(input: {
  name: string;
  slug?: string;
  ownerUserId: string;
  extraMembers?: ReadonlyArray<{ userId: string; role: WorkspaceMemberRole }>;
  /** Plan tier for the seeded workspace. Defaults to an ACTIVE Pro
   *  subscription so the plan-limit gates (products, mailboxes,
   *  autopilot, BYOK) never interfere with tests that aren't about
   *  them. Pass 'free' to seed an unsubscribed workspace when testing
   *  the limits themselves. Token debits are unaffected either way
   *  (billing_exempt stays false). */
  plan?: 'free' | 'starter' | 'pro';
  /** flow:F-07 go-live hold. Real workspaces start NOT live (cold,
   *  follow-up and AI-reply mail is held until a super-admin releases
   *  them). Seeded test workspaces default to live so suites that are not
   *  about the hold can send; pass false to test it. */
  live?: boolean;
}): Promise<bigint> {
  const plan = input.plan ?? 'pro';
  const live = input.live ?? true;
  return db.transaction(async (tx) => {
    const ws = await tx
      .insert(workspaces)
      .values({
        name: input.name,
        slug: input.slug ?? `${input.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`,
        ownerUserId: input.ownerUserId,
        ...(plan === 'free'
          ? {}
          : { plan, subscriptionStatus: 'active' as const }),
        ...(live ? { outreachLiveAt: new Date() } : {}),
      })
      .returning();
    const workspaceId = ws[0]?.id;
    if (!workspaceId) throw new Error('workspace insert returned no row');

    await tx.insert(workspaceMembers).values({
      workspaceId,
      userId: input.ownerUserId,
      role: 'owner',
    });
    await tx.insert(workspaceSettings).values({ workspaceId });

    if (input.extraMembers) {
      for (const m of input.extraMembers) {
        await tx.insert(workspaceMembers).values({
          workspaceId,
          userId: m.userId,
          role: m.role,
        });
      }
    }
    return workspaceId;
  });
}
