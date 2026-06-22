import { describe, expect, it } from 'vitest';
import {
  ENABLED_LANGUAGES,
  ENABLED_LANGUAGE_OPTIONS,
  LANGUAGE_NAMES,
  detectLanguageFromText,
  getLanguageName,
  isEnabledLanguage,
  isKnownLanguage,
  resolveProfileLanguage,
} from '@/lib/i18n/language';

// ─── getLanguageName ───────────────────────────────────────────────────

describe('getLanguageName', () => {
  it('maps known ISO codes to their English name', () => {
    expect(getLanguageName('pl')).toBe('Polish');
    expect(getLanguageName('en')).toBe('English');
    expect(getLanguageName('de')).toBe('German');
    expect(getLanguageName('ja')).toBe('Japanese');
  });

  it('strips region tags before lookup', () => {
    expect(getLanguageName('en-GB')).toBe('English');
    expect(getLanguageName('pl-PL')).toBe('Polish');
  });

  it('returns the bare code for unknown languages', () => {
    expect(getLanguageName('xx')).toBe('xx');
    expect(getLanguageName('mystery-tag')).toBe('mystery');
  });

  it('returns English for null/undefined', () => {
    expect(getLanguageName(null)).toBe('English');
    expect(getLanguageName(undefined)).toBe('English');
  });
});

describe('isKnownLanguage', () => {
  it('returns true for codes in LANGUAGE_NAMES', () => {
    expect(isKnownLanguage('pl')).toBe(true);
    expect(isKnownLanguage('en')).toBe(true);
    expect(isKnownLanguage('en-GB')).toBe(true);
  });

  it('returns false for unknown codes and empty values', () => {
    expect(isKnownLanguage('xx')).toBe(false);
    expect(isKnownLanguage(null)).toBe(false);
    expect(isKnownLanguage('')).toBe(false);
  });
});

// ─── detectLanguageFromText ───────────────────────────────────────────

describe('detectLanguageFromText', () => {
  it('returns null for null/undefined/empty/short input', () => {
    expect(detectLanguageFromText(null)).toBeNull();
    expect(detectLanguageFromText(undefined)).toBeNull();
    expect(detectLanguageFromText('')).toBeNull();
    expect(detectLanguageFromText('short')).toBeNull();
    expect(detectLanguageFromText('Hello world test')).toBeNull();
  });

  it('detects Polish (diacritics + words)', () => {
    const text =
      'Vetrofluid to innowacyjny system uszczelniający dla betonu, który zapewnia trwałą ochronę przed wodą i wilgocią. Nasz produkt jest stosowany w budownictwie komercyjnym i przemysłowym, zapewniając doskonałe rozwiązania dla projektów budowlanych.';
    expect(detectLanguageFromText(text)).toBe('pl');
  });

  it('detects English (word frequency, no diacritics)', () => {
    const text =
      'Vetrofluid is an innovative concrete waterproofing system that provides long-lasting protection against water and moisture. Our product is used in commercial and industrial construction, providing excellent solutions for building projects during the design stage. The technology enables superior performance.';
    expect(detectLanguageFromText(text)).toBe('en');
  });

  it('detects German (umlauts + words)', () => {
    const text =
      'Vetrofluid ist ein innovatives Betonabdichtungssystem, das einen dauerhaften Schutz gegen Wasser und Feuchtigkeit bietet. Unser Produkt wird im gewerblichen und industriellen Bau eingesetzt und bietet hervorragende Lösungen für Bauprojekte in der Planungsphase.';
    expect(detectLanguageFromText(text)).toBe('de');
  });

  it('detects French (diacritics + words)', () => {
    const text =
      'Vetrofluid est un système innovant d’étanchéité du béton qui offre une protection durable contre l’eau et l’humidité. Notre produit est utilisé dans la construction commerciale et industrielle pour des projets de bâtiment. Cette technologie permet une performance supérieure et une étanchéité à long terme.';
    expect(detectLanguageFromText(text)).toBe('fr');
  });

  it('detects Romanian (diacritics + words)', () => {
    const text =
      'Vetrofluid este o soluție inovatoare pentru impermeabilizarea betonului care oferă o protecție durabilă împotriva apei și umidității. Produsul nostru este utilizat în construcția comercială și industrială pentru proiecte de clădire de mare anvergură.';
    expect(detectLanguageFromText(text)).toBe('ro');
  });

  it('returns null for ambiguous mixed-language text', () => {
    expect(
      detectLanguageFromText('xxx yyy zzz aaa bbb ccc ddd eee fff ggg'),
    ).toBeNull();
  });
});

// ─── detectLanguageFromText: non-Latin scripts ────────────────────────

describe('detectLanguageFromText (non-Latin scripts)', () => {
  it('detects Japanese from kana + kanji', () => {
    const text =
      'ご連絡ありがとうございます。御社の製品にとても興味があります。詳細な情報と価格表をお送りいただけますでしょうか。';
    expect(detectLanguageFromText(text)).toBe('ja');
  });

  it('detects Hebrew', () => {
    const text =
      'שלום, אנחנו מאוד מעוניינים בהצעה שלכם עבור פרויקט הבנייה. אנא שלחו לנו מידע נוסף ומחירון מפורט.';
    expect(detectLanguageFromText(text)).toBe('he');
  });

  it('does not misfire on Latin text carrying a stray non-Latin glyph', () => {
    // A mostly-English sentence with one kanji must NOT read as Japanese —
    // the density gate keeps it under threshold and the scorer wins.
    const text =
      'Hello, we are very interested in your offer for the construction project 案 at our headquarters site this year.';
    expect(detectLanguageFromText(text)).toBe('en');
  });
});

// ─── resolveProfileLanguage ───────────────────────────────────────────

describe('resolveProfileLanguage', () => {
  it('description detection beats explicit field', () => {
    expect(
      resolveProfileLanguage({
        language: 'en',
        fullDescription:
          'Vetrofluid to innowacyjny system uszczelniający dla betonu, który zapewnia trwałą ochronę przed wodą i wilgocią. Nasz produkt jest stosowany w budownictwie komercyjnym.',
      }),
    ).toBe('pl');
  });

  it('falls back to shortDescription when fullDescription is empty', () => {
    expect(
      resolveProfileLanguage({
        language: 'en',
        fullDescription: null,
        shortDescription:
          'Vetrofluid ist ein innovatives Betonabdichtungssystem für gewerbliche und industrielle Bauprojekte mit dauerhaftem Schutz vor Feuchtigkeit.',
      }),
    ).toBe('de');
  });

  it('falls back to outreachInstructions when both descriptions are empty', () => {
    expect(
      resolveProfileLanguage({
        language: 'en',
        fullDescription: null,
        shortDescription: null,
        outreachInstructions:
          'Pisz w tonie profesjonalnym i konsultacyjnym, koncentrując się na wzajemnej wartości dla naszych klientów.',
      }),
    ).toBe('pl');
  });

  it('uses explicit language when no text scores high enough', () => {
    expect(
      resolveProfileLanguage({
        language: 'fr',
        fullDescription: null,
        shortDescription: 'short',
      }),
    ).toBe('fr');
  });

  it('returns en as ultimate fallback', () => {
    expect(resolveProfileLanguage({})).toBe('en');
    expect(resolveProfileLanguage({ language: null, fullDescription: null })).toBe('en');
  });

  it('does not use explicit language when description detects something else', () => {
    // Reproducer for the bug class kompas was specifically designed to
    // catch: user types a Polish description but leaves the language
    // dropdown on English. The detector must win.
    const language = resolveProfileLanguage({
      language: 'en',
      fullDescription:
        'Specjalizujemy się w technologii uszczelniania betonu i zapewniamy rozwiązania dla największych projektów budowlanych w kraju.',
    });
    expect(language).toBe('pl');
  });
});

// ─── LANGUAGE_NAMES coverage ──────────────────────────────────────────

describe('LANGUAGE_NAMES', () => {
  it('includes the canonical kompas set + extras', () => {
    // Spot check that the curated kompas-derived set is preserved.
    for (const code of ['pl', 'en', 'de', 'fr', 'es', 'it', 'ro', 'ja']) {
      expect(LANGUAGE_NAMES[code]).toBeTruthy();
    }
  });

  it('has every value as a non-empty string', () => {
    for (const [code, name] of Object.entries(LANGUAGE_NAMES)) {
      expect(typeof name).toBe('string');
      expect(name.length).toBeGreaterThan(0);
      expect(code).toMatch(/^[a-z]{2}$/);
    }
  });
});

// ─── ENABLED_LANGUAGES (curated UI set) ───────────────────────────────

describe('ENABLED_LANGUAGES', () => {
  it('contains the operator markets', () => {
    expect([...ENABLED_LANGUAGES]).toEqual(['en', 'pl', 'de', 'it', 'ja', 'he', 'ro']);
  });

  it('every enabled code resolves to a real name', () => {
    for (const code of ENABLED_LANGUAGES) {
      expect(LANGUAGE_NAMES[code]).toBeTruthy();
    }
  });

  it('ENABLED_LANGUAGE_OPTIONS pairs code with display name in order', () => {
    expect(ENABLED_LANGUAGE_OPTIONS).toEqual([
      { code: 'en', name: 'English' },
      { code: 'pl', name: 'Polish' },
      { code: 'de', name: 'German' },
      { code: 'it', name: 'Italian' },
      { code: 'ja', name: 'Japanese' },
      { code: 'he', name: 'Hebrew' },
      { code: 'ro', name: 'Romanian' },
    ]);
  });

  it('isEnabledLanguage gates on the curated set, region-tolerant', () => {
    expect(isEnabledLanguage('ja')).toBe(true);
    expect(isEnabledLanguage('he')).toBe(true);
    expect(isEnabledLanguage('en-GB')).toBe(true);
    expect(isEnabledLanguage('fr')).toBe(false); // known, but not enabled
    expect(isEnabledLanguage(null)).toBe(false);
    expect(isEnabledLanguage('')).toBe(false);
  });
});
