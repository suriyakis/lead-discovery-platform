import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import {
  mailMessages,
  mailThreads,
  mailboxes,
  suppressionList,
} from '@/lib/db/schema/mailing';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  addSuppression,
  isSuppressed,
  recordUnsubscribeByToken,
  revokeSuppression,
} from '@/lib/services/suppression';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  ownerA: string;
  mailboxId: bigint;
  threadId: bigint;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  const [mb] = await db
    .insert(mailboxes)
    .values({
      workspaceId: workspaceA,
      name: 'sales',
      fromAddress: 'sales@nulife.pl',
      smtpHost: 'smtp.x',
      smtpUser: 'sales@nulife.pl',
      smtpPasswordSecretKey: 'mailbox.smtpPassword_p35tests',
      imapFolder: 'INBOX',
      status: 'active',
      isDefault: true,
    })
    .returning();
  const [thread] = await db
    .insert(mailThreads)
    .values({
      workspaceId: workspaceA,
      mailboxId: mb!.id,
      subject: 'hi',
      externalThreadKey: `subj:hi-${Date.now()}`,
      participants: ['anna@target.com', 'sales@nulife.pl'],
    })
    .returning();
  return {
    workspaceA,
    ownerA,
    mailboxId: mb!.id,
    threadId: thread!.id,
  };
}

function ctx(
  workspaceId: bigint,
  userId: string,
  role: WorkspaceContext['role'] = 'owner',
): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

async function seedSentMessage(
  s: Setup,
  trackingToken: string,
  toAddresses: string[],
): Promise<bigint> {
  const [m] = await db
    .insert(mailMessages)
    .values({
      workspaceId: s.workspaceA,
      mailboxId: s.mailboxId,
      threadId: s.threadId,
      direction: 'outbound',
      status: 'sent',
      messageId: `<${trackingToken}@x>`,
      fromAddress: 'sales@nulife.pl',
      toAddresses,
      subject: 'hi',
      bodyText: 'hello',
      trackingToken,
    })
    .returning();
  return m!.id;
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ============ recordUnsubscribeByToken ==============================

describe('recordUnsubscribeByToken', () => {
  it('adds every recipient of the message to the suppression list', async () => {
    const s = await setup();
    const token = 'a'.repeat(32);
    await seedSentMessage(s, token, ['anna@target.com', 'cc@target.com']);

    const result = await recordUnsubscribeByToken(token);
    expect(result.workspaceId).toBe(s.workspaceA);
    expect(result.addresses.sort()).toEqual(['anna@target.com', 'cc@target.com']);

    // Both addresses should now be suppressed.
    expect(
      await isSuppressed(ctx(s.workspaceA, s.ownerA), 'anna@target.com'),
    ).toBe(true);
    expect(
      await isSuppressed(ctx(s.workspaceA, s.ownerA), 'cc@target.com'),
    ).toBe(true);
  });

  it('is idempotent — second call does not error', async () => {
    const s = await setup();
    const token = 'b'.repeat(32);
    await seedSentMessage(s, token, ['x@target.com']);
    await recordUnsubscribeByToken(token);
    const second = await recordUnsubscribeByToken(token);
    expect(second.addresses).toEqual(['x@target.com']);
    // Only one suppression row for that address.
    const rows = await db
      .select()
      .from(suppressionList)
      .where(
        and(
          eq(suppressionList.workspaceId, s.workspaceA),
          eq(suppressionList.value, 'x@target.com'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('unsubscribe');
  });

  it('records provenance: source unsubscribe_link, the outbound message as source_ref, and a suppression.add audit per address', async () => {
    const s = await setup();
    const token = 'f'.repeat(32);
    const msgId = await seedSentMessage(s, token, ['anna@target.com']);
    await recordUnsubscribeByToken(token);

    const [row] = await db
      .select()
      .from(suppressionList)
      .where(eq(suppressionList.workspaceId, s.workspaceA));
    expect(row!.source).toBe('unsubscribe_link');
    expect(row!.sourceRef).toBe(`mail_message:${msgId}`);
    expect(row!.createdBy).toBeNull();

    const adds = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.workspaceId, s.workspaceA),
          eq(auditLog.kind, 'suppression.add'),
        ),
      );
    expect(adds).toHaveLength(1);
    expect(adds[0]!.userId).toBeNull();
    expect(adds[0]!.payload).toMatchObject({
      value: 'anna@target.com',
      source: 'unsubscribe_link',
      sourceRef: `mail_message:${msgId}`,
      outcome: 'created',
      prior: null,
    });
  });

  it('re-activates a revoked row (a new opt-out beats an earlier revoke)', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    const entry = await addSuppression(c, {
      address: 'anna@target.com',
      reason: 'manual',
      source: 'manual',
    });
    await revokeSuppression(c, entry.id, 'test revoke');
    expect(await isSuppressed(c, 'anna@target.com')).toBe(false);

    const token = '0'.repeat(32);
    await seedSentMessage(s, token, ['anna@target.com']);
    await recordUnsubscribeByToken(token);

    expect(await isSuppressed(c, 'anna@target.com')).toBe(true);
    const [row] = await db
      .select()
      .from(suppressionList)
      .where(eq(suppressionList.id, entry.id));
    expect(row!.revokedAt).toBeNull();
    expect(row!.reason).toBe('unsubscribe');
    expect(row!.source).toBe('unsubscribe_link');
  });

  it('returns empty for malformed tokens', async () => {
    const result = await recordUnsubscribeByToken('not-a-token-!');
    expect(result.workspaceId).toBeNull();
    expect(result.addresses).toEqual([]);
  });

  it('returns empty for unknown valid-shaped tokens', async () => {
    const result = await recordUnsubscribeByToken('c'.repeat(32));
    expect(result.workspaceId).toBeNull();
    expect(result.addresses).toEqual([]);
  });

  it('lowercases recipient addresses', async () => {
    const s = await setup();
    const token = 'd'.repeat(32);
    await seedSentMessage(s, token, ['Anna@Target.COM']);
    const result = await recordUnsubscribeByToken(token);
    expect(result.addresses).toEqual(['anna@target.com']);
    expect(
      await isSuppressed(ctx(s.workspaceA, s.ownerA), 'anna@target.com'),
    ).toBe(true);
  });

  it('overrides a prior bounce reason with unsubscribe (more user-intent-y)', async () => {
    const s = await setup();
    // Plant a bounce row first.
    await db.insert(suppressionList).values({
      workspaceId: s.workspaceA,
      kind: 'email',
      address: 'flaky@target.com',
      value: 'flaky@target.com',
      reason: 'bounce_soft',
      note: 'soft bounce',
    });
    const token = 'e'.repeat(32);
    await seedSentMessage(s, token, ['flaky@target.com']);
    await recordUnsubscribeByToken(token);
    const rows = await db
      .select()
      .from(suppressionList)
      .where(
        and(
          eq(suppressionList.workspaceId, s.workspaceA),
          eq(suppressionList.value, 'flaky@target.com'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('unsubscribe');
    expect(rows[0]?.source).toBe('unsubscribe_link');
    expect(rows[0]?.expiresAt).toBeNull();
  });

  it('never downgrades a manual block: the row keeps its reason and source', async () => {
    const s = await setup();
    await addSuppression(ctx(s.workspaceA, s.ownerA), {
      address: 'blocked@target.com',
      reason: 'manual',
      source: 'manual',
      note: 'competitor',
    });
    const token = '1'.repeat(32);
    await seedSentMessage(s, token, ['blocked@target.com']);
    const result = await recordUnsubscribeByToken(token);
    expect(result.addresses).toEqual(['blocked@target.com']);
    const [row] = await db
      .select()
      .from(suppressionList)
      .where(eq(suppressionList.value, 'blocked@target.com'));
    expect(row!.reason).toBe('manual');
    expect(row!.source).toBe('manual');
    expect(row!.note).toBe('competitor');
  });
});
