import { describe, expect, it } from 'vitest';
import { getUnsubscribeFooter } from '@/lib/i18n/email-footer';

describe('getUnsubscribeFooter', () => {
  it('returns the language-specific footer for enabled languages', () => {
    expect(getUnsubscribeFooter('de').unsubscribe).toBe('Abmelden');
    expect(getUnsubscribeFooter('pl').unsubscribe).toBe('Anuluj subskrypcję');
    expect(getUnsubscribeFooter('it').unsubscribe).toBe('Annulla l’iscrizione');
    expect(getUnsubscribeFooter('ja').unsubscribe).toBe('配信停止');
    expect(getUnsubscribeFooter('he').unsubscribe).toBe('ביטול הרשמה');
  });

  it('marks Hebrew as right-to-left, others left-to-right', () => {
    expect(getUnsubscribeFooter('he').dir).toBe('rtl');
    expect(getUnsubscribeFooter('de').dir).toBe('ltr');
    expect(getUnsubscribeFooter('en').dir).toBe('ltr');
  });

  it('is region-tolerant', () => {
    expect(getUnsubscribeFooter('de-AT').unsubscribe).toBe('Abmelden');
  });

  it('falls back to English for unmapped / empty languages', () => {
    expect(getUnsubscribeFooter('fr').unsubscribe).toBe('Unsubscribe');
    expect(getUnsubscribeFooter(null).unsubscribe).toBe('Unsubscribe');
    expect(getUnsubscribeFooter(undefined).prompt).toContain('Unsubscribe');
  });
});
