import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockAIProvider } from '@/lib/ai';
import { InMemoryJobQueue, type JobStatus } from '@/lib/jobs';
import { MockSearchProvider } from '@/lib/search';
import { LocalFileStorage } from '@/lib/storage';

describe('MockAIProvider.generateText', () => {
  const ai = new MockAIProvider();

  it('is deterministic for the same input', async () => {
    const a = await ai.generateText({ prompt: 'hello world' });
    const b = await ai.generateText({ prompt: 'hello world' });
    expect(a.text).toBe(b.text);
    expect(a.model).toBe('mock-1');
  });

  it('produces different output for different prompts', async () => {
    const a = await ai.generateText({ prompt: 'apple' });
    const b = await ai.generateText({ prompt: 'banana' });
    expect(a.text).not.toBe(b.text);
  });

  it('honors mockSeed override', async () => {
    const a = await ai.generateText({ prompt: 'x' }, { mockSeed: 'fixed-seed' });
    const b = await ai.generateText({ prompt: 'completely different' }, { mockSeed: 'fixed-seed' });
    // Same seed → same hash prefix in output.
    expect(a.text.split(': ')[0]).toBe(b.text.split(': ')[0]);
  });
});

describe('MockAIProvider.generateJson', () => {
  const ai = new MockAIProvider();

  it('parses a JSON-shaped prompt against the schema', async () => {
    const schema = z.object({ name: z.string(), count: z.number() });
    const result = await ai.generateJson(
      { prompt: '{"name":"x","count":3}' },
      schema,
    );
    expect(result).toEqual({ name: 'x', count: 3 });
  });

  it('falls back to schema default when input is empty-shaped', async () => {
    const schema = z.object({ tag: z.string().default('mock') });
    const result = await ai.generateJson({ prompt: 'not json' }, schema);
    expect(result).toEqual({ tag: 'mock' });
  });

  it('throws when input is not JSON and schema has required fields', async () => {
    const schema = z.object({ name: z.string() });
    await expect(ai.generateJson({ prompt: 'free text' }, schema)).rejects.toThrow();
  });
});

describe('MockSearchProvider', () => {
  const search = new MockSearchProvider();
  const ctx = {
    workspaceId: 1n,
    userId: 'test-user',
    role: 'owner' as const,
  };

  it('returns the requested number of results, capped', async () => {
    const r3 = await search.search(ctx, 'q', { maxResults: 3 });
    expect(r3.results).toHaveLength(3);
    const r60 = await search.search(ctx, 'q', { maxResults: 60 });
    expect(r60.results).toHaveLength(50);
    const rDefault = await search.search(ctx, 'q');
    expect(rDefault.results).toHaveLength(5);
  });

  it('returns usage with mock keySource and zero cost', async () => {
    const r = await search.search(ctx, 'q');
    expect(r.usage.keySource).toBe('mock');
    expect(r.usage.costEstimateCents).toBe(0);
    expect(r.usage.units).toBe(1);
  });

  it('is deterministic for the same query', async () => {
    const a = await search.search(ctx, 'foo', { maxResults: 5 });
    const b = await search.search(ctx, 'foo', { maxResults: 5 });
    expect(a.results).toEqual(b.results);
  });

  it('differs across queries', async () => {
    const a = await search.search(ctx, 'apple', { maxResults: 1 });
    const b = await search.search(ctx, 'banana', { maxResults: 1 });
    expect(a.results[0]?.url).not.toBe(b.results[0]?.url);
  });
});

describe('InMemoryJobQueue', () => {
  it('runs a handler asynchronously and reports succeeded', async () => {
    const q = new InMemoryJobQueue();
    q.on<{ x: number }>('double', ({ x }) => x * 2);
    const id = await q.enqueue('double', { x: 21 });

    // Status starts pending; after a tick it succeeds.
    let status: JobStatus = await q.status(id);
    while (status.state === 'pending' || status.state === 'running') {
      await new Promise((r) => setTimeout(r, 1));
      status = await q.status(id);
    }
    expect(status.state).toBe('succeeded');
    if (status.state === 'succeeded') expect(status.result).toBe(42);
  });

  it('captures handler errors as failed', async () => {
    const q = new InMemoryJobQueue();
    q.on('boom', () => {
      throw new Error('kaboom');
    });
    const id = await q.enqueue('boom', {});
    let status: JobStatus = await q.status(id);
    while (status.state === 'pending' || status.state === 'running') {
      await new Promise((r) => setTimeout(r, 1));
      status = await q.status(id);
    }
    expect(status.state).toBe('failed');
    if (status.state === 'failed') expect(status.error.message).toBe('kaboom');
  });

  it('cancels a pending job before its handler runs', async () => {
    const q = new InMemoryJobQueue();
    // No handler registered, so the job stays pending.
    const id = await q.enqueue('nohandler', {});
    await q.cancel(id);
    const status = await q.status(id);
    expect(status.state).toBe('cancelled');
  });

  it('returns unknown for missing job ids', async () => {
    const q = new InMemoryJobQueue();
    const status = await q.status('does-not-exist');
    expect(status.state).toBe('unknown');
  });
});

describe('LocalFileStorage', () => {
  let dir: string;
  let storage: LocalFileStorage;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'lead-storage-'));
    storage = new LocalFileStorage(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a Buffer body', async () => {
    await storage.put('a/b.txt', Buffer.from('hello'));
    expect(await storage.exists('a/b.txt')).toBe(true);
    const stream = await storage.get('a/b.txt');
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe('hello');
  });

  it('round-trips a stream body', async () => {
    await storage.put('s.txt', Readable.from(Buffer.from('streamed')));
    const stream = await storage.get('s.txt');
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe('streamed');
  });

  it('delete removes the file', async () => {
    await storage.put('rm.txt', Buffer.from('x'));
    expect(await storage.exists('rm.txt')).toBe(true);
    await storage.delete('rm.txt');
    expect(await storage.exists('rm.txt')).toBe(false);
  });

  it('rejects path traversal keys', async () => {
    await expect(storage.put('../escape', Buffer.from('x'))).rejects.toThrow(/escapes root/);
    await expect(storage.put('a/../../escape', Buffer.from('x'))).rejects.toThrow(/escapes root/);
  });

  it('signedUrl returns a file:// URL for the local impl', async () => {
    await storage.put('s.txt', Buffer.from('x'));
    const url = await storage.signedUrl('s.txt');
    expect(url.startsWith('file://')).toBe(true);
  });
});
