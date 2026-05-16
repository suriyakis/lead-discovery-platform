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
  countThreadsByKind,
  getMessage,
  getThread,
  listThreads,
  sendMessage,
  sendTestEmail,
  syncInbound,
} from '@/lib/services/mail';
import { outreachThreadState } from '@/lib/db/schema/outreach';
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
  redesignSignatureHtml,
  updateSignature,
} from '@/lib/services/signatures';
import { _setAIProviderForTests, type IAIProvider } from '@/lib/ai';
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

  // ─── Phase 53: logoUrl ──────────────────────────────────────────
  it('accepts a valid https logoUrl on create + persists it', async () => {
    const s = await setup();
    const sig = await createSignature(ctx(s.workspaceA, s.ownerA), {
      name: 'L',
      bodyText: '—',
      logoUrl: 'https://cdn.example.com/logo.png',
    });
    expect(sig.logoUrl).toBe('https://cdn.example.com/logo.png');
  });

  it('blank logoUrl normalises to null', async () => {
    const s = await setup();
    const sig = await createSignature(ctx(s.workspaceA, s.ownerA), {
      name: 'L2',
      bodyText: '—',
      logoUrl: '   ',
    });
    expect(sig.logoUrl).toBeNull();
  });

  it('rejects non-http(s) logoUrl', async () => {
    const s = await setup();
    await expect(
      createSignature(ctx(s.workspaceA, s.ownerA), {
        name: 'L3',
        bodyText: '—',
        logoUrl: 'javascript:alert(1)',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('updateSignature can clear logoUrl by passing null', async () => {
    const s = await setup();
    const sig = await createSignature(ctx(s.workspaceA, s.ownerA), {
      name: 'L4',
      bodyText: '—',
      logoUrl: 'https://cdn.example.com/a.png',
    });
    const cleared = await updateSignature(ctx(s.workspaceA, s.ownerA), sig.id, {
      logoUrl: null,
    });
    expect(cleared.logoUrl).toBeNull();
  });
});

// ============ P54: redesignSignatureHtml ==============================

function makeStubAi(captured: { system?: string; prompt?: string }, html: string): IAIProvider {
  return {
    id: 'stub-ai',
    model: 'stub-model',
    async generateText() {
      throw new Error('not used');
    },
    async generateJson(input, schema) {
      captured.system = input.system;
      captured.prompt = input.prompt;
      return schema.parse({ bodyHtml: html });
    },
    estimateCost() {
      return 0;
    },
    async healthCheck() {
      return { ok: true };
    },
  };
}

describe('redesignSignatureHtml (P54)', () => {
  afterAll(() => {
    _setAIProviderForTests(null);
  });

  it('threads structured fields + extraPrompt into the AI prompt and returns sanitized HTML', async () => {
    const s = await setup();
    const captured: { system?: string; prompt?: string } = {};
    _setAIProviderForTests(
      makeStubAi(
        captured,
        '<table cellspacing="0" cellpadding="0" border="0"><tr><td>Hello, I am Jakub.</td></tr></table>',
      ),
    );
    const result = await redesignSignatureHtml(ctx(s.workspaceA, s.ownerA), {
      fullName: 'Jakub',
      title: 'Operator',
      company: 'Nulife',
      email: 'jb@nulife.pl',
      phones: [{ label: 'mob', number: '+48 555 111 222' }],
      logoUrl: 'https://cdn.example.com/logo.png',
      extraPrompt: 'use navy and gold',
    });
    expect(result.bodyHtml).toContain('<table');
    expect(result.providerId).toBe('stub-ai');
    expect(captured.prompt).toContain('Jakub');
    expect(captured.prompt).toContain('Nulife');
    expect(captured.prompt).toContain('jb@nulife.pl');
    expect(captured.prompt).toContain('+48 555 111 222');
    expect(captured.prompt).toContain('https://cdn.example.com/logo.png');
    expect(captured.prompt).toContain('use navy and gold');
    expect(captured.system).toContain('email signature designer');
  });

  it('strips script / iframe / on* / javascript: URLs from AI output', async () => {
    const s = await setup();
    const captured: { system?: string; prompt?: string } = {};
    const hostile = `
      <table>
        <tr><td>
          <script>alert('xss')</script>
          <iframe src="https://evil.example.com"></iframe>
          <a href="javascript:alert(1)" onclick="boom()" onmouseover='x()'>click</a>
          <img src="javascript:alert(2)" onerror="leak()">
          Good text
        </td></tr>
      </table>
    `;
    _setAIProviderForTests(makeStubAi(captured, hostile));
    const result = await redesignSignatureHtml(ctx(s.workspaceA, s.ownerA), {
      fullName: 'Jakub',
    });
    expect(result.bodyHtml).not.toMatch(/<script/i);
    expect(result.bodyHtml).not.toMatch(/<iframe/i);
    expect(result.bodyHtml).not.toMatch(/\bonclick\b/i);
    expect(result.bodyHtml).not.toMatch(/\bonmouseover\b/i);
    expect(result.bodyHtml).not.toMatch(/\bonerror\b/i);
    expect(result.bodyHtml).not.toMatch(/javascript:/i);
    // Benign content survives.
    expect(result.bodyHtml).toContain('Good text');
  });

  it('rejects when neither fields nor bodyText is supplied', async () => {
    const s = await setup();
    _setAIProviderForTests(
      makeStubAi({}, '<table><tr><td>x</td></tr></table>'),
    );
    await expect(
      redesignSignatureHtml(ctx(s.workspaceA, s.ownerA), {}),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('viewers cannot redesign', async () => {
    const s = await setup();
    _setAIProviderForTests(
      makeStubAi({}, '<table><tr><td>x</td></tr></table>'),
    );
    await expect(
      redesignSignatureHtml(ctx(s.workspaceA, s.ownerA, 'viewer'), {
        fullName: 'X',
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('strips markdown code fences if the model ignores instructions', async () => {
    const s = await setup();
    _setAIProviderForTests(
      makeStubAi(
        {},
        '```html\n<table><tr><td>Signature with markdown wrapper</td></tr></table>\n```',
      ),
    );
    const result = await redesignSignatureHtml(ctx(s.workspaceA, s.ownerA), {
      fullName: 'Jakub',
    });
    expect(result.bodyHtml).not.toMatch(/^```/);
    expect(result.bodyHtml).not.toMatch(/```$/);
    expect(result.bodyHtml).toContain('<table>');
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

// ============ P52: sendTestEmail =====================================

describe('sendTestEmail (P52)', () => {
  it('sends via SMTP, applies default signature, does NOT persist a mail_messages row', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, s.workspaceA, s.ownerA);
    await createSignature(ctx(s.workspaceA, s.ownerA), {
      name: 'Default sig',
      mailboxId: mb.id,
      bodyText: '— Jakub @ Nulife',
      bodyHtml: '<p>— Jakub @ Nulife</p>',
      isDefault: true,
    });
    const provider = new MockMailProvider();

    const result = await sendTestEmail(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: 'me@example.com',
      subject: 'Deliverability test',
      body: 'Hello world',
      providerOverride: provider,
    });

    // SMTP fired.
    expect(provider.sent).toHaveLength(1);
    const sent = provider.sent[0]!.message;
    expect(sent.subject).toBe('Deliverability test');
    expect(sent.text).toContain('Hello world');
    expect(sent.text).toContain('— Jakub @ Nulife'); // signature appended
    expect(sent.html).toContain('<p>— Jakub @ Nulife</p>');
    // Test-marker header so the operator's mail rules can recognise the
    // bounce-back if they want to.
    expect(sent.headers?.['X-LDP-Test']).toBe('true');
    // Test emails are not real outreach; no unsubscribe footer or
    // tracking pixel.
    expect(sent.text ?? '').not.toContain('Unsubscribe:');
    expect(sent.html ?? '').not.toContain('/api/track/');
    expect(sent.headers?.['List-Unsubscribe']).toBeUndefined();
    // Return shape reports the signature that was attached.
    expect(result.appendedSignature).toBe(true);
    expect(result.signatureName).toBe('Default sig');

    // Critically — no mail_messages row was created. Test emails don't
    // clutter the threads view.
    const rows = await db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.workspaceId, s.workspaceA));
    expect(rows).toHaveLength(0);
  });

  it('signatureId: null forces no signature', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, s.workspaceA, s.ownerA);
    await createSignature(ctx(s.workspaceA, s.ownerA), {
      name: 'Default sig',
      mailboxId: mb.id,
      bodyText: '— footer',
      bodyHtml: '<p>— footer</p>',
      isDefault: true,
    });
    const provider = new MockMailProvider();
    const result = await sendTestEmail(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: 'me@example.com',
      subject: 'plain',
      body: 'no signature please',
      signatureId: null,
      providerOverride: provider,
    });
    expect(result.appendedSignature).toBe(false);
    expect(provider.sent[0]!.message.text).not.toContain('— footer');
    expect(provider.sent[0]!.message.html).toBeUndefined();
  });

  it('viewers cannot send a test', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, s.workspaceA, s.ownerA);
    await expect(
      sendTestEmail(ctx(s.workspaceA, s.ownerA, 'viewer'), {
        mailboxId: mb.id,
        to: 'me@example.com',
        subject: 'x',
        body: 'x',
        providerOverride: new MockMailProvider(),
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('rejects empty to / subject / body', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, s.workspaceA, s.ownerA);
    for (const overrides of [
      { to: '', subject: 's', body: 'b' },
      { to: 'x@y.com', subject: '', body: 'b' },
      { to: 'x@y.com', subject: 's', body: '' },
    ]) {
      await expect(
        sendTestEmail(ctx(s.workspaceA, s.ownerA), {
          mailboxId: mb.id,
          providerOverride: new MockMailProvider(),
          ...overrides,
        }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });
});

// ============ P52: thread kind filter ================================

describe('listThreads kind filter + countThreadsByKind (P52)', () => {
  it('partitions threads by whether outreach_thread_state row exists', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, s.workspaceA, s.ownerA);
    const provider = new MockMailProvider();

    // Three threads via sendMessage (creates mail_threads rows).
    const a = await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'lead-a@target.com' }],
      subject: 'Lead A',
      text: 'a',
      providerOverride: provider,
    });
    const b = await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'lead-b@target.com' }],
      subject: 'Lead B',
      text: 'b',
      providerOverride: provider,
    });
    const c = await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'random-c@target.com' }],
      subject: 'Random C',
      text: 'c',
      providerOverride: provider,
    });

    // Attach outreach state to only A + B; C stays inbox-side.
    await db.insert(outreachThreadState).values([
      {
        workspaceId: s.workspaceA,
        qualifiedLeadId: 9001n,
        threadId: a.threadId!,
        stage: 'discovery',
      },
      {
        workspaceId: s.workspaceA,
        qualifiedLeadId: 9002n,
        threadId: b.threadId!,
        stage: 'engagement',
      },
    ]);

    const outreach = await listThreads(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      kind: 'outreach',
    });
    const inbox = await listThreads(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      kind: 'inbox',
    });
    const all = await listThreads(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      kind: 'all',
    });

    expect(outreach.map((t) => t.id).sort()).toEqual([a.threadId!, b.threadId!].sort());
    expect(inbox.map((t) => t.id)).toEqual([c.threadId!]);
    expect(all).toHaveLength(3);

    const counts = await countThreadsByKind(ctx(s.workspaceA, s.ownerA), mb.id);
    expect(counts).toEqual({ outreach: 2, inbox: 1, all: 3 });
  });

  it('default (no kind) returns all threads — backwards compatible', async () => {
    const s = await setup();
    const mb = await makeMailbox(s, s.workspaceA, s.ownerA);
    const provider = new MockMailProvider();
    await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'x@y.com' }],
      subject: 'no filter',
      text: 'x',
      providerOverride: provider,
    });
    const list = await listThreads(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
    });
    expect(list).toHaveLength(1);
  });

  it('counts scope to workspace + mailbox', async () => {
    const s = await setup();
    const mb1 = await makeMailbox(s, s.workspaceA, s.ownerA, 'mb1');
    const mb2 = await makeMailbox(s, s.workspaceA, s.ownerA, 'mb2');
    const provider = new MockMailProvider();
    await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb1.id,
      to: [{ address: 'x@y.com' }],
      subject: 'in mb1',
      text: 'x',
      providerOverride: provider,
    });
    // mb2 has zero — counts for mb2 should be {0,0,0}.
    const countsMb2 = await countThreadsByKind(ctx(s.workspaceA, s.ownerA), mb2.id);
    expect(countsMb2).toEqual({ outreach: 0, inbox: 0, all: 0 });
  });
});
