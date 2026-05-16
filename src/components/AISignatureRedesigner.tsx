'use client';

// Phase 54 — AI signature re-designer panel. Calls /api/signatures/redesign
// with the operator's structured fields + optional style prompt; on
// success hands the generated HTML to the parent via `onApply(html)`.
//
// Used by:
//   - SignatureForm (new-signature flow): apply directly into bodyHtml.
//   - SignatureList edit panel: apply into the per-signature HTML editor.
//
// The parent owns the field state — this component is stateless beyond
// the extra-prompt textarea + the loading/error indicator.

import { useState, useTransition } from 'react';

export interface SignatureRedesignFields {
  fullName?: string | null;
  title?: string | null;
  company?: string | null;
  tagline?: string | null;
  website?: string | null;
  email?: string | null;
  phones?: ReadonlyArray<{ label: string; number: string }>;
  logoUrl?: string | null;
  bodyText?: string | null;
  currentBodyHtml?: string | null;
}

interface AISignatureRedesignerProps {
  /** Resolves the current values of the surrounding form so the panel
   *  always submits the live data, not a stale snapshot. */
  getFields: () => SignatureRedesignFields;
  /** Callback invoked with the AI-returned HTML on success. */
  onApply: (html: string) => void;
}

interface RedesignResponse {
  bodyHtml: string;
  model: string;
  providerId: string;
}

export function AISignatureRedesigner({
  getFields,
  onApply,
}: AISignatureRedesignerProps) {
  const [extraPrompt, setExtraPrompt] = useState('');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  function run() {
    setError(null);
    setInfo(null);
    const fields = getFields();
    const body = {
      ...fields,
      extraPrompt: extraPrompt.trim() || null,
    };
    startTransition(async () => {
      try {
        const res = await fetch('/api/signatures/redesign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
          };
          setError(j.detail || j.error || `request failed (${res.status})`);
          return;
        }
        const data = (await res.json()) as RedesignResponse;
        onApply(data.bodyHtml);
        setInfo(`Applied — generated via ${data.providerId}/${data.model}.`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <fieldset className="ks-kind-fields">
      <legend className="muted">Re-design with AI (Phase 54)</legend>
      <p className="muted" style={{ fontSize: '0.825rem', marginTop: 0 }}>
        Don&apos;t like how the signature looks? Click below and the
        workspace&apos;s active AI provider will design fresh HTML using
        the fields you&apos;ve filled in. Add an optional style note
        (colors, logo size, layout preference…) and the AI will honor it.
        The output lands in the HTML field above and runs through the
        same defensive sanitiser (no script / iframe / javascript: URLs)
        before save.
      </p>
      <label>
        <span>Extra prompt (optional)</span>
        <textarea
          rows={3}
          maxLength={2000}
          value={extraPrompt}
          onChange={(e) => setExtraPrompt(e.target.value)}
          placeholder={
            "e.g. use navy and gold; make the logo bigger; put phones on one line; bold the company name"
          }
        />
      </label>
      <div className="action-row">
        <button
          type="button"
          onClick={run}
          disabled={isPending}
          className="primary-btn"
        >
          {isPending ? 'Designing…' : 'Re-design with AI'}
        </button>
      </div>
      {info ? <p className="form-info">{info}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
    </fieldset>
  );
}
