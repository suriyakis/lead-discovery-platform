import { z } from 'zod';
import {
  downloadErrorResponse,
  type DownloadFailure,
  type DownloadFailurePage,
} from '@/lib/download-failure';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import { DocumentServiceError, streamDocument } from '@/lib/services/documents';
import { storageDownloadResponse } from '@/lib/storage/download';

// GET /api/documents/[id]/download — the only way a browser gets a
// document's bytes. Signed out: 401. Not in the caller's active workspace
// (or no such id): 404, so the answer never confirms that another
// workspace's document exists. Archived: 409.
//
// Those are the answers fetch() and scripts get. A browser that followed
// the Download link is sent back to a page with the reason instead of
// being navigated to a JSON body (src/lib/download-failure.ts).

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_BIGINT = 9_223_372_036_854_775_807n;

const DocumentIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .transform((v) => BigInt(v))
  .refine((v) => v <= MAX_BIGINT);

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await params;
  try {
    // Session first, so a signed-out caller gets 401 whatever the id.
    const ctx = await getWorkspaceContext();
    const parsed = DocumentIdSchema.safeParse(rawId);
    if (!parsed.success) throw new DocumentServiceError('document not found', 'not_found');
    const { document, stream } = await streamDocument(ctx, parsed.data);
    return storageDownloadResponse({
      stream,
      filename: document.filename,
      contentType: document.mimeType,
      sizeBytes: document.sizeBytes,
    });
  } catch (err) {
    return downloadErrorResponse(req, err, (failure) => documentFailurePage(rawId, failure));
  }
}

const TRY_AGAIN = 'The download failed. Try again, and contact support if it keeps failing.';

/** Where a browser goes back to after a failed document download. */
function documentFailurePage(rawId: string, failure: DownloadFailure): DownloadFailurePage {
  const detail = DocumentIdSchema.safeParse(rawId).success ? `/documents/${rawId}` : '/documents';
  if (failure.code === 'file_missing') {
    return {
      path: detail,
      error:
        'The stored file for this document is missing. Upload it again, or ask an admin to check storage.',
    };
  }
  if (failure.status === 404) {
    // The detail page would bounce an id outside this workspace to the
    // list without the message, so go to the list directly.
    return {
      path: '/documents',
      error:
        'That document is not in your current workspace. If you switched workspace in another tab, switch back and try again.',
    };
  }
  if (failure.status === 409) {
    return { path: detail, error: 'This document is archived. Restore it to download it.' };
  }
  if (failure.status === 403) {
    return { path: detail, error: 'You do not have access to download this document.' };
  }
  return { path: detail, error: TRY_AGAIN };
}
