// S3-compatible IStorage implementation.
//
// Works against any S3-compatible service: AWS S3, Hetzner Object Storage,
// Cloudflare R2, MinIO. Configured purely via env so the same code shape
// runs anywhere.
//
// Required env:
//   S3_BUCKET            target bucket name
//   S3_REGION            region (e.g., eu-central-1, auto for some providers)
//   S3_ACCESS_KEY_ID     fall back to AWS_ACCESS_KEY_ID
//   S3_SECRET_ACCESS_KEY fall back to AWS_SECRET_ACCESS_KEY
//
// Optional env:
//   S3_ENDPOINT          custom endpoint URL (Hetzner / R2 / MinIO need this)
//   S3_FORCE_PATH_STYLE  "true" | "false" (default: true when S3_ENDPOINT
//                        is set, false for AWS native — most non-AWS
//                        services require path style)
//   S3_PUBLIC_BASE_URL   if set, signedUrl returns the public URL instead
//                        of a presigned one (for buckets with public read)

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import type { IStorage, SignedUrlOptions, StorageMeta } from './index';

export interface S3StorageConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl?: string;
}

export class S3Storage implements IStorage {
  public readonly id = 's3';
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string | null;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.publicBaseUrl = config.publicBaseUrl?.replace(/\/+$/, '') ?? null;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  static fromEnv(): S3Storage {
    const bucket = required('S3_BUCKET');
    const region = required('S3_REGION');
    const accessKeyId =
      process.env.S3_ACCESS_KEY_ID ?? required('AWS_ACCESS_KEY_ID');
    const secretAccessKey =
      process.env.S3_SECRET_ACCESS_KEY ?? required('AWS_SECRET_ACCESS_KEY');
    const endpoint = process.env.S3_ENDPOINT;
    const forcePathStyle = parseForcePathStyle(
      process.env.S3_FORCE_PATH_STYLE,
      Boolean(endpoint),
    );
    const publicBaseUrl = process.env.S3_PUBLIC_BASE_URL;

    return new S3Storage({
      bucket,
      region,
      endpoint,
      forcePathStyle,
      accessKeyId,
      secretAccessKey,
      publicBaseUrl,
    });
  }

  async put(key: string, body: Buffer | Readable, meta: StorageMeta = {}): Promise<void> {
    // S3 PutObject can stream, but the SDK requires Content-Length when the
    // body is a Readable. For Phase 9, materialize streams to Buffer to keep
    // the contract simple. Real upload paths feed Buffers anyway (form POSTs
    // are buffered before this layer).
    const buffer: Buffer = body instanceof Buffer ? body : await streamToBuffer(body as Readable);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: meta.contentType,
        Metadata: meta.headers,
      }),
    );
  }

  async get(key: string): Promise<Readable> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!result.Body) {
      throw new Error(`s3: GetObject returned empty body for ${key}`);
    }
    // SDK v3 returns SdkStream; cast to Readable (it implements the stream interface).
    return result.Body as unknown as Readable;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async signedUrl(key: string, options: SignedUrlOptions = {}): Promise<string> {
    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl}/${encodeURI(key)}`;
    }
    const expiresIn = options.expiresInSeconds ?? 60 * 15; // 15 minutes default
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: options.download
          ? `attachment; filename="${path.basename(key)}"`
          : undefined,
      }),
      { expiresIn },
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required env: ${name}. Set it (or its alias) for STORAGE_PROVIDER=s3.`,
    );
  }
  return value;
}

function parseForcePathStyle(input: string | undefined, fallbackForCustom: boolean): boolean {
  if (input === undefined || input === '') return fallbackForCustom;
  return input === 'true' || input === '1';
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number }; Code?: string };
  if (e.name === 'NotFound' || e.name === 'NoSuchKey') return true;
  if (e.$metadata?.httpStatusCode === 404) return true;
  if (e.Code === 'NoSuchKey' || e.Code === 'NotFound') return true;
  return false;
}

// `path` lazy-imported only when signedUrl() needs it. Top-level import would
// pull node:path into the bundle; this stays cleaner.
import path from 'node:path';
