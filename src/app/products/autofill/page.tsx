import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import {
  ProductAutofillError,
  autofillProductProfileFromSources,
} from '@/lib/services/product-autofill';
import { isNextRedirectError } from '@/lib/server-redirect';

export default async function AutofillPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  try {
    await getWorkspaceContext();
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) redirect('/');
    throw err;
  }

  async function autofillAction(formData: FormData) {
    'use server';
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
      redirect(
        `/products/autofill?error=${encodeURIComponent('Provide a URL, a PDF, or both.')}`,
      );
    }
    try {
      const result = await autofillProductProfileFromSources(c, {
        url,
        pdfs: pdfFiles,
      });
      redirect(
        `/products/${result.profile.id}?autofill=ok&confidence=${result.synthesized.confidence}`,
      );
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

  return (
    <AppShell>
      <div className="dashboard-wrap">
        <header className="page-intro">
          <p className="page-eyebrow">Catalog · Autofill</p>
          <h1 className="page-title">
            <Sparkles className="section-icon" aria-hidden="true" /> Generate a
            product profile from a URL or PDFs
          </h1>
          <p className="page-lede">
            Paste your product page URL and/or upload TDS / spec PDFs.
            We&apos;ll extract the text, ask the active AI provider to
            synthesize a structured profile, and create an inactive draft for
            you to review and approve.
          </p>
        </header>

        {sp.error ? (
          <p className="form-error">
            <strong>Autofill failed:</strong> {sp.error}
          </p>
        ) : null}

        <form action={autofillAction} className="edit-draft-form">
          <fieldset className="ks-kind-fields">
            <legend className="muted">Source 1 — Website (optional)</legend>
            <label>
              <span>Product / e-commerce URL</span>
              <input
                type="url"
                name="url"
                placeholder="https://yoursite.com/products/example"
                maxLength={2000}
              />
              <small className="muted">
                Static fetch — JS-rendered single-page apps may yield
                empty text. Paste a server-rendered marketing page when
                possible.
              </small>
            </label>
          </fieldset>

          <fieldset className="ks-kind-fields">
            <legend className="muted">Source 2 — PDFs (optional, multi-select)</legend>
            <label>
              <span>Upload TDS, spec sheets, brochures…</span>
              <input
                type="file"
                name="pdfs"
                accept="application/pdf,.pdf"
                multiple
              />
              <small className="muted">
                Text-based PDFs only. Scanned-image PDFs need OCR (not
                supported yet).
              </small>
            </label>
          </fieldset>

          <div className="action-row">
            <button type="submit" className="primary-btn">
              <Sparkles className="primary-btn-icon" aria-hidden="true" />
              <span>Generate product profile</span>
            </button>
            <Link href="/products/new" className="ghost-btn">
              Or fill out the form by hand
            </Link>
          </div>
          <p className="muted small" style={{ marginTop: '0.5rem' }}>
            Cost: ~1–3¢ per autofill, billed against your active AI provider.
            The generated profile is created with{' '}
            <code>active=false</code> so nothing in discovery / outreach uses
            it until you flip it on.
          </p>
        </form>
      </div>
    </AppShell>
  );
}
