// F-03 (X1, I088): suppression provenance, the non-downgrading upsert,
// revoke instead of delete, and the legacy backfill in the migration.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import { suppressionList, type SuppressionEntry } from '@/lib/db/schema/mailing';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import {
  addSuppression,
  isSuppressed,
  listSuppressions,
  mergeSuppression,
  recordBounce,
  revokeSuppression,
  type SuppressionIncoming,
  type SuppressionMergeState,
} from '@/lib/services/suppression';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  memberA: string;
  ownerB: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const memberA = await seedUser({ email: 'memberA@test.local' });
  const ownerB = await seedUser({ email: 'ownerB@test.local' });
  const workspaceA = await seedWorkspace({
    name: 'A',
    ownerUserId: ownerA,
    extraMembers: [{ userId: memberA, role: 'member' }],
  });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  return { workspaceA, workspaceB, ownerA, memberA, ownerB };
}

function ctx(
  workspaceId: bigint,
  userId: string,
  role: WorkspaceContext['role'] = 'owner',
): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

async function addEvents(workspaceId: bigint, kind = 'suppression.add') {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.kind, kind)))
    .orderBy(asc(auditLog.id));
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ============ merge rules (pure) ====================================

describe('mergeSuppression', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000);
  const row = (o: Partial<SuppressionMergeState>): SuppressionMergeState => ({
    reason: 'manual',
    source: 'manual',
    sourceRef: null,
    note: null,
    expiresAt: null,
    revokedAt: null,
    ...o,
  });
  const add = (o: Partial<SuppressionIncoming>): SuppressionIncoming => ({
    reason: 'manual',
    source: 'manual',
    sourceRef: null,
    note: null,
    expiresAt: null,
    ...o,
  });

  it('a soft bounce never weakens an opt-out or adds an expiry to it', () => {
    const r = mergeSuppression(
      row({ reason: 'unsubscribe', source: 'unsubscribe_link' }),
      add({ reason: 'bounce_soft', source: 'smtp', expiresAt: inDays(7) }),
      now,
    );
    expect(r).toEqual({ outcome: 'unchanged', patch: null });
  });

  it('a soft bounce never adds an expiry to a permanent hard bounce', () => {
    const r = mergeSuppression(
      row({ reason: 'bounce_hard', source: 'smtp' }),
      add({ reason: 'bounce_soft', source: 'smtp', expiresAt: inDays(7) }),
      now,
    );
    expect(r.outcome).toBe('unchanged');
  });

  it('a stronger reason takes over and an active expiry is never shortened', () => {
    const r = mergeSuppression(
      row({ reason: 'bounce_soft', source: 'smtp', expiresAt: inDays(5) }),
      add({ reason: 'bounce_hard', source: 'dsn', sourceRef: 'mail_message:9' }),
      now,
    );
    expect(r.outcome).toBe('upgraded');
    expect(r.patch).toMatchObject({
      reason: 'bounce_hard',
      source: 'dsn',
      sourceRef: 'mail_message:9',
      expiresAt: null,
    });
  });

  it('a stronger reason with a shorter expiry keeps the later expiry', () => {
    const r = mergeSuppression(
      row({ reason: 'bounce_soft', source: 'smtp', expiresAt: inDays(6) }),
      add({ reason: 'manual', source: 'manual', expiresAt: inDays(2) }),
      now,
    );
    expect(r.outcome).toBe('upgraded');
    expect(r.patch?.expiresAt).toEqual(inDays(6));
  });

  it('equal reason: explicit evidence takes over an inferred row', () => {
    const r = mergeSuppression(
      row({ reason: 'unsubscribe', source: 'reply', sourceRef: 'mail_message:1' }),
      add({ reason: 'unsubscribe', source: 'unsubscribe_link', sourceRef: 'mail_message:2' }),
      now,
    );
    expect(r.outcome).toBe('upgraded');
    expect(r.patch).toMatchObject({ source: 'unsubscribe_link', sourceRef: 'mail_message:2' });
  });

  it('equal reason: an inferred add never takes over an explicit row', () => {
    const r = mergeSuppression(
      row({ reason: 'manual', source: 'manual', note: 'competitor' }),
      add({ reason: 'unsubscribe', source: 'reply', note: 'auto' }),
      now,
    );
    expect(r).toEqual({ outcome: 'unchanged', patch: null });
  });

  it('equal reason: the later expiry wins (extended), provenance stays', () => {
    const r = mergeSuppression(
      row({ reason: 'bounce_soft', source: 'smtp', expiresAt: inDays(1), note: 'first' }),
      add({ reason: 'bounce_soft', source: 'smtp', expiresAt: inDays(7), note: 'second' }),
      now,
    );
    expect(r).toEqual({ outcome: 'extended', patch: { expiresAt: inDays(7) } });
  });

  it('an expired row is renewed with the new add, expiry included', () => {
    const r = mergeSuppression(
      row({ reason: 'manual', source: 'manual', expiresAt: inDays(-1) }),
      add({ reason: 'bounce_soft', source: 'smtp', expiresAt: inDays(7) }),
      now,
    );
    expect(r.outcome).toBe('renewed');
    expect(r.patch).toMatchObject({ reason: 'bounce_soft', source: 'smtp', expiresAt: inDays(7) });
  });

  it('a revoked row is re-activated by any add and its revoke is cleared', () => {
    const r = mergeSuppression(
      row({ reason: 'unsubscribe', source: 'legacy_auto', revokedAt: inDays(-3) }),
      add({ reason: 'bounce_soft', source: 'smtp', expiresAt: inDays(7) }),
      now,
    );
    expect(r.outcome).toBe('reactivated');
    expect(r.patch).toMatchObject({
      reason: 'bounce_soft',
      source: 'smtp',
      expiresAt: inDays(7),
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
    });
  });
});

// ============ non-downgrading upsert (DB) ===========================

describe('addSuppression — provenance + non-downgrading upsert', () => {
  it('a soft bounce after an unsubscribe leaves reason unsubscribe with no expiry', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    const first = await addSuppression(c, {
      address: 'anna@target.com',
      reason: 'unsubscribe',
      source: 'unsubscribe_link',
      sourceRef: 'mail_message:11',
    });
    const after = await recordBounce(c, 'anna@target.com', 'soft', '452 4.2.2 mailbox full');

    expect(after.id).toBe(first.id);
    expect(after.reason).toBe('unsubscribe');
    expect(after.expiresAt).toBeNull();
    expect(after.source).toBe('unsubscribe_link');
    expect(after.sourceRef).toBe('mail_message:11');
    expect(await isSuppressed(c, 'anna@target.com')).toBe(true);

    const events = await addEvents(s.workspaceA);
    expect(events).toHaveLength(2);
    expect(events[1]!.payload).toMatchObject({
      reason: 'bounce_soft',
      source: 'smtp',
      note: '452 4.2.2 mailbox full',
      outcome: 'unchanged',
      prior: { reason: 'unsubscribe', source: 'unsubscribe_link', expiresAt: null },
      result: { reason: 'unsubscribe', expiresAt: null },
    });
  });

  it('a hard bounce after a soft one makes the row permanent', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await recordBounce(c, 'b@target.com', 'soft', '452');
    const after = await recordBounce(c, 'b@target.com', 'hard', '550 5.1.1');
    expect(after.reason).toBe('bounce_hard');
    expect(after.expiresAt).toBeNull();
    expect(after.note).toBe('550 5.1.1');
  });

  it('a manual add after an automatic one keeps the strongest reason and records both in the audit log', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.memberA, 'member');

    // Automatic opt-out (reply classifier), then a weaker manual add.
    await addSuppression(c, {
      address: 'kept@target.com',
      reason: 'unsubscribe',
      source: 'reply',
      sourceRef: 'mail_message:7',
      note: 'auto-suppressed from message 7',
    });
    const kept = await addSuppression(c, {
      address: 'kept@target.com',
      reason: 'bounce_soft',
      source: 'manual',
      note: 'operator thinks the mailbox is full',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(kept.reason).toBe('unsubscribe');
    expect(kept.source).toBe('reply');
    expect(kept.expiresAt).toBeNull();
    expect(kept.note).toBe('auto-suppressed from message 7');

    // Automatic soft bounce, then a stronger manual block.
    await recordBounce(c, 'upgraded@target.com', 'soft', '452');
    const upgraded = await addSuppression(c, {
      address: 'upgraded@target.com',
      reason: 'manual',
      source: 'manual',
      note: 'asked us to stop',
    });
    expect(upgraded.reason).toBe('manual');
    expect(upgraded.source).toBe('manual');
    expect(upgraded.expiresAt).toBeNull();
    expect(upgraded.note).toBe('asked us to stop');

    const events = await addEvents(s.workspaceA);
    const forKept = events.filter(
      (e) => (e.payload as { value?: string }).value === 'kept@target.com',
    );
    expect(forKept.map((e) => (e.payload as { source: string }).source)).toEqual([
      'reply',
      'manual',
    ]);
    expect(forKept[1]!.userId).toBe(s.memberA);
    expect(forKept[1]!.payload).toMatchObject({
      outcome: 'unchanged',
      note: 'operator thinks the mailbox is full',
      prior: { reason: 'unsubscribe', source: 'reply', sourceRef: 'mail_message:7' },
    });
    const forUpgraded = events.filter(
      (e) => (e.payload as { value?: string }).value === 'upgraded@target.com',
    );
    expect(forUpgraded.map((e) => (e.payload as { outcome: string }).outcome)).toEqual([
      'created',
      'upgraded',
    ]);
    expect(forUpgraded[1]!.payload).toMatchObject({
      source: 'manual',
      prior: { reason: 'bounce_soft', source: 'smtp' },
      result: { reason: 'manual', source: 'manual', expiresAt: null },
    });
  });

  it('a manual confirmation of an automatic opt-out takes over its provenance', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await addSuppression(c, {
      address: 'confirm@target.com',
      reason: 'unsubscribe',
      source: 'reply',
      sourceRef: 'mail_message:3',
    });
    const confirmed = await addSuppression(c, {
      address: 'confirm@target.com',
      reason: 'manual',
      source: 'manual',
      note: 'confirmed by phone',
    });
    expect(confirmed.source).toBe('manual');
    expect(confirmed.sourceRef).toBeNull();
    expect(confirmed.note).toBe('confirmed by phone');
  });

  it('an automatic add never overrides a manual entry', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await addSuppression(c, {
      kind: 'domain',
      value: 'competitor.example',
      reason: 'manual',
      source: 'manual',
      note: 'competitor',
    });
    const after = await addSuppression(c, {
      kind: 'domain',
      value: 'competitor.example',
      reason: 'unsubscribe',
      source: 'reply',
      note: 'auto',
    });
    expect(after.reason).toBe('manual');
    expect(after.source).toBe('manual');
    expect(after.note).toBe('competitor');
  });

  it('the audit payload carries source, source_ref and the prior state', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    const first = await addSuppression(c, {
      address: 'audit@target.com',
      reason: 'bounce_soft',
      source: 'smtp',
      note: '452',
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    });
    await addSuppression(c, {
      address: 'audit@target.com',
      reason: 'bounce_hard',
      source: 'dsn',
      sourceRef: 'mail_message:99',
    });
    const events = await addEvents(s.workspaceA);
    expect(events).toHaveLength(2);
    expect(events[0]!.entityId).toBe(first.id.toString());
    expect(events[0]!.payload).toMatchObject({
      kind: 'email',
      value: 'audit@target.com',
      reason: 'bounce_soft',
      source: 'smtp',
      sourceRef: null,
      outcome: 'created',
      prior: null,
    });
    expect(events[1]!.payload).toMatchObject({
      reason: 'bounce_hard',
      source: 'dsn',
      sourceRef: 'mail_message:99',
      outcome: 'upgraded',
      prior: {
        reason: 'bounce_soft',
        source: 'smtp',
        sourceRef: null,
        note: '452',
        expiresAt: '2099-01-01T00:00:00.000Z',
        revokedAt: null,
      },
      result: {
        reason: 'bounce_hard',
        source: 'dsn',
        sourceRef: 'mail_message:99',
        // a permanent hard bounce outlasts any expiry
        expiresAt: null,
      },
    });
  });

  it('concurrent adds merge instead of racing (strongest wins, every add audited)', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await Promise.all([
      recordBounce(c, 'race@target.com', 'soft', '452'),
      addSuppression(c, {
        address: 'race@target.com',
        reason: 'unsubscribe',
        source: 'unsubscribe_link',
      }),
      recordBounce(c, 'race@target.com', 'soft', '452 again'),
    ]);
    const rows = await db
      .select()
      .from(suppressionList)
      .where(eq(suppressionList.value, 'race@target.com'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('unsubscribe');
    expect(rows[0]!.expiresAt).toBeNull();
    expect(await addEvents(s.workspaceA)).toHaveLength(3);
  });

  it('refuses the backfill-only sources and an over-long source_ref', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await expect(
      addSuppression(c, {
        address: 'x@target.com',
        reason: 'manual',
        source: 'legacy_auto' as never,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      addSuppression(c, {
        address: 'x@target.com',
        reason: 'manual',
        source: 'import',
        sourceRef: 'r'.repeat(201),
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

// ============ revoke ================================================

describe('revokeSuppression', () => {
  it('revoke makes isSuppressed false, and a new add reactivates the row', async () => {
    const s = await setup();
    const member = ctx(s.workspaceA, s.memberA, 'member');
    const admin = ctx(s.workspaceA, s.ownerA, 'admin');

    const entry = await addSuppression(member, {
      address: 'colleague@ecobeton.example',
      reason: 'unsubscribe',
      source: 'reply',
      sourceRef: 'mail_message:5',
    });
    expect(await isSuppressed(member, 'colleague@ecobeton.example')).toBe(true);

    const revoked = await revokeSuppression(admin, entry.id, '  newsletter footer, not an opt-out  ');
    expect(revoked.id).toBe(entry.id);
    expect(revoked.revokedAt).toBeInstanceOf(Date);
    expect(revoked.revokedBy).toBe(s.ownerA);
    expect(revoked.revokeReason).toBe('newsletter footer, not an opt-out');
    expect(await isSuppressed(member, 'colleague@ecobeton.example')).toBe(false);

    // The row survives as history.
    expect(await listSuppressions(member)).toHaveLength(0);
    const all = await listSuppressions(member, { includeRevoked: true });
    expect(all.map((e) => e.id)).toEqual([entry.id]);

    const [revokeEvent] = await addEvents(s.workspaceA, 'suppression.revoke');
    expect(revokeEvent!.userId).toBe(s.ownerA);
    expect(revokeEvent!.payload).toMatchObject({
      value: 'colleague@ecobeton.example',
      revokeReason: 'newsletter footer, not an opt-out',
      prior: { reason: 'unsubscribe', source: 'reply', revokedAt: null },
    });

    // A new add re-activates the same row.
    const again = await addSuppression(member, {
      address: 'colleague@ecobeton.example',
      reason: 'manual',
      source: 'manual',
      note: 'asked again',
    });
    expect(again.id).toBe(entry.id);
    expect(again.revokedAt).toBeNull();
    expect(again.revokedBy).toBeNull();
    expect(again.revokeReason).toBeNull();
    expect(again.reason).toBe('manual');
    expect(again.source).toBe('manual');
    expect(await isSuppressed(member, 'colleague@ecobeton.example')).toBe(true);

    const adds = await addEvents(s.workspaceA);
    expect(adds[adds.length - 1]!.payload).toMatchObject({
      outcome: 'reactivated',
      prior: {
        revokedBy: s.ownerA,
        revokeReason: 'newsletter footer, not an opt-out',
      },
    });
    expect(
      (adds[adds.length - 1]!.payload as { prior: { revokedAt: string | null } }).prior
        .revokedAt,
    ).not.toBeNull();
  });

  it('a revoked domain or company row no longer matches', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await addSuppression(c, {
      kind: 'domain',
      value: 'blocked.example',
      reason: 'manual',
      source: 'manual',
    });
    expect(await isSuppressed(c, 'x@blocked.example')).toBe(true);
    await revokeSuppression(c, { kind: 'domain', value: 'Blocked.Example' }, 'wrong domain');
    expect(await isSuppressed(c, 'x@blocked.example')).toBe(false);
  });

  it('is admin-only and needs a reason', async () => {
    const s = await setup();
    const owner = ctx(s.workspaceA, s.ownerA);
    const entry = await addSuppression(owner, {
      address: 'x@target.com',
      reason: 'manual',
      source: 'manual',
    });
    for (const role of ['member', 'manager', 'viewer'] as const) {
      await expect(
        revokeSuppression(ctx(s.workspaceA, s.memberA, role), entry.id, 'nope'),
      ).rejects.toMatchObject({ code: 'permission_denied' });
    }
    await expect(revokeSuppression(owner, entry.id, '   ')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      revokeSuppression(owner, entry.id, 'x'.repeat(501)),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await isSuppressed(owner, 'x@target.com')).toBe(true);
    expect(await addEvents(s.workspaceA, 'suppression.revoke')).toHaveLength(0);
  });

  it('refuses a second revoke and rows of another workspace', async () => {
    const s = await setup();
    const owner = ctx(s.workspaceA, s.ownerA);
    const entry = await addSuppression(owner, {
      address: 'x@target.com',
      reason: 'manual',
      source: 'manual',
    });
    await revokeSuppression(owner, entry.id, 'first');
    await expect(revokeSuppression(owner, entry.id, 'second')).rejects.toMatchObject({
      code: 'already_revoked',
    });
    await expect(
      revokeSuppression(ctx(s.workspaceB, s.ownerB), entry.id, 'not yours'),
    ).rejects.toMatchObject({ code: 'not_found' });
    const [row] = await db
      .select()
      .from(suppressionList)
      .where(eq(suppressionList.id, entry.id));
    expect(row!.revokeReason).toBe('first');
  });
});

// ============ migration backfill ====================================

/** The UPDATE statements of the migration that introduced suppression_source. */
function backfillStatements(): string[] {
  const dir = path.resolve(process.cwd(), 'drizzle');
  const file = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(path.join(dir, f), 'utf8'))
    .find((body) => body.includes('CREATE TYPE "public"."suppression_source"'));
  if (!file) throw new Error('suppression_source migration not found');
  const stmts = file
    .split('--> statement-breakpoint')
    .filter((st) => /UPDATE "suppression_list"/.test(st));
  expect(stmts.length).toBeGreaterThan(0);
  return stmts;
}

describe('migration backfill (legacy rows)', () => {
  it('classifies the auto-note rows as legacy_auto and everything else as legacy_unknown', async () => {
    const s = await setup();
    const base = { workspaceId: s.workspaceA, kind: 'email' as const, reason: 'unsubscribe' as const };
    const legacy = (value: string, note: string | null) => ({ ...base, address: value, value, note });
    // Inserted without `source`, exactly like pre-F-03 rows after the
    // column was added with its legacy_unknown default.
    await db.insert(suppressionList).values([
      legacy('a@x.com', 'auto-suppressed from message 41'),
      legacy('b@x.com', 'auto-suppressed by outreach handler from message 42'),
      legacy('c@x.com', 'one-click unsubscribe via List-Unsubscribe'),
      legacy('d@x.com', 'customer said: auto-suppressed from message 7 please'),
      legacy('e@x.com', null),
      legacy('f@x.com', 'Asked for no further emails'),
    ]);
    // A new-style row whose note happens to match must keep its source.
    await db.insert(suppressionList).values({
      ...legacy('g@x.com', 'auto-suppressed from message 43'),
      source: 'reply',
      sourceRef: 'mail_message:43',
    });

    const run = async () => {
      for (const st of backfillStatements()) await db.execute(sql.raw(st));
    };
    await run();
    await run(); // idempotent

    const rows = await db.select().from(suppressionList);
    const by = (v: string): SuppressionEntry => rows.find((r) => r.value === v)!;
    expect(by('a@x.com')).toMatchObject({ source: 'legacy_auto', sourceRef: 'mail_message:41' });
    expect(by('b@x.com')).toMatchObject({ source: 'legacy_auto', sourceRef: 'mail_message:42' });
    expect(by('c@x.com')).toMatchObject({ source: 'legacy_unknown', sourceRef: null });
    expect(by('d@x.com')).toMatchObject({ source: 'legacy_unknown', sourceRef: null });
    expect(by('e@x.com')).toMatchObject({ source: 'legacy_unknown', sourceRef: null });
    expect(by('f@x.com')).toMatchObject({ source: 'legacy_unknown', sourceRef: null });
    expect(by('g@x.com')).toMatchObject({ source: 'reply', sourceRef: 'mail_message:43' });
    // The backfill never revokes anything.
    expect(rows.every((r) => r.revokedAt === null)).toBe(true);
  });
});
