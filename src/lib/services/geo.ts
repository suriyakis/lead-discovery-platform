// Geography enforcement for qualification + outreach.
//
// The platform must never offer a product to a company outside the recipe's
// target country. Enforcement used to live ONLY inside the AI qualification
// prompt, which left three holes: the rules-engine fallback had no geo
// logic, an unknown location defaulted to "allowed", and nothing re-checked
// geography at send time. This module closes them with one deterministic
// gate shared by every path:
//
//   normalizeCountry()       — ISO 3166-1 alpha-2 canonicalisation ("UK",
//                              "Poland", "polska" → "GB"/"PL"), so recipe
//                              config and inferred values always compare
//                              equal by code, never by spelling.
//   inferCountryFromRecord() — heuristic location from ccTLD, phone
//                              prefixes and country-name mentions. Pure,
//                              no I/O.
//   applyGeoGate()           — takes any ClassificationVerdict (AI or
//                              rules) and enforces the target country on
//                              top of it. Mismatch → hard disqualify.
//                              Unknown → verdict kept but flagged
//                              'unverified' so the review queue and the
//                              send-time guard treat it as unconfirmed.
//
// GeoStatus is persisted on the qualification row and re-checked by the
// outreach queue before dispatch (see outreach-queue.ts).

import type { ClassifiableRecord, ClassificationVerdict } from './qualification-engine';

export type GeoStatus = 'no_gate' | 'match' | 'mismatch' | 'unverified';

// ---- ISO 3166-1 alpha-2 -----------------------------------------------

const ISO_ALPHA2 = new Set(
  (
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
    'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
    'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
    'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT ' +
    'MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
    'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ ' +
    'UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
  ).split(' '),
);

/** Aliases that Intl.DisplayNames reverse lookup won't cover: non-ISO
 *  shorthands, alpha-3-ish forms, and native-language names for the
 *  markets this platform actually targets. Keys must be lowercase. */
const COUNTRY_ALIASES: Record<string, string> = {
  uk: 'GB',
  'great britain': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'northern ireland': 'GB',
  usa: 'US',
  'u.s.': 'US',
  'u.s.a.': 'US',
  america: 'US',
  'united states of america': 'US',
  uae: 'AE',
  // native names (primary target markets)
  polska: 'PL',
  deutschland: 'DE',
  österreich: 'AT',
  oesterreich: 'AT',
  schweiz: 'CH',
  suisse: 'CH',
  svizzera: 'CH',
  italia: 'IT',
  españa: 'ES',
  espana: 'ES',
  frança: 'FR',
  românia: 'RO',
  romania: 'RO',
  česko: 'CZ',
  cesko: 'CZ',
  'česká republika': 'CZ',
  czechia: 'CZ',
  'czech republic': 'CZ',
  slovensko: 'SK',
  magyarország: 'HU',
  magyarorszag: 'HU',
  nederland: 'NL',
  belgië: 'BE',
  belgique: 'BE',
  sverige: 'SE',
  norge: 'NO',
  danmark: 'DK',
  suomi: 'FI',
  ukraina: 'UA',
  україна: 'UA',
  lietuva: 'LT',
  latvija: 'LV',
  eesti: 'EE',
  hrvatska: 'HR',
  srbija: 'RS',
  ελλάδα: 'GR',
  türkiye: 'TR',
  turkiye: 'TR',
  ísland: 'IS',
  éire: 'IE',
  ireland: 'IE',
};

/** Shared, lazily-built Intl.DisplayNames — constructing one per call is
 *  measurably expensive and this module runs once per (record, product). */
let displayNamesEn: Intl.DisplayNames | null = null;

function getDisplayNames(): Intl.DisplayNames {
  displayNamesEn ??= new Intl.DisplayNames(['en'], { type: 'region' });
  return displayNamesEn;
}

/** English-name → code map, built lazily from Intl.DisplayNames so we don't
 *  hand-maintain 249 names. */
let englishNameMap: Map<string, string> | null = null;

function getEnglishNameMap(): Map<string, string> {
  if (englishNameMap) return englishNameMap;
  const map = new Map<string, string>();
  const display = getDisplayNames();
  for (const code of ISO_ALPHA2) {
    const name = display.of(code);
    if (name && name !== code) map.set(name.toLowerCase(), code);
  }
  englishNameMap = map;
  return map;
}

/**
 * Canonicalise any reasonable country spelling to ISO 3166-1 alpha-2
 * (uppercase). Accepts alpha-2 codes in any case, common shorthands
 * ("UK", "USA"), English names ("Poland") and native names for target
 * markets ("polska"). Returns null when the input can't be resolved —
 * callers must treat null as "invalid", never as "no restriction".
 */
export function normalizeCountry(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const upper = trimmed.toUpperCase();
  if (upper.length === 2 && ISO_ALPHA2.has(upper)) return upper;

  const lower = trimmed.toLowerCase();
  const alias = COUNTRY_ALIASES[lower];
  if (alias) return alias;

  const byName = getEnglishNameMap().get(lower);
  if (byName) return byName;

  return null;
}

/** Human-readable English name for an alpha-2 code ("PL" → "Poland"). */
export function countryName(code: string): string {
  try {
    return getDisplayNames().of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

// ---- heuristic inference ----------------------------------------------

/** ccTLDs that are marketed/used globally and carry no location signal. */
const GENERIC_CCTLDS = new Set([
  'io', 'ai', 'co', 'tv', 'me', 'fm', 'am', 'cc', 'ws', 'la', 'gg', 'sh',
  'ac', 'to', 'nu', 'ly', 'gl', 'im', 'vc', 'ag',
]);

/** International calling code → country. Ambiguous codes (+1 NANP, +7) are
 *  intentionally absent — we never guess between countries. Longest match
 *  wins at lookup time. */
const PHONE_PREFIXES: Record<string, string> = {
  '44': 'GB', '48': 'PL', '49': 'DE', '33': 'FR', '39': 'IT', '34': 'ES',
  '31': 'NL', '32': 'BE', '41': 'CH', '43': 'AT', '45': 'DK', '46': 'SE',
  '47': 'NO', '351': 'PT', '353': 'IE', '358': 'FI', '36': 'HU', '40': 'RO',
  '420': 'CZ', '421': 'SK', '380': 'UA', '370': 'LT', '371': 'LV', '372': 'EE',
  '385': 'HR', '381': 'RS', '386': 'SI', '387': 'BA', '389': 'MK', '30': 'GR',
  '90': 'TR', '972': 'IL', '81': 'JP', '86': 'CN', '91': 'IN', '61': 'AU',
  '64': 'NZ', '55': 'BR', '52': 'MX', '27': 'ZA', '82': 'KR', '65': 'SG',
  '971': 'AE', '966': 'SA', '354': 'IS', '352': 'LU',
};

export interface InferredCountry {
  /** ISO alpha-2 or null when no reliable signal exists. */
  country: string | null;
  /** Which signals produced (or contradicted) the inference — audit trail. */
  signals: string[];
}

/** Pre-compiled country-name matchers (aliases + English names), built once —
 *  compiling ~250 RegExps per record classified was pure waste. */
let mentionMatchers: Array<{ re: RegExp; code: string }> | null = null;

function getMentionMatchers(): Array<{ re: RegExp; code: string }> {
  if (mentionMatchers) return mentionMatchers;
  const out: Array<{ re: RegExp; code: string }> = [];
  const add = (name: string, code: string) => {
    if (name.length < 4) return; // too short to word-match safely
    out.push({
      re: new RegExp(`(?<![\\p{L}])${escapeRe(name)}(?![\\p{L}])`, 'u'),
      code,
    });
  };
  for (const [name, code] of Object.entries(COUNTRY_ALIASES)) add(name, code);
  for (const [name, code] of getEnglishNameMap()) add(name, code);
  mentionMatchers = out;
  return out;
}

/**
 * Best-effort company location from a discovered record. Pure heuristic,
 * no I/O. Signal priority: ccTLD > phone prefix > unique country-name
 * mention. Conflicting signals of the same strength resolve to null
 * (unknown) rather than guessing.
 */
export function inferCountryFromRecord(record: ClassifiableRecord): InferredCountry {
  const signals: string[] = [];

  // 1. ccTLD of the company domain.
  const domain = (record.domain ?? extractDomain(record.url)) ?? null;
  if (domain) {
    const tld = domain.toLowerCase().split('.').pop() ?? '';
    if (tld.length === 2 && !GENERIC_CCTLDS.has(tld)) {
      const code = tld === 'uk' ? 'GB' : tld.toUpperCase();
      if (ISO_ALPHA2.has(code)) {
        signals.push(`cctld:.${tld}→${code}`);
        return { country: code, signals };
      }
    }
  }

  const text = [record.title ?? '', record.snippet ?? '', record.body ?? '']
    .join('\n')
    .slice(0, 8000);

  // 2. International phone prefixes (+48 …, 0048 …).
  const phoneCodes = new Set<string>();
  const phoneRe = /(?:\+|\b00)(\d{2,3})[\s\-().]?\d{2,}/g;
  for (const m of text.matchAll(phoneRe)) {
    const digits = m[1]!;
    // Longest prefix first: try 3-digit, then 2-digit.
    const hit = PHONE_PREFIXES[digits.slice(0, 3)] ?? PHONE_PREFIXES[digits.slice(0, 2)];
    if (hit) phoneCodes.add(hit);
  }
  if (phoneCodes.size === 1) {
    const code = [...phoneCodes][0]!;
    signals.push(`phone:${code}`);
    return { country: code, signals };
  }
  if (phoneCodes.size > 1) {
    signals.push(`phone:conflict(${[...phoneCodes].join(',')})`);
  }

  // 3. Country-name mentions (English + native aliases). Only trust a
  //    UNIQUE country: multi-country pages (e.g. "offices in Poland and
  //    Germany") give no single location.
  const lowerText = text.toLowerCase();
  const mentioned = new Set<string>();
  for (const { re, code } of getMentionMatchers()) {
    if (re.test(lowerText)) mentioned.add(code);
  }
  if (mentioned.size === 1) {
    const code = [...mentioned][0]!;
    signals.push(`mention:${code}`);
    return { country: code, signals };
  }
  if (mentioned.size > 1) {
    signals.push(`mention:conflict(${[...mentioned].join(',')})`);
  }

  return { country: null, signals };
}

function extractDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- the gate -----------------------------------------------------------

export interface GeoGateResult {
  verdict: ClassificationVerdict;
  geoStatus: GeoStatus;
  /** Normalized company country the gate compared against, or null. */
  inferredCountry: string | null;
  /** Normalized target country, or null when the recipe set none. */
  targetCountry: string | null;
}

/**
 * Enforce the target country on top of a classification verdict —
 * deterministically, regardless of whether the verdict came from the AI
 * or the rules engine. This is the single choke point:
 *
 *   no target set          → 'no_gate', verdict untouched.
 *   company in target      → 'match', verdict untouched.
 *   company elsewhere      → 'mismatch', verdict force-disqualified.
 *   location unknown       → 'unverified', verdict kept but flagged; the
 *                            review queue surfaces it and the send-time
 *                            guard refuses dispatch until a human approves.
 *
 * A target that is SET but unrecognisable (legacy typo predating recipe
 * validation) must never silently disable the gate — every record under it
 * is treated as 'unverified' with a geo:invalid_target signal, so nothing
 * ships without a human look and the config error surfaces in review.
 *
 * `aiDetectedCountry` (from the AI qualifier's structured output) wins
 * over heuristic inference — the model reads the whole record, the
 * heuristics only sample it. Both are normalized before comparison so
 * "UK" vs "gb" can never slip through as a mismatch-by-spelling.
 */
export function applyGeoGate(
  verdict: ClassificationVerdict,
  record: ClassifiableRecord,
  rawTargetCountry: string | null,
  aiDetectedCountry?: string | null,
): GeoGateResult {
  const targetCountry = normalizeCountry(rawTargetCountry);
  if (!targetCountry) {
    if (rawTargetCountry !== null && rawTargetCountry.trim() !== '') {
      return {
        verdict: {
          ...verdict,
          disqualifyingSignals: dedupe([
            ...verdict.disqualifyingSignals,
            `geo:invalid_target(${rawTargetCountry.trim()})`,
          ]),
          confidence: Math.min(verdict.confidence, 60),
        },
        geoStatus: 'unverified',
        inferredCountry: null,
        targetCountry: null,
      };
    }
    return { verdict, geoStatus: 'no_gate', inferredCountry: null, targetCountry: null };
  }

  const detected = normalizeCountry(aiDetectedCountry ?? null);
  const inferred = detected ?? inferCountryFromRecord(record).country;

  if (inferred === null) {
    // Unknown location: the verdict stands, but it must not reach outreach
    // without a human confirming the company is inside the target country.
    return {
      verdict: {
        ...verdict,
        disqualifyingSignals: dedupe([
          ...verdict.disqualifyingSignals,
          `geo:unverified(target=${targetCountry})`,
        ]),
        confidence: Math.min(verdict.confidence, 60),
      },
      geoStatus: 'unverified',
      inferredCountry: null,
      targetCountry,
    };
  }

  if (inferred === targetCountry) {
    return { verdict, geoStatus: 'match', inferredCountry: inferred, targetCountry };
  }

  // Hard disqualify. Product fit never overrides geography.
  return {
    verdict: {
      ...verdict,
      isRelevant: false,
      qualificationReason: null,
      rejectionReason:
        `outside target country: company located in ${countryName(inferred)} (${inferred}), ` +
        `recipe targets ${countryName(targetCountry)} (${targetCountry})` +
        (verdict.rejectionReason ? ` · ${verdict.rejectionReason}` : ''),
      disqualifyingSignals: dedupe([
        ...verdict.disqualifyingSignals,
        `geo:mismatch(${inferred}≠${targetCountry})`,
      ]),
    },
    geoStatus: 'mismatch',
    inferredCountry: inferred,
    targetCountry,
  };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)].slice(0, 10);
}
