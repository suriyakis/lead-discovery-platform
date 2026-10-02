// Component gallery (DS-06): every design token and primitive in every
// state, the review surface for the owner and the workstream leads
// (no Storybook). Dev and test only: an ordinary 404 unless
// ENABLE_TEST_ROUTES=1, which production never sets. It needs no session
// and no data. Later DS deliverables add a section per primitive.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Alert, type AlertTone } from '@/components/Alert';
import { BRAND_NAME } from '@/lib/brand';
import { IndeterminateCheckbox } from './_IndeterminateCheckbox';
import { GallerySection, TokenGroupSamples, ToneSamples } from './_samples';
import { TOKEN_GROUPS } from './_catalog';
import styles from './gallery.module.css';
import probe from './layer-probe.module.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `Component gallery · ${BRAND_NAME}`,
  robots: { index: false, follow: false },
};

/** The cascade layer order every stylesheet declares (src/styles/*.css). */
const LAYERS = ['reset', 'tokens', 'base', 'legacy', 'components', 'patterns', 'utilities'];

const ALERTS: ReadonlyArray<{ tone: AlertTone; title: string; body: string }> = [
  { tone: 'info', title: 'Import running', body: 'Results appear here as each source finishes.' },
  { tone: 'success', title: 'Mailbox connected', body: 'Sync reads new mail every 5 minutes.' },
  { tone: 'warning', title: 'Needs your decision', body: 'Three records wait for review.' },
  { tone: 'danger', title: 'Mailbox failing', body: 'Password rejected by the mail server.' },
];

interface ControlProps {
  id: string;
  'aria-describedby'?: string;
}

/** Label, control, error and hint, wired by id the way the Field primitive (DS-10) will be. */
function Field({
  id,
  label,
  hint,
  error,
  control,
}: Readonly<{
  id: string;
  label: string;
  hint?: string;
  error?: string;
  control: (props: ControlProps) => React.ReactNode;
}>) {
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean);
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.fieldLabel}>
        {label}
      </label>
      {control({
        id,
        ...(describedBy.length ? { 'aria-describedby': describedBy.join(' ') } : {}),
      })}
      {error ? (
        <span id={`${id}-error`} className={styles.fieldError}>
          {error}
        </span>
      ) : null}
      {hint ? (
        <span id={`${id}-hint`} className={styles.fieldHint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export default function ComponentGallery() {
  if (process.env.ENABLE_TEST_ROUTES !== '1') notFound();

  const sections = [
    ...TOKEN_GROUPS.map((g) => ({ id: g.id, title: g.title })),
    { id: 'tones', title: 'Tones' },
    { id: 'form-controls', title: 'Form controls' },
    { id: 'alerts', title: 'Alert' },
    { id: 'layers', title: 'Cascade layers' },
  ];

  return (
    <main className={styles.page} data-ds>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Design system · Direction A</p>
        <h1 className={styles.title}>Component gallery</h1>
        <p className={styles.lede}>
          Every token and primitive in every state, drawn from src/styles/tokens.css. Dev and test
          only. Each design-system deliverable adds its primitives here.
        </p>
        <nav className={styles.toc} aria-label="Gallery sections">
          {sections.map((s) => (
            <a key={s.id} href={`#${s.id}`}>
              {s.title}
            </a>
          ))}
        </nav>
      </header>

      {TOKEN_GROUPS.map((group) => (
        <GallerySection
          key={group.id}
          id={group.id}
          title={group.title}
          description={group.description}
        >
          <TokenGroupSamples group={group} />
        </GallerySection>
      ))}

      <GallerySection
        id="tones"
        title="Tones"
        description="The meaning map: a component picks one of eight tones. Each chip reads at 4.5:1 or more on every surface."
      >
        <ToneSamples />
      </GallerySection>

      <GallerySection
        id="form-controls"
        title="Form controls"
        description="Base element defaults inside [data-ds]: 36px controls (44px and 16px text on touch), the control border, focus ring (press Tab), invalid and disabled states. Buttons keep the legacy look until the Button primitive."
      >
        <div className={styles.fields}>
          <Field
            id="g-company"
            label="Company name"
            hint="As it appears on the website."
            control={(p) => <input {...p} type="text" placeholder="Mersey Mechanical" />}
          />
          <Field
            id="g-website"
            label="Website"
            control={(p) => <input {...p} type="url" defaultValue="https://mersey.example" />}
          />
          <Field
            id="g-email"
            label="Contact email"
            error="Enter a full address, like name@example.com."
            control={(p) => <input {...p} type="email" defaultValue="sales@" aria-invalid="true" />}
          />
          <Field
            id="g-search"
            label="Search"
            control={(p) => <input {...p} type="search" placeholder="Search records" />}
          />
          <Field
            id="g-limit"
            label="Daily send limit"
            control={(p) => <input {...p} type="number" defaultValue={40} min={0} />}
          />
          <Field
            id="g-date"
            label="Follow up on"
            control={(p) => <input {...p} type="date" defaultValue="2026-10-02" />}
          />
          <Field
            id="g-disabled"
            label="Disabled input"
            control={(p) => <input {...p} type="text" defaultValue="Not editable" disabled />}
          />
          <Field
            id="g-product"
            label="Product"
            control={(p) => (
              <select {...p} defaultValue="aerogel">
                <option value="aerogel">Aerogel blankets</option>
                <option value="boards">Insulation boards</option>
              </select>
            )}
          />
          <Field
            id="g-product-disabled"
            label="Disabled select"
            control={(p) => (
              <select {...p} defaultValue="aerogel" disabled>
                <option value="aerogel">Aerogel blankets</option>
              </select>
            )}
          />
          <Field
            id="g-reason"
            label="Reason"
            hint="Kept as a lesson for this product."
            control={(p) => <textarea {...p} placeholder="Why is this not a fit?" />}
          />
          <fieldset className={styles.checks}>
            <legend>Checkboxes</legend>
            <label className={styles.check}>
              <input type="checkbox" name="c1" />
              Unchecked
            </label>
            <label className={styles.check}>
              <input type="checkbox" name="c2" defaultChecked />
              Checked
            </label>
            <IndeterminateCheckbox className={styles.check} label="Some selected" />
            <label className={styles.check}>
              <input type="checkbox" name="c3" disabled />
              Disabled
            </label>
            <label className={styles.check}>
              <input type="checkbox" name="c4" defaultChecked disabled />
              Disabled, checked
            </label>
          </fieldset>
          <fieldset className={styles.checks}>
            <legend>Radios and switches</legend>
            <label className={styles.check}>
              <input type="radio" name="r" value="ai" defaultChecked />
              AI drafts
            </label>
            <label className={styles.check}>
              <input type="radio" name="r" value="manual" />
              Manual
            </label>
            <label className={styles.check}>
              <input type="checkbox" role="switch" name="s1" />
              Autopilot off
            </label>
            <label className={styles.check}>
              <input type="checkbox" role="switch" name="s2" defaultChecked />
              Autopilot on
            </label>
          </fieldset>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Native buttons</span>
            <div className={styles.check}>
              <button type="button">Save</button>
              <button type="button" disabled>
                Disabled
              </button>
            </div>
          </div>
        </div>
      </GallerySection>

      <GallerySection
        id="alerts"
        title="Alert"
        description="Tone, title, body and an optional action that wraps under the text below 640px."
      >
        <div className={styles.stack}>
          {ALERTS.map((a) => (
            <Alert
              key={a.tone}
              tone={a.tone}
              title={a.title}
              action={<button type="button">Open</button>}
            >
              <p>{a.body}</p>
            </Alert>
          ))}
          <Alert tone="info">
            <p>An alert with a body only.</p>
          </Alert>
        </div>
      </GallerySection>

      <GallerySection
        id="layers"
        title="Cascade layers"
        description="Every stylesheet and CSS module opens with the same @layer statement, so a later layer wins whatever the specificity or the order the chunks load in."
      >
        <ol className={styles.layerOrder} aria-label="Layer order, lowest first">
          {LAYERS.map((layer) => (
            <li key={layer}>{layer}</li>
          ))}
        </ol>
        <ul className="thread-list" data-layer-probe-list>
          <li data-layer-probe="legacy">
            Legacy only: <code className={styles.name}>.thread-list li</code> (0,1,1) pads this row.
          </li>
          <li className={probe.probe} data-layer-probe="component" data-probe-class={probe.probe}>
            Components layer: one class (0,1,0) sets a 4px padding and wins.
          </li>
        </ul>
      </GallerySection>
    </main>
  );
}
