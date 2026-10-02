// The outbound-language cascade, as data (AP-03, I132). The resolver in
// services/language-resolution.ts walks these tiers in this order, and the
// assistant handbook prints the same list ("Emails in the wrong
// language"), so reordering a tier changes the behaviour and the guide
// together. Kept free of imports so the handbook export script can load
// it without a database.

export type OutboundLanguageSource =
  | 'lead'
  | 'recipe'
  | 'workspace_default'
  | 'product'
  | 'workspace'
  | 'default';

export interface LanguageTier {
  source: OutboundLanguageSource;
  /** How the guide names the tier. */
  label: string;
  /** Where an operator sets it (handbook text; [/path] links allowed). */
  where: string;
}

/** First tier that yields a known language wins; 'default' always does. */
export const LANGUAGE_PRECEDENCE: ReadonlyArray<LanguageTier> = [
  {
    source: 'lead',
    label: "the lead's own language",
    where: "on the lead's page, opened from [/pipeline]",
  },
  {
    source: 'recipe',
    label: "the recipe's Language",
    where: 'on the recipe, under [/connectors]',
  },
  {
    source: 'workspace_default',
    label: 'the workspace default outreach language',
    where: '[/settings/outreach]',
  },
  {
    source: 'product',
    label: "the product's language",
    where:
      "[/products] — note that a product description written in another language can override the product's Language field",
  },
  {
    source: 'workspace',
    label: 'the workspace native language',
    where: '[/settings/outreach]',
  },
  { source: 'default', label: 'English', where: 'when nothing else is set' },
];
