import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
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
  isSuppressed,
  recordUnsubscribeByToken,
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
  });
});
