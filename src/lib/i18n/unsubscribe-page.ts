// flow:F-05 — copy for the public unsubscribe page (/api/unsubscribe/<token>),
// in the language the email was written in. Static strings, no AI call;
// same language set and fallback as the email footer (email-footer.ts).

export interface UnsubscribePageStrings {
  /** <html lang>. */
  lang: string;
  dir: 'ltr' | 'rtl';
  confirmTitle: string;
  /** Followed by the (masked) address list. */
  confirmLead: string;
  confirmButton: string;
  wrongPersonLink: string;
  /** Pre-filled body of the "wrong person" reply. */
  wrongPersonBody: string;
  doneTitle: string;
  /** Followed by the (masked) address list. */
  doneLead: string;
  doneNote: string;
  invalidTitle: string;
  invalidLead: string;
}

const EN: UnsubscribePageStrings = {
  lang: 'en',
  dir: 'ltr',
  confirmTitle: 'Unsubscribe from these emails?',
  confirmLead: 'Press the button and this sender stops emailing:',
  confirmButton: 'Unsubscribe',
  wrongPersonLink: 'Wrong person? Tell us who',
  wrongPersonBody: "I'm not the right person for this. Please contact instead: ",
  doneTitle: 'You have been unsubscribed',
  doneLead: 'This sender will not email these addresses again:',
  doneNote: 'Unsubscribed by mistake? Reply to the original email.',
  invalidTitle: 'This link is not valid',
  invalidLead: 'If you keep receiving these emails, reply to one of them and ask to be removed.',
};

const STRINGS: Readonly<Record<string, UnsubscribePageStrings>> = {
  en: EN,
  pl: {
    lang: 'pl',
    dir: 'ltr',
    confirmTitle: 'Zrezygnować z tych wiadomości?',
    confirmLead: 'Kliknij przycisk, a ten nadawca przestanie pisać na adres:',
    confirmButton: 'Wypisz mnie',
    wrongPersonLink: 'To nie do Ciebie? Napisz nam, z kim się skontaktować',
    wrongPersonBody: 'Nie jestem właściwą osobą w tej sprawie. Proszę skontaktować się z: ',
    doneTitle: 'Rezygnacja przyjęta',
    doneLead: 'Ten nadawca nie będzie już pisać na adres:',
    doneNote: 'To pomyłka? Odpowiedz na oryginalną wiadomość.',
    invalidTitle: 'Ten link jest nieważny',
    invalidLead:
      'Jeśli nadal dostajesz te wiadomości, odpowiedz na jedną z nich z prośbą o usunięcie.',
  },
  de: {
    lang: 'de',
    dir: 'ltr',
    confirmTitle: 'Von diesen E-Mails abmelden?',
    confirmLead: 'Klicken Sie auf die Schaltfläche, dann schreibt dieser Absender nicht mehr an:',
    confirmButton: 'Abmelden',
    wrongPersonLink: 'Falsche Person? Sagen Sie uns, wer zuständig ist',
    wrongPersonBody:
      'Ich bin dafür nicht die richtige Ansprechperson. Bitte wenden Sie sich an: ',
    doneTitle: 'Sie wurden abgemeldet',
    doneLead: 'Dieser Absender schreibt nicht mehr an:',
    doneNote: 'Versehentlich abgemeldet? Antworten Sie auf die ursprüngliche E-Mail.',
    invalidTitle: 'Dieser Link ist ungültig',
    invalidLead:
      'Wenn Sie diese E-Mails weiterhin erhalten, antworten Sie auf eine davon und bitten Sie um Entfernung.',
  },
  it: {
    lang: 'it',
    dir: 'ltr',
    confirmTitle: 'Annullare l’iscrizione a queste email?',
    confirmLead: 'Premi il pulsante e questo mittente smetterà di scrivere a:',
    confirmButton: 'Annulla l’iscrizione',
    wrongPersonLink: 'Persona sbagliata? Dicci a chi scrivere',
    wrongPersonBody: 'Non sono la persona giusta per questo argomento. Contattate invece: ',
    doneTitle: 'Iscrizione annullata',
    doneLead: 'Questo mittente non scriverà più a:',
    doneNote: 'Annullata per errore? Rispondi all’email originale.',
    invalidTitle: 'Questo link non è valido',
    invalidLead:
      'Se continui a ricevere queste email, rispondi a una di esse chiedendo la rimozione.',
  },
  ja: {
    lang: 'ja',
    dir: 'ltr',
    confirmTitle: 'このメールの配信を停止しますか？',
    confirmLead: 'ボタンを押すと、この送信者から次のアドレスへのメール送信が停止されます：',
    confirmButton: '配信停止',
    wrongPersonLink: '担当者が違いますか？正しい連絡先を教えてください',
    wrongPersonBody: 'この件の担当者は私ではありません。こちらにご連絡ください：',
    doneTitle: '配信を停止しました',
    doneLead: 'この送信者から次のアドレスへメールが送られることはありません：',
    doneNote: '誤って停止した場合は、元のメールに返信してください。',
    invalidTitle: 'このリンクは無効です',
    invalidLead: '引き続きメールが届く場合は、いずれかのメールに返信して配信停止をご依頼ください。',
  },
  he: {
    lang: 'he',
    dir: 'rtl',
    confirmTitle: 'לבטל את ההרשמה להודעות אלה?',
    confirmLead: 'לחצו על הכפתור והשולח יפסיק לשלוח הודעות אל:',
    confirmButton: 'ביטול הרשמה',
    wrongPersonLink: 'הגעתם לאדם הלא נכון? ספרו לנו למי לפנות',
    wrongPersonBody: 'אינני האדם המתאים לנושא זה. נא לפנות אל: ',
    doneTitle: 'ההרשמה בוטלה',
    doneLead: 'שולח זה לא ישלח עוד הודעות אל:',
    doneNote: 'ביטלתם בטעות? השיבו להודעה המקורית.',
    invalidTitle: 'הקישור אינו תקף',
    invalidLead: 'אם אתם ממשיכים לקבל הודעות אלה, השיבו לאחת מהן ובקשו להסיר אתכם.',
  },
};

/** Region-tolerant lookup; English for anything unmapped. */
export function getUnsubscribePageStrings(
  lang: string | null | undefined,
): UnsubscribePageStrings {
  const base = (lang ?? 'en').toLowerCase().split('-')[0] ?? 'en';
  return STRINGS[base] ?? EN;
}
