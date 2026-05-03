// Documents service. Wraps IStorage for byte handling, persists metadata,
// audit-logs every mutation. SHA-256 captured for dedup detection.

import { and, desc, eq, inArray, ne, type SQL } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { db } from '@/lib/db/client';
import {
  documents,
  type Document,
  type DocumentStatus,
  type NewDocument,
} from '@/lib/db/schema/documents';
import { recordAuditEvent } from './audit';
import {
  canAdminWorkspace,
  canWrite,
  type WorkspaceContext,
} from './context';
import { getStorage, type IStorage } from '@/lib/storage';

export class DocumentServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'DocumentServiceError';
    this.code = code;
  }
}

const permissionDenied = (op: string) =>
  new DocumentServiceError(`Permission denied: ${op}`, 'permission_denied');
const notFound = () =>
  new DocumentServiceError('document not found', 'not_found');
const invariant = (msg: string) =>
  new DocumentServiceError(msg, 'invariant_violation');
const invalid = (msg: string) =>
  new DocumentServiceError(msg, 'invalid_input');
const conflict = (msg: string) =>
  new DocumentServiceError(msg, 'conflict');

const MAX_NAME_LEN = 200;
const MAX_TAGS = 32;

// ---- upload ---------------------------------------------------------

export interface UploadDocumentInput {
  /** Display name. Defaults to filename if blank. */
  name?: string | null;
  filename: string;
  mimeType?: string | null;
  /** Bytes. Streams accepted; we materialize to compute sha256 + size. */
  body: Buffer | Readable;
  tags?: ReadonlyArray<string>;
}

export interface UploadDocumentResult {
  document: Document;
  /** Pre-signed URL or file:// URL the caller can offer for download. */
  url: string;
}

export async function uploadDocument(
  ctx: WorkspaceContext,
  input: UploadDocumentInput,
  storageOverride?: IStorage,
): Promise<UploadDocumentResult> {
  if (!canWrite(ctx)) throw permissionDenied('document.upload');
  const filename = input.filename.trim();
  if (!filename) throw invalid('filename is required');
  const name = (input.name ?? '').trim() || filename;
  if (name.length > MAX_NAME_LEN) throw invalid('name too long');
  const tags = sanitizeTags(input.tags);

  const buffer = await materializeToBuffer(input.body);
  if (buffer.length === 0) throw invalid('empty body');

  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const storage = storageOverride ?? getStorage();
  const ext = extractExtension(filename);
  const storageKey = `workspaces/${ctx.workspaceId}/documents/${randomUUID()}${ext}`;

  await storage.put(storageKey, buffer, {
    contentType: input.mimeType ?? 'application/octet-stream',
  });

  const row: NewDocument = {
    workspaceId: ctx.workspaceId,
    name,
    filename,
    mimeType: input.mimeType ?? 'application/octet-stream',
    sizeBytes: buffer.length,
    sha256,
    storageKey,
    storageProvider: storage.id,
    status: 'ready',
    tags,
    createdBy: ctx.userId,
  };

  const [created] = await db.insert(documents).values(row).returning();
  if (!created) throw invariant('document insert returned no row');

  await recordAuditEvent(ctx, {
    kind: 'document.upload',
    entityType: 'document',
    entityId: created.id,
    payload: {
      filename,
      mimeType: created.mimeType,
      sizeBytes: created.sizeBytes,
      sha256,
      storageKey,
      storageProvider: storage.id,
    },
  });

  const url = await storage.signedUrl(storageKey);
  return { document: created, url };
}

// ---- read -----------------------------------------------------------

export interface ListDocumentsFilter {
  status?: DocumentStatus | readonly DocumentStatus[];
  /** Default: exclude archived. */
  includeArchived?: boolean;
  limit?: number;
}

export async function listDocuments(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: ListDocumentsFilter = {},
): Promise<Document[]> {
  const conditions: SQL[] = [eq(documents.workspaceId, ctx.workspaceId)];
  if (filter.status !== undefined) {
    const statuses = Array.isArray(filter.status)
      ? (filter.status as DocumentStatus[])
      : [filter.status as DocumentStatus];
    if (statuses.length === 1) {
      conditions.push(eq(documents.status, statuses[0]!));
    } else if (statuses.length > 1) {
      conditions.push(inArray(documents.status, statuses));
    }
  } else if (filter.includeArchived !== true) {
    conditions.push(notArchivedCondition());
  }
  const limit = Math.min(filter.limit ?? 200, 1000);
  return db
    .select()
    .from(documents)
    .where(and(...conditions))
    .orderBy(desc(documents.createdAt))
    .limit(limit);
}

export async function getDocument(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
  storageOverride?: IStorage,
): Promise<{ document: Document; url: string }> {
  const rows = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.workspaceId, ctx.workspaceId),
        eq(documents.id, id),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound();
  const storage = storageOverride ?? getStorage();
  const url = await storage.signedUrl(rows[0].storageKey);
  return { document: rows[0], url };
}

/** Stream the document bytes back to the caller. */
export async function streamDocument(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
  storageOverride?: IStorage,
): Promise<{ document: Document; stream: Readable }> {
  const rows = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.workspaceId, ctx.workspaceId),
        eq(documents.id, id),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound();
  if (rows[0].status === 'archived') throw conflict('document is archived');
  const storage = storageOverride ?? getStorage();
  const stream = await storage.get(rows[0].storageKey);
  return { document: rows[0], stream };
}

// ---- mutate ---------------------------------------------------------

export interface UpdateDocumentInput {
  name?: string;
  tags?: ReadonlyArray<string>;
}

export async function updateDocument(
  ctx: WorkspaceContext,
  id: bigint,
  input: UpdateDocumentInput,
): Promise<Document> {
  if (!canWrite(ctx)) throw permissionDenied('document.update');
  const existing = await loadDocument(ctx, id);
  if (existing.status === 'archived') throw conflict('document is archived');
  const updates: Partial<Document> & { updatedAt: Date } = { updatedAt: new Date() };
  if (input.name !== undefined) {
    const next = input.name.trim();
    if (!next || next.length > MAX_NAME_LEN) throw invalid('invalid name');
    updates.name = next;
  }
  if (input.tags !== undefined) {
    updates.tags = sanitizeTags(input.tags);
  }
  const [updated] = await db
    .update(documents)
    .set(updates)
    .where(
      and(
        eq(documents.workspaceId, ctx.workspaceId),
        eq(documents.id, id),
      ),
    )
    .returning();
  if (!updated) throw invariant('document update returned no row');
  await recordAuditEvent(ctx, {
    kind: 'document.update',
    entityType: 'document',
    entityId: id,
    payload: { changedName: input.name !== undefined, changedTags: input.tags !== undefined },
  });
  return updated;
}

export async function archiveDocument(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<Document> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('document.archive');
  const existing = await loadDocument(ctx, id);
  if (existing.status === 'archived') return existing;
  const [updated] = await db
    .update(documents)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(
      and(
        eq(documents.workspaceId, ctx.workspaceId),
        eq(documents.id, id),
      ),
    )
    .returning();
  if (!updated) throw invariant('document archive returned no row');
  await recordAuditEvent(ctx, {
    kind: 'document.archive',
    entityType: 'document',
    entityId: id,
  });
  return updated;
}

export async function restoreDocument(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<Document> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('document.restore');
  const existing = await loadDocument(ctx, id);
  if (existing.status !== 'archived') return existing;
  const [updated] = await db
    .update(documents)
    .set({ status: 'ready', updatedAt: new Date() })
    .where(
      and(
        eq(documents.workspaceId, ctx.workspaceId),
        eq(documents.id, id),
      ),
    )
    .returning();
  if (!updated) throw invariant('document restore returned no row');
  await recordAuditEvent(ctx, {
    kind: 'document.restore',
    entityType: 'document',
    entityId: id,
  });
  return updated;
}

// ---- internals ------------------------------------------------------

async function loadDocument(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<Document> {
  const rows = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.workspaceId, ctx.workspaceId),
        eq(documents.id, id),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound();
  return rows[0];
}

async function materializeToBuffer(input: Buffer | Readable): Promise<Buffer> {
  if (input instanceof Buffer) return input;
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sanitizeTags(input: ReadonlyArray<string> | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const t = raw.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function extractExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx < 0 || idx === filename.length - 1) return '';
  const ext = filename.slice(idx).toLowerCase();
  // Limit extension to alphanumerics + a few harmless symbols.
  return /^\.[a-z0-9._-]{1,16}$/i.test(ext) ? ext : '';
}

function notArchivedCondition() {
  return ne(documents.status, 'archived');
}
