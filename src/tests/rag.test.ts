import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { db } from '@/lib/db/client';
import { documentChunks, indexingJobs } from '@/lib/db/schema/rag';
import { learningLessons } from '@/lib/db/schema/learning';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { uploadDocument } from '@/lib/services/documents';
import {
  createKnowledgeSource,
} from '@/lib/services/knowledge-sources';
import { createProductProfile } from '@/lib/services/product-profile';
import { createLesson } from '@/lib/services/learning';
import {
  RagServiceError,
  chunkText,
  embedAllLessons,
  embedLesson,
  indexDocument,
  indexKnowledgeSource,
  listChunksForDocument,
  listIndexingJobs,
  retrieve,
  retrieveLessons,
} from '@/lib/services/rag';
import {
  MockEmbeddingProvider,
  _setEmbeddingProviderForTests,
  cosineSimilarity,
  EMBEDDING_DIM,
} from '@/lib/embeddings';
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
const embedder = new MockEmbeddingProvider();

beforeEach(async () => {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'lead-rag-test-'));
  storage = new LocalFileStorage(storageRoot);
  _setStorageForTests(storage);
  _setEmbeddingProviderForTests(embedder);
  await truncateAll();
});

afterEach(async () => {
  _setStorageForTests(null);
  _setEmbeddingProviderForTests(null);
  await rm(storageRoot, { recursive: true, force: true });
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ============ chunkText ===========================================

describe('chunkText (pure)', () => {
  it('returns one chunk for short input', () => {
    const chunks = chunkText('Hello world. Short doc.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.startChar).toBe(0);
    expect(chunks[0]!.content).toBe('Hello world. Short doc.');
  });

  it('splits long text with char-target overlaps', () => {
    const long = 'A'.repeat(5000);
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk runs longer than the target.
    for (const c of chunks) {
      expect(c.endChar - c.startChar).toBeLessThanOrEqual(2001);
    }
    // Adjacent chunks overlap (start of next < end of previous).
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startChar).toBeLessThan(chunks[i - 1]!.endChar);
    }
  });

  it('skips empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });
});

// ============ deterministic embedder properties =================

describe('MockEmbeddingProvider', () => {
  it('returns 1536-dim unit vectors', async () => {
    const r = await embedder.embed({ texts: ['hello world'] });
    expect(r.embeddings).toHaveLength(1);
    expect(r.embeddings[0]!).toHaveLength(EMBEDDING_DIM);
    const norm = Math.sqrt(r.embeddings[0]!.reduce((a, x) => a + x * x, 0));
    expect(norm).toBeGreaterThan(0.99);
    expect(norm).toBeLessThan(1.01);
  });

  it('same input -> same vector; different input -> different', async () => {
    const r1 = await embedder.embed({ texts: ['one', 'two', 'one'] });
    const cosSame = cosineSimilarity(r1.embeddings[0]!, r1.embeddings[2]!);
    const cosDiff = cosineSimilarity(r1.embeddings[0]!, r1.embeddings[1]!);
    expect(cosSame).toBeCloseTo(1, 6);
    expect(Math.abs(cosDiff)).toBeLessThan(0.5); // very different
  });
});

// ============ index documents =====================================

describe('indexDocument', () => {
  it('chunks + embeds + persists', async () => {
    const s = await setup();
    const { document } = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'spec.txt',
      mimeType: 'text/plain',
      body: Buffer.from(
        'This is a spec. It has multiple sentences. ' +
          'We will discuss acoustic glass. The product name is X. ' +
          'Always remember to mention curtain walls when relevant.',
      ),
    });
    const result = await indexDocument(ctx(s.workspaceA, s.ownerA), document.id);
    expect(result.chunkCount).toBeGreaterThan(0);
    expect(result.job.status).toBe('succeeded');

    const chunks = await listChunksForDocument(ctx(s.workspaceA, s.ownerA), document.id);
    expect(chunks.length).toBe(result.chunkCount);
    expect(chunks[0]!.embedding).not.toBeNull();
    expect(chunks[0]!.embeddingDim).toBe(EMBEDDING_DIM);
    expect(chunks[0]!.embeddingModel).toBe('mock-embed-1');
    expect(chunks[0]!.embeddedAt).toBeInstanceOf(Date);
  });

  it('re-indexing replaces prior chunks', async () => {
    const s = await setup();
    const { document } = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'spec.txt',
      mimeType: 'text/plain',
      body: Buffer.from('original content here'),
    });
    await indexDocument(ctx(s.workspaceA, s.ownerA), document.id);
    const firstCount = (
      await listChunksForDocument(ctx(s.workspaceA, s.ownerA), document.id)
    ).length;

    await indexDocument(ctx(s.workspaceA, s.ownerA), document.id);
    const secondCount = (
      await listChunksForDocument(ctx(s.workspaceA, s.ownerA), document.id)
    ).length;
    expect(secondCount).toBe(firstCount); // stable for the same content
    // Job log should have two rows.
    const jobs = await listIndexingJobs(
      ctx(s.workspaceA, s.ownerA),
      { documentId: document.id },
    );
    expect(jobs.length).toBe(2);
  });

  it('refuses an unknown mime type', async () => {
    const s = await setup();
    const { document } = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'binary.bin',
      mimeType: 'application/octet-stream',
      // Buffer dominated by non-printable bytes -> looksLikeText false.
      body: Buffer.from([0x00, 0xff, 0x01, 0x80, 0x02, 0xfe, 0x03, 0x7f, 0xc1, 0xa0]),
    });
    await expect(
      indexDocument(ctx(s.workspaceA, s.ownerA), document.id),
    ).rejects.toBeInstanceOf(RagServiceError);

    // Job should be marked failed.
    const jobs = await listIndexingJobs(
      ctx(s.workspaceA, s.ownerA),
      { documentId: document.id },
    );
    expect(jobs[0]!.status).toBe('failed');
    expect(jobs[0]!.error).toBeTruthy();
  });

  it('viewer-denied', async () => {
    const s = await setup();
    const { document } = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'a.txt',
      body: Buffer.from('x'),
    });
    await expect(
      indexDocument(ctx(s.workspaceA, s.ownerA, 'viewer'), document.id),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('cross-workspace document refused (not_found)', async () => {
    const s = await setup();
    const { document } = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'a.txt',
      body: Buffer.from('hello'),
    });
    await expect(
      indexDocument(ctx(s.workspaceB, s.ownerB), document.id),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('indexKnowledgeSource', () => {
  it('indexes a kind=text source', async () => {
    const s = await setup();
    const ks = await createKnowledgeSource(ctx(s.workspaceA, s.ownerA), {
      kind: 'text',
      title: 'Tone guide',
      textExcerpt: 'Be concise. Avoid superlatives. Reference local case studies.',
    });
    const result = await indexKnowledgeSource(ctx(s.workspaceA, s.ownerA), ks.id);
    expect(result.chunkCount).toBeGreaterThan(0);
    const allChunks = await db
      .select()
      .from(documentChunks)
      .where(eq(documentChunks.workspaceId, s.workspaceA));
    expect(allChunks.every((c) => c.knowledgeSourceId === ks.id)).toBe(true);
  });

  it('indexes a kind=url source via title + summary + url serialization', async () => {
    const s = await setup();
    const ks = await createKnowledgeSource(ctx(s.workspaceA, s.ownerA), {
      kind: 'url',
      title: 'Industry overview',
      summary: 'Useful link about cross-border logistics in 2026.',
      url: 'https://example.com/report',
    });
    const result = await indexKnowledgeSource(ctx(s.workspaceA, s.ownerA), ks.id);
    expect(result.chunkCount).toBeGreaterThanOrEqual(1);
  });
});

// ============ retrieve ============================================

describe('retrieve', () => {
  it('returns top-k by cosine similarity, scoped to workspace', async () => {
    const s = await setup();
    // Upload 3 docs with progressively different content.
    const { document: a } = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'a.txt',
      body: Buffer.from('Acoustic glass for office towers. Curtain wall systems.'),
    });
    const { document: b } = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'b.txt',
      body: Buffer.from('Internal partitioning systems for corporate offices.'),
    });
    const { document: c } = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'c.txt',
      body: Buffer.from('Recipes for vegan lasagna. Completely unrelated content.'),
    });
    await indexDocument(ctx(s.workspaceA, s.ownerA), a.id);
    await indexDocument(ctx(s.workspaceA, s.ownerA), b.id);
    await indexDocument(ctx(s.workspaceA, s.ownerA), c.id);

    const top = await retrieve(
      ctx(s.workspaceA, s.ownerA),
      'Acoustic glass for office towers. Curtain wall systems.',
      { limit: 5 },
    );
    expect(top.length).toBeGreaterThan(0);
    // Order asserts: chunks from doc A should be before chunks from doc C.
    const docIds = top.map((r) => r.chunk.documentId?.toString());
    expect(docIds[0]).toBe(a.id.toString());
    // Similarity in [-1, 1]; top result should be very high (mock is
    // deterministic so the exact-match query returns ~cos=1).
    expect(top[0]!.similarity).toBeGreaterThan(0.99);

    // Workspace B sees nothing for the same query.
    const inB = await retrieve(ctx(s.workspaceB, s.ownerB), 'Acoustic glass', { limit: 5 });
    expect(inB).toEqual([]);
  });

  it('returns [] for empty query', async () => {
    const s = await setup();
    const out = await retrieve(ctx(s.workspaceA, s.ownerA), '   ');
    expect(out).toEqual([]);
  });

  it('product filter narrows knowledge-source-attached results', async () => {
    const s = await setup();
    const p1 = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P1' });
    const p2 = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P2' });
    const ks1 = await createKnowledgeSource(ctx(s.workspaceA, s.ownerA), {
      kind: 'text',
      title: 'P1 doc',
      textExcerpt: 'Acoustic glass for office towers.',
      productProfileIds: [p1.id],
    });
    const ks2 = await createKnowledgeSource(ctx(s.workspaceA, s.ownerA), {
      kind: 'text',
      title: 'P2 doc',
      textExcerpt: 'Acoustic glass for office towers.',
      productProfileIds: [p2.id],
    });
    await indexKnowledgeSource(ctx(s.workspaceA, s.ownerA), ks1.id);
    await indexKnowledgeSource(ctx(s.workspaceA, s.ownerA), ks2.id);

    const onlyP1 = await retrieve(ctx(s.workspaceA, s.ownerA), 'acoustic glass', {
      limit: 10,
      productProfileId: p1.id,
    });
    const ksIds = new Set(onlyP1.map((r) => r.chunk.knowledgeSourceId?.toString()));
    expect(ksIds.has(ks1.id.toString())).toBe(true);
    expect(ksIds.has(ks2.id.toString())).toBe(false);
  });
});

// ============ lesson embeddings ===================================

describe('embed lessons + retrieveLessons', () => {
  it('embedAllLessons populates embedding columns', async () => {
    const s = await setup();
    await createLesson(ctx(s.workspaceA, s.ownerA), {
      category: 'outreach_style',
      rule: 'Reference cross-border logistics expertise when relevant.',
    });
    await createLesson(ctx(s.workspaceA, s.ownerA), {
      category: 'qualification_negative',
      rule: 'Skip residential apartment work.',
    });
    const result = await embedAllLessons(ctx(s.workspaceA, s.ownerA));
    expect(result.embedded).toBe(2);
    const rows = await db
      .select()
      .from(learningLessons)
      .where(eq(learningLessons.workspaceId, s.workspaceA));
    for (const r of rows) {
      expect(r.embedding).not.toBeNull();
      expect(r.embeddingModel).toBe('mock-embed-1');
      expect(r.embeddedAt).toBeInstanceOf(Date);
    }
  });

  it('retrieveLessons orders by similarity', async () => {
    const s = await setup();
    const targetRule = 'Reference cross-border logistics expertise.';
    const target = await createLesson(ctx(s.workspaceA, s.ownerA), {
      category: 'outreach_style',
      rule: targetRule,
    });
    await createLesson(ctx(s.workspaceA, s.ownerA), {
      category: 'qualification_negative',
      rule: 'Avoid residential apartment refurb.',
    });
    await embedAllLessons(ctx(s.workspaceA, s.ownerA));

    const top = await retrieveLessons(ctx(s.workspaceA, s.ownerA), targetRule, { limit: 5 });
    expect(top[0]!.lesson.id).toBe(target.id);
    expect(top[0]!.similarity).toBeGreaterThan(0.99);
  });

  it('embedLesson does single-row update', async () => {
    const s = await setup();
    const lesson = await createLesson(ctx(s.workspaceA, s.ownerA), {
      category: 'outreach_style',
      rule: 'Be concise.',
    });
    const updated = await embedLesson(ctx(s.workspaceA, s.ownerA), lesson.id);
    expect(updated.embedding).not.toBeNull();
    expect(updated.embeddingModel).toBe('mock-embed-1');
  });
});

// ============ jobs / isolation ====================================

describe('isolation + jobs', () => {
  it('chunks and indexing_jobs scope strictly to workspace', async () => {
    const s = await setup();
    const { document: a } = await uploadDocument(ctx(s.workspaceA, s.ownerA), {
      filename: 'a.txt',
      body: Buffer.from('content for A'),
    });
    const { document: b } = await uploadDocument(ctx(s.workspaceB, s.ownerB), {
      filename: 'b.txt',
      body: Buffer.from('content for B'),
    });
    await indexDocument(ctx(s.workspaceA, s.ownerA), a.id);
    await indexDocument(ctx(s.workspaceB, s.ownerB), b.id);

    const allChunks = await db.select().from(documentChunks);
    for (const c of allChunks) {
      const expectedWs =
        c.documentId?.toString() === a.id.toString() ? s.workspaceA : s.workspaceB;
      expect(c.workspaceId).toBe(expectedWs);
    }

    const jobsA = await db
      .select()
      .from(indexingJobs)
      .where(eq(indexingJobs.workspaceId, s.workspaceA));
    expect(jobsA.every((j) => j.workspaceId === s.workspaceA)).toBe(true);
  });
});
