import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import { streamDocument } from '@/lib/services/documents';
import { errorResponse } from '@/lib/services/http';
import { storageDownloadResponse } from '@/lib/storage/download';

// GET /api/documents/[id]/download — the only way a browser gets a
// document's bytes. Signed out: 401. Not in the caller's active workspace
// (or no such id): 404, so the answer never confirms that another
// workspace's document exists. Archived: 409.

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_BIGINT = 9_223_372_036_854_775_807n;

const DocumentIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .transform((v) => BigInt(v))
  .refine((v) => v <= MAX_BIGINT);

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Session first, so a signed-out caller gets 401 whatever the id.
    const ctx = await getWorkspaceContext();
    const parsed = DocumentIdSchema.safeParse((await params).id);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'document not found', code: 'not_found' },
        { status: 404 },
      );
    }
    const { document, stream } = await streamDocument(ctx, parsed.data);
    return storageDownloadResponse({
      stream,
      filename: document.filename,
      contentType: document.mimeType,
      sizeBytes: document.sizeBytes,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
