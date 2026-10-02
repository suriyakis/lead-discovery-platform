'use server';

// "Generate product profile" on /products/autofill. PC-38 (I184): it used
// to be an inline page action with no guard, so a double-click fetched,
// synthesized (one AI call) and created the draft twice. Now it is
// single-flight in the workspace and rate-limited
// (services/action-guards.ts), and the service refuses an empty wallet
// before the fetch — asked before the guard, so a refused click never uses
// up the workspace's limit.

import { redirect } from 'next/navigation';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import { guardAction } from '@/lib/services/action-guards';
import {
  ProductAutofillError,
  assertCanAutofillProduct,
  autofillProductProfileFromSources,
} from '@/lib/services/product-autofill';
import { isNextRedirectError } from '@/lib/server-redirect';

export async function autofillAction(formData: FormData): Promise<void> {
  const c = await getWorkspaceContext();
  const url = String(formData.get('url') ?? '').trim() || null;
  const pdfFiles: Array<{ filename: string; buffer: Buffer }> = [];
  for (const value of formData.getAll('pdfs')) {
    if (!(value instanceof File)) continue;
    if (value.size === 0) continue;
    // Only accept actual PDF mimetype OR .pdf extension. Reject everything
    // else — image-only PDFs will fail at extract time and that's ok.
    const isPdfMime = value.type === 'application/pdf';
    const isPdfName = value.name.toLowerCase().endsWith('.pdf');
    if (!isPdfMime && !isPdfName) continue;
    const ab = await value.arrayBuffer();
    pdfFiles.push({
      filename: value.name || 'upload.pdf',
      buffer: Buffer.from(ab),
    });
  }
  if (!url && pdfFiles.length === 0) {
    redirect(`/products/autofill?error=${encodeURIComponent('Provide a URL, a PDF, or both.')}`);
  }
  try {
    const result = await guardAction(
      c,
      'product.autofill',
      () =>
        autofillProductProfileFromSources(c, {
          url,
          pdfs: pdfFiles,
        }),
      { precheck: () => assertCanAutofillProduct(c) },
    );
    // Expose per-source extraction sizes so the operator can spot a
    // thin/empty fetch (SPA, paywall, scanned-image PDF) at a glance.
    const sizes = result.sources.map((s) => `${s.kind}:${s.text.length}`).join(',');
    const params = new URLSearchParams({
      autofill: 'ok',
      confidence: result.synthesized.confidence,
      sizes,
    });
    if (result.synthesized.notes) {
      params.set('notes', result.synthesized.notes);
    }
    redirect(`/products/${result.profile.id}?${params.toString()}`);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    const message =
      err instanceof ProductAutofillError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'autofill failed';
    redirect(`/products/autofill?error=${encodeURIComponent(message)}`);
  }
}
