// Reads the follow-up card of /settings/outreach (deliverable ia:F-08,
// audit I114).
//
// Every step is one card that posts its own indexed fields, so a step's
// days and its AI instructions can never drift apart:
//   stepDays.<i>    days after the previous step (step 1: after the first email)
//   stepInstr.<i>   optional AI instructions for that step
//   stepRemove=<i>  present when the step's Remove box is ticked
// The "add a step" card posts the next free index with its days left
// empty unless the operator fills it in.
//
// Steps used to be removable only by clearing their days field, which the
// browser blocked because the inputs were `required`. Removal is now an
// explicit control, and a blank days field still means "no step here".

import { z } from 'zod';
import type { FollowUpStepConfig } from '@/lib/services/follow-up';

export const FOLLOW_UP_MAX_STEPS = 10;
export const FOLLOW_UP_MAX_DAYS = 365;
export const FOLLOW_UP_MAX_INSTRUCTIONS = 2000;

export const STEP_REMOVE_FIELD = 'stepRemove';
export const stepDaysField = (index: number): string => `stepDays.${index}`;
export const stepInstrField = (index: number): string => `stepInstr.${index}`;

const STEP_FIELD_RE = /^step(?:Days|Instr)\.(\d{1,2})$/;
const INDEX_RE = /^\d{1,2}$/;

const daysSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(FOLLOW_UP_MAX_DAYS);

export interface FollowUpFormValues {
  enabled: boolean;
  requireApproval: boolean;
  steps: FollowUpStepConfig[];
}

export type FollowUpFormResult =
  | { ok: true; value: FollowUpFormValues }
  | { ok: false; error: string };

/**
 * Turn the posted card into the settings to store. Steps keep the order
 * of their cards; removed and blank steps are dropped and the rest close
 * up, each with its own instructions.
 */
export function parseFollowUpForm(formData: FormData): FollowUpFormResult {
  const indices = new Set<number>();
  for (const key of formData.keys()) {
    const m = STEP_FIELD_RE.exec(key);
    if (m) indices.add(Number(m[1]));
  }
  const removed = new Set<number>();
  for (const v of formData.getAll(STEP_REMOVE_FIELD)) {
    if (typeof v === 'string' && INDEX_RE.test(v)) removed.add(Number(v));
  }

  const steps: FollowUpStepConfig[] = [];
  for (const index of [...indices].sort((a, b) => a - b)) {
    if (removed.has(index)) continue;
    const rawDays = fieldText(formData, stepDaysField(index)).trim();
    if (rawDays === '') continue;
    const days = daysSchema.safeParse(rawDays);
    if (!days.success) {
      return {
        ok: false,
        error: `Step ${index + 1}: days must be a whole number from 1 to ${FOLLOW_UP_MAX_DAYS}.`,
      };
    }
    steps.push({
      daysAfterPrev: days.data,
      customInstructions: fieldText(formData, stepInstrField(index))
        .trim()
        .slice(0, FOLLOW_UP_MAX_INSTRUCTIONS),
    });
  }

  if (steps.length === 0) {
    return {
      ok: false,
      error:
        'Keep at least one follow-up step. To stop follow-ups, switch "Follow-ups enabled" off instead.',
    };
  }
  if (steps.length > FOLLOW_UP_MAX_STEPS) {
    return { ok: false, error: `At most ${FOLLOW_UP_MAX_STEPS} follow-up steps.` };
  }

  return {
    ok: true,
    value: {
      enabled: formData.get('followUpEnabled') === 'on',
      requireApproval: formData.get('followUpRequireApproval') === 'on',
      steps,
    },
  };
}

function fieldText(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === 'string' ? v : '';
}
