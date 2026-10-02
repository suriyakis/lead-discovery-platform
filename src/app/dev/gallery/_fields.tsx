// The form primitives (DS-10) in the gallery: Field in both layouts and
// every width, the text controls at every size and in every state,
// SearchInput, Checkbox and Switch with and without a description, and
// an EmailPreview of a signature (a sandboxed frame: the app's CSS stays
// out of it). One `.form-grid` sample shows a component control inside a
// legacy context that restyles bare controls, looking the same.

import {
  Checkbox,
  EmailPreview,
  Field,
  Input,
  SearchInput,
  Select,
  Switch,
  Textarea,
} from '@/components/ui';
import styles from './gallery.module.css';

/** A signature as the renderer writes one, with a form control inside to show the isolation. */
export const SAMPLE_SIGNATURE_HTML = [
  '<p style="margin:0 0 8px">Kind regards,</p>',
  '<p style="margin:0"><strong>Jo Rivers</strong><br>Sales engineer, Mersey Mechanical</p>',
  '<p style="margin:8px 0 0"><a href="https://mersey.example">mersey.example</a> · +44 151 000 0000</p>',
  '<form><input name="probe" aria-label="Isolation probe" data-isolation-probe></form>',
].join('');

export function FieldSamples() {
  return (
    <div className={styles.stack}>
      <div className={styles.fields} data-field-sample="sizes">
        <Field label="Small (28px)" hint="Dense rows: inline edits, the header switcher.">
          <Input size="sm" defaultValue="sm" />
        </Field>
        <Field label="Medium (36px, 44px on touch)" hint="The default.">
          <Input defaultValue="md" />
        </Field>
        <Field label="Large (44px)">
          <Input size="lg" defaultValue="lg" />
        </Field>
        <Field label="Company name" optional>
          <Input name="company" placeholder="Mersey Mechanical" />
        </Field>
        <Field
          label="Contact email"
          error="Enter a full address, like name@example.com."
          hint="Replies go here."
        >
          <Input type="email" name="email" defaultValue="sales@" />
        </Field>
        <Field label="Daily send limit" width="num">
          <Input type="number" name="limit" defaultValue={40} min={0} align="end" />
        </Field>
        <Field label="Follow up on">
          <Input type="date" name="followUp" defaultValue="2026-10-02" />
        </Field>
        <Field label="Since">
          <Input type="datetime-local" name="since" defaultValue="2026-10-02T09:30" />
        </Field>
        <Field label="Disabled">
          <Input defaultValue="Not editable" disabled />
        </Field>
        <Field label="Product">
          <Select name="product" defaultValue="aerogel">
            <option value="aerogel">Aerogel blankets</option>
            <option value="boards">Insulation boards</option>
          </Select>
        </Field>
        <Field label="Small select">
          <Select size="sm" name="sm" defaultValue="a">
            <option value="a">Option A</option>
            <option value="b">Option B</option>
          </Select>
        </Field>
        <Field label="Reason" hint="Kept as a lesson for this product.">
          <Textarea name="reason" placeholder="Why is this not a fit?" />
        </Field>
        <Field label="Search records">
          <SearchInput name="q" placeholder="Company, domain or email" />
        </Field>
      </div>

      <div className={styles.fields} data-field-sample="inline">
        <Field label="From" layout="inline">
          <Input type="date" name="from" defaultValue="2026-09-01" />
        </Field>
        <Field label="State" layout="inline">
          <Select name="state" defaultValue="all">
            <option value="all">All</option>
            <option value="new">New</option>
          </Select>
        </Field>
        <SearchInput size="sm" aria-label="Filter the list" placeholder="Filter" />
      </div>

      <div className={styles.fields} data-field-sample="choices">
        <Checkbox name="signature" label="Include signature" defaultChecked />
        <Checkbox name="cc" label="Copy me" />
        <Checkbox name="locked" label="Disabled" disabled />
        <Checkbox
          name="learn"
          label="Learn from this decision"
          description="Adds a lesson to the product's knowledge."
          defaultChecked
        />
        <Switch name="autopilot" label="Autopilot" />
        <Switch name="drafts" label="Auto-draft replies" defaultChecked />
        <Switch
          name="approval"
          label="Require approval before send"
          description="Stages each follow-up for review."
          position="end"
          defaultChecked
        />
        <Switch name="ro" label="Read-only switch" disabled defaultChecked />
      </div>

      {/* A legacy context that restyles bare controls (.form-grid input):
          the component control looks the same as above. */}
      <div className="form-grid" data-field-sample="legacy-context">
        <Field label="Inside .form-grid">
          <Input name="legacyContext" defaultValue="Component wins" />
        </Field>
      </div>
    </div>
  );
}

export function EmailPreviewSample() {
  return (
    <div className={styles.stack} data-email-preview-sample="">
      <EmailPreview html={SAMPLE_SIGNATURE_HTML} title="Signature preview: sample" />
    </div>
  );
}
