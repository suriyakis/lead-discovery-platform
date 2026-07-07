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

interface StylePreset {
  id: string;
  label: string;
  blurb: string;
  /** Text added to the AI prompt when the operator clicks the chip. */
  prompt: string;
}

const STYLE_PRESETS: ReadonlyArray<StylePreset> = [
  {
    id: 'minimal',
    label: 'Minimal',
    blurb: 'Single column · generous whitespace · one thin accent',
    prompt:
      'Style: minimal. Single column, generous whitespace, one thin accent divider, no logo emphasis, title inline with name using a · separator. Neutral accent color (deep blue or warm slate).',
  },
  {
    id: 'branded',
    label: 'Branded',
    blurb: 'Logo emphasized · bold company colors · accent bar',
    prompt:
      'Style: branded. Two-column layout with the logo on the left, a vertical accent bar between columns, the name bold in the brand accent color, and contact lines stacked on the right. Make the company identity strong.',
  },
  {
    id: 'two-column',
    label: 'Two-column',
    blurb: 'Logo or person info left · contact details right',
    prompt:
      'Style: two columns. Logo or initials on the left, name + title + contact on the right. Subtle vertical separator. Title placed inline with company ("Title at Company") for a corporate feel.',
  },
  {
    id: 'compact',
    label: 'Compact',
    blurb: 'One or two rows · all contact on a single line',
    prompt:
      'Style: compact. One row for name + title, second row for all contact (website · email · phone) separated by middle-dots. No logo emphasis, no dividers, just clean type. Title inline with name.',
  },
];

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
  const [presetId, setPresetId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  function run() {
    setError(null);
    setInfo(null);
    const fields = getFields();
    const preset = STYLE_PRESETS.find((p) => p.id === presetId);
    // Preset goes first so the operator's own note can override / refine
    // anything they want to adjust.
    const combined = [preset?.prompt, extraPrompt.trim()]
      .filter(Boolean)
      .join('\n\n');
    const body = {
      ...fields,
      extraPrompt: combined || null,
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
      <legend className="muted">Re-design with AI</legend>
      <p className="muted" style={{ fontSize: '0.825rem', marginTop: 0 }}>
        Don&apos;t like how the signature looks? Pick a style direction
        below and click <strong>Re-design</strong> — the workspace&apos;s
        active AI provider will rebuild the HTML using your structured
        fields and the requested aesthetic. Add an optional note for
        specifics (colors, logo size, etc). The output drops into the
        HTML field above and goes through a defensive sanitiser
        (script / iframe / javascript: URLs stripped) before save.
        Each click bills one chat completion.
      </p>

      <div style={{ marginTop: '0.5rem' }}>
        <span
          className="muted"
          style={{ fontSize: '0.8rem', display: 'block', marginBottom: '0.35rem' }}
        >
          Style direction (optional)
        </span>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.4rem',
          }}
        >
          {STYLE_PRESETS.map((p) => {
            const active = p.id === presetId;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setPresetId(active ? null : p.id)}
                className={active ? 'primary-btn' : ''}
                title={p.blurb}
                style={{
                  fontSize: '0.78rem',
                  padding: '0.3rem 0.7rem',
                  borderRadius: '999px',
                  border: active ? undefined : '1px solid var(--brand-border, #ddd)',
                  background: active ? undefined : 'transparent',
                  cursor: 'pointer',
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        {presetId ? (
          <p className="muted" style={{ fontSize: '0.78rem', margin: '0.35rem 0 0' }}>
            {STYLE_PRESETS.find((p) => p.id === presetId)?.blurb}
          </p>
        ) : null}
      </div>

      <label style={{ marginTop: '0.75rem' }}>
        <span>Extra note (optional)</span>
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
      <div className="action-row" style={{ marginTop: '0.5rem' }}>
        <button
          type="button"
          onClick={run}
          disabled={isPending}
          className="primary-btn"
        >
          {isPending ? 'Designing…' : presetId || extraPrompt.trim() ? 'Re-design with AI' : 'Design with AI'}
        </button>
      </div>
      {info ? <p className="form-info">{info}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
    </fieldset>
  );
}
