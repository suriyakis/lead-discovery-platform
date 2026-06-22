// Localized unsubscribe footer appended to every outbound email. Static
// strings (no AI call, deterministic) keyed by ISO language, falling back
// to English. The footer language follows the email's target language so a
// foreign-language body doesn't carry an English footer.
//
// To change the wording or add a language, edit FOOTER_STRINGS below — it's
// the single source of truth for this boilerplate.

export interface UnsubscribeFooter {
  /** Plain-text line rendered above the unsubscribe URL. */
  prompt: string;
  /** Anchor label used in the HTML footer. */
  unsubscribe: string;
  /** Text direction for the HTML block (RTL for Hebrew/Arabic). */
  dir: 'ltr' | 'rtl';
}

const EN: UnsubscribeFooter = {
  prompt: "Don't want these messages? Unsubscribe:",
  unsubscribe: 'Unsubscribe',
  dir: 'ltr',
};

const FOOTER_STRINGS: Readonly<Record<string, UnsubscribeFooter>> = {
  en: EN,
  pl: {
    prompt: 'Nie chcesz otrzymywać tych wiadomości? Anuluj subskrypcję:',
    unsubscribe: 'Anuluj subskrypcję',
    dir: 'ltr',
  },
  de: {
    prompt: 'Sie möchten diese Nachrichten nicht mehr erhalten? Abmelden:',
    unsubscribe: 'Abmelden',
    dir: 'ltr',
  },
  it: {
    prompt: 'Non vuoi più ricevere questi messaggi? Annulla l’iscrizione:',
    unsubscribe: 'Annulla l’iscrizione',
    dir: 'ltr',
  },
  ja: {
    prompt: '今後このメールの配信を希望されない場合は、配信を停止できます：',
    unsubscribe: '配信停止',
    dir: 'ltr',
  },
  he: {
    prompt: 'אינך מעוניין לקבל הודעות אלה? בטל את ההרשמה:',
    unsubscribe: 'ביטול הרשמה',
    dir: 'rtl',
  },
};

/** Resolve the unsubscribe footer strings for an ISO language code,
 *  region-tolerant, defaulting to English for anything unmapped. */
export function getUnsubscribeFooter(
  lang: string | null | undefined,
): UnsubscribeFooter {
  const base = (lang ?? 'en').toLowerCase().split('-')[0] ?? 'en';
  return FOOTER_STRINGS[base] ?? EN;
}
