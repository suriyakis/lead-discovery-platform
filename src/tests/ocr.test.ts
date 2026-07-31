// OCR provider unit tests: Mistral client request/response handling and
// the key-cascade factory. The RAG routing integration (scanned PDF →
// OCR fallback) lives in ocr-routing.test.ts, which module-mocks
// pdf-parse.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db/client';
import { makeWorkspaceContext } from '@/lib/services/context';
import { setSecret } from '@/lib/services/secrets';
import {
  MistralOcrProvider,
  _setOcrProviderForTests,
  estimateOcrCostCents,
  getOcrProviderForCtx,
} from '@/lib/ocr';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

beforeEach(async () => {
  await truncateAll();
  _setOcrProviderForTests(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MISTRAL_API_KEY;
  _setOcrProviderForTests(null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('MistralOcrProvider', () => {
  it('sends the PDF as a base64 data-url and joins page markdown', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(
        JSON.stringify({
          model: 'mistral-ocr-latest',
          pages: [
            { index: 0, markdown: 'Page one text.' },
            { index: 1, markdown: 'Page two text.' },
          ],
          usage_info: { pages_processed: 2 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const p = new MistralOcrProvider({ apiKey: 'mk-test' });
    const result = await p.extractPdfText(Buffer.from('%PDF-fake'), 'scan.pdf');

    expect(result.text).toBe('Page one text.\n\nPage two text.');
    expect(result.pages).toBe(2);
    expect(result.model).toBe('mistral-ocr-latest');

    expect(captured!.url).toBe('https://api.mistral.ai/v1/ocr');
    const sentBody = JSON.parse(String(captured!.init.body)) as {
      model: string;
      document: { type: string; document_url: string };
    };
    expect(sentBody.model).toBe('mistral-ocr-latest');
    expect(sentBody.document.type).toBe('document_url');
    expect(sentBody.document.document_url.startsWith('data:application/pdf;base64,')).toBe(
      true,
    );
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer mk-test');
  });

  it('throws a typed error on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response('{"message":"invalid key"}', { status: 401 }),
    );
    const p = new MistralOcrProvider({ apiKey: 'mk-bad' });
    await expect(
      p.extractPdfText(Buffer.from('%PDF-fake'), 'scan.pdf'),
    ).rejects.toMatchObject({ code: 'api_error' });
  });

  it('rejects oversized buffers before any network call', async () => {
    let called = false;
    vi.stubGlobal('fetch', async () => {
      called = true;
      return new Response('{}', { status: 200 });
    });
    const p = new MistralOcrProvider({ apiKey: 'mk-test' });
    await expect(
      p.extractPdfText(Buffer.alloc(41 * 1024 * 1024), 'huge.pdf'),
    ).rejects.toMatchObject({ code: 'too_large' });
    expect(called).toBe(false);
  });
});

describe('getOcrProviderForCtx', () => {
  it('returns null when no key is configured anywhere', async () => {
    const owner = await seedUser({ email: 'ocr-owner@test.local' });
    const ws = await seedWorkspace({ name: 'OCR', ownerUserId: owner });
    const resolved = await getOcrProviderForCtx({ workspaceId: ws });
    expect(resolved).toBeNull();
  });

  it('resolves the env key as platform source', async () => {
    const owner = await seedUser({ email: 'ocr-owner@test.local' });
    const ws = await seedWorkspace({ name: 'OCR', ownerUserId: owner });
    process.env.MISTRAL_API_KEY = 'mk-env';
    const resolved = await getOcrProviderForCtx({ workspaceId: ws });
    expect(resolved).not.toBeNull();
    expect(resolved!.provider).toBeInstanceOf(MistralOcrProvider);
    expect(resolved!.keySource).toBe('platform');
  });

  it('prefers the workspace BYOK key (source workspace)', async () => {
    const owner = await seedUser({ email: 'ocr-owner@test.local' });
    const ws = await seedWorkspace({ name: 'OCR', ownerUserId: owner });
    process.env.MISTRAL_API_KEY = 'mk-env';
    await setSecret(
      makeWorkspaceContext({ workspaceId: ws, userId: owner, role: 'owner' }),
      'mistral.apiKey',
      'mk-workspace',
    );
    const resolved = await getOcrProviderForCtx({ workspaceId: ws });
    expect(resolved!.keySource).toBe('workspace');
  });
});

describe('estimateOcrCostCents', () => {
  it('charges 0.1 cents per page, rounded up', () => {
    expect(estimateOcrCostCents(0)).toBe(0);
    expect(estimateOcrCostCents(1)).toBe(1); // ceil(0.1)
    expect(estimateOcrCostCents(10)).toBe(1);
    expect(estimateOcrCostCents(25)).toBe(3); // ceil(2.5)
    expect(estimateOcrCostCents(1000)).toBe(100);
  });
});
