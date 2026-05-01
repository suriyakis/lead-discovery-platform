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
  'usage_log',
  'workspace_members',
  'workspace_settings',
  'workspaces',
  'sessions',
  'accounts',
  'verification_tokens',
  'users',
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
  // RESTART IDENTITY resets sequences. CASCADE handles FKs.
  const ident = TENANT_TABLES.map((t) => `"${t}"`).join(', ');
  await db.execute(sql.raw(`TRUNCATE TABLE ${ident} RESTART IDENTITY CASCADE;`));
}

export async function seedUser(input: {
  email: string;
  name?: string;
  role?: 'member' | 'super_admin';
}): Promise<string> {
  const inserted = await db
    .insert(users)
    .values({
      email: input.email,
      name: input.name ?? input.email.split('@')[0] ?? null,
      role: input.role ?? 'member',
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
}): Promise<bigint> {
  return db.transaction(async (tx) => {
    const ws = await tx
      .insert(workspaces)
      .values({
        name: input.name,
        slug: input.slug ?? `${input.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`,
        ownerUserId: input.ownerUserId,
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
