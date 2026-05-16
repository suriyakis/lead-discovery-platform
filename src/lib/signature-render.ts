// Pure signature rendering — no DB, no auth, no Next/server-only imports.
// Lives outside src/lib/services/ so client components (e.g. the
// /mailbox/signatures preview pane) can import it without dragging in
// the workspace context / drizzle client.
//
// signatures.ts re-exports both functions so existing server-side
// callers (mail.sendMessage, tests) keep working unchanged.

export interface SignaturePhone {
  label: string;
  number: string;
}

export interface SignatureRenderInput {
  bodyText: string | null;
  bodyHtml?: string | null;
  greeting?: string | null;
  fullName?: string | null;
  title?: string | null;
  company?: string | null;
  tagline?: string | null;
  website?: string | null;
  email?: string | null;
  /** jsonb on the wire; structurally an array of {label, number}. */
  phones?: unknown;
  logoStorageKey?: string | null;
  /** Phase 53: externally hosted logo URL. When set, the renderer uses
   *  this verbatim and skips any logoStorageKey signed-URL lookup. */
  logoUrl?: string | null;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function coercePhones(input: unknown): SignaturePhone[] {
  if (!Array.isArray(input)) return [];
  const out: SignaturePhone[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as { label?: unknown; number?: unknown };
    const number = (typeof p.number === 'string' ? p.number : '').trim();
    if (!number) continue;
    const label = (typeof p.label === 'string' ? p.label : '').trim();
    out.push({ label: label.slice(0, 40), number: number.slice(0, 60) });
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Render a Phase 17 structured signature as a brand-coherent HTML block.
 * Falls back to bodyHtml (if set) or bodyText wrapped in <pre> when no
 * structured fields are provided. Output is a self-contained inline-styled
 * <table> so it survives email clients without external CSS.
 *
 * Pass logoUrl explicitly — the storage layer's signedUrl is async so the
 * caller resolves it once and hands the URL in.
 */
export function renderSignatureHtml(
  signature: SignatureRenderInput,
  logoUrl?: string | null,
): string {
  if (signature.bodyHtml && signature.bodyHtml.trim()) {
    return signature.bodyHtml;
  }
  const phones = coercePhones(signature.phones);
  const hasStructured = Boolean(
    signature.fullName ||
      signature.title ||
      signature.company ||
      signature.website ||
      signature.email ||
      phones.length > 0,
  );
  if (!hasStructured) {
    return `<pre style="margin:0;font-family:inherit;white-space:pre-wrap">${escape(signature.bodyText ?? '')}</pre>`;
  }

  const accent = '#e87b1f'; // brand orange
  const muted = '#6b7280';

  const greeting = signature.greeting
    ? `<div style="padding:0 0 8px 0;border-bottom:2px solid ${accent};color:${muted};font-weight:500">${escape(signature.greeting)}</div>`
    : '';

  // Phase 53: prefer the externally-hosted URL on the row; the explicit
  // logoUrl parameter (which mail.send pre-resolves from logoStorageKey
  // via storage.signedUrl) is the fallback.
  const effectiveLogoUrl = signature.logoUrl?.trim() || logoUrl?.trim() || '';
  const logoCell = effectiveLogoUrl
    ? `<td valign="top" style="padding:8px 16px 0 0;width:96px"><img src="${escape(effectiveLogoUrl)}" alt="${escape(signature.company ?? 'logo')}" style="max-width:96px;height:auto;display:block" /></td>`
    : '';

  const phoneLines = phones
    .map((p) => {
      const labelHtml = p.label ? `<span style="color:${muted}">${escape(p.label)}: </span>` : '';
      return `<div>${labelHtml}<a href="tel:${escape(p.number)}" style="color:inherit;text-decoration:none">${escape(p.number)}</a></div>`;
    })
    .join('');

  const websiteLine = signature.website
    ? `<div><a href="${escape(signature.website)}" style="color:${accent};text-decoration:none">${escape(signature.website)}</a></div>`
    : '';
  const emailLine = signature.email
    ? `<div><a href="mailto:${escape(signature.email)}" style="color:inherit;text-decoration:none">${escape(signature.email)}</a></div>`
    : '';

  const taglineLine = signature.tagline
    ? `<div style="font-style:italic;color:${muted};margin-top:4px">${escape(signature.tagline)}</div>`
    : '';

  const nameLine = signature.fullName
    ? `<div style="font-weight:600;font-size:15px">${escape(signature.fullName)}</div>`
    : '';
  const titleLine = signature.title
    ? `<div style="color:${muted}">${escape(signature.title)}</div>`
    : '';
  const companyLine = signature.company
    ? `<div style="color:${accent};font-weight:500">${escape(signature.company)}</div>`
    : '';

  return `${greeting}<table cellspacing="0" cellpadding="0" border="0" style="margin-top:10px;font-family:inherit;font-size:14px;line-height:1.4"><tr>${logoCell}<td valign="top">${nameLine}${titleLine}${companyLine}${taglineLine}<div style="margin-top:6px">${websiteLine}${emailLine}${phoneLines}</div></td></tr></table>`;
}

/**
 * Plain-text rendering — used for the text/plain alternative of an
 * outbound message. Preserves bodyText if set; otherwise composes from
 * the structured fields.
 */
export function renderSignatureText(signature: SignatureRenderInput): string {
  if (signature.bodyText && signature.bodyText.trim()) return signature.bodyText;
  const lines: string[] = [];
  if (signature.greeting) lines.push(signature.greeting);
  if (signature.fullName) lines.push(signature.fullName);
  if (signature.title) lines.push(signature.title);
  if (signature.company) lines.push(signature.company);
  if (signature.tagline) lines.push(signature.tagline);
  if (signature.website) lines.push(signature.website);
  if (signature.email) lines.push(signature.email);
  for (const p of coercePhones(signature.phones)) {
    lines.push(p.label ? `${p.label}: ${p.number}` : p.number);
  }
  return lines.join('\n');
}
