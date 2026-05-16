'use client';

// Phase 53 — per-signature HTML editor with a live preview pane.
// Phase 54 — adds an AI re-design panel that drops generated HTML into
// the textarea, using the signature's structured fields as context.
//
// Used in /mailbox/signatures inside each existing signature's "Paste
// custom HTML" details block. The companion edit form for the URL-only
// logo path is a separate component to keep server-action wiring simple.

import { useState } from 'react';
import { AISignatureRedesigner } from './AISignatureRedesigner';

interface SignatureHtmlEditorProps {
  /** Server action receiving the FormData on submit. */
  action: (formData: FormData) => Promise<void>;
  signatureId: string;
  initialHtml: string;
  /** Phase 54: structured field snapshot for the AI redesigner. The
   *  per-signature edit panel doesn't carry an editable form for these
   *  here, so the snapshot is read-only at the time of redesign. */
  fieldsSnapshot?: {
    fullName?: string | null;
    title?: string | null;
    company?: string | null;
    tagline?: string | null;
    website?: string | null;
    email?: string | null;
    phones?: ReadonlyArray<{ label: string; number: string }>;
    logoUrl?: string | null;
    bodyText?: string | null;
  };
}

export function SignatureHtmlEditor({
  action,
  signatureId,
  initialHtml,
  fieldsSnapshot,
}: SignatureHtmlEditorProps) {
  const [html, setHtml] = useState(initialHtml);
  const trimmed = html.trim();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <form
        action={action}
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
          gap: '0.75rem',
          marginTop: '0.5rem',
        }}
      >
        <input type="hidden" name="id" value={signatureId} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <label className="muted" style={{ fontSize: '0.75rem' }}>
            HTML source
          </label>
          <textarea
            name="bodyHtml"
            rows={12}
            maxLength={20000}
            value={html}
            onChange={(e) => setHtml(e.target.value)}
            placeholder={'<table>\n  <tr><td>...</td></tr>\n</table>'}
            spellCheck={false}
            style={{
              fontFamily: 'var(--brand-mono)',
              fontSize: '0.825rem',
              width: '100%',
            }}
          />
          <p className="muted" style={{ fontSize: '0.75rem', margin: 0 }}>
            Leave blank and save to revert to the auto-rendered HTML from
            the structured fields.
          </p>
          <div>
            <button type="submit" className="primary-btn">
              Save HTML
            </button>
          </div>
        </div>
        <aside className="signature-preview" style={{ margin: 0 }}>
          <div className="signature-preview-header">
            <strong>Live preview</strong>
          </div>
          {trimmed ? (
            <div
              className="signature-preview-frame"
              // Operator-authored HTML for their own outgoing mail — same
              // trust boundary as the existing bodyHtml save path.
              dangerouslySetInnerHTML={{ __html: trimmed }}
            />
          ) : (
            <div className="signature-preview-empty">
              Empty HTML — saving like this reverts to the auto-rendered
              structured signature.
            </div>
          )}
        </aside>
      </form>
      {fieldsSnapshot ? (
        <AISignatureRedesigner
          getFields={() => ({
            ...fieldsSnapshot,
            currentBodyHtml: html,
          })}
          onApply={(generated) => setHtml(generated)}
        />
      ) : null}
    </div>
  );
}
