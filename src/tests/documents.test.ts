import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { db } from '@/lib/db/client';
import { documents } from '@/lib/db/schema/documents';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  DocumentServiceError,
  archiveDocument,
  getDocument,
  listDocuments,
  restoreDocument,
  streamDocument,
  updateDocument,
  uploadDocument,
} from '@/lib/services/documents';
import {
  createKnowledgeSource,
  deleteKnowledgeSource,
  getKnowledgeSource,
  listKnowledgeSources,
  updateKnowledgeSource,
} from '@/lib/services/knowledge-sources';
import { createProductProfile } from '@/lib/services/product-profile';
import { LocalFileStorage, _setStorageForTests } from '@/lib/storage';
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

let storageRoot: string;
let storage: LocalFileStorage;

beforeEach(async () => {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'lead-storage-test-'));
  storage = new LocalFileStorage(storageRoot);
  _setStorageForTests(storage);
  await truncateAll();
});

afterEach(async () => {
  _setStorageForTests(null);
  await rm(storageRoot, { recursive: true, force: true });
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ============ documents =================================================

describe('uploadDocument', () => {
  it('writes bytes to storage and returns a metadata row', async () => {
    const s = await setup();
    const result = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'pricing.pdf',
      mimeType: 'application/pdf',
      body: Buffer.from('fake-pdf-bytes'),
    });
    expect(result.document.workspaceId).toBe(s.workspaceA);
    expect(result.document.filename).toBe('pricing.pdf');
    expect(result.document.name).toBe('pricing.pdf');
    expect(result.document.mimeType).toBe('application/pdf');
    expect(result.document.sizeBytes).toBe('fake-pdf-bytes'.length);
    expect(result.document.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.document.status).toBe('ready');
    expect(result.document.storageProvider).toBe('local');
    expect(result.url.startsWith('file://')).toBe(true);
    expect(await storage.exists(result.document.storageKey)).toBe(true);
  });

  it('honors a Readable stream input', async () => {
    const s = await setup();
    const result = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'note.txt',
      body: Readable.from(['streamed-', 'content']),
    });
    expect(result.document.sizeBytes).toBe('streamed-content'.length);
  });

  it('rejects empty body', async () => {
    const s = await setup();
    await expect(
      uploadDocument(ctx(s.workspaceA, s.ownerA), {
        filename: 'empty.txt',
        body: Buffer.alloc(0),
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('viewers cannot upload', async () => {
    const s = await setup();
    await expect(
      uploadDocument(ctx(s.workspaceA, s.ownerA, 'viewer'), {
        filename: 'x.txt',
        body: Buffer.from('y'),
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('sanitizes tags (lowercase, dedup, hyphenate)', async () => {
    const s = await setup();
    const result = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'a.txt',
      body: Buffer.from('a'),
      tags: ['Pricing', 'pricing', 'spec sheet', 'SPEC sheet'],
    });
    expect(result.document.tags).toEqual(['pricing', 'spec-sheet']);
  });
});

describe('listDocuments + getDocument + streamDocument', () => {
  it('list returns workspace docs ordered newest-first; archived hidden by default', async () => {
    const s = await setup();
    const a = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'a.txt',
      body: Buffer.from('a'),
    });
    await new Promise((r) => setTimeout(r, 5));
    const b = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'b.txt',
      body: Buffer.from('b'),
    });
    await archiveDocument(ctx(s.workspaceA, s.ownerA), a.document.id);

    const list = await listDocuments(ctx(s.workspaceA, s.ownerA));
    expect(list.map((d) => d.id)).toEqual([b.document.id]);

    const all = await listDocuments(
      ctx(s.workspaceA, s.ownerA),
      { includeArchived: true },
    );
    expect(all.map((d) => d.id).sort()).toEqual([a.document.id, b.document.id].sort());
  });

  it('does not leak across workspaces', async () => {
    const s = await setup();
    const a = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'wsA.txt',
      body: Buffer.from('a'),
    });
    await uploadDocument(ctx(s.workspaceB, s.ownerB), {
      filename: 'wsB.txt',
      body: Buffer.from('b'),
    });

    const onlyA = await listDocuments(ctx(s.workspaceA, s.ownerA));
    expect(onlyA.map((d) => d.id)).toEqual([a.document.id]);

    await expect(
      getDocument(ctx(s.workspaceB, s.ownerB), a.document.id),
    ).rejects.toBeInstanceOf(DocumentServiceError);
  });

  it('streamDocument returns the bytes back', async () => {
    const s = await setup();
    const result = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'plain.txt',
      body: Buffer.from('round-trip'),
    });
    const { stream } = await streamDocument(ctx(s.workspaceA, s.ownerA), result.document.id);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe('round-trip');
  });

  it('streamDocument refuses an archived document', async () => {
    const s = await setup();
    const result = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'plain.txt',
      body: Buffer.from('x'),
    });
    await archiveDocument(ctx(s.workspaceA, s.ownerA), result.document.id);
    await expect(
      streamDocument(ctx(s.workspaceA, s.ownerA), result.document.id),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('document lifecycle', () => {
  it('archive then restore round-trips', async () => {
    const s = await setup();
    const r = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'x.txt',
      body: Buffer.from('x'),
    });
    const archived = await archiveDocument(ctx(s.workspaceA, s.ownerA), r.document.id);
    expect(archived.status).toBe('archived');
    const restored = await restoreDocument(ctx(s.workspaceA, s.ownerA), r.document.id);
    expect(restored.status).toBe('ready');
  });

  it('archive denied for non-admin members', async () => {
    const s = await setup();
    const r = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'x.txt',
      body: Buffer.from('x'),
    });
    await expect(
      archiveDocument(ctx(s.workspaceA, s.ownerA, 'member'), r.document.id),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('updateDocument changes name and tags', async () => {
    const s = await setup();
    const r = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'doc.txt',
      body: Buffer.from('x'),
    });
    const updated = await updateDocument(ctx(s.workspaceA, s.ownerA), r.document.id, {
      name: 'Customer brief — Q3',
      tags: ['brief', 'q3'],
    });
    expect(updated.name).toBe('Customer brief — Q3');
    expect(updated.tags).toEqual(['brief', 'q3']);
  });

  it('updateDocument refuses on archived', async () => {
    const s = await setup();
    const r = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'doc.txt',
      body: Buffer.from('x'),
    });
    await archiveDocument(ctx(s.workspaceA, s.ownerA), r.document.id);
    await expect(
      updateDocument(ctx(s.workspaceA, s.ownerA), r.document.id, { name: 'Y' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

// ============ knowledge sources =========================================

describe('knowledge_sources', () => {
  it('createKnowledgeSource(kind=document) requires a workspace-local document', async () => {
    const s = await setup();
    const docA = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'specs.pdf',
      body: Buffer.from('x'),
    });
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P' });

    const ks = await createKnowledgeSource(ctx(s.workspaceA, s.ownerA), {
      kind: 'document',
      title: 'Product specs',
      documentId: docA.document.id,
      productProfileIds: [product.id],
    });
    expect(ks.kind).toBe('document');
    expect(ks.documentId).toBe(docA.document.id);
    expect(ks.productProfileIds.map((id) => id.toString())).toEqual([
      product.id.toString(),
    ]);

    // Cross-workspace document rejected
    await expect(
      createKnowledgeSource(ctx(s.workspaceB, s.ownerB), {
        kind: 'document',
        title: 'leak',
        documentId: docA.document.id,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('createKnowledgeSource(kind=url) validates the URL shape', async () => {
    const s = await setup();
    const ok = await createKnowledgeSource(ctx(s.workspaceA, s.ownerA), {
      kind: 'url',
      title: 'Industry report',
      url: 'https://example.com/report.pdf',
    });
    expect(ok.url).toBe('https://example.com/report.pdf');

    await expect(
      createKnowledgeSource(ctx(s.workspaceA, s.ownerA), {
        kind: 'url',
        title: 'bad',
        url: 'ftp://example.com',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('createKnowledgeSource(kind=text) requires textExcerpt', async () => {
    const s = await setup();
    await expect(
      createKnowledgeSource(ctx(s.workspaceA, s.ownerA), {
        kind: 'text',
        title: 'snippet',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    const ok = await createKnowledgeSource(ctx(s.workspaceA, s.ownerA), {
      kind: 'text',
      title: 'snippet',
      textExcerpt: 'A short, useful piece of context.',
    });
    expect(ok.textExcerpt).toContain('useful piece');
  });

  it('list filters by product attachment', async () => {
    const s = await setup();
    const p1 = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P1' });
    const p2 = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P2' });

    await createKnowledgeSource(ctx(s.workspaceA, s.ownerA), {
      kind: 'url',
      title: 'For P1',
      url: 'https://x.com/1',
      productProfileIds: [p1.id],
    });
    await createKnowledgeSource(ctx(s.workspaceA, s.ownerA), {
      kind: 'url',
      title: 'For P2',
      url: 'https://x.com/2',
      productProfileIds: [p2.id],
    });
    await createKnowledgeSource(ctx(s.workspaceA, s.ownerA), {
      kind: 'url',
      title: 'For both',
      url: 'https://x.com/3',
      productProfileIds: [p1.id, p2.id],
    });

    const onlyP1 = await listKnowledgeSources(
      ctx(s.workspaceA, s.ownerA),
      { productProfileId: p1.id },
    );
    expect(onlyP1.map((r) => r.source.title).sort()).toEqual(['For P1', 'For both']);
  });

  it('updateKnowledgeSource enforces kind on field changes', async () => {
    const s = await setup();
    const ks = await createKnowledgeSource(ctx(s.workspaceA, s.ownerA), {
      kind: 'url',
      title: 'X',
      url: 'https://x.com',
    });
    // setting textExcerpt on a url source is invalid
    await expect(
      updateKnowledgeSource(ctx(s.workspaceA, s.ownerA), ks.id, {
        textExcerpt: 'nope',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    const updated = await updateKnowledgeSource(ctx(s.workspaceA, s.ownerA), ks.id, {
      url: 'https://x.com/v2',
      title: 'X v2',
    });
    expect(updated.url).toBe('https://x.com/v2');
    expect(updated.title).toBe('X v2');
  });

  it('getKnowledgeSource includes attached products', async () => {
    const s = await setup();
    const p = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P' });
    const ks = await createKnowledgeSource(ctx(s.workspaceA, s.ownerA), {
      kind: 'url',
      title: 'X',
      url: 'https://x.com',
      productProfileIds: [p.id],
    });
    const got = await getKnowledgeSource(ctx(s.workspaceA, s.ownerA), ks.id);
    expect(got.products.map((pp) => pp.name)).toEqual(['P']);
  });

  it('deleteKnowledgeSource is admin-only and removes the row', async () => {
    const s = await setup();
    const ks = await createKnowledgeSource(ctx(s.workspaceA, s.ownerA), {
      kind: 'url',
      title: 'X',
      url: 'https://x.com',
    });
    await expect(
      deleteKnowledgeSource(ctx(s.workspaceA, s.ownerA, 'member'), ks.id),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    await deleteKnowledgeSource(ctx(s.workspaceA, s.ownerA), ks.id);
    await expect(
      getKnowledgeSource(ctx(s.workspaceA, s.ownerA), ks.id),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('cross-workspace knowledge sources do not leak', async () => {
    const s = await setup();
    const ks = await createKnowledgeSource(ctx(s.workspaceA, s.ownerA), {
      kind: 'url',
      title: 'A only',
      url: 'https://x.com',
    });
    const listB = await listKnowledgeSources(ctx(s.workspaceB, s.ownerB));
    expect(listB).toHaveLength(0);
    await expect(
      getKnowledgeSource(ctx(s.workspaceB, s.ownerB), ks.id),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

// ---- isolation: documents physically deleted from storage on archive? ---

describe('archive does not delete bytes (audit-friendly)', () => {
  it('storage object remains after archive — only the row toggles', async () => {
    const s = await setup();
    const r = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'kept.txt',
      body: Buffer.from('keep me'),
    });
    expect(await storage.exists(r.document.storageKey)).toBe(true);
    await archiveDocument(ctx(s.workspaceA, s.ownerA), r.document.id);
    expect(await storage.exists(r.document.storageKey)).toBe(true); // still there
    const reloaded = await db
      .select()
      .from(documents)
      .where(eq(documents.id, r.document.id));
    expect(reloaded[0]!.status).toBe('archived');
  });
});
