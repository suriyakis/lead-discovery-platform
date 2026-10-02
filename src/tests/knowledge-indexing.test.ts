// KL-06 (I040, I103, I104, I108, I021): indexing as a job — index once per
// source, extraction cached by content hash (paid OCR never repeats),
// honest status, stale on edit, retries + a 15-minute sweeper with a
// notification, and a delete that needs confirmation and detaches.
//
// Acceptance (with OCR and embedding call counters):
//   1. a scanned-PDF source with 3 products: 1 OCR call, 1 ocr.pdf usage row,
//      1 embedding pass;
//   2. a re-index with unchanged content: 0 embedding calls;
//   3. editing the excerpt marks the source stale; the job re-indexes and
//      retrieval returns the new text;
//   4. a run left running past 15 min is swept to failed with a message and
//      a notification;
//   5. the upload action returns before extraction completes, with a job
//      enqueued;
//   6. deleting without confirmation is impossible.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db/client';
import { usageLog } from '@/lib/db/schema/audit';
import { documents, knowledgeSources } from '@/lib/db/schema/documents';
import { notifications } from '@/lib/db/schema/notifications';
import { documentChunks, indexingJobs } from '@/lib/db/schema/rag';
import { productVectorStores } from '@/lib/db/schema/vector-stores';
import {
  EMBEDDING_DIM,
  MockEmbeddingProvider,
  _setEmbeddingProviderForTests,
  type EmbedInput,
  type EmbedResult,
  type IEmbeddingProvider,
} from '@/lib/embeddings';
import {
  InMemoryJobQueue,
  _setJobQueueForTests,
  getJobQueue,
  type JobId,
  type JobOptions,
  type JobPayload,
  type RepeatableJobOptions,
} from '@/lib/jobs';
import { _resetHandlersForTests, registerJobHandlers } from '@/lib/jobs/bootstrap';
import { _resetRepeatablesForTests, registerRepeatableJobs } from '@/lib/jobs/repeatables';
import { _setOcrProviderForTests, type IOcrProvider } from '@/lib/ocr';
import { LocalFileStorage, _setStorageForTests } from '@/lib/storage';
import { _setVectorStorageProviderForTests } from '@/lib/vector-storage';
import { PgvectorVectorStorageProvider } from '@/lib/vector-storage/pgvector';
import { makeWorkspaceContext, type WorkspaceContext } from '@/lib/services/context';
import { archiveDocument, uploadDocument } from '@/lib/services/documents';
import { KNOWLEDGE_INDEX_JOB } from '@/lib/services/knowledge-index-queue';
import {
  INDEX_TIMEOUT_MESSAGE,
  KNOWLEDGE_INDEX_SWEEP_JOB,
  KNOWLEDGE_INDEX_SWEEP_TICK_MS,
  MAX_INDEX_ATTEMPTS,
  describeOcrCost,
  estimateDocumentOcr,
  knowledgeIndexFailedKey,
  requestDocumentOcrReextract,
  requestKnowledgeIndex,
  runKnowledgeIndexJob,
  runKnowledgeIndexSweep,
} from '@/lib/services/knowledge-indexing';
import {
  createKnowledgeSource,
  deleteKnowledgeSource,
  listDocumentSources,
  updateKnowledgeSource,
} from '@/lib/services/knowledge-sources';
import { createProductProfile } from '@/lib/services/product-profile';
import { indexKnowledgeSource, retrieve } from '@/lib/services/rag';
import DocumentsPage from '@/app/documents/page';
import DocumentDetail from '@/app/documents/[id]/page';
import KnowledgeSourceDetail from '@/app/knowledge/[id]/page';
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

// pdf-parse is module-mocked: `pdf.text` '' = a scanned PDF (parses, no
// text layer); a long text = a PDF with a text layer.
const pdf = vi.hoisted(() => ({ text: '', numpages: 3 }));
vi.mock('pdf-parse/lib/pdf-parse.js', () => ({
  default: async () => ({ text: pdf.text, numpages: pdf.numpages }),
}));

// ---- counters ---------------------------------------------------------------------

/** The mock embedder, counting every embed() call (one per 64-chunk batch). */
class CountingEmbedder implements IEmbeddingProvider {
  public readonly id = 'mock';
  public readonly dim = EMBEDDING_DIM;
  public calls = 0;
  public texts = 0;
  /** While set, embed() waits for it (a slow run). */
  public gate: Promise<void> | null = null;
  /** Throw this many times before working (a flaky provider). */
  public failNext = 0;
  private readonly inner = new MockEmbeddingProvider();
  constructor(public readonly model: string = 'mock-embed-1') {}
  async embed(input: EmbedInput): Promise<EmbedResult> {
    this.calls += 1;
    this.texts += input.texts.length;
    if (this.gate) await this.gate;
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('embedding provider timed out');
    }
    const r = await this.inner.embed(input);
    return { ...r, model: this.model };
  }
  estimateCost(): number {
    return 0;
  }
  async healthCheck() {
    return { ok: true };
  }
}

const OCR_TEXT = Array.from(
  { length: 40 },
  (_, i) =>
    `Vetrofluid technical data sheet, section ${i}: waterproofing for concrete surfaces, applied in two coats, coverage ${i * 3} square metres per litre. `,
).join('');

/** The Mistral OCR stub, counting calls. */
class CountingOcr implements IOcrProvider {
  public readonly id = 'mistral';
  public readonly model = 'mistral-ocr-latest';
  public calls = 0;
  public started = 0;
  public gate: Promise<void> | null = null;
  async extractPdfText(): Promise<{ text: string; pages: number; model: string }> {
    this.started += 1;
    if (this.gate) await this.gate;
    this.calls += 1;
    return { text: OCR_TEXT, pages: 3, model: this.model };
  }
}

/** Records enqueues; runs nothing. */
class RecordingQueue extends InMemoryJobQueue {
  public enqueued: Array<{ type: string; payload: JobPayload }> = [];
  public schedules: Array<{ type: string; everyMs: number }> = [];
  override async enqueue<P extends JobPayload>(
    type: string,
    payload: P,
    _options?: JobOptions,
  ): Promise<JobId> {
    this.enqueued.push({ type, payload });
    return String(this.enqueued.length);
  }
  override async enqueueRepeatable<P extends JobPayload>(
    type: string,
    _payload: P,
    options: RepeatableJobOptions,
  ): Promise<void> {
    this.schedules.push({ type, everyMs: options.everyMs });
  }
}

/** A real in-memory queue that also records what was enqueued. */
class WatchedQueue extends InMemoryJobQueue {
  public enqueued: Array<{ type: string; payload: JobPayload }> = [];
  override async enqueue<P extends JobPayload>(
    type: string,
    payload: P,
    options?: JobOptions,
  ): Promise<JobId> {
    this.enqueued.push({ type, payload });
    return super.enqueue(type, payload, options);
  }
}

class SpyPgvector extends PgvectorVectorStorageProvider {
  public detached: bigint[] = [];
  override async detachKnowledgeSource(ctx: WorkspaceContext, id: bigint): Promise<void> {
    this.detached.push(id);
    return super.detachKnowledgeSource(ctx, id);
  }
}

// ---- setup ------------------------------------------------------------------------

interface Setup {
  a: WorkspaceContext;
  member: WorkspaceContext;
  products: bigint[];
}

async function setup(): Promise<Setup> {
  const owner = await seedUser({ email: 'kl06-owner@test.local' });
  const memberId = await seedUser({ email: 'kl06-member@test.local' });
  const ws = await seedWorkspace({
    name: 'Index',
    ownerUserId: owner,
    extraMembers: [{ userId: memberId, role: 'member' }],
  });
  session.current = { user: { id: owner, role: 'member', accountStatus: 'active' } };
  const a = makeWorkspaceContext({ workspaceId: ws, userId: owner, role: 'owner' });
  const member = makeWorkspaceContext({ workspaceId: ws, userId: memberId, role: 'member' });
  const products: bigint[] = [];
  for (const name of ['Aerogel blanket', 'Fire sealant', 'Mineral wool']) {
    products.push((await createProductProfile(a, { name })).id);
  }
  return { a, member, products };
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

async function sourceRow(id: bigint) {
  const [row] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, id));
  return row!;
}

async function jobsOf(sourceId: bigint) {
  return db
    .select()
    .from(indexingJobs)
    .where(eq(indexingJobs.knowledgeSourceId, sourceId))
    .orderBy(indexingJobs.id);
}

async function ocrUsageRows(workspaceId: bigint) {
  return db
    .select()
    .from(usageLog)
    .where(and(eq(usageLog.workspaceId, workspaceId), eq(usageLog.kind, 'ocr.pdf')));
}

async function failureNotices(workspaceId: bigint) {
  return db
    .select()
    .from(notifications)
    .where(
      and(eq(notifications.workspaceId, workspaceId), eq(notifications.kind, 'knowledge.index_failed')),
    );
}

async function uploadScan(c: WorkspaceContext, filename = 'scanned-datasheet.pdf', body = 'scan-1') {
  return (
    await uploadDocument(c, {
      filename,
      mimeType: 'application/pdf',
      body: Buffer.from(`%PDF-1.4 ${body}`),
    })
  ).document;
}

function pdfFile(name = 'scanned-datasheet.pdf', body = 'scan-1'): File {
  return new File([`%PDF-1.4 ${body}`], name, { type: 'application/pdf' });
}

const minutes = (n: number) => n * 60 * 1000;

let storageRoot: string;
let embedder: CountingEmbedder;
let ocr: CountingOcr;

beforeEach(async () => {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'kl06-index-'));
  _setStorageForTests(new LocalFileStorage(storageRoot));
  embedder = new CountingEmbedder();
  _setEmbeddingProviderForTests(embedder);
  ocr = new CountingOcr();
  _setOcrProviderForTests(ocr);
  _setVectorStorageProviderForTests(new PgvectorVectorStorageProvider());
  pdf.text = '';
  pdf.numpages = 3;
  session.current = null;
  await truncateAll();
});

afterEach(async () => {
  _setStorageForTests(null);
  _setEmbeddingProviderForTests(null);
  _setOcrProviderForTests(null);
  _setVectorStorageProviderForTests(null);
  await rm(storageRoot, { recursive: true, force: true });
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- acceptance 1 + 2 ---------------------------------------------------------------

describe('acceptance 1 — a scanned PDF with 3 products is indexed once', () => {
  it('1 OCR call, 1 ocr.pdf usage row, 1 embedding pass; per-product attach is bookkeeping', async () => {
    const s = await setup();
    const page = await DocumentsPage({ searchParams: Promise.resolve({}) });
    const [uploadAction] = formActions(page);
    const fd = new FormData();
    fd.append('file', pdfFile());
    for (const p of s.products) fd.append('productProfileIds', p.toString());
    const target = await expectRedirect(() => uploadAction!(fd));
    expect(decodeURIComponent(target)).toContain('attached to 3 products. Indexing in the background');
    const docId = BigInt(/\/documents\/(\d+)/.exec(target)![1]!);

    const outcomes = await runQueuedIndexJobs(s.a);
    expect(outcomes.map((o) => o.kind)).toEqual(['succeeded']);

    expect(ocr.calls).toBe(1);
    expect(await ocrUsageRows(s.a.workspaceId)).toHaveLength(1);
    const [usage] = await ocrUsageRows(s.a.workspaceId);
    expect((usage!.payload as Record<string, unknown>).documentId).toBe(docId.toString());

    const [src] = await listDocumentSources(s.a, docId);
    const chunks = await db
      .select()
      .from(documentChunks)
      .where(eq(documentChunks.knowledgeSourceId, src!.source.id));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(64);
    // One pass: one embed() batch, each chunk embedded exactly once.
    expect(embedder.calls).toBe(1);
    expect(embedder.texts).toBe(chunks.length);

    const row = await sourceRow(src!.source.id);
    expect(row.indexStatus).toBe('indexed');
    expect(row.indexedAt).toBeInstanceOf(Date);
    expect(row.indexedContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.indexedEmbeddingModel).toBe('mock-embed-1');
    expect(row.lastIndexError).toBeNull();
    expect(row.externalProviderId).toBe('pgvector');

    // The extraction is cached on the document.
    const [doc] = await db.select().from(documents).where(eq(documents.id, docId));
    expect(doc!.extractor).toBe('ocr:mistral/mistral-ocr-latest');
    expect(doc!.extractedText).toContain('Vetrofluid technical data sheet');
    expect(doc!.extractedSha256).toBe(doc!.sha256);
    expect(doc!.pageCount).toBe(3);
    expect(doc!.detectedLanguage).toBe('en');

    // pgvector: one binding per product, counters derived from the chunks.
    const bytes = chunks.reduce((n, c) => n + Buffer.byteLength(c.content, 'utf8'), 0);
    const stores = await db
      .select()
      .from(productVectorStores)
      .where(eq(productVectorStores.workspaceId, s.a.workspaceId));
    expect(stores).toHaveLength(3);
    expect(stores.every((st) => st.fileCount === 1 && st.usageBytes === bytes)).toBe(true);

    // ---- acceptance 2: re-index with unchanged content ----
    const before = { embed: embedder.calls, ocr: ocr.calls };
    const reindexTree = await KnowledgeSourceDetail({
      params: Promise.resolve({ id: src!.source.id.toString() }),
      searchParams: Promise.resolve({}),
    });
    const [reindex] = formActions(reindexTree);
    const back = await expectRedirect(() => reindex!(new FormData()));
    expect(decodeURIComponent(back)).toContain('Indexing queued');
    expect((await sourceRow(src!.source.id)).indexStatus).toBe('queued');
    const again = await runQueuedIndexJobs(s.a);
    expect(again).toMatchObject([{ kind: 'succeeded', reembedded: false }]);
    expect(embedder.calls).toBe(before.embed); // 0 embedding calls
    expect(ocr.calls).toBe(before.ocr); // 0 OCR calls: the cache
    expect(await ocrUsageRows(s.a.workspaceId)).toHaveLength(1);
    const jobs = await jobsOf(src!.source.id);
    expect(jobs.map((j) => [j.status, j.note])).toEqual([
      ['succeeded', 'embedded'],
      ['succeeded', 'unchanged'],
    ]);
    expect(await db.select().from(documentChunks).where(eq(documentChunks.knowledgeSourceId, src!.source.id))).toHaveLength(chunks.length);
    // Counters did not grow (they only ever grew before, I040).
    const after = await db
      .select()
      .from(productVectorStores)
      .where(eq(productVectorStores.workspaceId, s.a.workspaceId));
    expect(after.every((st) => st.fileCount === 1 && st.usageBytes === bytes)).toBe(true);
  });

  it('a new embedding model re-embeds even when the text is unchanged', async () => {
    const s = await setup();
    const ks = await createKnowledgeSource(s.a, {
      kind: 'text',
      title: 'Tone',
      textExcerpt: 'Be concise. Mention local case studies first.',
      scope: { kind: 'workspace' },
    });
    await runQueuedIndexJobs(s.a);
    expect(embedder.calls).toBe(1);
    await requestKnowledgeIndex(s.a, ks.id);
    await runQueuedIndexJobs(s.a);
    expect(embedder.calls).toBe(1);

    const v2 = new CountingEmbedder('mock-embed-2');
    _setEmbeddingProviderForTests(v2);
    await requestKnowledgeIndex(s.a, ks.id);
    expect(await runQueuedIndexJobs(s.a)).toMatchObject([{ kind: 'succeeded', reembedded: true }]);
    expect(v2.calls).toBe(1);
    expect((await sourceRow(ks.id)).indexedEmbeddingModel).toBe('mock-embed-2');
  });

  it('the same bytes in a second document reuse the cached OCR text (once per SHA)', async () => {
    const s = await setup();
    const first = await uploadScan(s.a);
    await createKnowledgeSource(s.a, {
      kind: 'document',
      title: 'Datasheet',
      documentId: first.id,
      scope: { kind: 'workspace' },
    });
    await runQueuedIndexJobs(s.a);
    expect(ocr.calls).toBe(1);

    // Archived, then the same file uploaded again: a new row, same SHA.
    await archiveDocument(s.a, first.id);
    const second = await uploadScan(s.a);
    expect(second.id).not.toBe(first.id);
    expect(second.sha256).toBe(first.sha256);
    await createKnowledgeSource(s.a, {
      kind: 'document',
      title: 'Datasheet again',
      documentId: second.id,
      scope: { kind: 'workspace' },
    });
    await runQueuedIndexJobs(s.a);
    expect(ocr.calls).toBe(1);
    expect(await ocrUsageRows(s.a.workspaceId)).toHaveLength(1);
    const [doc] = await db.select().from(documents).where(eq(documents.id, second.id));
    expect(doc!.extractor).toBe('ocr:mistral/mistral-ocr-latest');
  });

  it('pages never index inside the request (the redundant page-level calls are gone)', () => {
    const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk(appDir);
    const offenders = files.filter((f) =>
      /\b(indexKnowledgeSource|indexDocument|attachKnowledgeSourceViaProvider|indexKnowledgeSourceNow)\b/.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});

// ---- acceptance 3 -----------------------------------------------------------------

describe('acceptance 3 — editing marks the source stale; the job re-indexes', () => {
  it('[handbook H-35] the excerpt edit: stale at once, old text served until the run, then the new text', async () => {
    const s = await setup();
    const ks = await createKnowledgeSource(s.a, {
      kind: 'text',
      title: 'Price objection',
      textExcerpt: 'Answer: our aerogel blanket costs 40 EUR per metre installed.',
      scope: { kind: 'products', productProfileIds: [s.products[0]!] },
    });
    await runQueuedIndexJobs(s.a);
    expect((await sourceRow(ks.id)).indexStatus).toBe('indexed');

    // Edit through the page's Save.
    const tree = await KnowledgeSourceDetail({
      params: Promise.resolve({ id: ks.id.toString() }),
      searchParams: Promise.resolve({}),
    });
    const [, saveEdits] = formActions(tree);
    const fd = new FormData();
    fd.append('title', 'Price objection');
    fd.append('textExcerpt', 'Answer: since October the blanket costs 35 EUR per metre installed.');
    fd.append('productProfileIds', s.products[0]!.toString());
    const target = await expectRedirect(() => saveEdits!(fd));
    expect(decodeURIComponent(target)).toContain('being re-indexed');

    const stale = await sourceRow(ks.id);
    expect(stale.indexStatus).toBe('stale');
    const queued = (await jobsOf(ks.id)).filter((j) => j.status === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.reason).toBe('edit');
    // The previous version still serves until the run finishes.
    const servedBefore = await retrieve(s.a, 'blanket price per metre', {
      productProfileId: s.products[0]!,
    });
    expect(servedBefore.map((r) => r.chunk.content).join(' ')).toContain('40 EUR');
    const html = await renderToHtml(
      await KnowledgeSourceDetail({
        params: Promise.resolve({ id: ks.id.toString() }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('data-index-status="stale"');
    expect(html).toContain('re-indexing is queued');
    expect(html).toContain('data-auto-refresh="knowledge-index"');

    const before = embedder.calls;
    expect(await runQueuedIndexJobs(s.a)).toMatchObject([{ kind: 'succeeded', reembedded: true }]);
    expect(embedder.calls).toBe(before + 1);
    expect((await sourceRow(ks.id)).indexStatus).toBe('indexed');
    const served = await retrieve(s.a, 'blanket price per metre', {
      productProfileId: s.products[0]!,
    });
    const text = served.map((r) => r.chunk.content).join(' ');
    expect(text).toContain('35 EUR');
    expect(text).not.toContain('40 EUR');
    const settled = await renderToHtml(
      await KnowledgeSourceDetail({
        params: Promise.resolve({ id: ks.id.toString() }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(settled).toContain('data-index-status="indexed"');
    expect(settled).not.toContain('data-auto-refresh');
  });

  it('URL, summary and product changes mark stale too; tags and purpose do not', async () => {
    const s = await setup();
    const url = await createKnowledgeSource(s.a, {
      kind: 'url',
      title: 'Product page',
      url: 'https://example.com/a',
      summary: 'Applications and FAQs.',
      scope: { kind: 'products', productProfileIds: [s.products[0]!] },
    });
    await runQueuedIndexJobs(s.a);

    await updateKnowledgeSource(s.a, url.id, { tags: ['web'], purposeCategory: 'marketing' });
    expect((await sourceRow(url.id)).indexStatus).toBe('indexed');
    expect((await jobsOf(url.id)).filter((j) => j.status === 'queued')).toHaveLength(0);

    for (const patch of [
      { url: 'https://example.com/b' },
      { summary: 'Applications, FAQs and prices.' },
      { scope: { kind: 'products' as const, productProfileIds: [s.products[0]!, s.products[1]!] } },
    ]) {
      const updated = await updateKnowledgeSource(s.a, url.id, patch);
      expect(updated.indexStatus).toBe('stale');
      expect((await jobsOf(url.id)).filter((j) => j.status === 'queued')).toHaveLength(1);
      await runQueuedIndexJobs(s.a);
      expect((await sourceRow(url.id)).indexStatus).toBe('indexed');
    }

    // A text source's summary is not in its embedded text: queued, but
    // nothing is re-embedded.
    const text = await createKnowledgeSource(s.a, {
      kind: 'text',
      title: 'Note',
      textExcerpt: 'Install in two coats.',
      scope: { kind: 'workspace' },
    });
    await runQueuedIndexJobs(s.a);
    const before = embedder.calls;
    expect((await updateKnowledgeSource(s.a, text.id, { summary: 'How to install' })).indexStatus).toBe('stale');
    expect(await runQueuedIndexJobs(s.a)).toMatchObject([{ kind: 'succeeded', reembedded: false }]);
    expect(embedder.calls).toBe(before);
  });

  it('an edit during a run: the run does not claim "indexed" for text it never read', async () => {
    const s = await setup();
    const ks = await createKnowledgeSource(s.a, {
      kind: 'text',
      title: 'Spec',
      textExcerpt: 'Thermal conductivity 0.015 W/mK.',
      scope: { kind: 'workspace' },
    });
    const [job] = await jobsOf(ks.id);
    let release!: () => void;
    embedder.gate = new Promise<void>((r) => (release = r));
    const running = runKnowledgeIndexJob(s.a, job!.id);
    // Wait until the run holds the source.
    for (let i = 0; i < 100 && (await sourceRow(ks.id)).indexStatus !== 'indexing'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await sourceRow(ks.id)).indexStatus).toBe('indexing');
    await updateKnowledgeSource(s.a, ks.id, { textExcerpt: 'Thermal conductivity 0.019 W/mK.' });
    expect((await sourceRow(ks.id)).indexStatus).toBe('stale');
    embedder.gate = null;
    release();
    expect((await running).kind).toBe('succeeded');
    // The edit's run is still queued, so the source stays stale.
    expect((await sourceRow(ks.id)).indexStatus).toBe('stale');
    await runQueuedIndexJobs(s.a);
    expect((await sourceRow(ks.id)).indexStatus).toBe('indexed');
    const served = await retrieve(s.a, 'thermal conductivity', {});
    expect(served.map((r) => r.chunk.content).join(' ')).toContain('0.019');
  });
});

// ---- acceptance 4 -----------------------------------------------------------------

describe('acceptance 4 — the sweeper', () => {
  async function stuckRun(s: Setup, title: string, startedMinutesAgo: number) {
    const ks = await createKnowledgeSource(s.a, {
      kind: 'text',
      title,
      textExcerpt: `${title}: install in two coats.`,
      scope: { kind: 'workspace' },
    });
    const [job] = await jobsOf(ks.id);
    await db
      .update(indexingJobs)
      .set({ status: 'running', attempts: 1, startedAt: new Date(Date.now() - minutes(startedMinutesAgo)) })
      .where(eq(indexingJobs.id, job!.id));
    await db.update(knowledgeSources).set({ indexStatus: 'indexing' }).where(eq(knowledgeSources.id, ks.id));
    return { ks, jobId: job!.id };
  }

  it('fails a run older than 15 minutes with a message and ONE notification per source', async () => {
    const s = await setup();
    const old = await stuckRun(s, 'Old run', 16);
    const young = await stuckRun(s, 'Young run', 14);
    const q = new RecordingQueue();

    const r1 = await runKnowledgeIndexSweep(new Date(), q);
    expect(r1).toMatchObject({ timedOut: 1, notified: 1 });
    const [job] = await db.select().from(indexingJobs).where(eq(indexingJobs.id, old.jobId));
    expect(job).toMatchObject({ status: 'failed', error: INDEX_TIMEOUT_MESSAGE, note: 'timed_out' });
    expect(job!.finishedAt).toBeInstanceOf(Date);
    const src = await sourceRow(old.ks.id);
    expect(src.indexStatus).toBe('failed');
    expect(src.lastIndexError).toBe(INDEX_TIMEOUT_MESSAGE);
    // The 14-minute run is left alone.
    expect((await jobsOf(young.ks.id))[0]!.status).toBe('running');

    const notes = await failureNotices(s.a.workspaceId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      dedupeKey: knowledgeIndexFailedKey(old.ks.id),
      href: `/knowledge/${old.ks.id}`,
      title: 'Indexing failed: Old run',
    });
    expect(notes[0]!.body).toContain('did not finish within 15 minutes');

    // Twenty minutes later the young one times out too: its own notice;
    // the old one's is not repeated.
    const r2 = await runKnowledgeIndexSweep(new Date(Date.now() + minutes(20)), q);
    expect(r2.timedOut).toBe(1);
    expect((await failureNotices(s.a.workspaceId)).map((n) => n.dedupeKey).sort()).toEqual(
      [knowledgeIndexFailedKey(old.ks.id), knowledgeIndexFailedKey(young.ks.id)].sort(),
    );

    // The source page says so, and offers Re-index; a success resolves the notice.
    const html = await renderToHtml(
      await KnowledgeSourceDetail({
        params: Promise.resolve({ id: old.ks.id.toString() }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('data-index-status="failed"');
    expect(html).toContain('did not finish within 15 minutes');
    await requestKnowledgeIndex(s.a, old.ks.id);
    await runQueuedIndexJobs(s.a);
    expect((await sourceRow(old.ks.id)).indexStatus).toBe('indexed');
    const [resolved] = (await failureNotices(s.a.workspaceId)).filter(
      (n) => n.dedupeKey === knowledgeIndexFailedKey(old.ks.id),
    );
    expect(resolved!.readAt).toBeInstanceOf(Date);
  });

  it('a hung run that finishes after the sweeper closed it leaves the source to the run holding it now', async () => {
    const s = await setup();
    const ks = await createKnowledgeSource(s.a, {
      kind: 'text',
      title: 'Hung',
      textExcerpt: 'Install in two coats.',
      scope: { kind: 'workspace' },
    });
    const [job] = await jobsOf(ks.id);
    let release!: () => void;
    embedder.gate = new Promise<void>((r) => (release = r));
    const hung = runKnowledgeIndexJob(s.a, job!.id);
    for (let i = 0; i < 100 && (await sourceRow(ks.id)).indexStatus !== 'indexing'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // 16 minutes on, the sweeper times the run out ...
    const later = new Date(Date.now() + minutes(16));
    expect((await runKnowledgeIndexSweep(later, new RecordingQueue())).timedOut).toBe(1);
    expect((await jobsOf(ks.id))[0]).toMatchObject({ status: 'failed', note: 'timed_out' });
    // ... and a newer run claims the source.
    const [newer] = await db
      .insert(indexingJobs)
      .values({
        workspaceId: s.a.workspaceId,
        knowledgeSourceId: ks.id,
        status: 'running',
        attempts: 1,
        startedAt: new Date(),
        reason: 'reindex',
      })
      .returning();
    await db
      .update(knowledgeSources)
      .set({ indexStatus: 'indexing' })
      .where(eq(knowledgeSources.id, ks.id));

    embedder.gate = null;
    release();
    expect(await hung).toEqual({ kind: 'skipped', reason: 'closed' });
    const rows = await jobsOf(ks.id);
    expect(rows.find((r) => r.id === job!.id)).toMatchObject({ status: 'failed', note: 'timed_out' });
    expect(rows.find((r) => r.id === newer!.id)).toMatchObject({ status: 'running' });
    // Not flipped to 'indexed' while the newer run still works.
    expect((await sourceRow(ks.id)).indexStatus).toBe('indexing');
  });

  it('re-enqueues lost and due rows only', async () => {
    const s = await setup();
    const ks = await createKnowledgeSource(s.a, {
      kind: 'text',
      title: 'Lost',
      textExcerpt: 'Install in two coats.',
      scope: { kind: 'workspace' },
    });
    const [job] = await jobsOf(ks.id);
    const q = new RecordingQueue();
    expect((await runKnowledgeIndexSweep(new Date(), q)).enqueued).toBe(0); // fresh
    expect((await runKnowledgeIndexSweep(new Date(Date.now() + minutes(3)), q)).enqueued).toBe(1); // lost
    expect(q.enqueued[0]).toMatchObject({
      type: KNOWLEDGE_INDEX_JOB,
      payload: { jobId: job!.id.toString(), workspaceId: s.a.workspaceId.toString() },
    });
  });

  it('[handbook H-35] retries a transient failure with backoff, then fails once with one notification', async () => {
    const s = await setup();
    const ks = await createKnowledgeSource(s.a, {
      kind: 'text',
      title: 'Flaky',
      textExcerpt: 'Install in two coats.',
      scope: { kind: 'workspace' },
    });
    const [job] = await jobsOf(ks.id);
    embedder.failNext = 99;
    let now = Date.now();
    const clock = { now: () => new Date(now) };
    const q = new RecordingQueue();

    const first = await runKnowledgeIndexJob(s.a, job!.id, clock);
    expect(first.kind).toBe('retrying');
    let [row] = await jobsOf(ks.id);
    expect(row).toMatchObject({ status: 'queued', attempts: 1, error: 'embedding provider timed out' });
    expect(row!.nextAttemptAt!.getTime() - now).toBe(minutes(1));
    expect(await sourceRow(ks.id)).toMatchObject({
      indexStatus: 'queued',
      lastIndexError: 'embedding provider timed out',
    });
    // Not due yet: not run, not re-enqueued.
    expect(await runKnowledgeIndexJob(s.a, job!.id, clock)).toEqual({ kind: 'skipped', reason: 'not_due' });
    expect((await runKnowledgeIndexSweep(new Date(now + 30_000), q)).enqueued).toBe(0);

    for (const delay of [1, 2, 4]) {
      now += minutes(delay);
      expect((await runKnowledgeIndexSweep(new Date(now), q)).enqueued).toBe(1);
      q.enqueued.length = 0;
      await runKnowledgeIndexJob(s.a, job!.id, clock);
    }
    [row] = await jobsOf(ks.id);
    expect(row).toMatchObject({ status: 'failed', attempts: MAX_INDEX_ATTEMPTS });
    expect((await sourceRow(ks.id)).indexStatus).toBe('failed');
    expect(await failureNotices(s.a.workspaceId)).toHaveLength(1);
    expect(embedder.calls).toBe(MAX_INDEX_ATTEMPTS);
  });

  it('a deterministic failure (no OCR key) fails at once, without retries', async () => {
    const s = await setup();
    _setOcrProviderForTests(null);
    const doc = await uploadScan(s.a);
    const ks = await createKnowledgeSource(s.a, {
      kind: 'document',
      title: 'Scan',
      documentId: doc.id,
      scope: { kind: 'workspace' },
    });
    await runQueuedIndexJobs(s.a);
    const [row] = await jobsOf(ks.id);
    expect(row).toMatchObject({ status: 'failed', attempts: 1 });
    expect(row!.error).toMatch(/Mistral API key/);
    expect((await sourceRow(ks.id)).indexStatus).toBe('failed');
    expect(await failureNotices(s.a.workspaceId)).toHaveLength(1);
  });

  it('knowledge.index.sweep is registered as a 2-minute repeatable and knowledge.index has a handler', async () => {
    const q = new RecordingQueue();
    const previous = getJobQueue();
    _setJobQueueForTests(q);
    _resetRepeatablesForTests();
    try {
      await registerRepeatableJobs();
      expect(q.schedules).toContainEqual({
        type: KNOWLEDGE_INDEX_SWEEP_JOB,
        everyMs: KNOWLEDGE_INDEX_SWEEP_TICK_MS,
      });
      expect(KNOWLEDGE_INDEX_SWEEP_TICK_MS).toBe(2 * 60 * 1000);
    } finally {
      _setJobQueueForTests(previous);
      _resetRepeatablesForTests();
    }
  });
});

// ---- acceptance 5 -----------------------------------------------------------------

describe('acceptance 5 — the upload returns before extraction', () => {
  it('returns with a queued job enqueued while OCR has not finished; the job then indexes it', async () => {
    const s = await setup();
    const q = new WatchedQueue();
    const previous = getJobQueue();
    _setJobQueueForTests(q);
    _resetHandlersForTests();
    registerJobHandlers();
    let release!: () => void;
    ocr.gate = new Promise<void>((r) => (release = r));
    try {
      const page = await DocumentsPage({ searchParams: Promise.resolve({}) });
      const [uploadAction] = formActions(page);
      const fd = new FormData();
      fd.append('file', pdfFile());
      fd.append('productProfileIds', s.products[0]!.toString());
      const target = await expectRedirect(() => uploadAction!(fd));
      // The action has returned: nothing extracted, embedded or OCR-billed yet.
      expect(decodeURIComponent(target)).toContain('Indexing in the background');
      const docId = BigInt(/\/documents\/(\d+)/.exec(target)![1]!);
      expect(ocr.calls).toBe(0);
      expect(embedder.calls).toBe(0);
      expect(await ocrUsageRows(s.a.workspaceId)).toHaveLength(0);
      const [doc] = await db.select().from(documents).where(eq(documents.id, docId));
      expect(doc!.extractedAt).toBeNull();
      const [src] = await listDocumentSources(s.a, docId);
      expect(['queued', 'indexing']).toContain(src!.source.indexStatus);
      const [job] = await jobsOf(src!.source.id);
      expect(job).toMatchObject({ reason: 'create' });
      expect(['queued', 'running']).toContain(job!.status);
      expect(q.enqueued).toContainEqual({
        type: KNOWLEDGE_INDEX_JOB,
        payload: expect.objectContaining({ jobId: job!.id.toString() }),
      });
      // The document page shows the status and polls.
      const html = await renderToHtml(
        await DocumentDetail({
          params: Promise.resolve({ id: docId.toString() }),
          searchParams: Promise.resolve({}),
        }),
      );
      expect(html).toContain('data-auto-refresh="knowledge-index"');

      release();
      await q.drain();
      expect(ocr.calls).toBe(1);
      expect((await sourceRow(src!.source.id)).indexStatus).toBe('indexed');
      expect((await jobsOf(src!.source.id))[0]!.status).toBe('succeeded');
    } finally {
      release();
      await q.drain();
      ocr.gate = null;
      _setJobQueueForTests(previous);
      _resetHandlersForTests();
    }
  });

  it('a file type with no text is not queued: the source says why', async () => {
    const s = await setup();
    const page = await DocumentsPage({ searchParams: Promise.resolve({}) });
    const [uploadAction] = formActions(page);
    const fd = new FormData();
    fd.append('file', new File([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2])], 'logo.png', { type: 'image/png' }));
    const target = await expectRedirect(() => uploadAction!(fd));
    expect(decodeURIComponent(target)).toContain('Not indexed automatically');
    const docId = BigInt(/\/documents\/(\d+)/.exec(target)![1]!);
    const [src] = await listDocumentSources(s.a, docId);
    expect(src!.source.indexStatus).toBe('failed');
    expect(src!.source.lastIndexError).toContain('has no text to extract');
    expect(await jobsOf(src!.source.id)).toHaveLength(0);
  });

  it('requests coalesce into one queued run; another run holding the source defers it', async () => {
    const s = await setup();
    const ks = await createKnowledgeSource(s.a, {
      kind: 'text',
      title: 'Coalesce',
      textExcerpt: 'Install in two coats.',
      scope: { kind: 'workspace' },
    });
    const a = await requestKnowledgeIndex(s.a, ks.id);
    const b = await requestKnowledgeIndex(s.a, ks.id);
    expect(b.id).toBe(a.id);
    expect((await jobsOf(ks.id)).filter((j) => j.status === 'queued')).toHaveLength(1);

    // A second, older row holds the source.
    await db.insert(indexingJobs).values({
      workspaceId: s.a.workspaceId,
      knowledgeSourceId: ks.id,
      status: 'running',
      startedAt: new Date(),
      attempts: 1,
    });
    const now = new Date();
    expect(await runKnowledgeIndexJob(s.a, a.id, { now: () => now })).toEqual({
      kind: 'skipped',
      reason: 'busy',
    });
    const [deferred] = await db.select().from(indexingJobs).where(eq(indexingJobs.id, a.id));
    expect(deferred!.status).toBe('queued');
    expect(deferred!.nextAttemptAt!.getTime()).toBe(now.getTime() + 60_000);
    // The database refuses a second running row for the source.
    await expect(
      db.insert(indexingJobs).values({
        workspaceId: s.a.workspaceId,
        knowledgeSourceId: ks.id,
        status: 'running',
      }),
    ).rejects.toThrow();
  });
});

// ---- Re-extract with OCR ----------------------------------------------------------

describe('Re-extract with OCR (admin, with the cost)', () => {
  it('shows the cost, is admin-only, OCRs once for the request and re-indexes', async () => {
    const s = await setup();
    pdf.text = OCR_TEXT.replace(/Vetrofluid/g, 'Textlayer');
    const doc = await uploadScan(s.a, 'datasheet.pdf', 'text-layer');
    const ks = await createKnowledgeSource(s.a, {
      kind: 'document',
      title: 'Datasheet',
      documentId: doc.id,
      scope: { kind: 'workspace' },
    });
    await runQueuedIndexJobs(s.a);
    expect(ocr.calls).toBe(0); // a text layer: no OCR
    const [cached] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(cached).toMatchObject({ extractor: 'pdf', pageCount: 3 });

    const estimate = await estimateDocumentOcr(s.a, cached!);
    expect(estimate).toMatchObject({ available: true, pages: 3, costCents: 1, keySource: 'platform' });
    expect(describeOcrCost(estimate)).toBe(
      'About 3 pages, estimated 1¢ (charged to your token balance).',
    );
    const html = await renderToHtml(
      await DocumentDetail({
        params: Promise.resolve({ id: doc.id.toString() }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('Re-extract with OCR');
    expect(html).toContain('About 3 pages, estimated 1¢');
    expect(html).toContain('data-testid="extraction"');

    await expect(requestDocumentOcrReextract(s.member, doc.id)).rejects.toMatchObject({
      code: 'permission_denied',
    });
    const { jobs } = await requestDocumentOcrReextract(s.a, doc.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ forceOcr: true, reason: 'reextract_ocr', status: 'queued' });
    await runQueuedIndexJobs(s.a);
    expect(ocr.calls).toBe(1);
    const usage = await ocrUsageRows(s.a.workspaceId);
    expect(usage).toHaveLength(1);
    expect((usage[0]!.payload as Record<string, unknown>).forced).toBe(true);
    const [after] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(after!.extractor).toBe('ocr:mistral/mistral-ocr-latest');
    const served = await retrieve(s.a, 'technical data sheet', {});
    expect(served.map((r) => r.chunk.content).join(' ')).toContain('Vetrofluid');
    expect((await sourceRow(ks.id)).indexStatus).toBe('indexed');

    // A later plain re-index reuses the OCR text: no second paid run.
    await requestKnowledgeIndex(s.a, ks.id);
    await runQueuedIndexJobs(s.a);
    expect(ocr.calls).toBe(1);
  });

  it('is unavailable without an OCR key, and says so', async () => {
    const s = await setup();
    pdf.text = OCR_TEXT;
    const doc = await uploadScan(s.a, 'datasheet.pdf', 'text-layer');
    await createKnowledgeSource(s.a, {
      kind: 'document',
      title: 'Datasheet',
      documentId: doc.id,
      scope: { kind: 'workspace' },
    });
    await runQueuedIndexJobs(s.a);
    _setOcrProviderForTests(null);
    const html = await renderToHtml(
      await DocumentDetail({
        params: Promise.resolve({ id: doc.id.toString() }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('data-testid="reextract-ocr-unavailable"');
    await expect(requestDocumentOcrReextract(s.a, doc.id)).rejects.toMatchObject({
      code: 'ocr_unavailable',
    });
  });
});

// ---- acceptance 6 -----------------------------------------------------------------

describe('acceptance 6 — deleting needs confirmation and detaches', () => {
  it('the service and the page refuse without the title; with it the source is detached and the counters go down', async () => {
    const s = await setup();
    const spy = new SpyPgvector();
    _setVectorStorageProviderForTests(spy);
    const ks = await createKnowledgeSource(s.a, {
      kind: 'text',
      title: 'Objection handling',
      textExcerpt: 'Compare installed cost per metre, not material cost.',
      scope: { kind: 'products', productProfileIds: [s.products[0]!] },
    });
    await runQueuedIndexJobs(s.a);
    const [store] = await db
      .select()
      .from(productVectorStores)
      .where(eq(productVectorStores.productProfileId, s.products[0]!));
    expect(store!.fileCount).toBe(1);
    expect(store!.usageBytes).toBeGreaterThan(0);

    for (const confirm of ['', 'objection handling', 'Something else']) {
      await expect(deleteKnowledgeSource(s.a, ks.id, { confirm })).rejects.toMatchObject({
        code: 'confirmation_required',
      });
    }
    // The page's delete form requires the typed title...
    const tree = await KnowledgeSourceDetail({
      params: Promise.resolve({ id: ks.id.toString() }),
      searchParams: Promise.resolve({}),
    });
    const html = await renderToHtml(tree);
    const confirmInput = /data-testid="delete-source"[\s\S]*?(<input[^>]*name="confirm"[^>]*>)/.exec(
      html,
    )?.[1];
    expect(confirmInput).toContain('required=""');
    const [, , destroy] = formActions(tree);
    // ...and a submission without it changes nothing.
    const refused = await expectRedirect(() => destroy!(new FormData()));
    expect(decodeURIComponent(refused)).toContain('Type the source title');
    expect(await sourceRow(ks.id)).toBeDefined();
    expect(spy.detached).toEqual([]);

    const fd = new FormData();
    fd.append('confirm', 'Objection handling');
    const done = await expectRedirect(() => destroy!(fd));
    expect(done.startsWith('/knowledge?')).toBe(true);
    expect(await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, ks.id))).toEqual([]);
    expect(spy.detached).toEqual([ks.id]);
    const [after] = await db
      .select()
      .from(productVectorStores)
      .where(eq(productVectorStores.productProfileId, s.products[0]!));
    expect(after).toMatchObject({ fileCount: 0, usageBytes: 0 });
  });

  it('members cannot delete; the inline index API still works for scripts', async () => {
    const s = await setup();
    const ks = await createKnowledgeSource(s.a, {
      kind: 'text',
      title: 'Keep',
      textExcerpt: 'Install in two coats.',
      scope: { kind: 'workspace' },
    });
    await expect(deleteKnowledgeSource(s.member, ks.id, { confirm: 'Keep' })).rejects.toMatchObject({
      code: 'permission_denied',
    });
    // indexKnowledgeSource runs the same job inline (reusing the queued row).
    const r = await indexKnowledgeSource(s.a, ks.id);
    expect(r.job.status).toBe('succeeded');
    expect(await jobsOf(ks.id)).toHaveLength(1);
  });
});
