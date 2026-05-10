// Shared FormFields component used by /products/new and /products/[id].
// Renders all editable product profile fields. The form's `action` prop
// is supplied by the parent page (a server action that calls the service).

import type { ProductProfile } from '@/lib/db/schema/products';
import {
  LANGUAGE_NAMES,
  detectLanguageFromText,
  getLanguageName,
} from '@/lib/i18n/language';
import { SuggestAngleButton } from './_suggest-button';

type Props = {
  profile?: ProductProfile;
  formError?: string | null;
  submitLabel: string;
  /** When provided (only on the edit page — needs a productId), the
   *  three angle fields render an inline "Suggest with AI" button. */
  suggesterAction?: (formData: FormData) => Promise<void>;
};

export function ProductFields({
  profile,
  formError,
  submitLabel,
  suggesterAction,
}: Readonly<Props>) {
  const v = profile;
  return (
    <div className="form-grid">
      {formError ? <p className="form-error">{formError}</p> : null}

      <label>
        <span>Name *</span>
        <input
          name="name"
          type="text"
          required
          maxLength={200}
          defaultValue={v?.name ?? ''}
          autoFocus={!profile}
        />
      </label>

      <label>
        <span>Short description</span>
        <input
          name="shortDescription"
          type="text"
          maxLength={500}
          defaultValue={v?.shortDescription ?? ''}
          placeholder="One sentence — what is this product, who is it for?"
        />
      </label>

      <label>
        <span>Full description</span>
        <textarea
          name="fullDescription"
          rows={5}
          maxLength={5000}
          defaultValue={v?.fullDescription ?? ''}
        />
      </label>

      <fieldset>
        <legend>Targeting</legend>

        <label>
          <span>Customer types</span>
          <input
            name="targetCustomerTypes"
            type="text"
            defaultValue={(v?.targetCustomerTypes ?? []).join(', ')}
            placeholder="e.g. main contractors, architects"
          />
          <small>Comma separated.</small>
        </label>

        <label>
          <span>Sectors</span>
          <input
            name="targetSectors"
            type="text"
            defaultValue={(v?.targetSectors ?? []).join(', ')}
            placeholder="e.g. construction, manufacturing"
          />
          <small>Comma separated.</small>
        </label>

        <label>
          <span>Project types</span>
          <input
            name="targetProjectTypes"
            type="text"
            defaultValue={(v?.targetProjectTypes ?? []).join(', ')}
            placeholder="e.g. new build, refurbishment"
          />
          <small>Comma separated.</small>
        </label>
      </fieldset>

      <fieldset>
        <legend>Keywords</legend>

        <label>
          <span>Include keywords</span>
          <input
            name="includeKeywords"
            type="text"
            defaultValue={(v?.includeKeywords ?? []).join(', ')}
          />
          <small>Comma separated. Boost relevance.</small>
        </label>

        <label>
          <span>Exclude keywords</span>
          <input
            name="excludeKeywords"
            type="text"
            defaultValue={(v?.excludeKeywords ?? []).join(', ')}
          />
          <small>Comma separated. Reject when matched.</small>
        </label>
      </fieldset>

      <fieldset>
        <legend>Qualification</legend>

        <label>
          <span>Qualification criteria</span>
          <textarea
            name="qualificationCriteria"
            rows={3}
            maxLength={5000}
            defaultValue={v?.qualificationCriteria ?? ''}
            placeholder="What makes a lead a good fit?"
          />
        </label>

        <label>
          <span>Disqualification criteria</span>
          <textarea
            name="disqualificationCriteria"
            rows={3}
            maxLength={5000}
            defaultValue={v?.disqualificationCriteria ?? ''}
            placeholder="What disqualifies a lead?"
          />
        </label>

        <label>
          <span>Relevance threshold (0–100)</span>
          <input
            name="relevanceThreshold"
            type="number"
            min={0}
            max={100}
            step={1}
            defaultValue={v?.relevanceThreshold ?? 50}
          />
          <small>Records below this score are not promoted.</small>
        </label>
      </fieldset>

      <fieldset>
        <legend>Outreach</legend>

        <label>
          <span>Outreach instructions (global fallback)</span>
          <textarea
            name="outreachInstructions"
            rows={3}
            maxLength={5000}
            defaultValue={v?.outreachInstructions ?? ''}
            placeholder="Used when a stage-specific angle below is empty."
          />
        </label>

        <label>
          <span>
            Discovery angle (first-touch email)
            {suggesterAction ? (
              <SuggestAngleButton stage="discovery" action={suggesterAction} />
            ) : null}
          </span>
          <textarea
            name="discoveryAngle"
            rows={3}
            maxLength={2000}
            defaultValue={v?.discoveryAngle ?? ''}
            placeholder="Tone + hook for the ≤60-word ask-for-the-right-person email. No product pitch."
          />
        </label>

        <label>
          <span>
            Engagement angle (in-thread reply)
            {suggesterAction ? (
              <SuggestAngleButton stage="engagement" action={suggesterAction} />
            ) : null}
          </span>
          <textarea
            name="engagementAngle"
            rows={3}
            maxLength={2000}
            defaultValue={v?.engagementAngle ?? ''}
            placeholder="How to acknowledge replies + which qualifying questions to ask. ≤80 words."
          />
        </label>

        <label>
          <span>
            Pitch angle (when recipient asks for product detail)
            {suggesterAction ? (
              <SuggestAngleButton stage="pitch" action={suggesterAction} />
            ) : null}
          </span>
          <textarea
            name="pitchAngle"
            rows={3}
            maxLength={2000}
            defaultValue={v?.pitchAngle ?? ''}
            placeholder="Which differentiator to lead with + concrete next step. ≤180 words."
          />
        </label>

        <label>
          <span>What NOT to do</span>
          <textarea
            name="negativeOutreachInstructions"
            rows={3}
            maxLength={5000}
            defaultValue={v?.negativeOutreachInstructions ?? ''}
            placeholder="Things to never write."
          />
        </label>

        <label>
          <span>Forbidden phrases</span>
          <input
            name="forbiddenPhrases"
            type="text"
            defaultValue={(v?.forbiddenPhrases ?? []).join(', ')}
            placeholder="e.g. revolutionary, world-class, synergy"
          />
          <small>Comma separated. Drafts containing these are blocked.</small>
        </label>
      </fieldset>

      <fieldset>
        <legend>Settings</legend>
        <label>
          <span>Language</span>
          <select name="language" defaultValue={v?.language ?? 'en'}>
            {Object.entries(LANGUAGE_NAMES)
              .sort((a, b) => a[1].localeCompare(b[1]))
              .map(([code, name]) => (
                <option key={code} value={code}>
                  {name} ({code})
                </option>
              ))}
          </select>
          <LanguageHint profile={v} />
        </label>
      </fieldset>

      <fieldset>
        <legend>Outreach research enrichment</legend>
        <label className="checkbox-row">
          <input
            type="checkbox"
            name="enrichDraftsWithResearch"
            defaultChecked={v?.enrichDraftsWithResearch ?? false}
          />
          <span>
            Enrich AI-generated drafts with live research about the recipient
          </span>
        </label>
        <small>
          When on, every <code>ai</code> or <code>hybrid</code> draft runs a
          Gemini / Perplexity research call against the lead before
          generation. Adds ~1–3¢ per draft. Cached per (lead, question), so
          re-generating the same draft is free.
        </small>
        <label>
          <span>Research question (templated)</span>
          <textarea
            name="researchQuestionTemplate"
            rows={2}
            maxLength={1000}
            defaultValue={
              v?.researchQuestionTemplate ??
              'What does {company} ({domain}) do, what are their main products and target customers, and what recent news or projects from the past 6 months would matter for a B2B introduction?'
            }
            placeholder="What does {company} ({domain}) do?"
          />
          <small>
            Tokens <code>{'{company}'}</code> and <code>{'{domain}'}</code>{' '}
            are replaced with the lead&apos;s details at draft time.
          </small>
        </label>
      </fieldset>

      <div className="form-actions">
        <button type="submit" className="primary-btn">
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * Renders a small hint under the language picker showing what the
 * description-based detector would pick. If detection disagrees with the
 * currently-set field, nudges the user to consider switching. Pure server
 * render — no live re-detection on description typing (that would need a
 * client component; deferred to a follow-up).
 */
function LanguageHint({ profile }: { profile?: ProductProfile }) {
  if (!profile) {
    return (
      <small>
        Drives the AI outreach prompt. Change after pasting a description in
        another language.
      </small>
    );
  }
  const detected = detectLanguageFromText(
    [profile.fullDescription, profile.shortDescription, profile.outreachInstructions]
      .filter(Boolean)
      .join('\n'),
  );
  if (!detected) {
    return (
      <small>
        Drives the AI outreach prompt. The description text is too short for
        auto-detection.
      </small>
    );
  }
  if (detected === profile.language) {
    return (
      <small>
        Detector agrees: description reads as{' '}
        <strong>{getLanguageName(detected)}</strong>.
      </small>
    );
  }
  return (
    <small style={{ color: 'var(--brand-accent-amber)' }}>
      Detector reads the description as{' '}
      <strong>{getLanguageName(detected)}</strong> ({detected}). Outreach
      generation will follow the detector unless the field is set
      explicitly — consider matching them.
    </small>
  );
}

/** Parse the comma-separated array fields out of a FormData. */
export function readArrayField(form: FormData, key: string): string[] {
  const raw = form.get(key);
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Read a string FormData field, returning null for empty (so service treats it as cleared). */
export function readNullableString(form: FormData, key: string): string | null {
  const raw = form.get(key);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}
