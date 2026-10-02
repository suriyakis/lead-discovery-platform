// Review reason chips (KL-03, §5 "Chip routing" of the KL plan).
//
// A decision can carry machine-readable reasons (learning_events.
// reason_codes) next to, or instead of, a written note. The decision
// panel (KL-20) renders these chips; the learning processor reads them:
//
//   - generalisable chips say something about the KIND of company — they
//     trigger a rule extraction and are stated in the extraction prompt;
//   - entity-fact chips say something about THIS company only (existing
//     customer, competitor, duplicate, wrong country) — they never become a
//     generalised rule.
//
// Unknown codes are kept on the event (recordDecision validates only their
// shape) but carry no meaning here. Pure module: no DB, no I/O.

import type { LessonPolarity } from './learning-categories';

export type ReasonChipKind = 'generalisable' | 'entity_fact';

export interface ReasonChipDefinition {
  label: string;
  kind: ReasonChipKind;
  /** The verdict the chip argues for: +1 Fit, -1 Not a fit, 0 neither. */
  polarity: LessonPolarity;
}

export const REVIEW_REASON_CHIPS = {
  right_sector: { label: 'Right sector', kind: 'generalisable', polarity: 1 },
  right_buyer_role: { label: 'Right buyer role', kind: 'generalisable', polarity: 1 },
  active_project: { label: 'Active project or tender', kind: 'generalisable', polarity: 1 },
  right_size: { label: 'Right size', kind: 'generalisable', polarity: 1 },
  wrong_sector: { label: 'Wrong sector', kind: 'generalisable', polarity: -1 },
  too_small: { label: 'Too small', kind: 'generalisable', polarity: -1 },
  not_a_company: {
    label: 'Not a company (a directory or listing)',
    kind: 'generalisable',
    polarity: -1,
  },
  no_need: { label: 'No need for the product', kind: 'generalisable', polarity: -1 },
  existing_customer: { label: 'Existing customer', kind: 'entity_fact', polarity: 0 },
  competitor: { label: 'Competitor', kind: 'entity_fact', polarity: 0 },
  duplicate: { label: 'Duplicate', kind: 'entity_fact', polarity: 0 },
  wrong_country: { label: 'Wrong country', kind: 'entity_fact', polarity: -1 },
} as const satisfies Record<string, ReasonChipDefinition>;

export type ReviewReasonChip = keyof typeof REVIEW_REASON_CHIPS;

export const REVIEW_REASON_CHIP_CODES = Object.keys(
  REVIEW_REASON_CHIPS,
) as readonly ReviewReasonChip[];

export function isReviewReasonChip(code: string): code is ReviewReasonChip {
  return Object.prototype.hasOwnProperty.call(REVIEW_REASON_CHIPS, code);
}

/** The generalisable chips among `codes`, in registry order, deduplicated.
 *  With `polarities`, only chips arguing for one of them (a "Right sector"
 *  chip on a rejection says nothing a rejection rule can use). */
export function generalisableChips(
  codes: readonly string[],
  polarities?: readonly LessonPolarity[],
): ReviewReasonChip[] {
  const wanted = new Set(codes);
  return REVIEW_REASON_CHIP_CODES.filter((code) => {
    if (!wanted.has(code)) return false;
    const def: ReasonChipDefinition = REVIEW_REASON_CHIPS[code];
    if (def.kind !== 'generalisable') return false;
    return !polarities || polarities.includes(def.polarity);
  });
}

export function reasonChipLabel(code: string): string | null {
  return isReviewReasonChip(code) ? REVIEW_REASON_CHIPS[code].label : null;
}
