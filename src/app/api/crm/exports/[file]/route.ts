import {
  downloadErrorResponse,
  type DownloadFailure,
  type DownloadFailurePage,
} from '@/lib/download-failure';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import { streamCsvExport } from '@/lib/services/crm';
import { storageDownloadResponse } from '@/lib/storage/download';

// GET /api/crm/exports/[file] — download a CSV export of the caller's
// active workspace (the "Download CSV" link on /settings/crm). Signed
// out: 401. A name that is not this workspace's export: 404.
//
// Those are the answers fetch() and scripts get. A browser that followed
// the link is sent back to /settings/crm with the reason instead of
// being navigated to a JSON body (src/lib/download-failure.ts).

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  req: Request,
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
    return downloadErrorResponse(req, err, csvExportFailurePage);
  }
}

const CRM_PATH = '/settings/crm';

/** Where a browser goes back to after a failed CSV download. */
function csvExportFailurePage(failure: DownloadFailure): DownloadFailurePage {
  if (failure.status === 403) {
    return { path: CRM_PATH, error: 'Your role cannot download lead exports. Ask an admin.' };
  }
  if (failure.status === 404) {
    return {
      path: CRM_PATH,
      error:
        'That CSV export is not available in your current workspace. Export again to get a fresh file.',
    };
  }
  return {
    path: CRM_PATH,
    error: 'The download failed. Try again, and contact support if it keeps failing.',
  };
}
