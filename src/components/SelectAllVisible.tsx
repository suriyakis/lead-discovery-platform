'use client';

// Lightweight client island used inside server-rendered bulk toolbars.
// Toggling this checkbox flips every checkbox in the document that is
// associated (via the HTML5 `form` attribute) with the given form id and
// has name="ids". Pure DOM mutation — keeps the rest of the page server-
// rendered.

import { useId, useRef, type ChangeEvent } from 'react';

interface Props {
  formId: string;
  label?: string;
}

export function SelectAllVisible({ formId, label = 'Select all on this page' }: Props) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const next = e.currentTarget.checked;
    const checkboxes = document.querySelectorAll<HTMLInputElement>(
      `input[type="checkbox"][form="${formId}"][name="ids"]`,
    );
    checkboxes.forEach((cb) => {
      if (cb.checked !== next) {
        cb.checked = next;
        // Dispatch a change event so any CSS selectors keyed on :checked
        // (e.g., .bulk-selectable-list li:has(input:checked)) get the
        // browser to re-evaluate — most engines do this automatically but
        // the manual dispatch is cheap and consistent across browsers.
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  };
  return (
    <label className="bulk-select-all" htmlFor={id}>
      <input
        ref={ref}
        id={id}
        type="checkbox"
        onChange={onChange}
        aria-label={label}
      />
      <span>{label}</span>
    </label>
  );
}
