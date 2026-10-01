import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  LocalFileStorage,
  StorageObjectNotFoundError,
  StorageUrlUnavailableError,
} from '@/lib/storage';
import {
  attachmentDisposition,
  safeContentType,
  storageDownloadResponse,
} from '@/lib/storage/download';

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

  // KL-11 / I106: file://<server path> was unopenable in a browser and
  // printed the server's storage path into the page.
  it('signedUrl refuses instead of returning a file:// URL', async () => {
    await storage.put('file.txt', Buffer.from('z'));
    const err = await storage.signedUrl('file.txt').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageUrlUnavailableError);
    expect(String((err as Error).message)).not.toContain('file://');
    expect(String((err as Error).message)).not.toContain(root);
  });

  it('signedUrl still rejects keys that escape the root', async () => {
    await expect(storage.signedUrl('../../etc/passwd')).rejects.toThrow(/escapes root/);
  });

  it('get of a missing key rejects up front with StorageObjectNotFoundError', async () => {
    const err = await storage.get('nope/missing.pdf').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageObjectNotFoundError);
    expect((err as StorageObjectNotFoundError).key).toBe('nope/missing.pdf');
    // The message is safe to show: no key, no server path.
    expect((err as Error).message).not.toContain('missing.pdf');
    expect((err as Error).message).not.toContain(root);
  });

  it('get streams binary bytes unchanged', async () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await storage.put('bin/all-bytes.bin', bytes);
    const stream = await storage.get('bin/all-bytes.bin');
    const chunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer>) chunks.push(c);
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
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

  it('get maps NoSuchKey to StorageObjectNotFoundError', async () => {
    process.env.S3_BUCKET = 'b';
    process.env.S3_REGION = 'us-east-1';
    process.env.S3_ACCESS_KEY_ID = 'k';
    process.env.S3_SECRET_ACCESS_KEY = 's';
    const { S3Storage } = await import('@/lib/storage/s3');
    const s = S3Storage.fromEnv();
    // Stub the SDK client: no network in tests.
    (s as unknown as { client: { send: () => Promise<never> } }).client.send = async () => {
      throw Object.assign(new Error('The specified key does not exist.'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      });
    };
    await expect(s.get('workspaces/1/documents/x.pdf')).rejects.toBeInstanceOf(
      StorageObjectNotFoundError,
    );
  });

  it('get rethrows other S3 errors unchanged', async () => {
    process.env.S3_BUCKET = 'b';
    process.env.S3_REGION = 'us-east-1';
    process.env.S3_ACCESS_KEY_ID = 'k';
    process.env.S3_SECRET_ACCESS_KEY = 's';
    const { S3Storage } = await import('@/lib/storage/s3');
    const s = S3Storage.fromEnv();
    const denied = Object.assign(new Error('Access Denied'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    (s as unknown as { client: { send: () => Promise<never> } }).client.send = async () => {
      throw denied;
    };
    await expect(s.get('k')).rejects.toBe(denied);
  });
});

// ============ download response helper (KL-11) ==========================

describe('storageDownloadResponse', () => {
  it('streams the bytes as an uncached attachment', async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255, 10, 13]);
    const res = storageDownloadResponse({
      stream: Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]),
      filename: 'price list.pdf',
      contentType: 'application/pdf',
      sizeBytes: bytes.length,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="price list.pdf"; filename*=UTF-8''price%20list.pdf`,
    );
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('content-length')).toBe(String(bytes.length));
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('turns string chunks into bytes and omits an unknown length', async () => {
    const res = storageDownloadResponse({
      stream: Readable.from(['a,b\n', '1,2\n']),
      filename: 'leads.csv',
      contentType: 'text/csv; charset=utf-8',
    });
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(await res.text()).toBe('a,b\n1,2\n');
  });

  it('cancelling the body destroys the source stream', async () => {
    const source = new Readable({ read() {} });
    source.push(Buffer.from('first'));
    const res = storageDownloadResponse({ stream: source, filename: 'x.bin' });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(source.destroyed).toBe(true);
  });
});

describe('attachmentDisposition', () => {
  it('keeps a UTF-8 name in filename* and folds the ASCII fallback', () => {
    expect(attachmentDisposition('Cennik zażółć 2026.pdf')).toBe(
      `attachment; filename="Cennik zazo_c 2026.pdf"; ` +
        `filename*=UTF-8''Cennik%20za%C5%BC%C3%B3%C5%82%C4%87%202026.pdf`,
    );
  });

  it('cannot inject a header, a quote or a path', () => {
    const value = attachmentDisposition('../../a"b\r\nSet-Cookie: x=1%41.txt');
    expect(value).not.toMatch(/[\r\n]/);
    expect(value).toMatch(/^attachment; filename="[^"]*"; filename\*=UTF-8''\S+$/);
    expect(value).not.toContain('/');
    expect(value).toContain('filename=".._.._a_bSet-Cookie: x=1_41.txt"');
  });

  it('falls back to "download" for an empty name', () => {
    expect(attachmentDisposition('  \u0000 ')).toBe(
      `attachment; filename="download"; filename*=UTF-8''download`,
    );
  });
});

describe('safeContentType', () => {
  it('passes plain MIME types and simple parameters through', () => {
    expect(safeContentType('application/pdf')).toBe('application/pdf');
    expect(safeContentType('text/csv; charset=utf-8')).toBe('text/csv; charset=utf-8');
    expect(
      safeContentType('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('replaces empty or malformed types with application/octet-stream', () => {
    expect(safeContentType(null)).toBe('application/octet-stream');
    expect(safeContentType('')).toBe('application/octet-stream');
    expect(safeContentType('pdf')).toBe('application/octet-stream');
    expect(safeContentType('text/html\r\nX-Evil: 1')).toBe('application/octet-stream');
  });
});

async function readToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
