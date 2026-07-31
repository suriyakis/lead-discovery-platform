// RAG → OCR auto-routing: an image-based (scanned) PDF — one that
// pdf-parse "parses" but yields no text from — must fall back to the
// configured OCR provider automatically, meter the pages, and fail
// with configuration instructions when no OCR key exists.
//
// pdf-parse is module-mocked to simulate the scanned case: real
// scanner-produced PDFs parse fine and simply contain no text
// operators, which is indistinguishable from this mock's output.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { usageLog } from '@/lib/db/schema/audit';
import { documentChunks } from '@/lib/db/schema/rag';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { uploadDocument } from '@/lib/services/documents';
import { indexDocument } from '@/lib/services/rag';
import { _setOcrProviderForTests, type IOcrProvider } from '@/lib/ocr';
import {
  MockEmbeddingProvider,
  _setEmbeddingProviderForTests,
} from '@/lib/embeddings';
import { LocalFileStorage, _setStorageForTests } from '@/lib/storage';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

vi.mock('pdf-parse/lib/pdf-parse.js', () => ({
  // A scanned PDF: parse succeeds, no text layer.
  default: async () => ({ text: '' }),
}));

function ctx(
  workspaceId: bigint,
  userId: string,
  role: WorkspaceContext['role'] = 'owner',
): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

let storageRoot: string;
const embedder = new MockEmbeddingProvider();

beforeEach(async () => {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'lead-ocr-test-'));
  _setStorageForTests(new LocalFileStorage(storageRoot));
  _setEmbeddingProviderForTests(embedder);
  _setOcrProviderForTests(null);
  await truncateAll();
});

afterEach(async () => {
  _setStorageForTests(null);
  _setEmbeddingProviderForTests(null);
  _setOcrProviderForTests(null);
  delete process.env.MISTRAL_API_KEY;
  await rm(storageRoot, { recursive: true, force: true });
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

async function uploadScan(workspaceId: bigint, ownerId: string) {
  return uploadDocument(ctx(workspaceId, ownerId), {
    filename: 'scanned-brochure.pdf',
    mimeType: 'application/pdf',
    body: Buffer.from('%PDF-1.4 pretend-scanned-bytes'),
  });
}

describe('scanned-PDF OCR auto-routing', () => {
  it('routes to the OCR provider, indexes its text, and meters the pages', async () => {
    const owner = await seedUser({ email: 'scan-owner@test.local' });
    const ws = await seedWorkspace({ name: 'Scan', ownerUserId: owner });
    const { document } = await uploadScan(ws, owner);

    const seen: string[] = [];
    const stub: IOcrProvider = {
      id: 'mistral',
      model: 'mistral-ocr-latest',
      async extractPdfText(_buffer, filename) {
        seen.push(filename);
        return {
          text: 'OCR recovered: Vetrofluid technical data sheet. Waterproofing for concrete surfaces, applied in two coats.',
          pages: 3,
          model: 'mistral-ocr-latest',
        };
      },
    };
    _setOcrProviderForTests(stub);

    const result = await indexDocument(ctx(ws, owner), document.id);
    expect(seen).toEqual(['scanned-brochure.pdf']);
    expect(result.chunkCount).toBeGreaterThan(0);

    const chunks = await db
      .select()
      .from(documentChunks)
      .where(eq(documentChunks.workspaceId, ws));
    expect(chunks.some((c) => c.content.includes('Vetrofluid technical data sheet'))).toBe(
      true,
    );

    const usage = await db
      .select()
      .from(usageLog)
      .where(eq(usageLog.workspaceId, ws));
    const ocrRow = usage.find((u) => u.kind === 'ocr.pdf');
    expect(ocrRow).toBeDefined();
    expect(ocrRow!.provider).toBe('mistral');
    expect(ocrRow!.units).toBe(3n);
    expect(ocrRow!.costEstimateCents).toBe(1); // ceil(3 × 0.1)
    expect((ocrRow!.payload as Record<string, unknown>).keySource).toBe('platform');
  });

  it('fails with configuration instructions when no OCR key exists', async () => {
    const owner = await seedUser({ email: 'scan-owner@test.local' });
    const ws = await seedWorkspace({ name: 'Scan', ownerUserId: owner });
    const { document } = await uploadScan(ws, owner);

    await expect(indexDocument(ctx(ws, owner), document.id)).rejects.toThrow(
      /Mistral API key/,
    );
    const chunks = await db
      .select()
      .from(documentChunks)
      .where(eq(documentChunks.workspaceId, ws));
    expect(chunks).toHaveLength(0);
  });

  it('surfaces an honest error when OCR itself finds nothing', async () => {
    const owner = await seedUser({ email: 'scan-owner@test.local' });
    const ws = await seedWorkspace({ name: 'Scan', ownerUserId: owner });
    const { document } = await uploadScan(ws, owner);

    _setOcrProviderForTests({
      id: 'mistral',
      model: 'mistral-ocr-latest',
      async extractPdfText() {
        return { text: '', pages: 2, model: 'mistral-ocr-latest' };
      },
    });
    await expect(indexDocument(ctx(ws, owner), document.id)).rejects.toThrow(
      /no readable text/,
    );
  });
});
