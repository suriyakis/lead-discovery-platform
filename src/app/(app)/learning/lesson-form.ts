// Shared parsing for the /learning/new and /learning/[id] rule forms. The
// form is a boundary, so it goes through Zod; the service then validates
// the domain (category in the registry, polarity allowed for it, products
// in this workspace — the last one by the composite FK).

import { z } from 'zod';
import type { LessonScopeInput } from '@/lib/services/learning';
import {
  LESSON_CATEGORY_REGISTRY,
  isLessonCategory,
  parseLessonPolarity,
  type LessonPolarity,
} from '@/lib/services/learning-categories';

const DIGITS = /^\d+$/;

// Every field degrades to a value the service rejects with a precise
// error code (rule_required, unknown_category, scope_required…) instead of
// a ZodError the page could only show as a crash.
const LessonFormSchema = z.object({
  rule: z.string(),
  category: z.string().max(100).catch(''),
  polarity: z.string().max(20).catch(''),
  scope: z.enum(['workspace', 'products']).catch('workspace'),
  productProfileIds: z.array(z.string().regex(DIGITS).max(20)).max(200).catch([]),
  confidence: z.coerce.number().int().min(0).max(100).catch(65),
});

export interface ParsedLessonForm {
  rule: string;
  category: string;
  /** undefined = keep / use the category default. */
  polarity: LessonPolarity | undefined;
  scope: LessonScopeInput;
  confidence: number;
}

export function parseLessonForm(formData: FormData): ParsedLessonForm {
  const parsed = LessonFormSchema.parse({
    rule: String(formData.get('rule') ?? ''),
    category: String(formData.get('category') ?? ''),
    polarity: String(formData.get('polarity') ?? ''),
    scope: String(formData.get('scope') ?? 'workspace'),
    productProfileIds: formData
      .getAll('productProfileIds')
      .map((v) => String(v))
      .filter((v) => DIGITS.test(v)),
    confidence: String(formData.get('confidence') ?? '65') || '65',
  });
  // A category with a single allowed direction fixes it: the select is
  // ignored there, so re-filing a style rule as a fit signal does not
  // fail on a now-meaningless "Neutral". Where the category lets the rule
  // choose, the operator's choice is passed on and validated.
  const fixedDirection =
    isLessonCategory(parsed.category) &&
    LESSON_CATEGORY_REGISTRY[parsed.category].polarity.allowed.length === 1;
  return {
    rule: parsed.rule,
    category: parsed.category,
    polarity: fixedDirection ? undefined : (parseLessonPolarity(parsed.polarity) ?? undefined),
    // 'products' with nothing ticked is passed through as-is: the service
    // answers scope_required, which the page turns into a sentence.
    scope:
      parsed.scope === 'products'
        ? { kind: 'products', productProfileIds: parsed.productProfileIds.map((v) => BigInt(v)) }
        : { kind: 'workspace' },
    confidence: parsed.confidence,
  };
}
