// The platform handbook — what the in-app guide ("Ask the platform")
// knows about how the product works, assembled once at boot (AP-03):
//
//   narrative.ts          the prose, with claim tags {H-xx}
//   generated.ts          blocks built from code: the screens index (from
//                         the navigation registry), pipeline stages, reply
//                         classes, language order, autopilot steps and the
//                         billing catalogue this install sells
//   known-limitations.ts  what does not work yet, by issue id
//   user-guide.ts         the same text as docs/USER_GUIDE.md
//                         (`pnpm handbook:export`)
//
// HANDBOOK_SOURCE keeps the claim tags for the tests; PLATFORM_HANDBOOK is
// what the model reads. HANDBOOK_VERSION fingerprints the text, so an
// answer can be traced to the handbook that produced it.

import { createHash } from 'node:crypto';
import { billingFactsFromEnv, generatedBlocks, type BillingFacts } from './generated';
import { knownLimitationsSection } from './known-limitations';
import { AUTOPILOT_STEP_NOTES, handbookNarrative } from './narrative';

export {
  KNOWN_LIMITATIONS,
  KNOWN_LIMITATIONS_HEADING,
  type KnownLimitation,
} from './known-limitations';

export interface BuildHandbookOptions {
  /** The billing catalogue to describe; default: this install's env. */
  billing?: BillingFacts;
}

/** The full handbook text, claim tags included. */
export function buildHandbookSource(options: BuildHandbookOptions = {}): string {
  const blocks = generatedBlocks({
    billing: options.billing ?? billingFactsFromEnv(),
    autopilotNotes: AUTOPILOT_STEP_NOTES,
  });
  return `${handbookNarrative(blocks)}\n\n${knownLimitationsSection()}`;
}

const CLAIM_TAG_RE = /\{(H-\d{2})\}/g;

/** Remove claim tags (and the space before them) for display. */
export function stripClaimTags(text: string): string {
  return text.replace(/ ?\{H-\d{2}\}/g, '');
}

/** A short, stable fingerprint of a handbook text. */
export function handbookVersion(text: string): string {
  return `hb-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
}

/** Built once at boot, from this install's environment. */
export const HANDBOOK_SOURCE = buildHandbookSource();

/** What the assistant's model reads: the handbook without claim tags. */
export const PLATFORM_HANDBOOK = stripClaimTags(HANDBOOK_SOURCE);

/** Fingerprint of PLATFORM_HANDBOOK; identical inputs give the same value. */
export const HANDBOOK_VERSION = handbookVersion(PLATFORM_HANDBOOK);

/** Every claim tag in the handbook, e.g. ["H-01", "H-02", …], deduped. */
export function handbookClaimTags(source: string = HANDBOOK_SOURCE): string[] {
  const tags = new Set<string>();
  for (const m of source.matchAll(CLAIM_TAG_RE)) tags.add(m[1]!);
  return [...tags].sort();
}
