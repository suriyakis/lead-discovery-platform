// File storage abstraction.
//
// Phase 1: local filesystem. Phase 9 added an S3-compatible implementation
// (works against AWS S3, Hetzner Object Storage, Cloudflare R2, MinIO, etc.).
// Selection at boot via STORAGE_PROVIDER env (`local` | `s3`).
//
// The interface is intentionally narrow. We add `list` / `copy` / etc. when
// a real caller needs them.

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface StorageMeta {
  contentType?: string;
  /** Free-form headers stored alongside (S3) or ignored (local). */
  headers?: Record<string, string>;
}

export interface SignedUrlOptions {
  expiresInSeconds?: number;
  /** Content-Disposition forced on the response. Local impl ignores. */
  download?: boolean;
}

export interface IStorage {
  readonly id: string;
  put(key: string, body: Buffer | Readable, meta?: StorageMeta): Promise<void>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  signedUrl(key: string, options?: SignedUrlOptions): Promise<string>;
  exists(key: string): Promise<boolean>;
}

// ---- local filesystem implementation -----------------------------------

export class LocalFileStorage implements IStorage {
  public readonly id = 'local';
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async put(key: string, body: Buffer | Readable, _meta?: StorageMeta): Promise<void> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    const stream = body instanceof Buffer ? Readable.from(body) : body;
    await pipeline(stream, createWriteStream(target));
  }

  async get(key: string): Promise<Readable> {
    const target = this.resolve(key);
    return createReadStream(target);
  }

  async delete(key: string): Promise<void> {
    const target = this.resolve(key);
    await rm(target, { force: true });
  }

  async signedUrl(key: string, _options: SignedUrlOptions = {}): Promise<string> {
    // Local impl returns a file:// URL. Production paths use S3 presigned URLs.
    return `file://${this.resolve(key)}`;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch (err) {
      if (
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: string }).code === 'ENOENT'
      ) {
        return false;
      }
      throw err;
    }
  }

  private resolve(key: string): string {
    // Disallow `..` traversal — keys must stay inside the storage root.
    const normalized = path.posix.normalize(key.replace(/\\/g, '/'));
    if (normalized.startsWith('..') || normalized.includes('/../')) {
      throw new Error(`Storage key escapes root: ${key}`);
    }
    return path.join(this.root, normalized);
  }
}

// ---- factory -----------------------------------------------------------

let cached: IStorage | null = null;

export function getStorage(): IStorage {
  if (cached) return cached;
  const id = process.env.STORAGE_PROVIDER ?? 'local';
  switch (id) {
    case 'local': {
      const root = process.env.STORAGE_LOCAL_ROOT ?? './storage';
      cached = new LocalFileStorage(root);
      return cached;
    }
    case 's3': {
      // Lazy-import so the AWS SDK is not loaded when the local provider is
      // used (saves cold-start time + memory).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { S3Storage } = require('./s3') as typeof import('./s3');
      cached = S3Storage.fromEnv();
      return cached;
    }
    default:
      throw new Error(`Unknown STORAGE_PROVIDER: ${id}. Supported: "local" | "s3".`);
  }
}

export function _setStorageForTests(storage: IStorage | null): void {
  cached = storage;
}
