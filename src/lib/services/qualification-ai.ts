// P62-08: AI-based qualification (Wandizz-style). Each (record, product)
// pair is judged by the workspace's AI provider (Gemini Flash / Claude
// Haiku / GPT-4o-mini — whichever is configured). The AI returns the
// same verdict shape as the existing rules engine, so the call sites
// don't have to branch.

import { z } from 'zod';
import type { ProductProfile } from '@/lib/db/schema/products';
import type { LearningLesson } from '@/lib/db/schema/learning';
import { getQualificationProviderForCtx } from '@/lib/ai';
import type { WorkspaceContext } from './context';
import type { ClassifiableRecord, ClassificationVerdict } from './qualification-engine';

const VerdictSchema = z.object({
  isRelevant: z.boolean(),
  relevanceScore: z.number().int().min(0).max(100),
  confidence: z.number().int().min(0).max(100),
  matchedKeywords: z.array(z.string()).max(10),
  disqualifyingSignals: z.array(z.string()).max(10).default([]),
  reason: z.string().min(1).max(800),
});

function buildSystemPrompt(): string {
  return [
    'You are a B2B lead qualification engine.',
    'Given a PRODUCT PROFILE and a DISCOVERED RECORD (a company / project /',
    'tender from search or scrape), decide whether the record represents a',
    'likely customer for the product. Be strict but fair — false positives',
    'cost more than false negatives because they trigger outreach emails.',
    '',
    'Return JSON only, with this exact shape:',
    '{',
    '  "isRelevant": boolean,                  // true if a sales rep would',
    '                                          //  open this lead',
    '  "relevanceScore": integer 0..100,       // 0=no fit, 100=ideal',
    '  "confidence": integer 0..100,           // how sure you are in the',
    '                                          //  score given the evidence',
    '  "matchedKeywords": string[] (≤10),      // concrete signals in the',
    '                                          //  record that support the',
    '                                          //  match (verbatim phrases)',
    '  "disqualifyingSignals": string[] (≤10), // concrete signals against',
    '                                          //  the match',
    '  "reason": string (≤800 chars)           // one paragraph rationale',
    '}',
    '',
    'Scoring guide:',
    '  0–39   no fit (wrong sector / wrong customer / forbidden)',
    '  40–59  weak fit, would need manual triage',
    '  60–74  reasonable fit, worth outreach',
    '  75–89  strong fit, ideal customer',
    '  90–100 textbook ideal customer',
    '',
    'Set isRelevant=true when score ≥ the product\'s minRelevanceThreshold',
    '(provided per call). Be parsimonious with relevanceScore: if the',
    'evidence is thin (e.g. only domain + a search snippet), reflect that',
    'in `confidence` and avoid scoring above 75.',
  ].join('\n');
}

function buildUserPrompt(
  record: ClassifiableRecord,
  product: ProductProfile,
  lessons: ReadonlyArray<LearningLesson>,
  targetCountry: string | null,
): string {
  const sections: string[] = [];

  sections.push('### PRODUCT PROFILE');
  sections.push(`Name: ${product.name}`);
  if (product.shortDescription) {
    sections.push(`Short: ${product.shortDescription}`);
  }
  if (product.fullDescription) {
    sections.push(`Full: ${product.fullDescription}`);
  }
  if (product.targetCustomerTypes.length > 0) {
    sections.push(
      `Target customer types: ${product.targetCustomerTypes.join(', ')}`,
    );
  }
  if (product.targetSectors.length > 0) {
    sections.push(`Target sectors: ${product.targetSectors.join(', ')}`);
  }
  if (product.targetProjectTypes.length > 0) {
    sections.push(
      `Target project types: ${product.targetProjectTypes.join(', ')}`,
    );
  }
  if (product.includeKeywords.length > 0) {
    sections.push(
      `Positive signals (any of these = good fit): ${product.includeKeywords.join(', ')}`,
    );
  }
  if (product.excludeKeywords.length > 0) {
    sections.push(
      `Disqualifying signals (any of these = bad fit): ${product.excludeKeywords.join(', ')}`,
    );
  }
  if (product.qualificationCriteria) {
    sections.push(`Qualification criteria: ${product.qualificationCriteria}`);
  }
  if (product.disqualificationCriteria) {
    sections.push(
      `Disqualification criteria: ${product.disqualificationCriteria}`,
    );
  }
  sections.push(`minRelevanceThreshold: ${product.relevanceThreshold}`);

  // Geo gate. The recipe that discovered this record decides the target
  // country (Connectors → recipes). Grounding search can only bias sourcing,
  // not enforce it, so this is where out-of-country companies are actually
  // rejected — working together with the product's disqualification criteria
  // above. When the recipe sets no country, this section is omitted and
  // qualification behaves exactly as before.
  if (targetCountry) {
    sections.push('');
    sections.push('### TARGET GEOGRAPHY (hard requirement)');
    sections.push(
      `The recipe that discovered this record targets companies in: ${targetCountry}.`,
    );
    sections.push(
      `Set isRelevant=false for any company that shows evidence of being based ` +
        `OUTSIDE ${targetCountry} (e.g. a foreign address, phone code, or country ` +
        `mention), even if it otherwise fits the product — a strong product fit ` +
        `does NOT override a geography mismatch. If the company's location is ` +
        `genuinely unclear, do not assume it is in ${targetCountry}: lower the ` +
        `confidence and treat the missing geography as a negative signal, but do ` +
        `not hard-reject on absence of evidence alone.`,
    );
  }

  if (lessons.length > 0) {
    sections.push('');
    sections.push('### PRIOR LESSONS (operator-validated; weigh accordingly)');
    for (const l of lessons.slice(0, 10)) {
      const polarity = l.category.includes('negative') || l.category === 'false_positive'
        ? 'AVOID'
        : 'PREFER';
      sections.push(`- [${polarity}] ${l.rule}`);
    }
  }

  sections.push('');
  sections.push('### DISCOVERED RECORD');
  if (record.title) sections.push(`Title: ${record.title}`);
  if (record.snippet) sections.push(`Snippet: ${record.snippet}`);
  if (record.domain) sections.push(`Domain: ${record.domain}`);
  if (record.url) sections.push(`URL: ${record.url}`);
  if (record.body) {
    // Truncate aggressively — long bodies are usually scraped HTML with
    // a lot of boilerplate.
    sections.push(`Body excerpt: ${record.body.slice(0, 3000)}`);
  }

  return sections.join('\n');
}

export interface AIClassifyOptions {
  /** Override model — useful for tests + cost-sensitive product overrides. */
  model?: string;
  /** Test seam — bypass real AI provider lookup. */
  providerOverride?: import('@/lib/ai').IAIProvider;
  /**
   * Target country for this record, taken from the recipe that discovered it.
   * When set, the qualifier disqualifies companies not located there. Null /
   * omitted = no geo gate (recipe set no country).
   */
  targetCountry?: string | null;
}

/** Wandizz-style AI qualification. Returns the same verdict shape as the
 *  rules engine, with method='ai'. Throws on AI provider failure — caller
 *  is responsible for the rules-engine fallback. */
export async function classifyRecordWithAI(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  record: ClassifiableRecord,
  product: ProductProfile,
  lessons: ReadonlyArray<LearningLesson>,
  options: AIClassifyOptions = {},
): Promise<ClassificationVerdict> {
  const provider =
    options.providerOverride ?? (await getQualificationProviderForCtx(ctx));
  const verdict = await provider.generateJson(
    {
      system: buildSystemPrompt(),
      prompt: buildUserPrompt(record, product, lessons, options.targetCountry ?? null),
    },
    VerdictSchema,
    {
      temperature: 0.1,
      maxTokens: 600,
      ...(options.model ? { model: options.model } : {}),
    },
  );
  return {
    isRelevant: verdict.isRelevant,
    relevanceScore: verdict.relevanceScore,
    confidence: verdict.confidence,
    matchedKeywords: verdict.matchedKeywords.slice(0, 10),
    disqualifyingSignals: (verdict.disqualifyingSignals ?? []).slice(0, 10),
    qualificationReason: verdict.isRelevant ? verdict.reason : null,
    rejectionReason: verdict.isRelevant ? null : verdict.reason,
    evidence: {
      contributions: [
        {
          kind: 'ai_score',
          value: `${verdict.relevanceScore}/100 (conf ${verdict.confidence})`,
          delta: verdict.relevanceScore,
        },
      ],
      matchedLessonIds: [] as bigint[],
    },
    method: 'ai',
  };
}
