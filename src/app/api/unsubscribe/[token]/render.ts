// flow:F-05 — self-contained HTML for the public unsubscribe page. No app
// shell: the reader is a prospect of the workspace, not a user of the
// platform. Colours are tokens on :root (light + dark), never inline.

import {
  getUnsubscribePageStrings,
  type UnsubscribePageStrings,
} from '@/lib/i18n/unsubscribe-page';

export interface ConfirmPageInput {
  addresses: ReadonlyArray<string>;
  language: string | null;
  subject: string;
  replyAddress: string;
}

/** GET: ask first. The form POSTs back to the same URL. */
export function renderConfirmPage(input: ConfirmPageInput): string {
  const t = getUnsubscribePageStrings(input.language);
  const mailto =
    `mailto:${input.replyAddress}` +
    `?subject=${encodeURIComponent(replySubject(input.subject))}` +
    `&body=${encodeURIComponent(t.wrongPersonBody)}`;
  return page(
    t,
    t.confirmTitle,
    `<h1>${escapeHtml(t.confirmTitle)}</h1>
    <p class="muted">${escapeHtml(t.confirmLead)}</p>
    ${addressList(input.addresses)}
    <form method="post">
      <input type="hidden" name="confirm" value="1" />
      <button type="submit">${escapeHtml(t.confirmButton)}</button>
    </form>
    <p class="aside"><a href="${escapeHtml(mailto)}">${escapeHtml(t.wrongPersonLink)}</a></p>`,
  );
}

/** POST from the page: the opt-out is recorded. */
export function renderDonePage(addresses: ReadonlyArray<string>, language: string | null): string {
  const t = getUnsubscribePageStrings(language);
  return page(
    t,
    t.doneTitle,
    `<h1>${escapeHtml(t.doneTitle)}</h1>
    <p class="muted">${escapeHtml(t.doneLead)}</p>
    ${addressList(addresses)}
    <p class="aside">${escapeHtml(t.doneNote)}</p>`,
  );
}

/** Unknown / malformed token. Still a 200 page. */
export function renderInvalidPage(language: string | null = null): string {
  const t = getUnsubscribePageStrings(language);
  return page(
    t,
    t.invalidTitle,
    `<h1>${escapeHtml(t.invalidTitle)}</h1>
    <p class="muted">${escapeHtml(t.invalidLead)}</p>`,
  );
}

/** "anna@target.com" → "a***@target.com": recognisable to the owner, not
 *  a full address for whoever else opens a forwarded link. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${address[0]}***${address.slice(at)}`;
}

function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`;
}

function addressList(addresses: ReadonlyArray<string>): string {
  if (addresses.length === 0) return '';
  return `<ul>${addresses
    .map((a) => `<li><code>${escapeHtml(maskEmail(a))}</code></li>`)
    .join('')}</ul>`;
}

function page(t: UnsubscribePageStrings, title: string, body: string): string {
  return `<!doctype html>
<html lang="${escapeHtml(t.lang)}" dir="${t.dir}">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
    <style>
      :root {
        --page-bg: #f6f7f9;
        --page-card: #ffffff;
        --page-fg: #1f2937;
        --page-muted: #6b7280;
        --page-border: #e5e7eb;
        --page-list: #f3f4f6;
        --page-button: #1f2937;
        --page-button-fg: #ffffff;
        --page-link: #2563eb;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --page-bg: #111827;
          --page-card: #1f2937;
          --page-fg: #f3f4f6;
          --page-muted: #9ca3af;
          --page-border: #374151;
          --page-list: #111827;
          --page-button: #f3f4f6;
          --page-button-fg: #111827;
          --page-link: #93c5fd;
        }
      }
      body { font-family: -apple-system, system-ui, sans-serif; background: var(--page-bg); color: var(--page-fg); margin: 0; padding: 4rem 1rem; }
      main { max-width: 32rem; margin: 0 auto; background: var(--page-card); border: 1px solid var(--page-border); border-radius: 8px; padding: 2rem 1.5rem; }
      h1 { font-size: 1.4rem; margin: 0 0 0.75rem; }
      .muted { color: var(--page-muted); font-size: 0.95rem; }
      ul { background: var(--page-list); padding: 0.75rem 1.5rem; border-radius: 6px; list-style: none; }
      code { font-family: ui-monospace, Menlo, Consolas, monospace; }
      button { background: var(--page-button); color: var(--page-button-fg); border: 0; border-radius: 6px; padding: 0.7rem 1.4rem; font-size: 1rem; cursor: pointer; }
      .aside { margin-top: 1.5rem; font-size: 0.9rem; }
      a { color: var(--page-link); }
    </style>
  </head>
  <body>
    <main>
    ${body}
    </main>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
