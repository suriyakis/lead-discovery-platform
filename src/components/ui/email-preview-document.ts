// The document an EmailPreview frame shows (DS-10), kept out of the
// 'use client' module so server code and tests can build it too.

/** The sandbox tokens. Never add allow-scripts: with allow-same-origin it would run as the app. */
export const EMAIL_PREVIEW_SANDBOX = 'allow-same-origin';

/** Images (remote, inline, data) and inline styles; no scripts, frames, fonts or fetches. */
export const EMAIL_PREVIEW_CSP =
  "default-src 'none'; img-src https: http: data: cid:; style-src 'unsafe-inline'";

/**
 * The mail-client canvas the HTML is drawn on: a light document in the
 * system font, like the inbox the recipient opens it in. System colours
 * (Canvas, CanvasText), not the app's tokens: nothing of the app's look
 * belongs in the email.
 */
const CANVAS_CSS = [
  'html{color-scheme:light}',
  'body{margin:0;padding:16px;background:Canvas;color:CanvasText;',
  "font:14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;",
  'overflow-wrap:anywhere}',
  'img{max-width:100%;height:auto}',
].join('');

/** The whole document the frame shows for `html`. */
export function emailPreviewDocument(html: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${EMAIL_PREVIEW_CSP}">` +
    '<meta name="color-scheme" content="light">' +
    // Links open nowhere: with no allow-popups a _blank target is blocked,
    // so a click cannot navigate the preview away either.
    '<base target="_blank">' +
    `<style>${CANVAS_CSS}</style></head><body>${html}</body></html>`
  );
}
