// KL-01 acceptance 4: the qualification prompt marks each rule PREFER /
// AVOID / NOTE from its polarity column, not from its category name. A
// polarity -1 sector_preference rule ("avoid councils") used to render as
// PREFER because only *negative* / false_positive categories became AVOID.

import { describe, expect, it } from 'vitest';
import type { ZodSchema } from 'zod';
import type { AIGenInput, AIGenResult, IAIProvider } from '@/lib/ai';
import type { ProductProfile } from '@/lib/db/schema/products';
import { classifyRecordWithAI } from '@/lib/services/qualification-ai';
import { makeLessonRow } from './helpers/learning';

class CapturingProvider implements IAIProvider {
  public readonly id = 'capture';
  public readonly model = 'capture-1';
  public prompt = '';
  async generateText(): Promise<AIGenResult> {
    throw new Error('not used');
  }
  async generateJson<T>(input: AIGenInput, schema: ZodSchema<T>): Promise<T> {
    this.prompt = input.prompt;
    return schema.parse({
      isRelevant: false,
      relevanceScore: 20,
      confidence: 60,
      matchedKeywords: [],
      disqualifyingSignals: [],
      reason: 'council',
      detectedCountry: null,
    });
  }
  estimateCost(): number {
    return 0;
  }
  async healthCheck() {
    return { ok: true };
  }
}

const product: ProductProfile = {
  id: 1n,
  workspaceId: 1n,
  name: 'Vetrofluid',
  shortDescription: null,
  fullDescription: null,
  targetCustomerTypes: [],
  targetSectors: [],
  targetProjectTypes: [],
  includeKeywords: [],
  excludeKeywords: [],
  qualificationCriteria: null,
  disqualificationCriteria: null,
  relevanceThreshold: 50,
  outreachInstructions: null,
  negativeOutreachInstructions: null,
  forbiddenPhrases: [],
  language: 'en',
  active: true,
  enrichDraftsWithResearch: false,
  researchQuestionTemplate: 'What does {company} ({domain}) do?',
  discoveryAngle: null,
  engagementAngle: null,
  pitchAngle: null,
  documentSourceIds: [],
  pricingSnapshotId: null,
  crmMapping: {} as never,
  createdBy: null,
  updatedBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function lessonsBlock(prompt: string): string {
  const start = prompt.indexOf('### PRIOR LESSONS');
  const end = prompt.indexOf('### DISCOVERED RECORD');
  return prompt.slice(start, end).trim();
}

describe('qualification prompt renders PREFER / AVOID from polarity', () => {
  it('snapshot: an AVOID sector rule, a PREFER sector rule, a fixed AVOID and a neutral rule', async () => {
    const provider = new CapturingProvider();
    await classifyRecordWithAI(
      { workspaceId: 1n },
      { title: 'Leeds City Council — roof works', domain: 'leeds.gov.uk' },
      product,
      [
        makeLessonRow({
          id: 1n,
          category: 'sector_preference',
          rule: 'Councils and other public bodies do not buy Vetrofluid directly.',
          polarity: -1,
        }),
        makeLessonRow({
          id: 2n,
          category: 'sector_preference',
          rule: 'Roofing contractors are the best fit.',
          polarity: 1,
        }),
        makeLessonRow({
          id: 3n,
          category: 'false_positive',
          rule: 'Online shops are retailers, not installers.',
          polarity: -1,
        }),
        makeLessonRow({
          id: 4n,
          category: 'general_instruction',
          rule: 'Treat branches of one group as one company.',
          polarity: 0,
        }),
      ],
      { providerOverride: provider },
    );

    expect(lessonsBlock(provider.prompt)).toMatchInlineSnapshot(`
      "### PRIOR LESSONS (operator-validated; weigh accordingly)
      - [AVOID] Councils and other public bodies do not buy Vetrofluid directly.
      - [PREFER] Roofing contractors are the best fit.
      - [AVOID] Online shops are retailers, not installers.
      - [NOTE] Treat branches of one group as one company."
    `);
  });
});
