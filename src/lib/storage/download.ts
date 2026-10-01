// Turn a stored object into a browser download.
//
// Shared by every route that hands workspace files to a browser:
// /api/documents/[id]/download and /api/crm/exports/[file]. Those routes
// resolve the WorkspaceContext, let their service find the object inside
// that workspace, then return storageDownloadResponse(). Nothing here
// knows about workspaces; it only builds a safe response.

import type { Readable } from 'node:stream';

export interface StorageDownloadInput {
  /** The bytes, as returned by IStorage.get(). */
  stream: Readable;
  /** Filename offered to the browser. Sanitised here. */
  filename: string;
  /** MIME type. Anything that is not a plain `type/subtype` (optionally
   *  with simple parameters) is sent as application/octet-stream. */
  contentType?: string | null;
  /** Byte length when known exactly, so the browser can show progress. */
  sizeBytes?: number | null;
}

/**
 * A 200 Response that streams `stream` as an attachment.
 *
 * - Content-Disposition is always `attachment`. Uploaded files are user
 *   content, and rendering one inline on our origin (an .html or .svg
 *   upload) would run it with the viewer's session.
 * - `nosniff` and a sandboxing CSP back that up if a browser renders anyway.
 * - `Cache-Control: private, no-store`: the response is per-user,
 *   authorised content and must not sit in a shared or disk cache.
 */
export function storageDownloadResponse(input: StorageDownloadInput): Response {
  const headers = new Headers({
    'Content-Type': safeContentType(input.contentType),
    'Content-Disposition': attachmentDisposition(input.filename),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  const size = input.sizeBytes;
  if (typeof size === 'number' && Number.isSafeInteger(size) && size >= 0) {
    headers.set('Content-Length', String(size));
  }
  return new Response(nodeToWebStream(input.stream), { status: 200, headers });
}

const TOKEN = "[a-z0-9!#$&^_.+-]+";
const CONTENT_TYPE_RE = new RegExp(
  `^${TOKEN}/${TOKEN}(?:\\s*;\\s*${TOKEN}=(?:${TOKEN}|"[^"\\\\\\r\\n]*"))*$`,
  'i',
);

/** The MIME type to send, or application/octet-stream when the stored one
 *  is empty or malformed (it comes from the uploading browser). */
export function safeContentType(contentType: string | null | undefined): string {
  const value = (contentType ?? '').trim();
  if (value.length === 0 || value.length > 200) return 'application/octet-stream';
  return CONTENT_TYPE_RE.test(value) ? value : 'application/octet-stream';
}

/**
 * `attachment; filename="<ascii>"; filename*=UTF-8''<utf-8>` (RFC 6266).
 * The quoted ASCII form is the fallback for old clients: accents are
 * folded and anything else non-ASCII becomes `_` (Zażółć -> Zazo_c). Control characters, path separators, quotes and `%` never reach
 * the header, so a filename cannot inject a header or a path.
 */
export function attachmentDisposition(filename: string): string {
  const cleaned =
    filename
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[\\/]/g, '_')
      .trim()
      .slice(0, 200) || 'download';
  const ascii = cleaned
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["%]/g, '_');
  const encoded = encodeURIComponent(cleaned).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Node Readable -> web ReadableStream. Pull-based, so the file is read only
 * as fast as the client takes it; string chunks become bytes; cancelling
 * (client went away) destroys the Node stream, which closes the file.
 */
function nodeToWebStream(stream: Readable): ReadableStream<Uint8Array> {
  const iterator = stream[Symbol.asyncIterator]() as AsyncIterator<unknown>;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(toBytes(value));
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      stream.destroy();
    },
  });
}

function toBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  throw new TypeError('download stream produced a non-byte chunk');
}
