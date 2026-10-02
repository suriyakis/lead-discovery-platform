// KL-05 (I039, I101, I104, I109): knowledge scope and chunk ownership.
// Every chunk belongs to exactly one knowledge source; one predicate
// (knowledge-scope.ts) decides, for retrieve(), the product coverage,
// Suggest reply and the pgvector provider query, whether a chunk may reach
// a prompt. Acceptance 1-4 and 6 below; 5 (migration + rollback) is
// knowledge-scope-migration.test.ts.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db/client';
import { contactAssociations, contacts } from '@/lib/db/schema/contacts';
import { sourceRecords } from '@/lib/db/schema/connectors';
import { knowledgeSourceProducts, knowledgeSources } from '@/lib/db/schema/documents';
import { mailboxes, mailMessages, mailThreads } from '@/lib/db/schema/mailing';
import { outreachThreadState } from '@/lib/db/schema/outreach';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { documentChunks, indexingJobs } from '@/lib/db/schema/rag';
import { reviewItems } from '@/lib/db/schema/review';
import { _setAIProviderForTests, type IAIProvider } from '@/lib/ai';
import { MockEmbeddingProvider, _setEmbeddingProviderForTests } from '@/lib/embeddings';
import { LocalFileStorage, _setStorageForTests } from '@/lib/storage';
import {
  MockVectorStorageProvider,
  _setVectorStorageProviderForTests,
} from '@/lib/vector-storage';
import { PgvectorVectorStorageProvider } from '@/lib/vector-storage/pgvector';
import { makeWorkspaceContext, type WorkspaceContext } from '@/lib/services/context';
import { archiveDocument, restoreDocument, uploadDocument } from '@/lib/services/documents';
import {
  NO_PRODUCT_TICKED_COPY,
  knowledgeScopeFromTicks,
} from '@/lib/services/knowledge-scope';
import {
  attachKnowledgeSourceViaProvider,
  createKnowledgeSource,
  getKnowledgeSource,
  listDocumentSources,
  listKnowledgeSources,
  updateKnowledgeSource,
  type CreateKnowledgeSourceInput,
} from '@/lib/services/knowledge-sources';
import { getProductKnowledgeCoverage } from '@/lib/services/outreach-knowledge';
import { createProductProfile, deleteProductProfile } from '@/lib/services/product-profile';
import {
  indexDocument,
  indexKnowledgeSource,
  listChunksForDocument,
  listIndexingJobs,
  retrieve,
} from '@/lib/services/rag';
import { resolveThreadProduct, suggestReply } from '@/lib/services/reply-assistant';
import DocumentsPage from '@/app/documents/page';
import DocumentDetail from '@/app/documents/[id]/page';
import KnowledgeSourceDetail from '@/app/knowledge/[id]/page';
import NewKnowledgeSourcePage from '@/app/knowledge/new/page';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { runQueuedIndexJobs } from './helpers/knowledge';
import { expectRedirect, renderToHtml } from './helpers/next-render';

const session = vi.hoisted(() => ({
  current: null as null | {
    user: { id: string; role: 'member'; accountStatus: 'active' };
  },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => children,
}));

interface Setup {
  a: WorkspaceContext;
  b: WorkspaceContext;
  pA: bigint;
  pB: bigint;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'kl05-a@test.local' });
  const ownerB = await seedUser({ email: 'kl05-b@test.local' });
  const wsA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  const wsB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  session.current = { user: { id: ownerA, role: 'member', accountStatus: 'active' } };
  const a = makeWorkspaceContext({ workspaceId: wsA, userId: ownerA, role: 'owner' });
  const b = makeWorkspaceContext({ workspaceId: wsB, userId: ownerB, role: 'owner' });
  const pA = (await createProductProfile(a, { name: 'Aerogel blanket' })).id;
  const pB = (await createProductProfile(a, { name: 'Fire sealant' })).id;
  return { a, b, pA, pB };
}

/** ~3 chunks of distinct text. */
function longText(topic: string): string {
  return Array.from(
    { length: 60 },
    (_, i) => `${topic} fact number ${i}: the ${topic} datasheet lists value ${i * 7}. `,
  ).join('');
}

const QUERY = 'datasheet value';

async function upload(c: WorkspaceContext, filename: string, text: string) {
  const r = await uploadDocument(c, {
    filename,
    mimeType: 'text/plain',
    body: Buffer.from(text),
  });
  return r.document;
}

async function textSource(
  c: WorkspaceContext,
  title: string,
  scope: CreateKnowledgeSourceInput['scope'],
): Promise<bigint> {
  const ks = await createKnowledgeSource(c, {
    kind: 'text',
    title,
    textExcerpt: longText(title),
    scope,
  });
  await indexKnowledgeSource(c, ks.id);
  return ks.id;
}

const products = (...ids: bigint[]) => ({ kind: 'products' as const, productProfileIds: ids });
const WORKSPACE = { kind: 'workspace' as const };

async function sourceIdsFor(c: WorkspaceContext, productProfileId?: bigint): Promise<string[]> {
  const rows = await retrieve(c, QUERY, { productProfileId, limit: 100 });
  return [...new Set(rows.map((r) => r.knowledgeSource.id.toString()))].sort();
}

async function chunkIdsOf(sourceId: bigint): Promise<string[]> {
  const rows = await db
    .select({ id: documentChunks.id })
    .from(documentChunks)
    .where(eq(documentChunks.knowledgeSourceId, sourceId));
  return rows.map((r) => r.id.toString()).sort();
}

/** Every <form action={fn}> in a server-component tree, in document order. */
function formActions(node: ReactNode): Array<(fd: FormData) => Promise<void>> {
  const out: Array<(fd: FormData) => Promise<void>> = [];
  const visit = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (!isValidElement(n)) return;
    const el = n as ReactElement<{ action?: unknown; children?: ReactNode }>;
    if (el.type === 'form' && typeof el.props.action === 'function') {
      out.push(el.props.action as (fd: FormData) => Promise<void>);
    }
    visit(el.props.children);
  };
  visit(node);
  return out;
}

let storageRoot: string;

beforeEach(async () => {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'kl05-scope-'));
  _setStorageForTests(new LocalFileStorage(storageRoot));
  _setEmbeddingProviderForTests(new MockEmbeddingProvider());
  _setVectorStorageProviderForTests(new MockVectorStorageProvider());
  _setAIProviderForTests(null);
  session.current = null;
  await truncateAll();
});

afterEach(async () => {
  _setStorageForTests(null);
  _setEmbeddingProviderForTests(null);
  _setVectorStorageProviderForTests(null);
  _setAIProviderForTests(null);
  await rm(storageRoot, { recursive: true, force: true });
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('acceptance 1 — re-indexing a product-A document from the document page', () => {
  it('B retrieves none of its chunks, A gets every passage once, and the page lists the source jobs', async () => {
    const s = await setup();
    const doc = await upload(s.a, 'ag10-datasheet.txt', longText('aerogel'));
    const ks = await createKnowledgeSource(s.a, {
      kind: 'document',
      title: 'AG10 datasheet',
      documentId: doc.id,
      scope: products(s.pA),
    });
    await indexKnowledgeSource(s.a, ks.id);
    const before = await listChunksForDocument(s.a, doc.id);
    expect(before.length).toBeGreaterThan(1);

    // The document page's button: index THIS document's sources, in place.
    const res = await indexDocument(s.a, doc.id);
    expect(res.createdSourceId).toBeNull();
    expect(res.sources.map((r) => r.knowledgeSourceId)).toEqual([ks.id]);

    const all = await db
      .select()
      .from(documentChunks)
      .where(eq(documentChunks.workspaceId, s.a.workspaceId));
    expect(all).toHaveLength(before.length); // replaced, not duplicated
    expect(all.every((c) => c.knowledgeSourceId === ks.id && c.documentId === null)).toBe(true);

    expect(await sourceIdsFor(s.a, s.pB)).toEqual([]);
    const forA = await retrieve(s.a, QUERY, { productProfileId: s.pA, limit: 100 });
    expect(forA).toHaveLength(before.length);
    expect(new Set(forA.map((r) => r.chunk.content)).size).toBe(forA.length);
    expect(forA.every((r) => r.document?.id === doc.id)).toBe(true);

    // The pgvector provider query (engagement / pitch drafts) uses the same predicate.
    const provider = new PgvectorVectorStorageProvider();
    expect(
      (await provider.query(s.a, s.pB, QUERY, { topK: 50, minSimilarity: -1 })).chunks,
    ).toEqual([]);
    const providerA = await provider.query(s.a, s.pA, QUERY, { topK: 50, minSimilarity: -1 });
    expect(providerA.chunks).toHaveLength(before.length);
    expect(providerA.chunks.every((c) => c.knowledgeSourceId === ks.id)).toBe(true);
    expect(providerA.chunks[0]!.citationFilename).toBe('ag10-datasheet.txt');

    // The document page lists the source's jobs and offers Re-index.
    const jobs = await listIndexingJobs(s.a, { documentId: doc.id });
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.knowledgeSourceId === ks.id && j.status === 'succeeded')).toBe(true);
    const tree = await DocumentDetail({
      params: Promise.resolve({ id: doc.id.toString() }),
      searchParams: Promise.resolve({}),
    });
    const html = await renderToHtml(tree);
    expect(html).toContain('Re-index');
    expect(html).not.toContain('Index for every product');
    expect(html).toContain('Aerogel blanket'); // the source's scope chip
    expect((html.match(/<strong>succeeded<\/strong>/g) ?? []).length).toBe(2);

    // Clicking it re-indexes in place, scope untouched. KL-06: the click
    // queues the run; the knowledge.index job does it.
    // Forms in order: edit, re-index, archive (admin).
    const [, reindex] = formActions(tree);
    const target = await expectRedirect(() => reindex!(new FormData()));
    expect(decodeURIComponent(target)).toContain('Re-indexing queued');
    await runQueuedIndexJobs(s.a);
    expect(await sourceIdsFor(s.a, s.pB)).toEqual([]);
    expect(
      await db.select().from(documentChunks).where(eq(documentChunks.workspaceId, s.a.workspaceId)),
    ).toHaveLength(before.length);
  });

  it('a document with no source is indexed through ONE explicit workspace-wide source', async () => {
    const s = await setup();
    const doc = await upload(s.a, 'faq.txt', longText('faq'));
    const res = await indexDocument(s.a, doc.id);
    expect(res.createdSourceId).not.toBeNull();
    const [row] = await listDocumentSources(s.a, doc.id);
    expect(row!.source.id).toBe(res.createdSourceId);
    expect(row!.scope).toMatchObject({ kind: 'workspace', needsScope: false });
    expect(row!.source.title).toBe('faq.txt');
    // Indexed means indexed: no "pending" on a workspace-wide source (I104).
    expect(row!.source.externalStatus).toBe('indexed');
    expect(row!.source.externalProviderId).toBe('pgvector');
    // Re-indexing again reuses it.
    const again = await indexDocument(s.a, doc.id);
    expect(again.createdSourceId).toBeNull();
    expect(await listDocumentSources(s.a, doc.id)).toHaveLength(1);
    expect(await sourceIdsFor(s.a, s.pB)).toEqual([res.createdSourceId!.toString()]);
    // "Index now" on the source page works for a workspace-wide source
    // instead of refusing it for having no product (I104).
    const attached = await attachKnowledgeSourceViaProvider(s.a, res.createdSourceId!);
    expect(attached.externalStatus).toBe('indexed');
    expect(await listDocumentSources(s.a, doc.id)).toHaveLength(1);
  });
});

describe('acceptance 2 — an unscoped upload later attached to product A', () => {
  it('B sees nothing once attached, with no re-index; a second copy cannot be made', async () => {
    const s = await setup();
    // Upload through the /documents form with no product ticked.
    const page = await DocumentsPage({ searchParams: Promise.resolve({}) });
    const html = await renderToHtml(page);
    expect(html).toContain(NO_PRODUCT_TICKED_COPY);
    const [uploadAction] = formActions(page);
    const fd = new FormData();
    fd.append('file', new File([longText('acoustic')], 'acoustic.txt', { type: 'text/plain' }));
    const target = await expectRedirect(() => uploadAction!(fd));
    expect(decodeURIComponent(target)).toContain(
      'available to every product. Indexing in the background',
    );
    await runQueuedIndexJobs(s.a); // KL-06: the knowledge.index job
    const docId = BigInt(/\/documents\/(\d+)/.exec(target)![1]!);

    const [src] = await listDocumentSources(s.a, docId);
    expect(src!.scope.kind).toBe('workspace');
    expect(await sourceIdsFor(s.a, s.pB)).toEqual([src!.source.id.toString()]);
    const chunkIds = await chunkIdsOf(src!.source.id);

    // Attach it to A on its knowledge source.
    await updateKnowledgeSource(s.a, src!.source.id, { scope: products(s.pA) });
    expect(await sourceIdsFor(s.a, s.pB)).toEqual([]);
    expect(await sourceIdsFor(s.a, s.pA)).toEqual([src!.source.id.toString()]);
    expect(await chunkIdsOf(src!.source.id)).toEqual(chunkIds); // no re-index

    // /knowledge/new cannot add a second (e.g. workspace-wide) copy.
    await expect(
      createKnowledgeSource(s.a, {
        kind: 'document',
        title: 'again',
        documentId: docId,
        scope: WORKSPACE,
      }),
    ).rejects.toMatchObject({ code: 'document_has_source', existingSourceId: src!.source.id });
    const newPage = await NewKnowledgeSourcePage({ searchParams: Promise.resolve({}) });
    const [create] = formActions(newPage);
    const createFd = new FormData();
    for (const [k, v] of Object.entries({ kind: 'document', title: 'again', documentId: docId.toString() })) {
      createFd.append(k, v);
    }
    const redirectTo = await expectRedirect(() => create!(createFd));
    expect(redirectTo.startsWith(`/knowledge/${src!.source.id}?error=`)).toBe(true);
    expect(await sourceIdsFor(s.a, s.pB)).toEqual([]);
  });

  it('an upload with products ticked creates one source scoped to them', async () => {
    const s = await setup();
    const page = await DocumentsPage({ searchParams: Promise.resolve({}) });
    const [uploadAction] = formActions(page);
    const fd = new FormData();
    fd.append('file', new File([longText('sealant')], 'sealant.txt', { type: 'text/plain' }));
    fd.append('productProfileIds', s.pB.toString());
    const target = await expectRedirect(() => uploadAction!(fd));
    expect(decodeURIComponent(target)).toContain(
      'attached to 1 product. Indexing in the background',
    );
    await runQueuedIndexJobs(s.a); // KL-06: the knowledge.index job
    const docId = BigInt(/\/documents\/(\d+)/.exec(target)![1]!);
    const rows = await listDocumentSources(s.a, docId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scope).toMatchObject({ kind: 'products', productProfileIds: [s.pB] });
    expect(await sourceIdsFor(s.a, s.pA)).toEqual([]);
    expect(await sourceIdsFor(s.a, s.pB)).toEqual([rows[0]!.source.id.toString()]);
  });
});

describe('acceptance 3 — archived documents', () => {
  it('archive excludes at once from retrieve(), coverage and Suggest reply; restore brings it back without re-indexing; url/text sources stay', async () => {
    const s = await setup();
    const doc = await upload(s.a, 'old-spec.txt', longText('legacy'));
    const docKs = (await indexDocument(s.a, doc.id)).createdSourceId!; // workspace-wide
    const textKs = await textSource(s.a, 'tone guide', WORKSPACE);
    const urlKs = await createKnowledgeSource(s.a, {
      kind: 'url',
      title: 'Product page',
      url: 'https://example.test/aerogel',
      summary: 'datasheet value page',
      scope: products(s.pA),
    });
    await indexKnowledgeSource(s.a, urlKs.id);
    const docChunks = await chunkIdsOf(docKs);
    const jobsBefore = (await db.select().from(indexingJobs)).length;
    const thread = await seedThread(s.a.workspaceId, null);

    const live = [docKs, textKs, urlKs.id].map(String).sort();
    expect(await sourceIdsFor(s.a, s.pA)).toEqual(live);
    expect((await getProductKnowledgeCoverage(s.a, s.pA)).workspace.sources).toBe(2);

    await archiveDocument(s.a, doc.id);
    const withoutDoc = [textKs, urlKs.id].map(String).sort();
    expect(await sourceIdsFor(s.a, s.pA)).toEqual(withoutDoc);
    expect(await sourceIdsFor(s.a)).toEqual(withoutDoc);
    const coverage = await getProductKnowledgeCoverage(s.a, s.pA);
    expect(coverage.workspace.sources).toBe(1);
    expect(coverage.product.sources).toBe(1);
    const reply = await suggestReply(s.a, { threadId: thread.threadId, ai: stubAi, chunkLimit: 50 });
    const replyIds = reply.sources.chunkIds.map(String);
    expect(replyIds.some((id) => docChunks.includes(id))).toBe(false);
    expect(replyIds.length).toBeGreaterThan(0); // the text / url sources still answer

    await restoreDocument(s.a, doc.id);
    expect(await sourceIdsFor(s.a, s.pA)).toEqual(live);
    expect(await chunkIdsOf(docKs)).toEqual(docChunks);
    expect((await db.select().from(indexingJobs)).length).toBe(jobsBefore);
    expect((await getProductKnowledgeCoverage(s.a, s.pA)).workspace.sources).toBe(2);
  });
});

describe('acceptance 4 — a foreign-workspace product', () => {
  it('fails on the composite FK, on create, on update and on a raw insert', async () => {
    const s = await setup();
    const foreign = (await createProductProfile(s.b, { name: 'B product' })).id;

    await expect(
      createKnowledgeSource(s.a, {
        kind: 'text',
        title: 'leak',
        textExcerpt: 'x',
        scope: products(s.pA, foreign),
      }),
    ).rejects.toMatchObject({ code: 'product_not_found' });
    // The transaction rolled back: no half-created source.
    expect(
      await db.select().from(knowledgeSources).where(eq(knowledgeSources.workspaceId, s.a.workspaceId)),
    ).toHaveLength(0);

    const ks = await textSource(s.a, 'scoped', products(s.pA));
    await expect(updateKnowledgeSource(s.a, ks, { scope: products(foreign) })).rejects.toMatchObject({
      code: 'product_not_found',
    });
    expect((await getKnowledgeSource(s.a, ks)).scope.productProfileIds).toEqual([s.pA]);
    await expect(
      updateKnowledgeSource(s.a, ks, { scope: products(999_999n) }),
    ).rejects.toMatchObject({ code: 'product_not_found' });

    const rawErr = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        let e = err as { code?: string; constraint_name?: string; cause?: unknown };
        if (!e.code && e.cause) e = e.cause as typeof e;
        return [e.code, e.constraint_name];
      }
      return null;
    };
    expect(
      await rawErr(() =>
        db.insert(knowledgeSourceProducts).values({
          sourceId: ks,
          workspaceId: s.a.workspaceId,
          productProfileId: foreign,
        }),
      ),
    ).toEqual(['23503', 'knowledge_source_products_product_fk']);
    expect(
      await rawErr(() =>
        db.insert(knowledgeSourceProducts).values({
          sourceId: ks,
          workspaceId: s.b.workspaceId,
          productProfileId: foreign,
        }),
      ),
    ).toEqual(['23503', 'knowledge_source_products_source_fk']);
    // Chunk ownership: a chunk can only belong to a source of its workspace,
    // and must belong to one.
    expect(
      await rawErr(() =>
        db.insert(documentChunks).values({
          workspaceId: s.b.workspaceId,
          knowledgeSourceId: ks,
          content: 'cross-tenant',
        }),
      ),
    ).toEqual(['23503', 'document_chunks_knowledge_source_fk']);
    expect(
      (await rawErr(() =>
        db.execute(
          sql`INSERT INTO document_chunks (workspace_id, content) VALUES (${s.a.workspaceId}, 'no owner')`,
        ),
      ))?.[0],
    ).toBe('23502');
  });
});

describe('acceptance 6 — deleting a product', () => {
  it('removes its scope rows; a source left with none needs a scope and is retrieved nowhere', async () => {
    const s = await setup();
    const solo = await textSource(s.a, 'solo', products(s.pA));
    const shared = await textSource(s.a, 'shared', products(s.pA, s.pB));
    const everyone = await textSource(s.a, 'everyone', WORKSPACE);

    await deleteProductProfile(s.a, s.pA);

    const rows = await db.select().from(knowledgeSourceProducts);
    expect(rows.map((r) => [r.sourceId, r.productProfileId])).toEqual([[shared, s.pB]]);
    const soloRow = await getKnowledgeSource(s.a, solo);
    expect(soloRow.scope).toMatchObject({ kind: 'products', productProfileIds: [], needsScope: true });
    expect((await listKnowledgeSources(s.a, { scope: 'needs_scope' })).map((r) => r.source.id)).toEqual([
      solo,
    ]);

    expect(await sourceIdsFor(s.a, s.pB)).toEqual([shared, everyone].map(String).sort());
    expect(await sourceIdsFor(s.a)).toEqual([shared, everyone].map(String).sort());
    expect(await getProductKnowledgeCoverage(s.a, s.pB)).toMatchObject({
      product: { sources: 1 },
      workspace: { sources: 1 },
    });
    await expect(attachKnowledgeSourceViaProvider(s.a, solo)).rejects.toMatchObject({
      code: 'needs_scope',
    });

    session.current = { user: { id: s.a.userId, role: 'member', accountStatus: 'active' } };
    const html = await renderToHtml(
      await KnowledgeSourceDetail({
        params: Promise.resolve({ id: solo.toString() }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('Needs a scope');
    expect(html).toContain(NO_PRODUCT_TICKED_COPY);

    // Saving it with no product ticked makes it available to every product.
    await updateKnowledgeSource(s.a, solo, { scope: knowledgeScopeFromTicks([]) });
    expect(await sourceIdsFor(s.a, s.pB)).toEqual([solo, shared, everyone].map(String).sort());
  });
});

describe('coverage (I104)', () => {
  it("counts the product's own sources and the workspace-wide ones separately", async () => {
    const s = await setup();
    const own = await textSource(s.a, 'own', products(s.pA));
    await textSource(s.a, 'other', products(s.pB));
    const wide = await textSource(s.a, 'wide', WORKSPACE);
    await createKnowledgeSource(s.a, {
      kind: 'text',
      title: 'not indexed yet',
      textExcerpt: 'x',
      scope: products(s.pA),
    });
    const ownChunks = (await chunkIdsOf(own)).length;
    const wideChunks = (await chunkIdsOf(wide)).length;

    expect(await getProductKnowledgeCoverage(s.a, s.pA)).toEqual({
      product: { sources: 2, chunks: ownChunks },
      workspace: { sources: 1, chunks: wideChunks },
    });
    const forB = await getProductKnowledgeCoverage(s.a, s.pB);
    expect(forB.workspace).toEqual({ sources: 1, chunks: wideChunks });
    expect(forB.product.sources).toBe(1);
    // Another workspace sees none of it.
    const pOther = (await createProductProfile(s.b, { name: 'x' })).id;
    expect(await getProductKnowledgeCoverage(s.b, pOther)).toEqual({
      product: { sources: 0, chunks: 0 },
      workspace: { sources: 0, chunks: 0 },
    });
  });
});

describe('Suggest reply', () => {
  it("reads the thread lead's product plus workspace-wide knowledge, never another product's", async () => {
    const s = await setup();
    const forA = await textSource(s.a, 'aerogel note', products(s.pA));
    const forB = await textSource(s.a, 'sealant note', products(s.pB));
    const wide = await textSource(s.a, 'company note', WORKSPACE);
    const owned = async (threadId: bigint) => {
      const r = await suggestReply(s.a, { threadId, ai: stubAi, chunkLimit: 100 });
      const ids = r.sources.chunkIds.map(String);
      const out: string[] = [];
      for (const [name, ks] of [
        ['A', forA],
        ['B', forB],
        ['wide', wide],
      ] as const) {
        if ((await chunkIdsOf(ks)).some((id) => ids.includes(id))) out.push(name);
      }
      return out;
    };

    const leadThread = await seedThread(s.a.workspaceId, s.pB);
    expect(await resolveThreadProduct(s.a, leadThread.threadId)).toBe(s.pB);
    expect(await owned(leadThread.threadId)).toEqual(['B', 'wide']);

    // No lead: workspace-wide plus every source that still has a product.
    const plain = await seedThread(s.a.workspaceId, null);
    expect(await resolveThreadProduct(s.a, plain.threadId)).toBeNull();
    expect(await owned(plain.threadId)).toEqual(['A', 'B', 'wide']);
  });
});

describe('explicit scope', () => {
  it('scope is required, an empty product list is refused, and the column default never widens', async () => {
    const s = await setup();
    await expect(
      createKnowledgeSource(s.a, {
        kind: 'text',
        title: 'x',
        textExcerpt: 'x',
      } as unknown as CreateKnowledgeSourceInput),
    ).rejects.toMatchObject({ code: 'scope_required' });
    await expect(
      createKnowledgeSource(s.a, { kind: 'text', title: 'x', textExcerpt: 'x', scope: products() }),
    ).rejects.toMatchObject({ code: 'scope_required' });
    const [col] = (await db.execute(sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'knowledge_sources' AND column_name = 'scope_kind'`)) as unknown as Array<{
      column_default: string | null;
    }>;
    // The default exists only for the additive migration (the contract PR
    // drops it). It is the safe side: a row written without a scope is a
    // 'products' source with no products ("Needs a scope", retrieved
    // nowhere), never a workspace-wide one.
    expect(col!.column_default).toBe("'products'::knowledge_scope_kind");
  });

  it('the upload and edit forms carry the explicit line', async () => {
    const s = await setup();
    const html = await renderToHtml(
      await NewKnowledgeSourcePage({ searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain(`${NO_PRODUCT_TICKED_COPY}.`);
    const ks = await textSource(s.a, 'note', products(s.pA));
    const detail = await renderToHtml(
      await KnowledgeSourceDetail({
        params: Promise.resolve({ id: ks.toString() }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(detail).toContain(`${NO_PRODUCT_TICKED_COPY}.`);
    expect(detail).toContain('Aerogel blanket');
  });
});

describe('legacy columns', () => {
  it('nothing in src/ or scripts/ reads the deprecated arrays or the old filter', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    // knowledge_sources.product_profile_ids and product_profiles.
    // document_source_ids stay DECLARED (as legacyProductProfileIds /
    // legacyDocumentSourceIds) until the contract PR drops them, so the
    // lane migration is purely additive. Only their declarations may name
    // them; the read-only KL-05 report reads the array in raw SQL.
    const declarations = new Set([
      'src/lib/db/schema/documents.ts',
      'src/lib/db/schema/products.ts',
    ]);
    const banned = [
      /\bdocumentSourceIds\b/,
      /\bdocument_source_ids\b/,
      /\bsanitizeProductIds\b/,
      /knowledgeSources\.productProfileIds/,
      /\b(?:source|ks|src)\.productProfileIds\b/,
      /\blegacy(?:ProductProfileIds|DocumentSourceIds)\b/,
    ];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== 'node_modules' && name !== 'tests') walk(p);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        if (declarations.has(path.relative(root, p).split(path.sep).join('/'))) continue;
        // Code only: comments may name what was removed.
        const code = readFileSync(p, 'utf8')
          .split('\n')
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .join('\n');
        for (const re of banned) if (re.test(code)) offenders.push(`${path.relative(root, p)}: ${re}`);
      }
    };
    walk(path.join(root, 'src'));
    walk(path.join(root, 'scripts'));
    expect(offenders).toEqual([]);
  });
});

// ---- helpers ----------------------------------------------------------------

const stubAi: IAIProvider = {
  id: 'stub',
  model: 'stub-model',
  async generateText() {
    return { text: 'STUB-REPLY', model: 'stub-1', usage: { inputTokens: 1, outputTokens: 1 } };
  },
  async generateJson() {
    throw new Error('not used');
  },
  estimateCost() {
    return 0;
  },
  async healthCheck() {
    return { ok: true };
  },
};

let threadSeq = 0;

/** A mail thread with one inbound message; with a product, a qualified lead
 *  for it whose outreach conversation is this thread. */
async function seedThread(
  workspaceId: bigint,
  productProfileId: bigint | null,
): Promise<{ threadId: bigint }> {
  threadSeq += 1;
  const [mailbox] = await db
    .insert(mailboxes)
    .values({
      workspaceId,
      name: `sales-${threadSeq}`,
      fromAddress: `sales${threadSeq}@nulife.test`,
      smtpHost: 'smtp.example.test',
      smtpUser: `sales${threadSeq}@nulife.test`,
      smtpPasswordSecretKey: 'mailbox.smtpPassword_fixedfortests',
      imapFolder: 'INBOX',
      status: 'active',
      isDefault: threadSeq === 1,
    })
    .returning();
  const [thread] = await db
    .insert(mailThreads)
    .values({
      workspaceId,
      mailboxId: mailbox!.id,
      subject: 'Question about the datasheet',
      externalThreadKey: `subj:kl05-${threadSeq}`,
      participants: ['buyer@target.test'],
    })
    .returning();
  await db.insert(mailMessages).values({
    workspaceId,
    mailboxId: mailbox!.id,
    threadId: thread!.id,
    direction: 'inbound',
    status: 'received',
    messageId: `<kl05-${threadSeq}@target.test>`,
    fromAddress: 'buyer@target.test',
    toAddresses: [`sales${threadSeq}@nulife.test`],
    subject: 'Question about the datasheet',
    bodyText: QUERY,
  });
  if (productProfileId !== null) {
    const [source] = await db
      .insert(sourceRecords)
      .values({
        workspaceId,
        sourceSystem: 'mock',
        sourceId: `kl05-${threadSeq}`,
        rawData: {},
        normalizedData: {},
        sourceUrl: 'https://example.test',
      })
      .returning();
    const [review] = await db
      .insert(reviewItems)
      .values({ workspaceId, sourceRecordId: source!.id, state: 'new' })
      .returning();
    const [lead] = await db
      .insert(qualifiedLeads)
      .values({
        workspaceId,
        reviewItemId: review!.id,
        productProfileId,
        state: 'contacted',
        currentThreadId: thread!.id,
      })
      .returning();
    await db.insert(outreachThreadState).values({
      workspaceId,
      qualifiedLeadId: lead!.id,
      threadId: thread!.id,
      stage: 'engagement',
    });
    const [contact] = await db
      .insert(contacts)
      .values({ workspaceId, email: `buyer${threadSeq}@target.test`, name: 'Buyer', status: 'active' })
      .returning();
    await db.insert(contactAssociations).values([
      { workspaceId, contactId: contact!.id, entityType: 'qualified_lead', entityId: lead!.id.toString() },
      { workspaceId, contactId: contact!.id, entityType: 'mail_thread', entityId: thread!.id.toString() },
    ]);
  }
  return { threadId: thread!.id };
}
