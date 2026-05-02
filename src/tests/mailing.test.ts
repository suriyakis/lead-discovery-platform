import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  mailMessages,
  mailThreads,
  mailboxes,
  signatures,
  suppressionList,
} from '@/lib/db/schema/mailing';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  archiveMailbox,
  createMailbox,
  defaultMailbox,
  getMailbox,
  listMailboxes,
  testMailboxConnection,
  updateMailbox,
} from '@/lib/services/mailbox';
import {
  getMessage,
  getThread,
  listThreads,
  sendMessage,
  syncInbound,
} from '@/lib/services/mail';
import {
  addSuppression,
  isSuppressed,
  listSuppressions,
  removeSuppression,
} from '@/lib/services/suppression';
import {
  createSignature,
  defaultSignature,
  deleteSignature,
  listSignatures,
  updateSignature,
} from '@/lib/services/signatures';
import { MockMailProvider, type InboundMessage } from '@/lib/mail';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  ownerB: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const ownerB = await seedUser({ email: 'ownerB@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  return { workspaceA, workspaceB, ownerA, ownerB };
}

function ctx(workspaceId: bigint, userId: string, role: WorkspaceContext['role'] = 'owner'): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

function stringifyForAssert(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val));
}

async function makeMailbox(s: Setup, ws: bigint, owner: string, name = 'sales') {
  return createMailbox(ctx(ws, owner), {
    name,
    fromAddress: `${name}@nulife.pl`,
    fromName: 'Sales Team',
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: `${name}@nulife.pl`,
    smtpPassword: 'super-secret',
    imap: {
      host: 'imap.example.com',
      port: 993,
      secure: true,
      user: `${name}@nulife.pl`,
      password: 'super-secret',
      folder: 'INBOX',
    },
    isDefault: true,
  });
}

// ============ suppression ============================================

describe('suppression list', () => {
  it('add + isSuppressed lowercases input and returns true', async () => {
    const s = await setup();
    await addSuppression(ctx(s.workspaceA, s.ownerA), {
      address: 'No.Send@Example.com',
      reason: 'unsubscribe',
    });
    expect(await isSuppressed(ctx(s.workspaceA, s.ownerA), 'no.send@example.com')).toBe(true);
    expect(await isSuppressed(ctx(s.workspaceA, s.ownerA), 'NO.SEND@example.com')).toBe(true);
  });

  it('expires_at TTL — expired entries do not match', async () => {
    const s = await setup();
    await addSuppression(ctx(s.workspaceA, s.ownerA), {
      address: 'temp@example.com',
      reason: 'bounce_soft',
      expiresAt: new Date(Date.now() - 60_000), // 1 minute ago
    });
    expect(await isSuppressed(ctx(s.workspaceA, s.ownerA), 'temp@example.com')).toBe(false);

    await addSuppression(ctx(s.workspaceA, s.ownerA), {
      address: 'future@example.com',
      reason: 'bounce_soft',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await isSuppressed(ctx(s.workspaceA, s.ownerA), 'future@example.com')).toBe(true);
  });

  it('addSuppression upserts on the address', async () => {
    const s = await setup();
    const a = await addSuppression(ctx(s.workspaceA, s.ownerA), {
      address: 'x@example.com',
      reason: 'manual',
    });
    const b = await addSuppression(ctx(s.workspaceA, s.ownerA), {
      address: 'x@example.com',
      reason: 'unsubscribe',
      note: 'updated',
    });
    expect(a.address).toBe('x@example.com');
    expect(b.id).toBe(a.id);
    expect(b.reason).toBe('unsubscribe');
    expect(b.note).toBe('updated');
  });

  it('removeSuppression deletes the row', async () => {
    const s = await setup();
    await addSuppression(ctx(s.workspaceA, s.ownerA), {
      address: 'x@example.com',
      reason: 'manual',
    });
    await removeSuppression(ctx(s.workspaceA, s.ownerA), 'X@Example.com');
    expect(await isSuppressed(ctx(s.workspaceA, s.ownerA), 'x@example.com')).toBe(false);
  });

  it('does not leak across workspaces', async () => {
    const s = await setup();
    await addSuppression(ctx(s.workspaceA, s.ownerA), {
      address: 'x@example.com',
      reason: 'manual',
    });
    expect(await isSuppressed(ctx(s.workspaceB, s.ownerB), 'x@example.com')).toBe(false);
    const listB = await listSuppressions(ctx(s.workspaceB, s.ownerB));
    expect(listB).toHaveLength(0);
  });

  it('viewers cannot add', async () => {
    const s = await setup();
    await expect(
      addSuppression(ctx(s.workspaceA, s.ownerA, 'viewer'), {
        address: 'x@example.com',
        reason: 'manual',
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

// ============ mailbox =================================================

describe('mailbox', () => {
  it('createMailbox stores secret keys, not passwords', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, s.workspaceA, s.ownerA);
    expect(mb.smtpPasswordSecretKey).toMatch(/^mailbox\.smtpPassword_[0-9a-f]{12}$/);
    expect(mb.imapPasswordSecretKey).toMatch(/^mailbox\.imapPassword_[0-9a-f]{12}$/);
    expect(mb.fromAddress).toBe('sales@nulife.pl');
    expect(mb.isDefault).toBe(true);
    // Row must NOT contain raw passwords
    const raw = stringifyForAssert(mb);
    expect(raw).not.toContain('super-secret');
  });

  it('only one default per workspace', async () => {
    const s = await setup();
    const a = await makeMailbox(s, s.workspaceA, s.ownerA, 'a');
    expect(a.isDefault).toBe(true);
    const b = await makeMailbox(s, s.workspaceA, s.ownerA, 'b');
    expect(b.isDefault).toBe(true);
    const aReloaded = await getMailbox(ctx(s.workspaceA, s.ownerA), a.id);
    expect(aReloaded.isDefault).toBe(false);
    const def = await defaultMailbox(ctx(s.workspaceA, s.ownerA));
    expect(def?.id).toBe(b.id);
  });

  it('archive sets status archived and clears default', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, s.workspaceA, s.ownerA);
    const archived = await archiveMailbox(ctx(s.workspaceA, s.ownerA), mb.id);
    expect(archived.status).toBe('archived');
    expect(archived.isDefault).toBe(false);
    expect(await defaultMailbox(ctx(s.workspaceA, s.ownerA))).toBe(null);
  });

  it('archive denied for non-admin members', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, s.workspaceA, s.ownerA);
    await expect(
      archiveMailbox(ctx(s.workspaceA, s.ownerA, 'member'), mb.id),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('list scopes to workspace', async () => {
    const s = await setup();
    const a = await makeMailbox(s, s.workspaceA, s.ownerA);
    await makeMailbox(s, s.workspaceB, s.ownerB);
    const listA = await listMailboxes(ctx(s.workspaceA, s.ownerA));
    expect(listA.map((m) => m.id)).toEqual([a.id]);
  });

  it('testMailboxConnection updates status on outcome', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, s.workspaceA, s.ownerA);
    const provider = new MockMailProvider();
    const result = await testMailboxConnection(
      ctx(s.workspaceA, s.ownerA),
      mb.id,
      provider,
    );
    expect(result.smtp.ok).toBe(true);
    expect(result.imap?.ok).toBe(true);
    const reloaded = await getMailbox(ctx(s.workspaceA, s.ownerA), mb.id);
    expect(reloaded.status).toBe('active');
    expect(reloaded.lastError).toBe(null);
  });

  it('updateMailbox(smtpPassword) re-encrypts the secret without persisting cleartext', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, s.workspaceA, s.ownerA);
    await updateMailbox(ctx(s.workspaceA, s.ownerA), mb.id, {
      smtpPassword: 'new-rotated-password',
    });
    const reloaded = await getMailbox(ctx(s.workspaceA, s.ownerA), mb.id);
    expect(stringifyForAssert(reloaded)).not.toContain('new-rotated-password');
  });
});

// ============ signatures =============================================

describe('signatures', () => {
  it('create + list', async () => {
    const s = await setup();
    const a = await createSignature(ctx(s.workspaceA, s.ownerA), {
      name: 'Default',
      bodyText: '— Sales Team',
      isDefault: true,
    });
    const list = await listSignatures(ctx(s.workspaceA, s.ownerA));
    expect(list.map((sg) => sg.id)).toEqual([a.id]);
  });

  it('only one default per (workspace, mailbox|null)', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, s.workspaceA, s.ownerA);
    const a = await createSignature(ctx(s.workspaceA, s.ownerA), {
      name: 'A',
      bodyText: 'A',
      mailboxId: mb.id,
      isDefault: true,
    });
    const b = await createSignature(ctx(s.workspaceA, s.ownerA), {
      name: 'B',
      bodyText: 'B',
      mailboxId: mb.id,
      isDefault: true,
    });
    const reloadedA = (await listSignatures(ctx(s.workspaceA, s.ownerA), { mailboxId: mb.id }))
      .find((sg) => sg.id === a.id)!;
    expect(reloadedA.isDefault).toBe(false);
    const def = await defaultSignature(ctx(s.workspaceA, s.ownerA), mb.id);
    expect(def?.id).toBe(b.id);
  });

  it('update / delete', async () => {
    const s = await setup();
    const sig = await createSignature(ctx(s.workspaceA, s.ownerA), {
      name: 'X',
      bodyText: '...',
    });
    const updated = await updateSignature(ctx(s.workspaceA, s.ownerA), sig.id, {
      name: 'X v2',
    });
    expect(updated.name).toBe('X v2');
    await deleteSignature(ctx(s.workspaceA, s.ownerA), sig.id);
    const list = await listSignatures(ctx(s.workspaceA, s.ownerA));
    expect(list).toHaveLength(0);
  });
});

// ============ mail send / receive ====================================

describe('sendMessage', () => {
  it('persists outbound, threads via subject, blocks suppressed recipients', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, s.workspaceA, s.ownerA);
    const provider = new MockMailProvider();

    const sent = await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'lead@target.com', name: 'Target' }],
      subject: 'Glass tender Q3',
      text: 'Hi — short note about the tender.',
      providerOverride: provider,
    });

    expect(sent.direction).toBe('outbound');
    expect(sent.status).toBe('sent');
    expect(sent.toAddresses).toEqual(['lead@target.com']);
    expect(sent.fromAddress).toBe(mb.fromAddress);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.message.subject).toBe('Glass tender Q3');

    // Suppress that address; second send should reject before hitting the provider.
    await addSuppression(ctx(s.workspaceA, s.ownerA), {
      address: 'lead@target.com',
      reason: 'unsubscribe',
    });
    await expect(
      sendMessage(ctx(s.workspaceA, s.ownerA), {
        mailboxId: mb.id,
        to: [{ address: 'lead@target.com' }],
        subject: 'Re: Glass tender Q3',
        text: 'follow-up',
        providerOverride: provider,
      }),
    ).rejects.toMatchObject({ code: 'suppressed' });
    expect(provider.sent).toHaveLength(1); // unchanged
  });

  it('threads two outbound messages with the same subject + In-Reply-To', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, s.workspaceA, s.ownerA);
    const provider = new MockMailProvider();

    const first = await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'lead@target.com' }],
      subject: 'Tender Q3',
      text: 'first',
      providerOverride: provider,
    });
    const second = await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'lead@target.com' }],
      subject: 'Re: Tender Q3',
      text: 'follow up',
      inReplyTo: first.messageId,
      references: [first.messageId],
      providerOverride: provider,
    });

    expect(first.threadId).toBe(second.threadId);
    const { messages } = await getThread(ctx(s.workspaceA, s.ownerA), first.threadId!);
    expect(messages.map((m) => m.id)).toEqual([first.id, second.id]);
  });

  it('viewers cannot send', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, s.workspaceA, s.ownerA);
    await expect(
      sendMessage(ctx(s.workspaceA, s.ownerA, 'viewer'), {
        mailboxId: mb.id,
        to: [{ address: 'lead@target.com' }],
        subject: 'x',
        text: 'x',
        providerOverride: new MockMailProvider(),
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('refuses send via archived mailbox', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, s.workspaceA, s.ownerA);
    await archiveMailbox(ctx(s.workspaceA, s.ownerA), mb.id);
    await expect(
      sendMessage(ctx(s.workspaceA, s.ownerA), {
        mailboxId: mb.id,
        to: [{ address: 'lead@target.com' }],
        subject: 'x',
        text: 'x',
        providerOverride: new MockMailProvider(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('syncInbound', () => {
  it('persists fetched messages, dedups by message_id, threads them', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, s.workspaceA, s.ownerA);
    const provider = new MockMailProvider();
    const now = new Date();
    const inbound1: InboundMessage = {
      uid: 1,
      messageId: '<m1@example.com>',
      inReplyTo: null,
      references: [],
      from: { address: 'lead@target.com', name: 'Target' },
      to: [{ address: mb.fromAddress }],
      cc: [],
      subject: 'New tender',
      textBody: 'we have a new tender',
      htmlBody: null,
      receivedAt: now,
      headers: {},
      attachments: [],
    };
    const inbound2: InboundMessage = {
      ...inbound1,
      uid: 2,
      messageId: '<m2@example.com>',
      inReplyTo: '<m1@example.com>',
      references: ['<m1@example.com>'],
      subject: 'Re: New tender',
      textBody: 'reply text',
      receivedAt: new Date(now.getTime() + 1000),
    };
    provider.enqueueInbound(inbound1, inbound2);

    const r1 = await syncInbound(ctx(s.workspaceA, s.ownerA), mb.id, provider);
    expect(r1).toEqual({ fetched: 2, inserted: 2, duplicates: 0 });

    // Run again with the same fixtures — both should be deduped.
    provider.enqueueInbound(inbound1, inbound2);
    const r2 = await syncInbound(ctx(s.workspaceA, s.ownerA), mb.id, provider);
    expect(r2.duplicates).toBe(2);
    expect(r2.inserted).toBe(0);

    // Both messages share the same thread (References resolves to inbound1).
    const persisted = await db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.workspaceId, s.workspaceA));
    expect(persisted).toHaveLength(2);
    const threadIds = new Set(persisted.map((m) => m.threadId?.toString()));
    expect(threadIds.size).toBe(1);
  });

  it('does not leak inbound across workspaces', async () => {
    const s = await setup();
    const mbA = await makeMailbox(s, s.workspaceA, s.ownerA);
    const mbB = await makeMailbox(s, s.workspaceB, s.ownerB, 'b-sales');
    const providerA = new MockMailProvider();
    const providerB = new MockMailProvider();
    providerA.enqueueInbound({
      uid: 1,
      messageId: '<a@example.com>',
      inReplyTo: null,
      references: [],
      from: { address: 'a@target.com' },
      to: [{ address: mbA.fromAddress }],
      cc: [],
      subject: 'For A',
      textBody: 't',
      htmlBody: null,
      receivedAt: new Date(),
      headers: {},
      attachments: [],
    });
    providerB.enqueueInbound({
      uid: 1,
      messageId: '<b@example.com>',
      inReplyTo: null,
      references: [],
      from: { address: 'b@target.com' },
      to: [{ address: mbB.fromAddress }],
      cc: [],
      subject: 'For B',
      textBody: 't',
      htmlBody: null,
      receivedAt: new Date(),
      headers: {},
      attachments: [],
    });

    await syncInbound(ctx(s.workspaceA, s.ownerA), mbA.id, providerA);
    await syncInbound(ctx(s.workspaceB, s.ownerB), mbB.id, providerB);

    const inA = await db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.workspaceId, s.workspaceA));
    expect(inA).toHaveLength(1);
    expect(inA[0]!.subject).toBe('For A');

    const inB = await db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.workspaceId, s.workspaceB));
    expect(inB).toHaveLength(1);
    expect(inB[0]!.subject).toBe('For B');
  });
});

describe('listThreads + getThread + getMessage', () => {
  it('list scopes by workspace and orders by lastMessageAt desc', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, s.workspaceA, s.ownerA);
    const provider = new MockMailProvider();
    await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'one@x.com' }],
      subject: 'one',
      text: 'one',
      providerOverride: provider,
    });
    await new Promise((r) => setTimeout(r, 5));
    const second = await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'two@x.com' }],
      subject: 'two',
      text: 'two',
      providerOverride: provider,
    });

    const threads = await listThreads(ctx(s.workspaceA, s.ownerA));
    expect(threads).toHaveLength(2);
    expect(threads[0]!.id).toBe(second.threadId);
  });

  it('getMessage refuses cross-workspace lookup', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, s.workspaceA, s.ownerA);
    const sent = await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'x@x.com' }],
      subject: 'x',
      text: 'x',
      providerOverride: new MockMailProvider(),
    });
    await expect(
      getMessage(ctx(s.workspaceB, s.ownerB), sent.id),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('isolation', () => {
  it('mailboxes, threads, messages, signatures, suppression all stay in workspace', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, s.workspaceA, s.ownerA);
    await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'x@x.com' }],
      subject: 'x',
      text: 'x',
      providerOverride: new MockMailProvider(),
    });
    await createSignature(ctx(s.workspaceA, s.ownerA), {
      name: 'sig',
      bodyText: '—',
      mailboxId: mb.id,
    });
    await addSuppression(ctx(s.workspaceA, s.ownerA), {
      address: 'spam@x.com',
      reason: 'manual',
    });

    // Workspace B sees nothing
    expect(await listMailboxes(ctx(s.workspaceB, s.ownerB))).toHaveLength(0);
    expect(await listThreads(ctx(s.workspaceB, s.ownerB))).toHaveLength(0);
    expect(await listSignatures(ctx(s.workspaceB, s.ownerB))).toHaveLength(0);
    expect(await listSuppressions(ctx(s.workspaceB, s.ownerB))).toHaveLength(0);

    const rawMb = await db.select().from(mailboxes);
    const rawThreads = await db.select().from(mailThreads);
    const rawMsgs = await db.select().from(mailMessages);
    const rawSigs = await db.select().from(signatures);
    const rawSupp = await db.select().from(suppressionList);
    for (const arr of [rawMb, rawThreads, rawMsgs, rawSigs, rawSupp]) {
      for (const r of arr) {
        expect((r as { workspaceId: bigint }).workspaceId).toBe(s.workspaceA);
      }
    }
  });
});
