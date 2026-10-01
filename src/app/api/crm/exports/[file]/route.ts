import { getWorkspaceContext } from '@/lib/services/auth-context';
import { streamCsvExport } from '@/lib/services/crm';
import { errorResponse } from '@/lib/services/http';
import { storageDownloadResponse } from '@/lib/storage/download';

// GET /api/crm/exports/[file] — download a CSV export of the caller's
// active workspace (the "Download CSV" link on /settings/crm). Signed
// out: 401. A name that is not this workspace's export: 404.

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ file: string }> },
) {
  try {
    const ctx = await getWorkspaceContext();
    const { file } = await params;
    const { fileName, stream } = await streamCsvExport(ctx, file);
    return storageDownloadResponse({
      stream,
      filename: fileName,
      contentType: 'text/csv; charset=utf-8',
    });
  } catch (err) {
    return errorResponse(err);
  }
}
