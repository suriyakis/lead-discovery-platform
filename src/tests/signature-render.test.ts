// Phase 53 — pure signature renderer (no DB / no auth).

import { describe, expect, it } from 'vitest';
import { renderSignatureHtml } from '@/lib/signature-render';

describe('renderSignatureHtml — logoUrl', () => {
  const base = {
    bodyText: '—',
    fullName: 'Jakub',
    title: 'Operator',
    company: 'Nulife',
    email: 'jb@nulife.pl',
    phones: [],
  };

  it('embeds an <img> when logoUrl is set on the signature row', () => {
    const html = renderSignatureHtml({
      ...base,
      logoUrl: 'https://cdn.example.com/logo.png',
    });
    expect(html).toContain('<img src="https://cdn.example.com/logo.png"');
    expect(html).toContain('max-width:96px');
    expect(html).toContain('alt="Nulife"');
  });

  it('falls back to the explicit logoUrl arg when the row has none', () => {
    const html = renderSignatureHtml(
      { ...base, logoUrl: null },
      'https://signed.example.com/local-logo.png',
    );
    expect(html).toContain('<img src="https://signed.example.com/local-logo.png"');
  });

  it('row-level logoUrl wins over the explicit arg', () => {
    const html = renderSignatureHtml(
      { ...base, logoUrl: 'https://row.example.com/x.png' },
      'https://fallback.example.com/y.png',
    );
    expect(html).toContain('https://row.example.com/x.png');
    expect(html).not.toContain('https://fallback.example.com/y.png');
  });

  it('omits the logo cell entirely when nothing is set', () => {
    const html = renderSignatureHtml(base);
    expect(html).not.toContain('<img');
    // Still renders the rest of the structured signature.
    expect(html).toContain('Jakub');
    expect(html).toContain('Nulife');
  });

  it('escapes the URL — quote injection in logoUrl cannot break out of src="..."', () => {
    // Real callers go through validateLogoUrl which rejects non-http(s),
    // but the renderer must still escape defensively for any path that
    // bypasses validation (e.g. raw DB row loaded by an old migration).
    const html = renderSignatureHtml({
      ...base,
      logoUrl: 'https://example.com/"><script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;');
  });

  it('bodyHtml override bypasses the structured renderer (incl. logo)', () => {
    const html = renderSignatureHtml({
      ...base,
      bodyHtml: '<p>raw</p>',
      logoUrl: 'https://x.example.com/logo.png',
    });
    expect(html).toBe('<p>raw</p>');
    expect(html).not.toContain('<img');
  });
});
