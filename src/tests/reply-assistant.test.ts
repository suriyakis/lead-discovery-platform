import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { db } from '@/lib/db/client';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  ReplyAssistantError,
  suggestReply,
} from '@/lib/services/reply-assistant';
import { createMailbox } from '@/lib/services/mailbox';
import { syncInbound } from '@/lib/services/mail';
import { uploadDocument } from '@/lib/services/documents';
import { indexDocument } from '@/lib/services/rag';
import {
  MockEmbeddingProvider,
  _setEmbeddingProviderForTests,
} from '@/lib/embeddings';
import {
  MockMailProvider,
  type InboundMessage,
} from '@/lib/mail';
import { _setAIProviderForTests, type IAIProvider } from '@/lib/ai';
import { LocalFileStorage, _setStorageForTests } from '@/lib/storage';
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

function ctx(workspaceId: bigint, userId: string, role: WorkspaceContext['role'] = 'owner'): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

let storageRoot: string;

beforeEach(async () => {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'lead-reply-'));
  _setStorageForTests(new LocalFileStorage(storageRoot));
  _setEmbeddingProviderForTests(new MockEmbeddingProvider());
  _setAIProviderForTests(null);
  await truncateAll();
});

afterEach(async () => {
  _setStorageForTests(null);
  _setEmbeddingProviderForTests(null);
  _setAIProviderForTests(null);
  await rm(storageRoot, { recursive: true, force: true });
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

const stubAi: IAIProvider = {
  id: 'stub',
  async generateText(input) {
    // Echo the prompt back so tests can assert what was sent.
    return {
      text: `STUB-REPLY [chunks=${(input.prompt.match(/<chunk /g) ?? []).length}]`,
      model: 'stub-1',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  },
  async generateJson() { throw new Error('not used'); },
  estimateCost() { return 0; },
  async healthCheck() { return { ok: true }; },
};

describe('suggestReply', () => {
  async function setupThread(s: Setup, indexedDocText?: string) {
    const mb = await createMailbox(ctx(s.workspaceA, s.ownerA), {
      name: 'sales',
      fromAddress: 'sales@nulife.pl',
      smtpHost: 'smtp.example.com',
      smtpUser: 'sales@nulife.pl',
      smtpPassword: 'pw',
      imap: {
        host: 'imap.example.com',
        user: 'sales@nulife.pl',
        password: 'pw',
      },
    });
    const provider = new MockMailProvider();
    const inbound: InboundMessage = {
      uid: 1,
      messageId: '<inquiry-1@target.com>',
      inReplyTo: null,
      references: [],
      from: { address: 'lead@target.com', name: 'Lead' },
      to: [{ address: mb.fromAddress }],
      cc: [],
      subject: 'Acoustic glass for office tower',
      textBody: 'We are evaluating acoustic curtain wall systems. What R-values can you offer?',
      htmlBody: null,
      receivedAt: new Date(),
      headers: {},
      attachments: [],
    };
    provider.enqueueInbound(inbound);
    await syncInbound(ctx(s.workspaceA, s.ownerA), mb.id, provider);

    const messages = await db.execute(
      `select id, thread_id from mail_messages where workspace_id = ${s.workspaceA} order by id` as unknown as never,
    );
    void messages;

    if (indexedDocText) {
      const { document } = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
        filename: 'spec.txt',
        mimeType: 'text/plain',
        body: Buffer.from(indexedDocText),
      });
      await indexDocument(ctx(s.workspaceA, s.ownerA), document.id);
    }

    const threadRows = await db.query.mailThreads.findMany({
      where: (t, { eq }) => eq(t.workspaceId, s.workspaceA),
    });
    return { mb, threadId: threadRows[0]!.id };
  }

  it('drafts a reply using retrieved chunks', async () => {
    const s = await setup();
    const { threadId } = await setupThread(
      s,
      'Acoustic curtain wall systems achieve up to R-45 with our standard 12mm panel.',
    );
    const result = await suggestReply(ctx(s.workspaceA, s.ownerA), {
      threadId,
      ai: stubAi,
    });
    expect(result.text).toContain('STUB-REPLY');
    expect(result.text).toContain('chunks='); // confirms prompt included chunks block
    expect(result.sources.chunkIds.length).toBeGreaterThan(0);
    expect(result.model).toBe('stub-1');
  });

  it('drafts a reply even with no indexed knowledge', async () => {
    const s = await setup();
    const { threadId } = await setupThread(s);
    const result = await suggestReply(ctx(s.workspaceA, s.ownerA), {
      threadId,
      ai: stubAi,
    });
    expect(result.text).toContain('STUB-REPLY');
    expect(result.sources.chunkIds).toEqual([]);
  });

  it('viewer denied', async () => {
    const s = await setup();
    const { threadId } = await setupThread(s);
    await expect(
      suggestReply(ctx(s.workspaceA, s.ownerA, 'viewer'), {
        threadId,
        ai: stubAi,
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('rejects unknown thread', async () => {
    const s = await setup();
    await expect(
      suggestReply(ctx(s.workspaceA, s.ownerA), { threadId: 999999n, ai: stubAi }),
    ).rejects.toBeInstanceOf(ReplyAssistantError);
  });
});
