// Language helpers — pure, no DB, no AI, no Next/server-only imports.
// Ported from kompas-lead-discovery's aiProvider helpers (suriyakis repo)
// where the same heuristic detection has been battle-tested in production.
//
// Two responsibilities:
//   1. Detect a language from free-form text (description, instructions,
//      outreach angle) using a diacritic + word-frequency scoring system.
//   2. Resolve an effective language for a product profile via a priority
//      cascade so a Polish description on a profile that explicitly says
//      `language: 'en'` still ends up generating Polish outreach.
//
// Lives outside src/lib/services/ so client components and pure tests can
// import without dragging in the workspace context or drizzle client.

/** ISO 639-1 → human-readable English name. Used to instruct LLMs more
 *  legibly than raw two-letter codes. */
export const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  pl: 'Polish',
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  cs: 'Czech',
  sk: 'Slovak',
  uk: 'Ukrainian',
  ro: 'Romanian',
  he: 'Hebrew',
  ja: 'Japanese',
  ar: 'Arabic',
  zh: 'Chinese',
  ko: 'Korean',
  pt: 'Portuguese',
  nl: 'Dutch',
  sv: 'Swedish',
  da: 'Danish',
  fi: 'Finnish',
  no: 'Norwegian',
  hu: 'Hungarian',
  bg: 'Bulgarian',
  hr: 'Croatian',
  sr: 'Serbian',
  el: 'Greek',
  tr: 'Turkish',
  th: 'Thai',
  vi: 'Vietnamese',
  hi: 'Hindi',
  lt: 'Lithuanian',
  lv: 'Latvian',
  et: 'Estonian',
};

export type SupportedLanguage = keyof typeof LANGUAGE_NAMES;

/** ISO 639-1 → display name, defaulting to the bare code if unknown so
 *  unfamiliar tags still produce something usable in a prompt. */
export function getLanguageName(iso: string | null | undefined): string {
  if (!iso) return 'English';
  const normalized = iso.toLowerCase().split('-')[0] ?? iso;
  return LANGUAGE_NAMES[normalized] ?? normalized;
}

/** Returns true if the ISO code is in the LANGUAGE_NAMES map. */
export function isKnownLanguage(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const normalized = iso.toLowerCase().split('-')[0] ?? iso;
  return normalized in LANGUAGE_NAMES;
}

// ─── Heuristic detection ──────────────────────────────────────────────
//
// Word-frequency markers per language. The regex captures common stop
// words and a few sector-specific terms (construction / business) that
// the kompas dataset showed up reliably in B2B descriptions. Weight is
// applied per-match; PL/DE/FR/RO additionally score on language-specific
// diacritics (very strong signal — diacritic mismatch is rare).

interface LangMarker {
  words: RegExp;
  weight: number;
}

const LANG_MARKERS: Readonly<Record<string, LangMarker>> = {
  pl: {
    words:
      /\b(jest|oraz|dla|nie|się|który|która|które|przez|jako|może|będzie|został|przy|nad|pod|bez|ich|tego|tej|tych|nasz|wasz|bardzo|tylko|także|również|jednak|więc|ponieważ|dlatego|kiedy|gdzie|jak|co|kto|czy|tak|już|jeszcze|jestem|jesteś|mamy|firma|produkt|projekt|budow|beton|materiał|zastosow|rozwiązan|technolog|ofert|współprac|specjalizuj|zapewn|umożliwi)\b/gi,
    weight: 3,
  },
  en: {
    words:
      /\b(the|and|for|that|with|this|from|are|was|were|been|have|has|had|will|would|could|should|our|your|their|which|about|into|through|during|before|after|between|under|over|also|however|therefore|because|when|where|how|what|who|company|product|project|construction|concrete|material|solution|technology|offer|provide|enable|specializ)\b/gi,
    weight: 3,
  },
  de: {
    words:
      /\b(und|der|die|das|ist|ein|eine|für|mit|von|auf|den|dem|des|als|auch|sich|wird|wurde|werden|kann|sind|hat|haben|oder|aber|nach|bei|über|unter|durch|vor|zwischen|noch|nur|sehr|schon|wenn|weil|dass|wie|wo|wer|was|Unternehmen|Produkt|Projekt|Bau|Beton|Material|Lösung|Technologie|Angebot|bieten)\b/gi,
    weight: 3,
  },
  fr: {
    words:
      /\b(les|des|une|est|sont|pour|avec|dans|par|sur|qui|que|nous|vous|leur|cette|ces|mais|aussi|donc|parce|quand|comment|entreprise|produit|projet|construction|béton|matériau|solution|technologie|offre|permettre)\b/gi,
    weight: 3,
  },
  es: {
    words:
      /\b(los|las|una|del|por|con|para|como|más|pero|también|porque|cuando|donde|empresa|producto|proyecto|construcción|hormigón|material|solución|tecnología|oferta|proporcionar)\b/gi,
    weight: 3,
  },
  it: {
    words:
      /\b(gli|dei|una|del|per|con|che|come|più|anche|perché|quando|dove|azienda|prodotto|progetto|costruzione|calcestruzzo|materiale|soluzione|tecnologia|offerta|fornire)\b/gi,
    weight: 3,
  },
  ro: {
    words:
      /\b(este|sunt|pentru|care|din|sau|dar|mai|fost|poate|avea|fiind|acest|această|aceste|prin|între|asupra|după|fără|doar|foarte|încă|deja|când|unde|cum|cine|firma|companie|produs|proiect|construcție|beton|material|soluție|tehnologie|ofertă|furniza|impermeabilizare|lucrări|clădire|structură|rezistență|aplicare|suprafață|protecție|etanșare)\b/gi,
    weight: 3,
  },
};

const PL_DIACRITICS = /[ąćęłńśźżĄĆĘŁŃŚŹŻ]/g;
const DE_DIACRITICS = /[äöüßÄÖÜ]/g;
const FR_DIACRITICS = /[àâçèéêëîïôùûÿÀÂÇÈÉÊËÎÏÔÙÛŸ]/g;
const RO_DIACRITICS = /[ăâîșțĂÂÎȘȚ]/g;

/** Minimum text length we'll attempt detection on. Anything shorter is
 *  too noisy — the false-positive rate explodes. */
const DETECTION_MIN_LENGTH = 20;

/** Minimum aggregate score for a confident verdict. Below this we say
 *  "no idea" rather than guess. */
const DETECTION_CONFIDENCE_THRESHOLD = 6;

/**
 * Detect a language from free-form text. Returns an ISO 639-1 code or
 * `null` when the text is too short, too noisy, or doesn't score above
 * the confidence floor.
 *
 * Algorithm:
 *   - Sample first 2000 chars (longer doesn't help, hurts perf).
 *   - For each language, count regex matches × weight.
 *   - Boost PL/DE/FR/RO by their diacritic count × 5 (or 4 for FR
 *     because French diacritics overlap with Romanian/Portuguese).
 *   - Return the highest-scoring language, or null below threshold.
 */
export function detectLanguageFromText(
  text: string | null | undefined,
): string | null {
  if (!text || text.trim().length < DETECTION_MIN_LENGTH) return null;

  const sample = text.substring(0, 2000);
  const scores: Record<string, number> = {};

  for (const [lang, { words, weight }] of Object.entries(LANG_MARKERS)) {
    const matches = sample.match(words);
    scores[lang] = (matches?.length ?? 0) * weight;
  }

  const plDiacritics = (sample.match(PL_DIACRITICS) ?? []).length;
  const deDiacritics = (sample.match(DE_DIACRITICS) ?? []).length;
  const frDiacritics = (sample.match(FR_DIACRITICS) ?? []).length;
  const roDiacritics = (sample.match(RO_DIACRITICS) ?? []).length;

  if (plDiacritics > 2) scores.pl = (scores.pl ?? 0) + plDiacritics * 5;
  if (deDiacritics > 2) scores.de = (scores.de ?? 0) + deDiacritics * 5;
  if (frDiacritics > 2) scores.fr = (scores.fr ?? 0) + frDiacritics * 4;
  if (roDiacritics > 2) scores.ro = (scores.ro ?? 0) + roDiacritics * 5;

  let bestLang: string | null = null;
  let bestScore = 0;
  for (const [lang, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestLang = lang;
    }
  }

  return bestScore >= DETECTION_CONFIDENCE_THRESHOLD ? bestLang : null;
}

/** Subset of a product profile that participates in language resolution.
 *  Defined structurally so callers can pass either a full profile row or
 *  a freshly-typed form draft without ceremony. */
export interface ResolvableProfile {
  /** Explicit language tag set by the user (defaults to 'en' on create). */
  language?: string | null;
  /** Free-form description fields scanned by the detector, in priority
   *  order: long description first, then any instruction/angle text the
   *  caller wants the detector to consider. */
  fullDescription?: string | null;
  shortDescription?: string | null;
  outreachInstructions?: string | null;
  negativeOutreachInstructions?: string | null;
}

/**
 * Resolve the effective language for outreach generation against a product
 * profile. Detection from text BEATS the explicit `language` field — that
 * way an operator who pastes a Polish description but forgot to flip the
 * language dropdown still gets Polish outreach instead of English-with-
 * Polish-context-leakage.
 *
 * Cascade (highest priority first):
 *   1. detected from `fullDescription`
 *   2. detected from `shortDescription`
 *   3. detected from `outreachInstructions`
 *   4. detected from `negativeOutreachInstructions`
 *   5. explicit `language` field
 *   6. 'en'
 */
export function resolveProfileLanguage(profile: ResolvableProfile): string {
  const sources: ReadonlyArray<string | null | undefined> = [
    profile.fullDescription,
    profile.shortDescription,
    profile.outreachInstructions,
    profile.negativeOutreachInstructions,
  ];
  for (const src of sources) {
    const detected = detectLanguageFromText(src);
    if (detected) return detected;
  }
  if (profile.language) return profile.language;
  return 'en';
}
