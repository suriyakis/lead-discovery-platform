// Shared FormFields component used by /products/new and /products/[id].
// Renders all editable product profile fields. The form's `action` prop
// is supplied by the parent page (a server action that calls the service).

import type { ProductProfile } from '@/lib/db/schema/products';

type Props = {
  profile?: ProductProfile;
  formError?: string | null;
  submitLabel: string;
};

export function ProductFields({ profile, formError, submitLabel }: Readonly<Props>) {
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
          <span>Outreach instructions</span>
          <textarea
            name="outreachInstructions"
            rows={4}
            maxLength={5000}
            defaultValue={v?.outreachInstructions ?? ''}
            placeholder="Tone, structure, what to lead with."
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
          <input
            name="language"
            type="text"
            pattern="[a-z]{2}(-[A-Z]{2})?"
            defaultValue={v?.language ?? 'en'}
          />
          <small>BCP 47 short tag, e.g. en, en-GB, pl.</small>
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
