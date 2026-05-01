import { z } from 'zod';

const stringArray = z.array(z.string().min(1).max(120)).max(200);

const baseFields = {
  name: z.string().min(1).max(200),
  shortDescription: z.string().max(500).nullish(),
  fullDescription: z.string().max(5000).nullish(),
  targetCustomerTypes: stringArray.optional(),
  targetSectors: stringArray.optional(),
  targetProjectTypes: stringArray.optional(),
  includeKeywords: stringArray.optional(),
  excludeKeywords: stringArray.optional(),
  qualificationCriteria: z.string().max(5000).nullish(),
  disqualificationCriteria: z.string().max(5000).nullish(),
  relevanceThreshold: z.number().int().min(0).max(100).optional(),
  outreachInstructions: z.string().max(5000).nullish(),
  negativeOutreachInstructions: z.string().max(5000).nullish(),
  forbiddenPhrases: stringArray.optional(),
  language: z
    .string()
    .min(2)
    .max(8)
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'language must be like "en" or "en-GB"')
    .optional(),
};

/** POST /api/products body. */
export const CreateProductProfileSchema = z.object(baseFields).strict();

/** PATCH /api/products/[id] body. */
export const UpdateProductProfileSchema = z
  .object({
    ...baseFields,
    name: baseFields.name.optional(),
    active: z.boolean().optional(),
  })
  .strict();

export type CreateProductProfileBody = z.infer<typeof CreateProductProfileSchema>;
export type UpdateProductProfileBody = z.infer<typeof UpdateProductProfileSchema>;
