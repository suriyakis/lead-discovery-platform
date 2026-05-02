import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { LocalFileStorage } from '@/lib/storage';

describe('LocalFileStorage', () => {
  let root: string;
  let storage: LocalFileStorage;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'lead-storage-'));
    storage = new LocalFileStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('put + get round-trips a Buffer', async () => {
    await storage.put('a/b.txt', Buffer.from('hello world'));
    const stream = await storage.get('a/b.txt');
    const text = await readToString(stream);
    expect(text).toBe('hello world');
  });

  it('put accepts a Readable stream', async () => {
    await storage.put('stream.bin', Readable.from('streaming-bytes'));
    const stream = await storage.get('stream.bin');
    const text = await readToString(stream);
    expect(text).toBe('streaming-bytes');
  });

  it('exists reflects presence', async () => {
    expect(await storage.exists('missing.txt')).toBe(false);
    await storage.put('present.txt', Buffer.from('x'));
    expect(await storage.exists('present.txt')).toBe(true);
  });

  it('delete removes the file', async () => {
    await storage.put('to-delete.txt', Buffer.from('y'));
    expect(await storage.exists('to-delete.txt')).toBe(true);
    await storage.delete('to-delete.txt');
    expect(await storage.exists('to-delete.txt')).toBe(false);
  });

  it('rejects keys that escape the root', async () => {
    await expect(
      storage.put('../../etc/passwd', Buffer.from('nope')),
    ).rejects.toThrow(/escapes root/);
  });

  it('signedUrl returns a file:// URL pointing inside the root', async () => {
    await storage.put('file.txt', Buffer.from('z'));
    const url = await storage.signedUrl('file.txt');
    expect(url.startsWith('file://')).toBe(true);
    expect(url).toContain(root.replace(/\\/g, '/'));
  });

  it('id is "local"', () => {
    expect(storage.id).toBe('local');
  });
});

describe('S3Storage.fromEnv()', () => {
  // We exercise only configuration parsing — no real S3 calls. A misconfigured
  // factory should fail loudly; a configured one should return an object with
  // id='s3' and the IStorage method shape.
  const ENV_KEYS = [
    'S3_BUCKET',
    'S3_REGION',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_ENDPOINT',
    'S3_FORCE_PATH_STYLE',
    'S3_PUBLIC_BASE_URL',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('throws when required env is missing', async () => {
    const { S3Storage } = await import('@/lib/storage/s3');
    expect(() => S3Storage.fromEnv()).toThrow(/S3_BUCKET/);
  });

  it('builds the client when full env is present (custom endpoint)', async () => {
    process.env.S3_BUCKET = 'b';
    process.env.S3_REGION = 'eu-central-1';
    process.env.S3_ACCESS_KEY_ID = 'AKIA';
    process.env.S3_SECRET_ACCESS_KEY = 's3cret';
    process.env.S3_ENDPOINT = 'https://hel1.your-objectstorage.com';
    const { S3Storage } = await import('@/lib/storage/s3');
    const s = S3Storage.fromEnv();
    expect(s.id).toBe('s3');
    expect(typeof s.put).toBe('function');
    expect(typeof s.get).toBe('function');
    expect(typeof s.delete).toBe('function');
    expect(typeof s.signedUrl).toBe('function');
    expect(typeof s.exists).toBe('function');
  });

  it('falls back to AWS_ACCESS_KEY_ID when S3_ACCESS_KEY_ID is unset', async () => {
    process.env.S3_BUCKET = 'b';
    process.env.S3_REGION = 'us-east-1';
    process.env.AWS_ACCESS_KEY_ID = 'AKIA-fallback';
    process.env.AWS_SECRET_ACCESS_KEY = 'fallback-secret';
    const { S3Storage } = await import('@/lib/storage/s3');
    const s = S3Storage.fromEnv();
    expect(s.id).toBe('s3');
  });

  it('signedUrl with S3_PUBLIC_BASE_URL returns a public URL (no presign)', async () => {
    process.env.S3_BUCKET = 'b';
    process.env.S3_REGION = 'us-east-1';
    process.env.S3_ACCESS_KEY_ID = 'k';
    process.env.S3_SECRET_ACCESS_KEY = 's';
    process.env.S3_PUBLIC_BASE_URL = 'https://cdn.example.com/bucket';
    const { S3Storage } = await import('@/lib/storage/s3');
    const s = S3Storage.fromEnv();
    const url = await s.signedUrl('a/b.png');
    expect(url).toBe('https://cdn.example.com/bucket/a/b.png');
  });
});

async function readToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
